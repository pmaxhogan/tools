/**
 * A hand rolled JSONPath engine.
 *
 * There is no `eval` and no `new Function` anywhere in this file, on purpose.
 * An implementation that leans on the host language for filter expressions
 * inherits that language's whole surface, so `[?(@.x)]` turns into arbitrary
 * code execution the moment an expression arrives from a URL fragment.
 * Instead the path grammar and the filter grammar each get a small tokenizer
 * plus a recursive descent parser, and the evaluator walks the resulting tree.
 * The exact supported subset is documented in meta.ts.
 */
import { ToolError, type ToolLogic } from "../types";

/* ------------------------------------------------------------------ types */

/** A name selector: `.author`, `['author']`, or one member of a union. */
interface NameSelector {
  kind: "name";
  name: string;
}

/** A single array index, possibly negative (counted back from the end). */
interface IndexSelector {
  kind: "index";
  index: number;
}

/** An array slice. `step` is normalized to a non zero integer at parse time. */
interface SliceSelector {
  kind: "slice";
  start: number | null;
  end: number | null;
  step: number;
}

/** One step of a path. Segments apply left to right over a node list. */
type Segment =
  | NameSelector
  | IndexSelector
  | SliceSelector
  | { kind: "wildcard" }
  | { kind: "descendant" }
  | { kind: "union"; members: Array<NameSelector | IndexSelector | SliceSelector> }
  | { kind: "filter"; expr: FilterNode };

type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/** The right hand side of a comparison. Always a JSON scalar. */
type Literal =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "null" };

/** The filter expression tree. */
type FilterNode =
  | { kind: "or"; left: FilterNode; right: FilterNode }
  | { kind: "and"; left: FilterNode; right: FilterNode }
  | { kind: "not"; operand: FilterNode }
  | { kind: "exists"; path: Segment[] }
  | { kind: "compare"; path: Segment[]; op: CompareOp; literal: Literal }
  | { kind: "match"; path: Segment[]; regex: RegExp };

/** A matched value together with the location it was found at. */
interface Node {
  value: unknown;
  path: Array<string | number>;
}

/* ----------------------------------------------------------------- errors */

function pathFail(message: string, at: number): never {
  throw new ToolError(
    "bad-path",
    `${message} (at character ${at}).`,
    'Check the dots, brackets, and quotes. A path looks like $.store.book[0].title or $["store"]["book"][0].',
  );
}

function filterFail(message: string, at: number): never {
  throw new ToolError(
    "bad-filter",
    `${message} (at character ${at}).`,
    "A filter looks like [?(@.price < 10)]. Compare a relative path with a number, a quoted string, true, false, or null, and join tests with && or ||.",
  );
}

/* -------------------------------------------------------------- the cursor */

/** Characters allowed in an unquoted (dot notation) property name. */
const NAME_CHAR = /[A-Za-z0-9_$-]/;
const DIGIT = /[0-9]/;
const SPACE = /\s/;

/** A scan position over the expression text. */
class Cursor {
  readonly src: string;
  i = 0;

  constructor(src: string) {
    this.src = src;
  }

  peek(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  take(): string {
    const c = this.src[this.i] ?? "";
    this.i += 1;
    return c;
  }

  done(): boolean {
    return this.i >= this.src.length;
  }

  skipSpace(): void {
    while (SPACE.test(this.peek())) this.i += 1;
  }
}

/* ------------------------------------------------------------ path parsing */

/** Fail with whichever grammar we are currently inside. */
function fail(where: "path" | "filter", message: string, at: number): never {
  if (where === "path") pathFail(message, at);
  filterFail(message, at);
}

/** Read a `'...'` or `"..."` literal, resolving the JSON escape sequences. */
function readQuoted(cur: Cursor, where: "path" | "filter"): string {
  const open = cur.i;
  const quote = cur.take();
  let out = "";
  for (;;) {
    if (cur.done()) fail(where, "Unterminated quoted string opened", open);
    const c = cur.take();
    if (c === quote) return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    if (cur.done()) fail(where, "Unterminated quoted string opened", open);
    const esc = cur.take();
    if (esc === "n") out += "\n";
    else if (esc === "t") out += "\t";
    else if (esc === "r") out += "\r";
    else if (esc === "b") out += "\b";
    else if (esc === "f") out += "\f";
    else if (esc === "u") {
      const hex = cur.src.slice(cur.i, cur.i + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex))
        fail(where, "A unicode escape needs four hex digits", cur.i);
      out += String.fromCharCode(parseInt(hex, 16));
      cur.i += 4;
    } else out += esc;
  }
}

