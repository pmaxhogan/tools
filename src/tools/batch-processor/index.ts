/**
 * Batch Processor: run one text transform over many files in a folder.
 *
 * The split follows the folder tool contract in `src/lib/fs-access.ts`:
 *
 *   - This file is pure. It knows how to transform one string
 *     (`applyOperation`), how to decide which files a run covers and where
 *     each result lands (`planBatch`), and how to turn finished results into
 *     write operations (`buildWriteOps`). It never reads or writes a file.
 *   - The panel owns the real handles: it walks the folder into an `FsScan`,
 *     reads the bytes of each planned file, calls `applyOperation` on the
 *     decoded text, and hands the results back through `buildWriteOps`.
 *
 * v1 is text only. Images, archives and other binary formats need a different
 * pipeline (bytes in, bytes out, per format decoders), so they are filtered
 * out by extension rather than half handled.
 */
import { ToolError, type ToolLogic } from '../types';
import type { FsScan, WriteOp } from '@/lib/fs-access';

/* ------------------------------------------------------------------ */
/* operations                                                          */
/* ------------------------------------------------------------------ */

export type BatchOperationId =
  | 'find-replace'
  | 'case'
  | 'trim-whitespace'
  | 'line-endings'
  | 'encoding-normalize'
  | 'prefix-suffix'
  | 'sort-lines'
  | 'dedupe-lines'
  | 'json-format'
  | 'template-wrap';

/**
 * Every option any operation takes, in one flat bag. The panel builds it from
 * the controls for whichever operation is selected, and merges the per file
 * identity (`name`, `path`) in before each call, because `template-wrap` needs
 * the file name and `applyOperation` only ever sees a string.
 */
export interface BatchOperationOpts {
  /** find-replace: the text or pattern to look for. Required. */
  find?: string;
  /** find-replace: what to put in its place. `$1` works in regex mode. */
  replace?: string;
  /** find-replace: treat `find` as a regular expression. */
  regex?: boolean;
  /** find-replace: match case. Default true. */
  caseSensitive?: boolean;

  /** case: which casing to apply to the whole file. */
  caseMode?: 'upper' | 'lower' | 'title' | 'sentence';

  /** trim-whitespace: remove spaces and tabs at the end of each line. Default true. */
  trimTrailingSpaces?: boolean;
  /** trim-whitespace: what to do about the last line. Default "ensure". */
  finalNewline?: 'ensure' | 'strip' | 'keep';
  /** trim-whitespace: squeeze runs of blank lines down to one. Default false. */
  collapseBlankLines?: boolean;

  /** line-endings: which line ending every line should use. Default "lf". */
  eol?: 'lf' | 'crlf';

  /** encoding-normalize: also remove byte order marks found mid file. Default false. */
  stripInnerBom?: boolean;

  /** prefix-suffix: text added as its own lines above the file. */
  prefix?: string;
  /** prefix-suffix: text added as its own lines below the file. */
  suffix?: string;

  /** sort-lines: which way round. Default "asc". */
  sortDirection?: 'asc' | 'desc';
  /** sort-lines: compare digit runs as numbers, so file10 sorts after file9. */
  sortNumeric?: boolean;
  /** sort-lines: uppercase sorts separately from lowercase. Default false. */
  sortCaseSensitive?: boolean;

  /** dedupe-lines: compare with case. Default true. */
  dedupeCaseSensitive?: boolean;
  /** dedupe-lines: ignore leading and trailing spaces when comparing. Default false. */
  dedupeTrim?: boolean;
  /** dedupe-lines: leave blank lines alone instead of collapsing them. Default true. */
  keepBlankLines?: boolean;

  /** json-format: pretty print or squeeze onto one line. Default "pretty". */
  jsonMode?: 'pretty' | 'minify';
  /** json-format: spaces per indent level when pretty printing. Default 2. */
  jsonIndent?: number;

  /** template-wrap: the wrapper, using {content}, {name} and {path}. */
  template?: string;

