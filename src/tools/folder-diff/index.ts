import { diffLines } from 'diff';
import { ToolError, type ToolLogic } from '../types';
import type { FsDirEntry, FsFileEntry, FsScan } from '@/lib/fs-access';

/**
 * Folder Diff: compare two folders that were scanned in place.
 *
 * Everything here is pure (rule 27). The panel owns the handles: it picks two
 * folders, walks each one into an `FsScan`, and hands both plain objects to
 * `diffScans`. Nothing in this file reads a file, hashes one, or knows that a
 * File System Access API exists.
 *
 * The comparison is deliberately staged, because reading is the expensive part:
 *
 *   1. Match files by relative path. A path only on one side is added or
 *      removed, and no bytes are ever read for it.
 *   2. A matched pair whose sizes differ is already known to be different.
 *      Two files cannot hold the same content at different lengths.
 *   3. A matched pair with the same size is `maybe-different`: it is a real
 *      candidate, and only these need bytes. `planHashCompare` returns exactly
 *      that list, so the panel hashes the short list rather than the folder.
 *   4. Feeding those hashes back through `diffScans` promotes each pair to
 *      `identical` or `different`. Status is never patched in place, so the
 *      report is always a function of the two scans plus the hashes in hand.
 *
 * `diffTextPair` is the last step down: once a pair is known to differ and both
 * sides are text, the panel reads the two strings and gets a line diff back.
 */

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

/**
 * What is known about a matched pair.
 *
 * `maybe-different` is an honest third state rather than a guess: the two files
 * share a path and a size, and nothing has read them yet.
 */
export type CommonStatus = 'identical' | 'different' | 'maybe-different';

/** One file present in both folders. */
export interface CommonPair {
  /** Display path, taken from folder A. */
  path: string;
  /** The entry as folder A has it. Its `path` is the one to read from A. */
  a: FsFileEntry;
  /** The entry as folder B has it. Under case-insensitive matching the path can differ in case. */
  b: FsFileEntry;
  status: CommonStatus;
}

export interface FolderDiff {
  /** Name of folder A, for report headers. */
  rootA: string;
  /** Name of folder B, for report headers. */
  rootB: string;
  /** Files only folder A has, in scan order. */
  onlyInA: FsFileEntry[];
  /** Files only folder B has, in scan order. */
  onlyInB: FsFileEntry[];
  /** Files both folders have, with what is known about each pair. */
  common: CommonPair[];
  dirsOnlyInA: FsDirEntry[];
  dirsOnlyInB: FsDirEntry[];
  /** Carried through for the text-diff step, which is where it applies. */
  ignoreLineEndings: boolean;
}

export interface DiffScansOptions {
  /**
   * Glob patterns to leave out of the comparison, as an array or as one string
   * separated by commas or newlines. A pattern without a slash matches any path
   * segment, so `node_modules` skips it at any depth and `*.log` skips every log
   * file. A pattern with a slash matches the whole path or any folder along it,
   * so `build/**` and `src/generated` both skip a subtree.
   */
  ignore?: string[] | string;
  /** Match paths without regard to case, which is how Windows and macOS behave. */
  caseInsensitive?: boolean;
  /** Passed through to the text diff, where CRLF against LF is a real question. */
  ignoreLineEndings?: boolean;
  /** Hashes already computed for folder A, keyed by that file's path in A. */
  hashesA?: Record<string, string>;
  /** Hashes already computed for folder B, keyed by that file's path in B. */
  hashesB?: Record<string, string>;
  [key: string]: unknown;
}

/** One pair worth reading, produced by `planHashCompare`. */
export interface HashCandidate {
  /** Display path (folder A's). */
  path: string;
  /** Exact path to read from folder A. */
  pathA: string;
  /** Exact path to read from folder B. */
  pathB: string;
  /** Both sides are this many bytes, which is why they are still a question. */
  size: number;
}

