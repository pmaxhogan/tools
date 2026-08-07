import { ToolError, type ToolLogic } from '../types';
import {
  KEYCODE_NAMES,
  MOD_NAMES,
  MOD_TAP_ALIASES,
  MOD_WRAPPERS,
  MOONLANDER_POSITIONS,
  NONE_TOKENS,
  TRANSPARENT_TOKENS,
} from './data';

/** The line that splits keymap.c A from keymap.c B in the single input box. */
export const SEPARATOR = '=====';

/** A Moonlander LAYOUT macro takes exactly this many keycodes. */
export const MOONLANDER_KEY_COUNT = 72;

/** Canonical spelling every transparent alias collapses to before comparing. */
const CANONICAL_TRANSPARENT = 'KC_TRANSPARENT';
/** Canonical spelling every "does nothing" alias collapses to. */
const CANONICAL_NONE = 'KC_NO';

export interface OryxOpts {
  /** List every key, not just the changed ones. */
  showUnchanged: boolean;
  /** 'report' | 'csv'. */
  format: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Lexing: comments, balanced parens, depth aware splitting
 * ------------------------------------------------------------------ */

/**
 * Replace every C comment with a single space, leaving string and character
 * literals alone. Everything downstream assumes comments are already gone,
 * including the enum parser, because Oryx writes a `// comment` after most
 * layer names.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      out += ' ';
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          out += source[j] + (j + 1 < n ? source[j + 1] : '');
          j += 2;
          continue;
        }
        out += source[j];
        const closed = source[j] === quote;
        j++;
        if (closed) break;
      }
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Split an argument list on commas that sit at paren depth 0, so nested calls
 * like LT(1, KC_SPC) and MT(MOD_LSFT, KC_ESC) survive as single tokens.
 */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const cleaned = parts.map((part) => part.replace(/\s+/g, ' ').trim());
  // A trailing comma before the closing paren yields one empty tail token.
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return cleaned;
}

/** Index of the `)` closing the `(` at `open`, or -1 when it never closes. */
function matchParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * Parsing a keymap.c
 * ------------------------------------------------------------------ */

export interface ParsedLayer {
  /** Layer index: from the enum, from a numeric key, or from file order. */
  index: number;
  /** Enum name when the file has one, else L0, L1 and so on. */
  name: string;
  /** The LAYOUT macro this layer used. */
  macro: string;
  /** Keycode tokens exactly as written, whitespace collapsed. */
  tokens: string[];
  /** Comparison form of each token: no whitespace, aliases collapsed. */
  canonical: string[];
}

export interface ParsedKeymap {
  layers: ParsedLayer[];
  /** Layer index to enum name, empty when the file has no layers enum. */
  layerNames: string[];
  warnings: string[];
}

/** Pull `enum layers { BASE, SYM = 2, NAV }` into an index to name list. */
function parseLayerEnum(source: string, macroKeys: string[]): string[] {
  const re = /enum\s+([A-Za-z_]\w*)?\s*\{([^}]*)\}/g;
  const candidates: { name: string; body: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    candidates.push({ name: match[1] ?? '', body: match[2] });
  }

  const identifierKeys = macroKeys.filter((key) => !/^\d+$/.test(key));

  const parseBody = (body: string): string[] => {
    const names: string[] = [];
    let nextIndex = 0;
    for (const raw of body.split(',')) {
      const entry = raw.trim();
      if (entry === '') continue;
      const assign = /^([A-Za-z_]\w*)\s*=\s*(\d+)$/.exec(entry);
      const plain = /^([A-Za-z_]\w*)$/.exec(entry);
      if (assign) {
        nextIndex = Number(assign[2]);
        names[nextIndex] = assign[1];
        nextIndex++;
      } else if (plain) {
        names[nextIndex] = plain[1];
        nextIndex++;
      } else {
        // Anything else (a computed value, a macro) means this is not a plain
        // layers enum; give up on it rather than guess.
        return [];
      }
    }
    return names;
  };

  // Preferred: an enum whose name mentions layers, which is what both Oryx
  // and the QMK docs emit.
  for (const candidate of candidates) {
    if (/layer/i.test(candidate.name)) {
      const names = parseBody(candidate.body);
      if (names.length > 0) return names;
    }
  }
  // Fallback: any enum that actually defines every identifier the layer
  // macros use as a key, so an unrelated enum can never supply names.
  if (identifierKeys.length > 0) {
    for (const candidate of candidates) {
      const names = parseBody(candidate.body);
      if (names.length === 0) continue;
      if (identifierKeys.every((key) => names.includes(key))) return names;
    }
  }
  return [];
}