  /** Per file identity, filled in by the panel. Base name including extension. */
  name?: string;
  /** Per file identity, filled in by the panel. Path relative to the folder. */
  path?: string;
}

/**
 * What one operation returns for one file: either the new text, or a plain
 * language reason the file was left alone. A skip is a normal outcome, not an
 * error: `json-format` over a folder that also holds README.md should process
 * the JSON and say why it walked past the rest.
 */
export type OperationResult = { ok: true; text: string } | { ok: false; reason: string };

export interface BatchOperationSpec {
  id: BatchOperationId;
  label: string;
  /** One line, shown next to the control in the panel. */
  description: string;
  /** True when this operation can decline a file it cannot handle. */
  canSkip: boolean;
  apply(text: string, opts: BatchOperationOpts): OperationResult;
}

/* ---------------- line helpers ---------------- */

/** The line ending a file already uses, so a line based edit does not switch it. */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

interface SplitText {
  lines: string[];
  eol: '\r\n' | '\n';
  /** True when the text ended with a line ending, which is not a blank line. */
  trailingNewline: boolean;
}

function splitLines(text: string): SplitText {
  const eol = detectEol(text);
  const lines = text.split(/\r\n|\r|\n/);
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

function joinLines(split: SplitText, lines: string[]): string {
  return lines.join(split.eol) + (split.trailingNewline ? split.eol : '');
}

/* ---------------- individual operations ---------------- */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findReplace(text: string, opts: BatchOperationOpts): OperationResult {
  const find = opts.find ?? '';
  if (find === '') {
    throw new ToolError(
      'empty-find',
      'Find and replace needs something to look for, and the find box is empty.',
      'Type the text or the pattern you want replaced.',
    );
  }

  const flags = `g${opts.caseSensitive === false ? 'i' : ''}`;
  let pattern: RegExp;
  if (opts.regex) {
    try {
      pattern = new RegExp(find, flags);
    } catch (error) {
      throw new ToolError(
        'invalid-regex',
        `That regular expression is not valid: ${error instanceof Error ? error.message : String(error)}.`,
        'Check the pattern, or switch off regex mode to search for the text exactly as typed.',
      );
    }
  } else {
    pattern = new RegExp(escapeRegExp(find), flags);
  }

  return { ok: true, text: text.replace(pattern, opts.replace ?? '') };
}

function toTitleCase(text: string): string {
  return text.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function toSentenceCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[.!?]["')\]]?\s+|\r?\n\s*)([a-z])/g, (_m, lead: string, letter: string) =>
      lead + letter.toUpperCase(),
    );
}

function changeCase(text: string, opts: BatchOperationOpts): OperationResult {
  switch (opts.caseMode ?? 'lower') {
    case 'upper':
      return { ok: true, text: text.toUpperCase() };
    case 'lower':
      return { ok: true, text: text.toLowerCase() };
    case 'title':
      return { ok: true, text: toTitleCase(text) };
    case 'sentence':
      return { ok: true, text: toSentenceCase(text) };
    default:
      throw new ToolError(
        'unknown-case-mode',
        `"${String(opts.caseMode)}" is not a casing this tool knows.`,
        'Choose upper, lower, title or sentence.',
      );
  }
}

function trimWhitespace(text: string, opts: BatchOperationOpts): OperationResult {
  if (text === '') return { ok: true, text };
  const split = splitLines(text);
  let lines = split.lines;

  if (opts.trimTrailingSpaces !== false) {
    lines = lines.map((line) => line.replace(/[ \t]+$/, ''));
  }
  if (opts.collapseBlankLines) {
    lines = lines.filter((line, i) => !(line.trim() === '' && (lines[i - 1] ?? 'x').trim() === ''));
  }

  const mode = opts.finalNewline ?? 'ensure';
  if (mode === 'ensure') {
    while (lines.length > 1 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    return { ok: true, text: lines.join(split.eol) + split.eol };
  }
  if (mode === 'strip') {
    while (lines.length > 1 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    return { ok: true, text: lines.join(split.eol) };
  }
  return { ok: true, text: joinLines(split, lines) };
}

function convertLineEndings(text: string, opts: BatchOperationOpts): OperationResult {
  const target = (opts.eol ?? 'lf') === 'crlf' ? '\r\n' : '\n';
  return { ok: true, text: text.replace(/\r\n|\r|\n/g, target) };
}

/** U+FEFF, the character a UTF-8 BOM decodes to. */
const BOM = '\uFEFF';

function normalizeEncoding(text: string, opts: BatchOperationOpts): OperationResult {
  let out = text.startsWith(BOM) ? text.slice(1) : text;
  if (opts.stripInnerBom) out = out.split(BOM).join('');
  return { ok: true, text: out };
}

function prefixSuffix(text: string, opts: BatchOperationOpts): OperationResult {
  const prefix = opts.prefix ?? '';
  const suffix = opts.suffix ?? '';
  if (prefix === '' && suffix === '') {
    throw new ToolError(
      'empty-prefix-suffix',
      'Add header or footer needs a header, a footer, or both, and neither was given.',
      'Type the text you want above or below every file.',
    );
  }

  const eol = detectEol(text);
  let out = prefix === '' ? text : `${prefix}${eol}${text}`;
  if (suffix !== '') {
    const needsBreak = out !== '' && !out.endsWith('\n');
    out = `${out}${needsBreak ? eol : ''}${suffix}${eol}`;
  }
  return { ok: true, text: out };
}

function sortLines(text: string, opts: BatchOperationOpts): OperationResult {
  if (text === '') return { ok: true, text };
  const split = splitLines(text);
  const caseSensitive = opts.sortCaseSensitive === true;

  const sorted = [...split.lines].sort((a, b) => {
    const left = caseSensitive ? a : a.toLowerCase();
    const right = caseSensitive ? b : b.toLowerCase();
    if (opts.sortNumeric) {
      const compared = left.localeCompare(right, 'en', { numeric: true, sensitivity: 'variant' });
      if (compared !== 0) return compared;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });

  if ((opts.sortDirection ?? 'asc') === 'desc') sorted.reverse();
  return { ok: true, text: joinLines(split, sorted) };
}

function dedupeLines(text: string, opts: BatchOperationOpts): OperationResult {
  if (text === '') return { ok: true, text };
  const split = splitLines(text);
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const line of split.lines) {
    if (line.trim() === '' && opts.keepBlankLines !== false) {
      kept.push(line);
      continue;
    }
    let key = opts.dedupeTrim ? line.trim() : line;
    if (opts.dedupeCaseSensitive === false) key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }

  return { ok: true, text: joinLines(split, kept) };
}

function formatJson(text: string, opts: BatchOperationOpts): OperationResult {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (body.trim() === '') {
    return { ok: false, reason: 'the file is empty, so there is no JSON to format' };
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `not valid JSON (${detail})` };
  }

  if (opts.jsonMode === 'minify') return { ok: true, text: JSON.stringify(value) };

  const indent = Math.min(8, Math.max(0, Math.floor(opts.jsonIndent ?? 2)));
  return { ok: true, text: `${JSON.stringify(value, null, indent)}\n` };
}

function templateWrap(text: string, opts: BatchOperationOpts): OperationResult {
  const template = opts.template ?? '';
  if (template === '') {
    throw new ToolError(
      'empty-template',
      'Wrap in a template needs a template, and none was given.',
      'Write the wrapper you want, putting {content} where the file should go.',
    );
  }
  if (!template.includes('{content}')) {
    throw new ToolError(
      'template-missing-content',
      'That template never uses {content}, so every file would be replaced by the template itself.',
      'Put {content} where the original text should sit. {name} and {path} are available too.',
    );
  }

  const out = template
    .split('{content}')
    .join(text)
    .split('{name}')
    .join(opts.name ?? '')
    .split('{path}')
    .join(opts.path ?? opts.name ?? '');
  return { ok: true, text: out };
}

/* ---------------- the registry ---------------- */

/** Every batch operation, keyed by id. The panel renders this list. */
export const BATCH_OPERATIONS: Record<BatchOperationId, BatchOperationSpec> = {
  'find-replace': {
    id: 'find-replace',
    label: 'Find and replace',
    description: 'Replace every match of a literal string or a regular expression.',
    canSkip: false,
    apply: findReplace,
  },
  case: {
    id: 'case',
    label: 'Change case',
    description: 'Convert the whole file to upper, lower, title or sentence case.',
    canSkip: false,
    apply: changeCase,
  },
  'trim-whitespace': {
    id: 'trim-whitespace',
    label: 'Trim whitespace',
    description: 'Strip trailing spaces on each line and settle the final newline.',
    canSkip: false,
    apply: trimWhitespace,
  },
  'line-endings': {
    id: 'line-endings',
    label: 'Convert line endings',
    description: 'Rewrite every line ending as LF or as CRLF.',
    canSkip: false,
    apply: convertLineEndings,
  },
  'encoding-normalize': {
    id: 'encoding-normalize',
    label: 'Strip byte order mark',
    description: 'Remove the UTF-8 BOM that some editors write at the start of a file.',
    canSkip: false,
    apply: normalizeEncoding,
  },
  'prefix-suffix': {
    id: 'prefix-suffix',
    label: 'Add header or footer',
    description: 'Put fixed text above the file, below it, or both.',
    canSkip: false,
    apply: prefixSuffix,
  },
  'sort-lines': {
    id: 'sort-lines',
    label: 'Sort lines',
    description: 'Sort every line, optionally numerically or in reverse.',
    canSkip: false,
    apply: sortLines,
  },
  'dedupe-lines': {
    id: 'dedupe-lines',
    label: 'Remove duplicate lines',
    description: 'Keep the first copy of each line and drop the repeats.',
    canSkip: false,
    apply: dedupeLines,
  },
  'json-format': {
    id: 'json-format',
    label: 'Format JSON',
    description: 'Pretty print or minify JSON. Files that are not JSON are skipped and listed.',
    canSkip: true,
    apply: formatJson,
  },
  'template-wrap': {
    id: 'template-wrap',
    label: 'Wrap in a template',
    description: 'Wrap each file in a template using {content}, {name} and {path}.',
    canSkip: false,
    apply: templateWrap,
  },
};

/** The operations in the order the panel offers them. */
export const BATCH_OPERATION_LIST: BatchOperationSpec[] = [
  BATCH_OPERATIONS['find-replace'],
  BATCH_OPERATIONS.case,
  BATCH_OPERATIONS['trim-whitespace'],
  BATCH_OPERATIONS['line-endings'],
  BATCH_OPERATIONS['encoding-normalize'],
  BATCH_OPERATIONS['prefix-suffix'],
  BATCH_OPERATIONS['sort-lines'],
  BATCH_OPERATIONS['dedupe-lines'],
  BATCH_OPERATIONS['json-format'],
  BATCH_OPERATIONS['template-wrap'],
];

/**
 * Run one operation over one file's text.
 *
 * Pure and synchronous: the panel does the reading, this decides the bytes.
 * Throws `ToolError` for a broken configuration (an empty find box, a bad
 * regex, a template with no {content}) because that is wrong for every file
 * and should stop the run before it starts. A file the operation simply
 * cannot handle comes back as `{ ok: false, reason }` instead.
 */
export function applyOperation(
  text: string,
  operation: BatchOperationId,
  opts: BatchOperationOpts = {},
): OperationResult {
  const spec = BATCH_OPERATIONS[operation];
  if (!spec) {
    throw new ToolError(
      'unknown-operation',
      `"${String(operation)}" is not an operation this tool knows how to run.`,
      `Choose one of: ${Object.keys(BATCH_OPERATIONS).join(', ')}.`,
    );
  }
  return spec.apply(text, opts);
}

/* ------------------------------------------------------------------ */
/* filtering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extensions this tool refuses to open as text. Not a complete list of every
 * binary format, just the ones that turn up in a normal folder and would come
 * back as mojibake, then be written back as damage.
 */
export const BINARY_EXTENSIONS = new Set([
  '7z', 'aac', 'avi', 'bin', 'bmp', 'bz2', 'class', 'dat', 'db', 'dll', 'dmg', 'doc', 'docx',
  'dylib', 'ear', 'exe', 'flac', 'flv', 'gif', 'gz', 'heic', 'heif', 'ico', 'iso', 'jar', 'jpeg',
  'jpg', 'lz4', 'lzma', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'mpg', 'mpeg', 'o', 'odp', 'ods',
  'odt', 'ogg', 'otf', 'pdf', 'png', 'ppt', 'pptx', 'psd', 'pyc', 'rar', 'so', 'sqlite', 'tar',
  'tgz', 'tif', 'tiff', 'ttf', 'wasm', 'wav', 'webm', 'webp', 'wmv', 'woff', 'woff2', 'xls',
  'xlsx', 'zip', 'zst',
]);

/** Files larger than this are skipped: a text edit should not eat a gigabyte. */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The extension of a path without its dot, lowercased. Empty when there is none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Split a filter on the commas that are not inside a brace group. */
function splitPatterns(filter: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of filter) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * Turn one glob into a regular expression.
 *
 * `*` stops at a slash, `**` crosses them, `?` is one character, and
 * `{a,b}` is an alternation. Everything else is literal. Matching is case
 * insensitive, because Windows and macOS file names are.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') out += '(?:';
    else if (ch === '}') out += ')';
    else if (ch === ',') out += '|';
    else if ('.+^$()[]|\\'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`^${out}$`, 'i');
}

interface CompiledFilter {
  test(path: string): boolean;
}

/**
 * Compile the filter box into something that can say yes or no to a path.
 *
 * Glob mode: a pattern with no slash is matched against the file name, one
 * with a slash against the whole relative path. Patterns are comma separated,
 * and a pattern starting with `!` excludes instead of including.
 * Regex mode: the whole box is one expression, tested against the path.
 */
export function compileFilter(filter: string, mode: 'glob' | 'regex' = 'glob'): CompiledFilter {
  const raw = (filter ?? '').trim();
  if (raw === '' || raw === '*' || raw === '**' || raw === '**/*') {
    return { test: () => true };
  }

  if (mode === 'regex') {
    let expression: RegExp;
    try {
      expression = new RegExp(raw, 'i');
    } catch (error) {
      throw new ToolError(
        'invalid-filter-regex',
        `That filter is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}.`,
        'Fix the pattern, or switch the filter back to glob mode and use something like *.txt.',
      );
    }
    return { test: (path) => expression.test(path) };
  }

  const patterns = splitPatterns(raw);
  if (patterns.length === 0) return { test: () => true };

  const includes: { expression: RegExp; wholePath: boolean }[] = [];
  const excludes: { expression: RegExp; wholePath: boolean }[] = [];

  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (body === '') continue;
    const entry = { expression: globToRegExp(body), wholePath: body.includes('/') };
    (negated ? excludes : includes).push(entry);
  }

  return {
    test(path: string) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const matches = (entry: { expression: RegExp; wholePath: boolean }) =>
        entry.expression.test(entry.wholePath ? path : name);
      if (includes.length > 0 && !includes.some(matches)) return false;
      if (excludes.some(matches)) return false;
      return true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* planning                                                            */
/* ------------------------------------------------------------------ */

export type BatchOutputMode = 'in-place' | 'suffix' | 'subfolder';

export interface BatchPlanOpts {
  /** Which files the run covers. Empty means every file. */
  filter?: string;
  /** How to read the filter. Default "glob". */
  filterMode?: 'glob' | 'regex';
  operation: BatchOperationId;
  operationOpts?: BatchOperationOpts;
  /** Where the results land. Default "in-place". */
  output?: BatchOutputMode;
  /** suffix mode: the marker inserted before the extension. Default "processed". */
  suffix?: string;
  /** subfolder mode: the folder results are written into. Default "processed". */
  subfolder?: string;
  /** Skip files whose extension says they are not text. Default true. */
  skipBinary?: boolean;
  /** Skip files larger than this. Default `DEFAULT_MAX_FILE_BYTES`. */
  maxBytes?: number;
}

export interface BatchPlanItem {
  /** The file to read, relative to the chosen folder. */
  path: string;
  name: string;
  size: number;
  action: 'transform';
  /** Where the result is written. Equal to `path` in in-place mode. */
  outPath: string;
}

export interface BatchPlanSkip {
  path: string;
  reason: string;
}

export interface BatchPlan {
  operation: BatchOperationId;
  output: BatchOutputMode;
  /** The files the run will read and transform, in scan order. */
  items: BatchPlanItem[];
  /** Files the filter did not match. */
  unmatched: string[];
  /** Files the filter matched but the plan will not touch, and why. */
  skipped: BatchPlanSkip[];
  matchedCount: number;
  unmatchedCount: number;
  skippedCount: number;
  /** Total bytes of the files that will be read. */
  totalBytes: number;
  /** True when the plan overwrites the files it reads. */
  inPlace: boolean;
}

/** Insert a marker before the last extension: notes.txt gives notes.processed.txt. */
export function suffixedPath(path: string, marker: string): string {
  const cut = path.lastIndexOf('/');
  const dir = cut === -1 ? '' : path.slice(0, cut + 1);
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${dir}${name}.${marker}`;
  return `${dir}${name.slice(0, dot)}.${marker}${name.slice(dot)}`;
}

function cleanFolderName(value: string, fallback: string): string {
  const trimmed = String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/');
  return trimmed === '' ? fallback : trimmed;
}

function cleanMarker(value: string, fallback: string): string {
  const trimmed = String(value ?? '').replace(/[\\/]/g, '').trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Decide which files a run covers and where each result goes.
 *
 * Pure planning: nothing here reads a byte of any file. It looks only at the
 * scan's paths and sizes, so a 50,000 file folder plans instantly and the
 * panel can show a live matched count while somebody types in the filter box.
 *
 * The two recursion guards matter more than they look. In subfolder mode a
 * second run would otherwise pick up the results of the first and process
 * them again; in suffix mode it would produce name.processed.processed.txt.
 * Both are excluded here rather than explained afterwards.
 */
export function planBatch(scan: FsScan, opts: BatchPlanOpts): BatchPlan {
  const output = opts.output ?? 'in-place';
  const marker = cleanMarker(opts.suffix ?? '', 'processed');
  const subfolder = cleanFolderName(opts.subfolder ?? '', 'processed');
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES));
  const skipBinary = opts.skipBinary !== false;

  if (!BATCH_OPERATIONS[opts.operation]) {
    throw new ToolError(
      'unknown-operation',
      `"${String(opts.operation)}" is not an operation this tool knows how to run.`,
      `Choose one of: ${Object.keys(BATCH_OPERATIONS).join(', ')}.`,
    );
  }

  const match = compileFilter(opts.filter ?? '', opts.filterMode ?? 'glob');

  const items: BatchPlanItem[] = [];
  const unmatched: string[] = [];
  const skipped: BatchPlanSkip[] = [];
  let totalBytes = 0;

  for (const entry of scan?.entries ?? []) {
    if (!match.test(entry.path)) {
      unmatched.push(entry.path);
      continue;
    }

    if (output === 'subfolder' && entry.path.startsWith(`${subfolder}/`)) {
      skipped.push({
        path: entry.path,
        reason: `already inside the "${subfolder}" output folder`,
      });
      continue;
    }
    if (output === 'suffix' && entry.name.includes(`.${marker}.`)) {
      skipped.push({
        path: entry.path,
        reason: `already carries the "${marker}" marker, so it is a result of an earlier run`,
      });
      continue;
    }
    if (skipBinary && BINARY_EXTENSIONS.has(extensionOf(entry.path))) {
      skipped.push({
        path: entry.path,
        reason: `a .${extensionOf(entry.path)} file is not text, and this tool only edits text`,
      });
      continue;
    }
    if (entry.size > maxBytes) {
      skipped.push({
        path: entry.path,
        reason: `larger than the ${Math.round(maxBytes / (1024 * 1024))} MB per file limit`,
      });
      continue;
    }

    const outPath =
      output === 'in-place'
        ? entry.path
        : output === 'suffix'
          ? suffixedPath(entry.path, marker)
          : `${subfolder}/${entry.path}`;

    items.push({ path: entry.path, name: entry.name, size: entry.size, action: 'transform', outPath });
    totalBytes += entry.size;
  }

  return {
    operation: opts.operation,
    output,
    items,
    unmatched,
    skipped,
    matchedCount: items.length,
    unmatchedCount: unmatched.length,
    skippedCount: skipped.length,
    totalBytes,
    inPlace: output === 'in-place',
  };
}

/* ------------------------------------------------------------------ */
/* write ops                                                           */
/* ------------------------------------------------------------------ */

/** One finished file, as the panel hands it back. */
export interface BatchFileResult {
  /** Where the text should be written. */
  outPath: string;
  newText: string;
  /** False when the transform produced exactly what was already there. */
  changed: boolean;
}

/**
 * Turn finished results into write operations.
 *
 * Only changed files get an op. Writing a file whose contents did not move
 * would bump its modified time for nothing, which breaks incremental builds
 * and backup tools that watch timestamps, and it would put an entry in the
 * confirm list that a person then has to reason about.
 */
export function buildWriteOps(results: BatchFileResult[]): WriteOp[] {
  return (results ?? [])
    .filter((result) => result.changed)
    .map((result) => ({ op: 'writeFile', path: result.outPath, data: result.newText }));
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const USAGE_ROWS: Record<string, string> = {
  'How this works':
    'This tool is panel first, because it works on a folder on your disk rather than on pasted text. Choose a folder, filter down to the files you mean, pick one transform, preview it on the first match, then apply it to the rest.',
  Operations: BATCH_OPERATION_LIST.map((spec) => `${spec.label}: ${spec.description}`).join('\n'),
  'Where results go':
    'In place overwrites each file. Alongside writes name.processed.ext next to the original. Into a subfolder copies the folder structure under a folder you name, leaving the originals untouched.',
  'Text only in v1':
    'Images, archives, PDFs and other binary formats are skipped by extension. Editing those needs a per format decoder rather than a text transform, so they are left alone instead of half handled.',
  Undo: 'Before an in place run the panel offers a backup file holding the original contents of every file it is about to change. That backup, not the folder tool undo file, is what puts an overwritten file back.',
  Browsers:
    'Opening a folder in place needs the File System Access API, which Chromium browsers such as Chrome, Edge, Brave and Opera ship on desktop. Firefox and Safari do not support it yet.',
  Privacy: 'Everything happens in this tab: your files and inputs never leave your device.',
};

/**
 * With no folder there is nothing to transform, so `run` returns the usage
 * rows: what the operations do, where results land, and what undo means here.
 * The real work happens through `planBatch`, `applyOperation` and
 * `buildWriteOps`, which the panel calls with the bytes it read.
 */
export function run(): Record<string, string> {
  return { ...USAGE_ROWS };
}

export default { run } satisfies ToolLogic<unknown, Record<string, string>, Record<string, unknown>>;