/** Read an optionally signed integer, or null when there is no integer here. */
function readInteger(cur: Cursor): number | null {
  const start = cur.i;
  if (cur.peek() === "-") cur.i += 1;
  const digitsAt = cur.i;
  while (DIGIT.test(cur.peek())) cur.i += 1;
  if (cur.i === digitsAt) {
    cur.i = start;
    return null;
  }
  return Number(cur.src.slice(start, cur.i));
}

/**
 * Is this a character an unquoted property name may contain? Anything above
 * ASCII counts, so a key written in another script still parses.
 */
function isNameChar(c: string): boolean {
  return c !== "" && (NAME_CHAR.test(c) || c.charCodeAt(0) > 127);
}

/** Read a bare property name after a dot. */
function readDotName(cur: Cursor): string {
  const start = cur.i;
  while (isNameChar(cur.peek())) cur.i += 1;
  if (cur.i === start) pathFail('Expected a property name or "*" after "."', start);
  return cur.src.slice(start, cur.i);
}

/** One member of a bracket: a quoted name, an index, or a slice. */
function readSelector(cur: Cursor): NameSelector | IndexSelector | SliceSelector {
  const c = cur.peek();
  if (c === "'" || c === '"') return { kind: "name", name: readQuoted(cur, "path") };

  const start = cur.i;
  const first = readInteger(cur);
  cur.skipSpace();
  if (cur.peek() !== ":") {
    if (first === null)
      pathFail('Expected an index, a slice, a quoted name, or "*" inside the brackets', start);
    return { kind: "index", index: first };
  }

  cur.i += 1;
  cur.skipSpace();
  const end = readInteger(cur);
  cur.skipSpace();
  let step: number | null = null;
  if (cur.peek() === ":") {
    cur.i += 1;
    cur.skipSpace();
    step = readInteger(cur);
    cur.skipSpace();
  }
  if (step === 0) pathFail("A slice step of 0 would never advance", start);
  return { kind: "slice", start: first, end, step: step ?? 1 };
}

/** Read a whole `[...]` segment. The cursor sits on the opening bracket. */
function readBracket(cur: Cursor): Segment {
  const open = cur.i;
  cur.i += 1;
  cur.skipSpace();
  // Catch the run off the end here so the message blames the bracket, not
  // whatever selector the empty tail happens to fail to parse as.
  if (cur.done()) pathFail("Unterminated bracket opened", open);

  if (cur.peek() === "*") {
    cur.i += 1;
    cur.skipSpace();
    if (cur.peek() !== "]") pathFail('Expected "]" after the wildcard', cur.i);
    cur.i += 1;
    return { kind: "wildcard" };
  }

  if (cur.peek() === "?") {
    cur.i += 1;
    /**
     * The parenthesis in `[?(@.a)]` is not consumed as a wrapper. A group is
     * already a primary of the filter grammar, so `?(@.a)` parses as a
     * parenthesized expression, and `?(@.a) && (@.b)` keeps working too.
     */
    const expr = parseOr(cur);
    cur.skipSpace();
    if (cur.peek() !== "]") filterFail('Expected "]" to close the filter', cur.i);
    cur.i += 1;
    return { kind: "filter", expr };
  }

  const members: Array<NameSelector | IndexSelector | SliceSelector> = [];
  for (;;) {
    cur.skipSpace();
    members.push(readSelector(cur));
    cur.skipSpace();
    if (cur.peek() === ",") {
      cur.i += 1;
      continue;
    }
    break;
  }

  if (cur.peek() !== "]") {
    if (cur.done()) pathFail("Unterminated bracket opened", open);
    pathFail('Expected "," or "]" inside the brackets', cur.i);
  }
  cur.i += 1;

  const only = members[0];
  return members.length === 1 && only ? only : { kind: "union", members };
}

