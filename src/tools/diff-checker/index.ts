import { ToolError, type ToolLogic } from '../types';
import { diffLines, diffWords, diffChars, type Change } from 'diff';
import { parse as parseYaml } from 'yaml';

/** The line that splits document A from document B in the single input box. */
export const SEPARATOR = '=====';

export type DiffMode = 'lines' | 'words' | 'chars' | 'json' | 'yaml';

export interface DiffOpts {
  /** 'lines' | 'words' | 'chars' | 'json' | 'yaml'. */
  mode: string;
  /** Lines mode only: trims each line before comparing. */
  ignoreWhitespace: boolean;
  /** Case-insensitive comparison (lines, words, chars). */
  ignoreCase: boolean;
  /** Lines mode only: unchanged lines to keep around each change, 0-10. */
  context: number;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Splitting the single input box into two documents
 * ------------------------------------------------------------------ */

/**
 * Split on the first line whose content (ignoring a trailing \r) is exactly
 * `=====`. Everything before is document A, everything after is document B.
 */
function splitDocuments(input: string): [string, string] {
  const lines = input.split('\n');
  const idx = lines.findIndex((line) => line.replace(/\r$/, '') === SEPARATOR);
  if (idx === -1) {
    throw new ToolError(
      'missing-separator',
      'Could not find the ===== separator line between the two texts.',
      'Paste the first text, then a line with just =====, then the second text.',
    );
  }
  return [lines.slice(0, idx).join('\n'), lines.slice(idx + 1).join('\n')];
}

/* ------------------------------------------------------------------ *
 * Lines mode
 * ------------------------------------------------------------------ */

type LineKind = 'add' | 'remove' | 'same';

interface LineEntry {
  kind: LineKind;
  text: string;
}

function toLineEntries(changes: Change[]): LineEntry[] {
  const entries: LineEntry[] = [];
  for (const change of changes) {
    const kind: LineKind = change.added ? 'add' : change.removed ? 'remove' : 'same';
    const rawLines = change.value.split('\n');
    // A trailing newline in the change's text produces a trailing empty
    // string when split; drop it so we don't emit a phantom blank line.
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    for (const text of rawLines) entries.push({ kind, text });
  }
  return entries;
}

function summary(additions: number, removals: number): string {
  const a = `${additions} addition${additions === 1 ? '' : 's'}`;
  const r = `${removals} removal${removals === 1 ? '' : 's'}`;
  return `${a}, ${r}.`;
}

function formatLinesDiff(a: string, b: string, opts: DiffOpts): string {
  const lineOptions: {
    ignoreWhitespace?: boolean;
    ignoreCase?: boolean;
    ignoreNewlineAtEof?: boolean;
  } = {
    ignoreWhitespace: opts.ignoreWhitespace,
    ignoreCase: opts.ignoreCase,
    // Line tokens keep their newline, so the last line of a document that does
    // not end in one ("C") never matches the same line elsewhere ("C\n"). That
    // splits an otherwise minimal diff into a whole-block delete plus insert.
    ignoreNewlineAtEof: true,
  };
  const entries = toLineEntries(diffLines(a, b, lineOptions));

  let additions = 0;
  let removals = 0;
  for (const entry of entries) {
    if (entry.kind === 'add') additions++;
    else if (entry.kind === 'remove') removals++;
  }
  if (additions === 0 && removals === 0) return 'No differences.';

  const context = Math.min(10, Math.max(0, Math.floor(opts.context ?? 3)));
  const maxRun = 2 * context + 1;
  const out: string[] = [];

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (entry.kind !== 'same') {
      out.push((entry.kind === 'add' ? '+ ' : '- ') + entry.text);
      i++;
      continue;
    }

    let j = i;
    while (j < entries.length && entries[j].kind === 'same') j++;
    const runLength = j - i;

    if (runLength <= maxRun) {
      for (let k = i; k < j; k++) out.push('  ' + entries[k].text);
    } else {
      for (let k = i; k < i + context; k++) out.push('  ' + entries[k].text);
      const collapsed = runLength - 2 * context;
      out.push(`... ${collapsed} unchanged lines ...`);
      for (let k = j - context; k < j; k++) out.push('  ' + entries[k].text);
    }
    i = j;
  }