/** Collapse alias spellings so equal bindings compare equal across sides. */
export function canonicalToken(token: string): string {
  const bare = token.replace(/\s+/g, '');
  if (TRANSPARENT_TOKENS.includes(bare)) return CANONICAL_TRANSPARENT;
  if (NONE_TOKENS.includes(bare)) return CANONICAL_NONE;
  return bare;
}

/** Parse one keymap.c into its layers. Throws when there is nothing to read. */
export function parseKeymap(source: string, side: string): ParsedKeymap {
  const clean = stripComments(source);
  const warnings: string[] = [];

  const macroRe = /\[\s*([A-Za-z_]\w*|\d+)\s*\]\s*=\s*(LAYOUT\w*)\s*\(/g;
  const found: { key: string; macro: string; body: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = macroRe.exec(clean)) !== null) {
    const open = macroRe.lastIndex - 1;
    const close = matchParen(clean, open);
    if (close === -1) {
      warnings.push(
        `Layout ${side}: the ${match[2]} call for [${match[1]}] is missing its closing parenthesis, so that layer was skipped.`,
      );
      continue;
    }
    found.push({ key: match[1], macro: match[2], body: clean.slice(open + 1, close) });
    macroRe.lastIndex = close;
  }

  if (found.length === 0) {
    throw new ToolError(
      'no-layers',
      `Layout ${side} has no layer definitions in it.`,
      'Paste the whole keymap.c from the Download Source zip. The tool looks for lines like [0] = LAYOUT( or [BASE] = LAYOUT_moonlander(.',
    );
  }

  const layerNames = parseLayerEnum(
    clean,
    found.map((entry) => entry.key),
  );

  const layers: ParsedLayer[] = found.map((entry, order) => {
    let index: number;
    if (/^\d+$/.test(entry.key)) index = Number(entry.key);
    else if (layerNames.indexOf(entry.key) !== -1) index = layerNames.indexOf(entry.key);
    else index = order;

    const named = /^\d+$/.test(entry.key) ? layerNames[index] : entry.key;
    const tokens = splitTopLevel(entry.body);

    return {
      index,
      name: named ?? `L${index}`,
      macro: entry.macro,
      tokens,
      canonical: tokens.map(canonicalToken),
    };
  });

  for (const layer of layers) {
    if (layer.tokens.length !== MOONLANDER_KEY_COUNT) {
      warnings.push(
        `Layout ${side}, layer ${layer.name}: ${layer.tokens.length} keycodes, not the ${MOONLANDER_KEY_COUNT} a Moonlander layer uses. Those keys are reported by index instead of physical position. A ZSA Voyager layer has 52 keycodes and an ErgoDox layer has more than 72; neither physical map ships in this tool yet.`,
      );
    }
  }

  return { layers, layerNames, warnings };
}

/* ------------------------------------------------------------------ *
 * Keycode display names
 * ------------------------------------------------------------------ */

/** Turn a layer argument into something readable, using enum names if any. */
function layerRef(arg: string, layerNames: string[]): string {
  const trimmed = arg.trim();
  if (/^\d+$/.test(trimmed)) {
    const named = layerNames[Number(trimmed)];
    return named ?? `L${trimmed}`;
  }
  return trimmed;
}

/** Readable name for a modifier constant, including OR-ed combinations. */
function modName(arg: string): string {
  return arg
    .split('|')
    .map((part) => {
      const key = part.trim();
      return MOD_NAMES[key] ?? key;
    })
    .join('+');
}

/**
 * Display name for one keycode token. Known keycodes use the curated table,
 * unknown KC_ keycodes drop the prefix, and anything else is shown verbatim
 * so custom Oryx macros stay recognisable.
 */