/**
 * Read the segments after a `$` or a `@`. Stops at the first character that
 * cannot start a segment, which is how a relative path inside a filter ends
 * at an operator, a `)`, or the closing `]`.
 */
function parseSegments(cur: Cursor): Segment[] {
  const segments: Segment[] = [];
  for (;;) {
    if (cur.peek() === "." && cur.peek(1) === ".") {
      cur.i += 2;
      segments.push({ kind: "descendant" });
      if (cur.peek() === "[") {
        segments.push(readBracket(cur));
        continue;
      }
      if (cur.peek() === "*") {
        cur.i += 1;
        segments.push({ kind: "wildcard" });
        continue;
      }
      segments.push({ kind: "name", name: readDotName(cur) });
      continue;
    }
    if (cur.peek() === ".") {
      cur.i += 1;
      if (cur.peek() === "*") {
        cur.i += 1;
        segments.push({ kind: "wildcard" });
        continue;
      }
      segments.push({ kind: "name", name: readDotName(cur) });
      continue;
    }
    if (cur.peek() === "[") {
      segments.push(readBracket(cur));
      continue;
    }
    return segments;
  }
}

/** Parse a complete absolute JSONPath expression into its segments. */
export function parsePath(expression: string): Segment[] {
  const cur = new Cursor(expression);
  cur.skipSpace();
  if (cur.peek() !== "$")
    throw new ToolError(
      "bad-root",
      "A JSONPath expression has to start with $, the root of the document.",
      'Add the root, so "store.book" becomes "$.store.book".',
    );
  cur.i += 1;
  const segments = parseSegments(cur);
  cur.skipSpace();
  if (!cur.done()) pathFail(`Unexpected character ${JSON.stringify(cur.peek())}`, cur.i);
  return segments;
}

/* ---------------------------------------------------------- filter parsing */

/** or := and ( "||" and )* */
function parseOr(cur: Cursor): FilterNode {
  let left = parseAnd(cur);
  for (;;) {
    cur.skipSpace();
    if (cur.peek() !== "|" || cur.peek(1) !== "|") return left;
    cur.i += 2;
    left = { kind: "or", left, right: parseAnd(cur) };
  }
}

/** and := unary ( "&&" unary )* */
function parseAnd(cur: Cursor): FilterNode {
  let left = parseUnary(cur);
  for (;;) {
    cur.skipSpace();
    if (cur.peek() !== "&" || cur.peek(1) !== "&") return left;
    cur.i += 2;
    left = { kind: "and", left, right: parseUnary(cur) };
  }
}

/** unary := "!" unary | primary */
function parseUnary(cur: Cursor): FilterNode {
  cur.skipSpace();
  if (cur.peek() === "!" && cur.peek(1) !== "=") {
    cur.i += 1;
    return { kind: "not", operand: parseUnary(cur) };
  }
  return parsePrimary(cur);
}

/** Read a comparison operator, or null when the test is a bare existence check. */
function readCompareOp(cur: Cursor): CompareOp | "=~" | null {
  const two = cur.peek() + cur.peek(1);
  if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "=~") {
    cur.i += 2;
    return two;
  }
  const one = cur.peek();
  if (one === "<" || one === ">") {
    cur.i += 1;
    return one;
  }
  if (one === "=") filterFail('Use "==" for equality, not a single "="', cur.i);
  return null;
}