  out.push('');
  out.push(summary(additions, removals));
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Words / chars mode
 * ------------------------------------------------------------------ */

function formatInlineDiff(a: string, b: string, opts: DiffOpts, mode: 'words' | 'chars'): string {
  const changes = mode === 'words' ? diffWords(a, b, { ignoreCase: opts.ignoreCase }) : diffChars(a, b, { ignoreCase: opts.ignoreCase });

  let additions = 0;
  let removals = 0;
  const parts: string[] = [];
  for (const change of changes) {
    if (change.added) {
      additions += change.count;
      parts.push(`[+${change.value}+]`);
    } else if (change.removed) {
      removals += change.count;
      parts.push(`[-${change.value}-]`);
    } else {
      parts.push(change.value);
    }
  }
  if (additions === 0 && removals === 0) return 'No differences.';
  return `${parts.join('')}\n\n${summary(additions, removals)}`;
}

/* ------------------------------------------------------------------ *
 * JSON / YAML semantic mode
 * ------------------------------------------------------------------ */

function parseSide(text: string, mode: 'json' | 'yaml', side: 'A' | 'B'): unknown {
  if (mode === 'json') {
    try {
      return JSON.parse(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ToolError(
        'invalid-json',
        `Side ${side} is not valid JSON: ${reason}`,
        'Check for a trailing comma, a missing comma or brace, unquoted keys, or single quotes where JSON requires double quotes.',
      );
    }
  }
  try {
    return parseYaml(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ToolError(
      'invalid-yaml',
      `Side ${side} is not valid YAML: ${reason}`,
      'Check indentation, and make sure lists and mappings are indented consistently.',
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}

interface SemanticEntry {
  kind: 'added' | 'removed' | 'changed';
  path: string;
  before?: unknown;
  after?: unknown;
}

function walkDiff(a: unknown, b: unknown, path: string, out: SemanticEntry[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= a.length) out.push({ kind: 'added', path: childPath, after: b[i] });
      else if (i >= b.length) out.push({ kind: 'removed', path: childPath, before: a[i] });
      else walkDiff(a[i], b[i], childPath, out);
    }
    return;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasA = Object.prototype.hasOwnProperty.call(a, key);
      const hasB = Object.prototype.hasOwnProperty.call(b, key);
      if (!hasA) out.push({ kind: 'added', path: childPath, after: b[key] });
      else if (!hasB) out.push({ kind: 'removed', path: childPath, before: a[key] });
      else walkDiff(a[key], b[key], childPath, out);
    }
    return;
  }

  if (!valuesEqual(a, b)) out.push({ kind: 'changed', path: path || '(root)', before: a, after: b });
}

function formatValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function formatSemanticEntry(entry: SemanticEntry): string {
  const label = entry.kind.padEnd(9);
  if (entry.kind === 'added') return `${label}${entry.path}: ${formatValue(entry.after)}`;
  if (entry.kind === 'removed') return `${label}${entry.path}`;
  return `${label}${entry.path}: ${formatValue(entry.before)} -> ${formatValue(entry.after)}`;
}

function formatSemanticDiff(a: string, b: string, mode: 'json' | 'yaml'): string {
  const parsedA = parseSide(a, mode, 'A');
  const parsedB = parseSide(b, mode, 'B');
  const entries: SemanticEntry[] = [];
  walkDiff(parsedA, parsedB, '', entries);
  if (entries.length === 0) return 'No semantic differences.';
  return entries.map(formatSemanticEntry).join('\n');
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export function run(input: string, opts: DiffOpts): string {
  const [a, b] = splitDocuments(input ?? '');
  const mode = (opts.mode || 'lines') as DiffMode;

  switch (mode) {
    case 'lines':
      return formatLinesDiff(a, b, opts);
    case 'words':
      return formatInlineDiff(a, b, opts, 'words');
    case 'chars':
      return formatInlineDiff(a, b, opts, 'chars');
    case 'json':
      return formatSemanticDiff(a, b, 'json');
    case 'yaml':
      return formatSemanticDiff(a, b, 'yaml');
    default:
      throw new ToolError(
        'unknown-mode',
        `Unknown mode "${String(opts.mode)}".`,
        'Pick one of: lines, words, chars, json, yaml.',
      );
  }
}

export default { run } satisfies ToolLogic<string, string, DiffOpts>;