export interface DiffSummary {
  /** Files only folder B has. */
  added: number;
  /** Files only folder A has. */
  removed: number;
  /** Matched pairs known to differ. */
  changed: number;
  /** Matched pairs known to match. */
  identical: number;
  /** Matched pairs that share a size and have not been read yet. */
  unresolved: number;
  dirsAdded: number;
  dirsRemoved: number;
  /** Bytes in the files only folder B has. */
  bytesAdded: number;
  /** Bytes in the files only folder A has. */
  bytesRemoved: number;
  /** Files considered on either side, after the ignore list. */
  totalFiles: number;
}

export type ReportFormat = 'tree' | 'flat' | 'csv';

export interface ReportOptions {
  /** Leave the matching files out, which is usually what a person wants to read. */
  includeIdentical?: boolean;
}

export interface FolderDiffOpts extends DiffScansOptions {
  format?: string;
}

/* ------------------------------------------------------------------ *
 * ignore globs
 * ------------------------------------------------------------------ */

/** Split whatever the panel or the options panel supplied into clean patterns. */
export function normalizeIgnore(patterns: string[] | string | undefined): string[] {
  const raw = Array.isArray(patterns) ? patterns : String(patterns ?? '').split(/[\n,]/);
  return raw
    .map((pattern) => String(pattern ?? '').trim().replace(/\\/g, '/'))
    .map((pattern) => pattern.replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((pattern) => pattern !== '');
}

/**
 * Compile one glob. `**` crosses folder boundaries, `*` and `?` do not, and
 * every other character is matched literally.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Build the exclusion test.
 *
 * A pattern with no slash is checked against every segment of the path, which
 * is what makes `node_modules` and `*.log` behave the way people expect. A
 * pattern with a slash is checked against the whole path and against each
 * folder along it, so naming a folder excludes everything inside it.
 */
export function makeIgnoreMatcher(
  patterns: string[],
  caseInsensitive = false,
): (path: string) => boolean {
  const compiled = patterns.map((pattern) => ({
    scoped: pattern.includes('/'),
    re: globToRegExp(caseInsensitive ? pattern.toLowerCase() : pattern),
  }));

  if (compiled.length === 0) return () => false;

  return (path: string): boolean => {
    const target = caseInsensitive ? path.toLowerCase() : path;
    const segments = target.split('/');
    for (const { scoped, re } of compiled) {
      if (scoped) {
        let prefix = '';
        for (const segment of segments) {
          prefix = prefix === '' ? segment : `${prefix}/${segment}`;
          if (re.test(prefix)) return true;
        }
      } else {
        for (const segment of segments) {
          if (re.test(segment)) return true;
        }
      }
    }
    return false;
  };
}

/* ------------------------------------------------------------------ *
 * the comparison
 * ------------------------------------------------------------------ */

function statusFor(
  a: FsFileEntry,
  b: FsFileEntry,
  hashesA: Record<string, string> | undefined,
  hashesB: Record<string, string> | undefined,
): CommonStatus {
  // Different lengths settle it without reading a byte.
  if (a.size !== b.size) return 'different';
  const hashA = hashesA?.[a.path];
  const hashB = hashesB?.[b.path];
  // A hash on one side alone says nothing, so the pair stays a candidate.
  if (typeof hashA !== 'string' || typeof hashB !== 'string') return 'maybe-different';
  return hashA === hashB ? 'identical' : 'different';
}

/**
 * Compare two scans.
 *
 * Pure and repeatable: call it again with more hashes and more pairs resolve,
 * with no state carried between calls.
 */
export function diffScans(a: FsScan, b: FsScan, opts: DiffScansOptions = {}): FolderDiff {
  if (!a || !Array.isArray(a.entries) || !b || !Array.isArray(b.entries)) {
    throw new ToolError(
      'missing-scan',
      'Two scanned folders are needed before anything can be compared.',
      'Choose folder A and folder B in the panel, and let both finish reading.',
    );
  }

  const caseInsensitive = opts.caseInsensitive === true;
  const ignored = makeIgnoreMatcher(normalizeIgnore(opts.ignore), caseInsensitive);
  const key = (path: string) => (caseInsensitive ? path.toLowerCase() : path);

  const filesA = a.entries.filter((entry) => !ignored(entry.path));
  const filesB = b.entries.filter((entry) => !ignored(entry.path));

  // Last entry wins on a key collision, which only happens when a folder holds
  // two names differing by case and case-insensitive matching is on.
  const byKeyB = new Map<string, FsFileEntry>();
  for (const entry of filesB) byKeyB.set(key(entry.path), entry);
  const keysA = new Set(filesA.map((entry) => key(entry.path)));

  const onlyInA: FsFileEntry[] = [];
  const common: CommonPair[] = [];

  for (const entry of filesA) {
    const match = byKeyB.get(key(entry.path));
    if (!match) {
      onlyInA.push(entry);
      continue;
    }
    common.push({
      path: entry.path,
      a: entry,
      b: match,
      status: statusFor(entry, match, opts.hashesA, opts.hashesB),
    });
  }

  const onlyInB = filesB.filter((entry) => !keysA.has(key(entry.path)));

  const dirsA = (a.directories ?? []).filter((dir) => !ignored(dir.path));
  const dirsB = (b.directories ?? []).filter((dir) => !ignored(dir.path));
  const dirKeysA = new Set(dirsA.map((dir) => key(dir.path)));
  const dirKeysB = new Set(dirsB.map((dir) => key(dir.path)));

  return {
    rootA: a.rootName,
    rootB: b.rootName,
    onlyInA,
    onlyInB,
    common,
    dirsOnlyInA: dirsA.filter((dir) => !dirKeysB.has(key(dir.path))),
    dirsOnlyInB: dirsB.filter((dir) => !dirKeysA.has(key(dir.path))),
    ignoreLineEndings: opts.ignoreLineEndings === true,
  };
}

/**
 * The pairs that need a hash on both sides.
 *
 * This is the whole optimization: same path, same size, unread. Everything
 * else is already settled, so a folder of 40,000 files usually comes down to a
 * few dozen reads.
 */
export function planHashCompare(diff: FolderDiff): HashCandidate[] {
  return diff.common
    .filter((pair) => pair.status === 'maybe-different')
    .map((pair) => ({
      path: pair.path,
      pathA: pair.a.path,
      pathB: pair.b.path,
      size: pair.a.size,
    }));
}

export function summarize(diff: FolderDiff): DiffSummary {
  let changed = 0;
  let identical = 0;
  let unresolved = 0;
  for (const pair of diff.common) {
    if (pair.status === 'different') changed += 1;
    else if (pair.status === 'identical') identical += 1;
    else unresolved += 1;
  }

  const bytes = (entries: FsFileEntry[]) =>
    entries.reduce((total, entry) => total + (Number(entry.size) || 0), 0);

  return {
    added: diff.onlyInB.length,
    removed: diff.onlyInA.length,
    changed,
    identical,
    unresolved,
    dirsAdded: diff.dirsOnlyInB.length,
    dirsRemoved: diff.dirsOnlyInA.length,
    bytesAdded: bytes(diff.onlyInB),
    bytesRemoved: bytes(diff.onlyInA),
    totalFiles: diff.onlyInA.length + diff.onlyInB.length + diff.common.length,
  };
}

/* ------------------------------------------------------------------ *
 * reports
 * ------------------------------------------------------------------ */

export type RowStatus =
  | 'added'
  | 'removed'
  | 'different'
  | 'maybe-different'
  | 'identical'
  | 'dir-added'
  | 'dir-removed';

/** One line of a report, before it is shaped into a tree, a list or a CSV. */
export interface ReportRow {
  path: string;
  kind: 'file' | 'directory';
  status: RowStatus;
  marker: '+' | '-' | '~' | '?' | '=';
  /** Null when the file is not in folder A. */
  sizeA: number | null;
  /** Null when the file is not in folder B. */
  sizeB: number | null;
}

const MARKERS: Record<RowStatus, ReportRow['marker']> = {
  added: '+',
  removed: '-',
  different: '~',
  'maybe-different': '?',
  identical: '=',
  'dir-added': '+',
  'dir-removed': '-',
};

/** Flatten a diff into sorted rows. The shared input for all three formats. */
export function reportRows(diff: FolderDiff, opts: ReportOptions = {}): ReportRow[] {
  const includeIdentical = opts.includeIdentical !== false;
  const rows: ReportRow[] = [];

  const push = (
    path: string,
    kind: ReportRow['kind'],
    status: RowStatus,
    sizeA: number | null,
    sizeB: number | null,
  ) => {
    rows.push({ path, kind, status, marker: MARKERS[status], sizeA, sizeB });
  };

  for (const entry of diff.onlyInA) push(entry.path, 'file', 'removed', entry.size, null);
  for (const entry of diff.onlyInB) push(entry.path, 'file', 'added', null, entry.size);
  for (const pair of diff.common) {
    if (pair.status === 'identical' && !includeIdentical) continue;
    push(pair.path, 'file', pair.status, pair.a.size, pair.b.size);
  }
  for (const dir of diff.dirsOnlyInA) push(dir.path, 'directory', 'dir-removed', null, null);
  for (const dir of diff.dirsOnlyInB) push(dir.path, 'directory', 'dir-added', null, null);

  rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return rows;
}

function legend(diff: FolderDiff): string[] {
  return [
    `A: ${diff.rootA}`,
    `B: ${diff.rootB}`,
    '- only in A   + only in B   ~ different   ? same size, not read yet   = identical',
    '',
  ];
}

interface TreeNode {
  name: string;
  kind: 'file' | 'directory';
  marker: string;
  children: Map<string, TreeNode>;
}

function buildTree(rows: ReportRow[]): TreeNode {
  const root: TreeNode = { name: '', kind: 'directory', marker: ' ', children: new Map() };
  for (const row of rows) {
    const segments = row.path.split('/').filter((segment) => segment !== '');
    let node = root;
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1;
      let child = node.children.get(segment);
      if (!child) {
        child = {
          name: segment,
          kind: last ? row.kind : 'directory',
          marker: ' ',
          children: new Map(),
        };
        node.children.set(segment, child);
      }
      // A folder that only shows up as a parent stays unmarked; a folder that
      // is itself a row (added or removed) takes that row's marker.
      if (last) {
        child.kind = row.kind;
        child.marker = row.marker;
      }
      node = child;
    });
  }
  return root;
}