/** Read a `/pattern/flags` literal and compile it. */
function readRegex(cur: Cursor): RegExp {
  cur.skipSpace();
  if (cur.peek() !== "/")
    filterFail('The right side of "=~" must be a regular expression like /^Ni/i', cur.i);
  const open = cur.i;
  cur.i += 1;
  let pattern = "";
  for (;;) {
    if (cur.done()) filterFail("Unterminated regular expression opened", open);
    const c = cur.take();
    if (c === "/") break;
    if (c === "\\") {
      if (cur.done()) filterFail("Unterminated regular expression opened", open);
      pattern += "\\" + cur.take();
      continue;
    }
    pattern += c;
  }
  let flags = "";
  while (/[a-z]/.test(cur.peek())) flags += cur.take();
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    filterFail(`That regular expression is not valid: ${detail}`, open);
  }
}

/** Read a scalar literal: number, quoted string, true, false, or null. */
function readLiteral(cur: Cursor): Literal {
  cur.skipSpace();
  const start = cur.i;
  const c = cur.peek();

  if (c === "'" || c === '"') return { type: "string", value: readQuoted(cur, "filter") };

  if (/[A-Za-z]/.test(c)) {
    let word = "";
    while (/[A-Za-z]/.test(cur.peek())) word += cur.take();
    if (word === "true") return { type: "boolean", value: true };
    if (word === "false") return { type: "boolean", value: false };
    if (word === "null") return { type: "null" };
    filterFail(`Expected a number, a quoted string, true, false, or null, not "${word}"`, start);
  }

  if (c === "-" || c === "+") cur.i += 1;
  while (DIGIT.test(cur.peek())) cur.i += 1;
  if (cur.peek() === ".") {
    cur.i += 1;
    while (DIGIT.test(cur.peek())) cur.i += 1;
  }
  if (cur.peek() === "e" || cur.peek() === "E") {
    cur.i += 1;
    if (cur.peek() === "-" || cur.peek() === "+") cur.i += 1;
    while (DIGIT.test(cur.peek())) cur.i += 1;
  }
  const text = cur.src.slice(start, cur.i);
  const value = Number(text);
  if (text === "" || !Number.isFinite(value))
    filterFail("Expected a number, a quoted string, true, false, or null", start);
  return { type: "number", value };
}

/** primary := "(" or ")" | relativePath [ operator literal ] */
function parsePrimary(cur: Cursor): FilterNode {
  cur.skipSpace();

  if (cur.peek() === "(") {
    const open = cur.i;
    cur.i += 1;
    const inner = parseOr(cur);
    cur.skipSpace();
    if (cur.peek() !== ")") filterFail(`Expected ")" to close the group opened at ${open}`, cur.i);
    cur.i += 1;
    return inner;
  }

  if (cur.peek() !== "@") filterFail('A filter test starts with "@", the item being tested', cur.i);
  cur.i += 1;
  const path = parseSegments(cur);
  cur.skipSpace();

  const op = readCompareOp(cur);
  if (op === null) return { kind: "exists", path };
  if (op === "=~") return { kind: "match", path, regex: readRegex(cur) };
  return { kind: "compare", path, op, literal: readLiteral(cur) };
}

/* -------------------------------------------------------------- evaluation */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The indices a slice selects, following the RFC 9535 rules: bounds are
 * resolved against the length, negatives count back from the end, and a
 * negative step walks backwards with the bounds clamped one step further.
 */