export function displayKeycode(token: string, layerNames: string[] = []): string {
  const text = token.replace(/\s+/g, ' ').trim();
  if (text === '') return '(empty)';

  const canonical = canonicalToken(text);
  if (canonical === CANONICAL_TRANSPARENT) return 'transparent';
  if (canonical === CANONICAL_NONE) return 'none';

  const call = /^([A-Za-z_]\w*)\s*\((.*)\)$/s.exec(text);
  if (call) {
    const name = call[1];
    const args = splitTopLevel(call[2]);
    const arg0 = args[0] ?? '';
    const arg1 = args[1] ?? '';

    if (name === 'LT' && args.length === 2) {
      return `LT ${layerRef(arg0, layerNames)} / ${displayKeycode(arg1, layerNames)}`;
    }
    if (name === 'MT' && args.length === 2) {
      return `${modName(arg0)}-tap / ${displayKeycode(arg1, layerNames)}`;
    }
    if (MOD_TAP_ALIASES[name] && args.length === 1) {
      return `${MOD_TAP_ALIASES[name]}-tap / ${displayKeycode(arg0, layerNames)}`;
    }
    if (name === 'LM' && args.length === 2) {
      return `LM ${layerRef(arg0, layerNames)} + ${modName(arg1)}`;
    }
    if (['MO', 'TO', 'TG', 'OSL', 'DF', 'TT'].includes(name) && args.length === 1) {
      return `${name} ${layerRef(arg0, layerNames)}`;
    }
    if (name === 'OSM' && args.length === 1) {
      return `One-shot ${modName(arg0)}`;
    }
    if (name === 'TD' && args.length === 1) {
      return `Tap dance ${arg0.trim()}`;
    }
    if (MOD_WRAPPERS[name] && args.length === 1) {
      return `${MOD_WRAPPERS[name]}+${displayKeycode(arg0, layerNames)}`;
    }
    return `${name}(${args.join(', ')})`;
  }

  const known = KEYCODE_NAMES[text];
  if (known !== undefined) return known;
  if (text.startsWith('KC_') && text.length > 3) return text.slice(3);
  return text;
}

/* ------------------------------------------------------------------ *
 * Positions
 * ------------------------------------------------------------------ */

/** Human descriptor for a key index, falling back to the raw index. */
export function positionLabel(index: number, keyCount: number): string {
  if (keyCount === MOONLANDER_KEY_COUNT) {
    const position = MOONLANDER_POSITIONS[index];
    if (position) return position.label;
  }
  return `Key ${index}`;
}

/* ------------------------------------------------------------------ *
 * Diffing
 * ------------------------------------------------------------------ */

interface KeyChange {
  index: number;
  position: string;
  oldName: string;
  newName: string;
  oldCanonical: string;
  newCanonical: string;
}

interface MovedBinding {
  name: string;
  from: string;
  to: string;
}

interface LayerDiff {
  name: string;
  changes: KeyChange[];
  unchanged: number;
  compared: number;
  moved: MovedBinding[];
  note?: string;
}

interface LayerRow {
  index: number;
  position: string;
  oldName: string;
  newName: string;
  changed: boolean;
}

function isPlaceholder(canonical: string): boolean {
  return canonical === CANONICAL_TRANSPARENT || canonical === CANONICAL_NONE;
}

/** Bindings that vanished from one position and turned up at exactly one other. */
function findMoves(
  a: ParsedLayer,
  b: ParsedLayer,
  compared: number,
  namesA: string[],
): MovedBinding[] {
  const gone = new Map<string, number[]>();
  const arrived = new Map<string, number[]>();

  for (let i = 0; i < compared; i++) {
    if (a.canonical[i] === b.canonical[i]) continue;
    if (!isPlaceholder(a.canonical[i])) {
      const list = gone.get(a.canonical[i]) ?? [];
      list.push(i);
      gone.set(a.canonical[i], list);
    }
    if (!isPlaceholder(b.canonical[i])) {
      const list = arrived.get(b.canonical[i]) ?? [];
      list.push(i);
      arrived.set(b.canonical[i], list);
    }
  }

  const moves: MovedBinding[] = [];
  for (const [token, fromList] of gone) {
    const toList = arrived.get(token);
    // Only call it a move when the binding left one place and landed in one
    // place; anything else is a reshuffle we cannot describe honestly.
    if (!toList || fromList.length !== 1 || toList.length !== 1) continue;
    moves.push({
      name: displayKeycode(a.tokens[fromList[0]], namesA),
      from: positionLabel(fromList[0], a.tokens.length),
      to: positionLabel(toList[0], b.tokens.length),
    });
  }
  return moves.sort((x, y) => x.name.localeCompare(y.name));
}

function buildRows(a: ParsedLayer, b: ParsedLayer, namesA: string[], namesB: string[]): LayerRow[] {
  const compared = Math.min(a.tokens.length, b.tokens.length);
  const rows: LayerRow[] = [];
  for (let i = 0; i < compared; i++) {
    rows.push({
      index: i,
      position: positionLabel(i, a.tokens.length === b.tokens.length ? a.tokens.length : 0),
      oldName: displayKeycode(a.tokens[i], namesA),
      newName: displayKeycode(b.tokens[i], namesB),
      changed: a.canonical[i] !== b.canonical[i],
    });
  }
  return rows;
}