function renderTree(node: TreeNode, depth: number, out: string[]): void {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const child of children) {
    const suffix = child.kind === 'directory' ? '/' : '';
    out.push(`${'  '.repeat(depth)}${child.marker} ${child.name}${suffix}`);
    if (child.children.size > 0) renderTree(child, depth + 1, out);
  }
}

/** Quote a CSV field only when it needs it, doubling any quote inside. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Render the diff.
 *
 * `tree` keeps the folder structure, which is how a person reads "what moved".
 * `flat` is one marked path per line, which greps and diffs well. `csv` opens
 * in a spreadsheet with both sizes side by side.
 */
export function formatReport(
  diff: FolderDiff,
  format: ReportFormat | string = 'tree',
  opts: ReportOptions = {},
): string {
  const rows = reportRows(diff, opts);

  if (format === 'csv') {
    const lines = ['path,status,sizeA,sizeB'];
    for (const row of rows) {
      lines.push(
        [
          csvField(row.path),
          row.status,
          row.sizeA === null ? '' : String(row.sizeA),
          row.sizeB === null ? '' : String(row.sizeB),
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  if (format === 'flat') {
    const lines = legend(diff);
    if (rows.length === 0) lines.push('No differences.');
    for (const row of rows) {
      lines.push(`${row.marker} ${row.path}${row.kind === 'directory' ? '/' : ''}`);
    }
    return lines.join('\n');
  }

  if (format === 'tree') {
    const lines = legend(diff);
    if (rows.length === 0) {
      lines.push('No differences.');
      return lines.join('\n');
    }
    renderTree(buildTree(rows), 0, lines);
    return lines.join('\n');
  }

  throw new ToolError(
    'unknown-format',
    `"${String(format)}" is not a report format this tool knows.`,
    'Pick one of: tree, flat, csv.',
  );
}

/* ------------------------------------------------------------------ *
 * text pairs
 * ------------------------------------------------------------------ */

/** Above this, the panel offers a hash comparison instead of a line diff. */
export const MAX_TEXT_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * True when these bytes are not text worth diffing.
 *
 * A single NUL byte in the first few kilobytes is the check every diff tool
 * uses, and it is right often enough: no text encoding this tool would show
 * puts one there, and every common binary format does.
 */
export function looksBinary(bytes: Uint8Array, sampleSize = 8000): boolean {
  const limit = Math.min(bytes.length, Math.max(0, sampleSize));
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export interface TextDiffOptions {
  /** Treat CRLF and LF as the same, so a checkout difference is not a change. */
  ignoreLineEndings?: boolean;
  /** Unchanged lines kept around each change, 0 to 10. Default 3. */
  context?: number;
}

type LineKind = 'add' | 'remove' | 'same';

/**
 * Line diff for one matched pair, once both sides are known to be text.
 *
 * The panel reads the two strings and calls this; the reading is its job and
 * the comparing is this file's.
 */
export function diffTextPair(a: string, b: string, opts: TextDiffOptions = {}): string {
  const normalize = (text: string) =>
    opts.ignoreLineEndings ? String(text ?? '').replace(/\r\n?/g, '\n') : String(text ?? '');

  const changes = diffLines(normalize(a), normalize(b), { ignoreNewlineAtEof: true });

  const entries: { kind: LineKind; text: string }[] = [];
  for (const change of changes) {
    const kind: LineKind = change.added ? 'add' : change.removed ? 'remove' : 'same';
    const lines = change.value.split('\n');
    // Splitting a chunk that ends in a newline leaves a trailing empty string.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (const text of lines) entries.push({ kind, text });
  }

  let additions = 0;
  let removals = 0;
  for (const entry of entries) {
    if (entry.kind === 'add') additions += 1;
    else if (entry.kind === 'remove') removals += 1;
  }
  if (additions === 0 && removals === 0) return 'No differences.';

  const context = Math.min(10, Math.max(0, Math.floor(opts.context ?? 3)));
  const maxRun = 2 * context + 1;
  const out: string[] = [];

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i] as { kind: LineKind; text: string };
    if (entry.kind !== 'same') {
      out.push(`${entry.kind === 'add' ? '+ ' : '- '}${entry.text}`);
      i += 1;
      continue;
    }

    let j = i;
    while (j < entries.length && entries[j]?.kind === 'same') j += 1;
    const run = j - i;

    if (run <= maxRun) {
      for (let k = i; k < j; k += 1) out.push(`  ${entries[k]?.text ?? ''}`);
    } else {
      for (let k = i; k < i + context; k += 1) out.push(`  ${entries[k]?.text ?? ''}`);
      out.push(`... ${run - 2 * context} unchanged lines ...`);
      for (let k = j - context; k < j; k += 1) out.push(`  ${entries[k]?.text ?? ''}`);
    }
    i = j;
  }

  out.push('');
  out.push(
    `${additions} addition${additions === 1 ? '' : 's'}, ${removals} removal${removals === 1 ? '' : 's'}.`,
  );
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

/**
 * There is nothing to type into this tool: the input is two folders on disk,
 * and only the panel can open those. `run` says so, and names the options the
 * panel exposes, rather than pretending to do the work.
 */
export function run(_input: unknown, opts: FolderDiffOpts = {}): Record<string, string> {
  const ignore = normalizeIgnore(opts.ignore);
  return {
    'How it works':
      'Choose folder A and folder B in the panel above. Both folders are opened in place and read in this tab: your files and inputs never leave your device.',
    'What it compares':
      'Files are matched by their path inside each folder. A pair whose sizes differ is already different. A pair with the same size is checked by hash when you press Resolve same-size files, and a text pair can then be opened as a line diff.',
    'Ignore list': ignore.length > 0 ? ignore.join(', ') : 'nothing ignored',
    'Path matching': opts.caseInsensitive === true ? 'case-insensitive' : 'case-sensitive',
    'Line endings':
      opts.ignoreLineEndings === true
        ? 'CRLF and LF treated as the same in the text diff'
        : 'line endings compared exactly',
    'Report format': typeof opts.format === 'string' && opts.format ? opts.format : 'tree',
    Browser:
      'Opening a folder in place needs the File System Access API, which ships in Chromium browsers such as Chrome, Edge, Brave and Opera on desktop.',
  };
}

export default { run } satisfies ToolLogic<unknown, Record<string, string>, FolderDiffOpts>;