function sliceIndices(len: number, start: number | null, end: number | null, step: number) {
  const norm = (i: number) => (i >= 0 ? i : len + i);
  const clamp = (i: number, lo: number, hi: number) => Math.min(Math.max(i, lo), hi);
  const out: number[] = [];

  if (step > 0) {
    const lower = start === null ? 0 : clamp(norm(start), 0, len);
    const upper = end === null ? len : clamp(norm(end), 0, len);
    for (let i = lower; i < upper; i += step) out.push(i);
  } else {
    const lower = start === null ? len - 1 : clamp(norm(start), -1, len - 1);
    const upper = end === null ? -1 : clamp(norm(end), -1, len - 1);
    for (let i = lower; i > upper; i += step) out.push(i);
  }
  return out;
}

/** Push one child of `node` onto `out` when the selector can reach it. */
function selectInto(out: Node[], node: Node, sel: NameSelector | IndexSelector | SliceSelector) {
  const value = node.value;

  if (sel.kind === "name") {
    if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, sel.name))
      out.push({ value: value[sel.name], path: [...node.path, sel.name] });
    return;
  }

  if (!Array.isArray(value)) return;

  if (sel.kind === "index") {
    const i = sel.index >= 0 ? sel.index : value.length + sel.index;
    if (i >= 0 && i < value.length) out.push({ value: value[i], path: [...node.path, i] });
    return;
  }

  for (const i of sliceIndices(value.length, sel.start, sel.end, sel.step))
    out.push({ value: value[i], path: [...node.path, i] });
}

/** Every child of a node, arrays by index and objects in key order. */
function children(node: Node): Node[] {
  const value = node.value;
  if (Array.isArray(value))
    return value.map((item, i) => ({ value: item, path: [...node.path, i] }));
  if (isPlainObject(value))
    return Object.keys(value).map((key) => ({ value: value[key], path: [...node.path, key] }));
  return [];
}

/**
 * The node and every descendant, in document order. An explicit stack keeps
 * a pathological nesting depth from overflowing the call stack.
 */
function descendants(node: Node): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    out.push(current);
    const kids = children(current);
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid) stack.push(kid);
    }
  }
  return out;
}

function literalValue(literal: Literal): unknown {
  return literal.type === "null" ? null : literal.value;
}

/** Comparison of a selected value against a scalar literal. */
function compare(left: unknown, op: CompareOp, literal: Literal): boolean {
  const right = literalValue(literal);
  if (op === "==") return left === right;
  if (op === "!=") return left !== right;

  const bothNumbers = typeof left === "number" && typeof right === "number";
  const bothStrings = typeof left === "string" && typeof right === "string";
  if (!bothNumbers && !bothStrings) return false;

  if (op === "<") return left < right;
  if (op === "<=") return left <= right;
  if (op === ">") return left > right;
  return left >= right;
}

/** Run a relative path against one candidate value and return what it selects. */
function selectRelative(path: Segment[], value: unknown): unknown[] {
  let nodes: Node[] = [{ value, path: [] }];
  for (const segment of path) nodes = applySegment(nodes, segment);
  return nodes.map((node) => node.value);
}

/**
 * Evaluate a filter against one candidate value.
 *
 * When the relative path selects nothing, every comparison is false except
 * `!=`, which is true: that is the RFC 9535 rule, and it is what makes
 * `[?(@.isbn != null)]` read the way people expect. A path that selects more
 * than one value is not a single comparable value, so a comparison on it is
 * false while an existence test on it is still true.
 */
function test(node: FilterNode, value: unknown): boolean {
  if (node.kind === "or") return test(node.left, value) || test(node.right, value);
  if (node.kind === "and") return test(node.left, value) && test(node.right, value);
  if (node.kind === "not") return !test(node.operand, value);
  if (node.kind === "exists") return selectRelative(node.path, value).length > 0;

  const found = selectRelative(node.path, value);
  if (node.kind === "match") {
    const only = found[0];
    return found.length === 1 && typeof only === "string" && node.regex.test(only);
  }
  if (found.length === 0) return node.op === "!=";
  if (found.length > 1) return false;
  return compare(found[0], node.op, node.literal);
}