function diffLayerPair(
  a: ParsedLayer,
  b: ParsedLayer,
  label: string,
  namesA: string[],
  namesB: string[],
): { diff: LayerDiff; rows: LayerRow[] } {
  const rows = buildRows(a, b, namesA, namesB);
  const compared = rows.length;
  const changes: KeyChange[] = rows
    .filter((row) => row.changed)
    .map((row) => ({
      index: row.index,
      position: row.position,
      oldName: row.oldName,
      newName: row.newName,
      oldCanonical: a.canonical[row.index],
      newCanonical: b.canonical[row.index],
    }));

  const note =
    a.tokens.length === b.tokens.length
      ? undefined
      : `key counts differ (${a.tokens.length} in A, ${b.tokens.length} in B), compared the first ${compared}`;

  return {
    diff: {
      name: label,
      changes,
      unchanged: compared - changes.length,
      compared,
      moved: findMoves(a, b, compared, namesA),
      note,
    },
    rows,
  };
}

interface Matching {
  pairs: { label: string; a: ParsedLayer; b: ParsedLayer }[];
  onlyA: ParsedLayer[];
  onlyB: ParsedLayer[];
  matchedBy: 'name' | 'index';
}

function matchLayers(a: ParsedLayer[], b: ParsedLayer[]): Matching {
  const namesA = new Set(a.map((layer) => layer.name));
  const namesB = new Set(b.map((layer) => layer.name));
  const shared = [...namesA].filter((name) => namesB.has(name));

  if (shared.length > 0) {
    const byNameB = new Map(b.map((layer) => [layer.name, layer]));
    const pairs = a
      .filter((layer) => byNameB.has(layer.name))
      .map((layer) => ({
        label: layer.name,
        a: layer,
        b: byNameB.get(layer.name) as ParsedLayer,
      }));
    return {
      pairs,
      onlyA: a.filter((layer) => !namesB.has(layer.name)),
      onlyB: b.filter((layer) => !namesA.has(layer.name)),
      matchedBy: 'name',
    };
  }

  // No name in common: the two files probably use different enum names, so
  // fall back to position in the file and say so in the report.
  const count = Math.min(a.length, b.length);
  const pairs = [];
  for (let i = 0; i < count; i++) {
    const label = a[i].name === b[i].name ? a[i].name : `${a[i].name} vs ${b[i].name}`;
    pairs.push({ label, a: a[i], b: b[i] });
  }
  return { pairs, onlyA: a.slice(count), onlyB: b.slice(count), matchedBy: 'index' };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Widest descriptor is 39 characters, so this always leaves a clear gutter. */
const POSITION_WIDTH = 41;

function pad(text: string): string {
  return text.length >= POSITION_WIDTH ? `${text}  ` : text.padEnd(POSITION_WIDTH, ' ');
}

function layerList(layers: ParsedLayer[]): string {
  if (layers.length === 0) return 'none';
  return layers.map((layer) => layer.name).join(', ');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function renderReport(
  a: ParsedKeymap,
  b: ParsedKeymap,
  matching: Matching,
  results: { diff: LayerDiff; rows: LayerRow[] }[],
  opts: OryxOpts,
): string {
  const out: string[] = [];
  out.push('Oryx layout diff: Moonlander keymap.c A vs keymap.c B');
  out.push('');
  out.push(`Layout A: ${plural(a.layers.length, 'layer', 'layers')} (${layerList(a.layers)})`);
  out.push(`Layout B: ${plural(b.layers.length, 'layer', 'layers')} (${layerList(b.layers)})`);
  out.push(`Layers only in B: ${layerList(matching.onlyB)}`);
  out.push(`Layers only in A: ${layerList(matching.onlyA)}`);
  out.push(
    matching.matchedBy === 'name'
      ? 'Layers matched by name.'
      : 'The two files share no layer names, so layers were matched by their order in the file.',
  );
  out.push('');
  out.push(
    'Positions follow the Moonlander physical layout. Rows run 1 to 5 from the top, columns are counted from the outer edge of each hand inward, so col 1 is the outer pinky column on both hands. Thumb 1 is the large thumb key.',
  );

  const warnings = [...a.warnings, ...b.warnings];
  if (warnings.length > 0) {
    out.push('');
    out.push('Warnings');
    for (const warning of warnings) out.push(`  ${warning}`);
  }

  for (const result of results) {
    const { diff, rows } = result;
    out.push('');
    const suffix = diff.note ? ` (${diff.note})` : '';
    if (diff.changes.length === 0) {
      out.push(`Layer ${diff.name}: no changes, ${plural(diff.compared, 'key', 'keys')} identical${suffix}`);
    } else {
      out.push(
        `Layer ${diff.name}: ${plural(diff.changes.length, 'changed key', 'changed keys')}, ${diff.unchanged} unchanged${suffix}`,
      );
    }

    const shown = opts.showUnchanged ? rows : rows.filter((row) => row.changed);
    for (const row of shown) {
      const marker = opts.showUnchanged ? (row.changed ? '* ' : '  ') : '';
      if (row.changed) {
        out.push(`  ${marker}${pad(row.position)}${row.oldName} -> ${row.newName}`);
      } else {
        out.push(`  ${marker}${pad(row.position)}${row.oldName}`);
      }
    }
  }

  for (const layer of matching.onlyB) {
    out.push('');
    out.push(
      `Layer ${layer.name}: only in layout B, ${plural(layer.tokens.length, 'key', 'keys')}, nothing to compare it against.`,
    );
  }
  for (const layer of matching.onlyA) {
    out.push('');
    out.push(
      `Layer ${layer.name}: only in layout A, ${plural(layer.tokens.length, 'key', 'keys')}, nothing to compare it against.`,
    );
  }

  const totalChanged = results.reduce((sum, result) => sum + result.diff.changes.length, 0);
  out.push('');
  out.push('Summary');
  out.push(`  Total changed keys: ${totalChanged}`);
  for (const result of results) {
    out.push(`    ${result.diff.name}: ${result.diff.changes.length}`);
  }

  const moves = results.flatMap((result) =>
    result.diff.moved.map((move) => `    ${move.name}: ${move.from} -> ${move.to} (layer ${result.diff.name})`),
  );
  out.push(`  Moved bindings: ${moves.length === 0 ? 'none' : ''}`.trimEnd());
  for (const line of moves) out.push(line);

  return out.join('\n');
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function renderCsv(
  a: ParsedKeymap,
  b: ParsedKeymap,
  results: { diff: LayerDiff; rows: LayerRow[] }[],
  opts: OryxOpts,
): string {
  const out: string[] = [];
  for (const warning of [...a.warnings, ...b.warnings]) out.push(`# ${warning}`);
  out.push('position,layer,old,new');
  for (const result of results) {
    const shown = opts.showUnchanged ? result.rows : result.rows.filter((row) => row.changed);
    for (const row of shown) {
      out.push(
        [csvCell(row.position), csvCell(result.diff.name), csvCell(row.oldName), csvCell(row.newName)].join(','),
      );
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

function splitSides(input: string): [string, string] {
  const lines = input.split('\n');
  const idx = lines.findIndex((line) => line.replace(/\r$/, '') === SEPARATOR);
  if (idx === -1) {
    throw new ToolError(
      'missing-separator',
      'Could not find the ===== separator line between the two keymap.c files.',
      'Paste the first keymap.c, then a line with just =====, then the second keymap.c.',
    );
  }
  return [lines.slice(0, idx).join('\n'), lines.slice(idx + 1).join('\n')];
}

export function run(input: string, opts: OryxOpts): string {
  const text = input ?? '';
  if (text.trim() === '') {
    throw new ToolError(
      'empty-input',
      'Nothing to compare.',
      'Paste the keymap.c from one Download Source zip, a line with just =====, then the keymap.c from the other.',
    );
  }

  const [rawA, rawB] = splitSides(text);
  if (rawA.trim() === '' || rawB.trim() === '') {
    const side = rawA.trim() === '' ? 'A (above the ===== line)' : 'B (below the ===== line)';
    throw new ToolError(
      'empty-side',
      `Only one keymap.c was given: side ${side} is empty.`,
      'A diff needs both revisions. Paste the older keymap.c above the ===== line and the newer one below it.',
    );
  }

  const format = opts.format || 'report';
  if (format !== 'report' && format !== 'csv') {
    throw new ToolError('unknown-format', `Unknown format "${String(opts.format)}".`, 'Pick report or csv.');
  }

  const a = parseKeymap(rawA, 'A');
  const b = parseKeymap(rawB, 'B');

  const matching = matchLayers(a.layers, b.layers);
  const results = matching.pairs.map((pair) =>
    diffLayerPair(pair.a, pair.b, pair.label, a.layerNames, b.layerNames),
  );

  return format === 'csv' ? renderCsv(a, b, results, opts) : renderReport(a, b, matching, results, opts);
}

export default { run } satisfies ToolLogic<string, string, OryxOpts>;