/** Apply one segment across the whole node list. */
function applySegment(nodes: Node[], segment: Segment): Node[] {
  const out: Node[] = [];

  switch (segment.kind) {
    case "name":
    case "index":
    case "slice":
      for (const node of nodes) selectInto(out, node, segment);
      return out;

    case "union":
      for (const node of nodes) for (const member of segment.members) selectInto(out, node, member);
      return out;

    case "wildcard":
      for (const node of nodes) out.push(...children(node));
      return out;

    case "descendant":
      for (const node of nodes) out.push(...descendants(node));
      return out;

    case "filter":
      for (const node of nodes)
        for (const child of children(node)) if (test(segment.expr, child.value)) out.push(child);
      return out;
  }
}

/** Evaluate a parsed path against a document. Exported for the test suite. */
export function evaluate(document: unknown, segments: Segment[]): Node[] {
  let nodes: Node[] = [{ value: document, path: [] }];
  for (const segment of segments) nodes = applySegment(nodes, segment);
  return nodes;
}

/** Render a location as a normalized bracket path, e.g. `$['book'][0]`. */
export function formatPath(path: Array<string | number>): string {
  let out = "$";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += `['${part.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
  }
  return out;
}

/* --------------------------------------------------------------- the tool */

export interface JsonpathQueryOpts {
  /** The JSONPath expression, e.g. "$.store.book[*].author". */
  path?: string;
  /** Print a lone match as the value itself instead of a one element array. */
  unwrap?: boolean | string;
  /** Spaces per level in the Result row. 0 prints one compact line. */
  indent?: number | string;
  [key: string]: unknown;
}

export type JsonpathQueryResult = Record<string, string>;

/** How many matches are reported before the output is capped. */
export const MAX_MATCHES = 5000;

/** Options round trip through the URL fragment as strings, so coerce both ways. */
function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1" || text === "yes") return true;
    if (text === "false" || text === "0" || text === "no") return false;
  }
  return fallback;
}

function asIndent(value: unknown): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 2;
  return Math.min(Math.max(Math.round(n), 0), 8);
}

export function run(input: string, opts: JsonpathQueryOpts): JsonpathQueryResult {
  const text = (input ?? "").trim();
  if (text === "")
    throw new ToolError(
      "empty-input",
      "Paste a JSON document to query.",
      'Drop in some JSON, for example {"store":{"book":[{"price":8.95}]}}.',
    );

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ToolError(
      "invalid-json",
      "That input is not valid JSON, so there is nothing to query yet.",
      `The JSON parser reported: ${detail}. Fix that spot and run the query again.`,
    );
  }

  const expression = (opts?.path ?? "").trim();
  if (expression === "")
    throw new ToolError(
      "empty-path",
      "Enter a JSONPath expression.",
      'Try "$.store.book[*].author", or "$..*" to list every value in the document.',
    );

  const segments = parsePath(expression);
  const matches = evaluate(document, segments);
  const truncated = matches.length > MAX_MATCHES;
  const shown = truncated ? matches.slice(0, MAX_MATCHES) : matches;

  const unwrap = asBoolean(opts?.unwrap, true);
  const indent = asIndent(opts?.indent);
  const values = shown.map((node) => node.value);
  const payload = unwrap && values.length === 1 ? values[0] : values;

  const out: JsonpathQueryResult = {};
  out["Matches"] =
    matches.length === 0
      ? "No matches"
      : matches.length === 1
        ? "1 match"
        : `${matches.length} matches`;
  if (truncated)
    out["Truncated"] =
      `Only the first ${MAX_MATCHES} matches are listed, out of ${matches.length} found.`;
  out["Paths"] =
    shown.length === 0 ? "(none)" : shown.map((node) => formatPath(node.path)).join("\n");
  out["Result"] = JSON.stringify(payload, null, indent);
  out["Expression"] = expression;
  return out;
}

export default { run } satisfies ToolLogic<string, JsonpathQueryResult, JsonpathQueryOpts>;
