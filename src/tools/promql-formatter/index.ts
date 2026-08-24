import { ToolError, type ToolLogic } from "../types";

/**
 * LogQL and PromQL formatter / explainer.
 *
 * This is deliberately NOT a full grammar. It is a resilient tokenizer, a loose
 * recursive descent parser, and a pretty printer. Anything the parser cannot
 * make sense of falls back to a token level whitespace normalization pass, so a
 * plausible but odd query is never rejected and never crashes. Both the printer
 * and the fallback are idempotent: format(format(q)) === format(q).
 */

export interface PromqlFormatterOpts {
  /** "auto" | "promql" | "logql" (synonyms accepted). */
  lang: string;
  /** "format" | "explain" | "both". */
  mode: string;
  [key: string]: unknown;
}

export type PromqlFormatterResult = string | Record<string, string>;

type Lang = "promql" | "logql";

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

type TokKind = "str" | "num" | "dur" | "ident" | "op" | "punct" | "comment";

interface Tok {
  kind: TokKind;
  value: string;
  pos: number;
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const PUNCT = new Set(["(", ")", "[", "]", "{", "}", ",", ":"]);

/** Longest match first, so "|=" wins over "|" and "=~" over "=". */
const OPERATORS = [
  "=~",
  "!~",
  "!=",
  "==",
  "<=",
  ">=",
  "|=",
  "|~",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "@",
  "|",
  "~",
];

const DURATION_RE = /^(?:\d+(?:\.\d+)?(?:ms|[smhdwy]))+/;
const HEX_RE = /^0[xX][0-9a-fA-F]+/;
const NUM_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_:$.]*/;

/** Never throws. Unknown characters become single character operator tokens. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i += 1;
      continue;
    }
    if (c === "#") {
      let j = i;
      while (j < src.length && src.charAt(j) !== "\n") j += 1;
      out.push({ kind: "comment", value: src.slice(i, j).trimEnd(), pos: i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const raw = c === "`";
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const ch = src.charAt(j);
        if (!raw && ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === c) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      const end = closed ? j : src.length;
      out.push({ kind: "str", value: src.slice(i, end), pos: i });
      i = end;
      continue;
    }

    const rest = src.slice(i);

    const dur = DURATION_RE.exec(rest);
    if (dur && !/^[a-zA-Z0-9_]/.test(rest.slice(dur[0].length))) {
      out.push({ kind: "dur", value: dur[0], pos: i });
      i += dur[0].length;
      continue;
    }

    const hex = HEX_RE.exec(rest);
    if (hex) {
      out.push({ kind: "num", value: hex[0], pos: i });
      i += hex[0].length;
      continue;
    }

    if (/^[0-9.]/.test(c)) {
      const num = NUM_RE.exec(rest);
      if (num) {
        out.push({ kind: "num", value: num[0], pos: i });
        i += num[0].length;
        continue;
      }
    }

    const ident = IDENT_RE.exec(rest);
    if (ident) {
      out.push({ kind: "ident", value: ident[0], pos: i });
      i += ident[0].length;
      continue;
    }

    if (PUNCT.has(c)) {
      out.push({ kind: "punct", value: c, pos: i });
      i += 1;
      continue;
    }

    let matched = "";
    for (const op of OPERATORS) {
      if (rest.startsWith(op)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      out.push({ kind: "op", value: matched, pos: i });
      i += matched.length;
      continue;
    }

    out.push({ kind: "op", value: c, pos: i });
    i += 1;
  }
  return out;
}

const CLOSER_FOR: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const UNBALANCED_FIX = "Check that every ( [ { has a matching ) ] } in the same order.";

function checkBalance(toks: Tok[]): void {
  const stack: Tok[] = [];
  for (const t of toks) {
    if (t.kind !== "punct") continue;
    if (OPENERS.has(t.value)) {
      stack.push(t);
    } else if (CLOSERS.has(t.value)) {
      const top = stack.pop();
      if (!top || top.value !== CLOSER_FOR[t.value]) {
        throw new ToolError(
          "unbalanced",
          `Unbalanced parentheses or braces: unexpected "${t.value}" at position ${t.pos + 1}.`,
          UNBALANCED_FIX,
        );
      }
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1] as Tok;
    throw new ToolError(
      "unbalanced",
      `Unbalanced parentheses or braces: "${top.value}" opened at position ${top.pos + 1} is never closed.`,
      UNBALANCED_FIX,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Whitespace normalization (matchers, pipeline stage bodies, fallback) */
/* ------------------------------------------------------------------ */

/** Operators that bind with no surrounding space, matcher style. */
const TIGHT_OPS = new Set(["=", "=~", "!~", "!=", "~"]);

function needsSpace(prev: Tok, next: Tok): boolean {
  if (OPENERS.has(prev.value) && prev.kind === "punct") return false;
  if (next.kind === "punct" && (CLOSERS.has(next.value) || next.value === ",")) return false;
  if (prev.kind === "punct" && prev.value === ",") return true;
  if (next.value === ":" || prev.value === ":") return false;
  if (prev.kind === "op" && TIGHT_OPS.has(prev.value)) return false;
  if (next.kind === "op" && TIGHT_OPS.has(next.value)) return false;
  if (
    next.kind === "punct" &&
    OPENERS.has(next.value) &&
    (prev.kind === "ident" || (prev.kind === "punct" && CLOSERS.has(prev.value)))
  ) {
    return false;
  }
  return true;
}

function joinTokens(toks: Tok[]): string {
  let out = "";
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i] as Tok;
    if (i > 0 && needsSpace(toks[i - 1] as Tok, t)) out += " ";
    out += t.value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Language detection                                                  */
/* ------------------------------------------------------------------ */

const LINE_FILTER_OPS = new Set(["|=", "|~"]);

function detectLang(toks: Tok[]): Lang {
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i] as Tok;
    if (t.kind !== "op") continue;
    if (LINE_FILTER_OPS.has(t.value)) return "logql";
    if (t.value === "|") {
      const n = toks[i + 1];
      if (n && n.kind === "ident") return "logql";
    }
  }
  const first = toks.find((t) => t.kind !== "comment");
  if (first && first.kind === "punct" && first.value === "{") return "logql";
  return "promql";
}

/* ------------------------------------------------------------------ */
/* Node model                                                          */
/* ------------------------------------------------------------------ */

interface LineFilterStage {
  kind: "filter";
  op: string;
  value: string;
}
interface PipeStage {
  kind: "pipe";
  body: string;
}
type Stage = LineFilterStage | PipeStage;

interface NumNode {
  kind: "num";
  text: string;
}
interface StrNode {
  kind: "str";
  text: string;
}
interface SelectorNode {
  kind: "selector";
  metric: string;
  matchers: string[];
}
interface CallNode {
  kind: "call";
  name: string;
  args: Node[];
  /** LogQL unwrapped range aggregations may carry a trailing by/without. */
  clause: string;
  labels: string[];
}
interface AggrNode {
  kind: "aggr";
  name: string;
  clause: string;
  labels: string[];
  clauseAfter: boolean;
  args: Node[];
}
interface ParenNode {
  kind: "paren";
  inner: Node;
}
interface UnaryNode {
  kind: "unary";
  op: string;
  operand: Node;
}
interface BinaryNode {
  kind: "binary";
  op: string;
  bool: boolean;
  matching: string;
  lhs: Node;
  rhs: Node;
}
interface ExprNode {
  kind: "expr";
  base: Node;
  stages: Stage[];
  range: string;
  step: string;
  hasStep: boolean;
  offset: string;
  at: string;
}

type Node =
  | NumNode
  | StrNode
  | SelectorNode
  | CallNode
  | AggrNode
  | ParenNode
  | UnaryNode
  | BinaryNode
  | ExprNode;

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

const AGGREGATORS = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "count_values",
  "quantile",
  "topk",
  "bottomk",
  "group",
  "stddev",
  "stdvar",
  "limitk",
  "limit_ratio",
]);

const GROUPING = new Set(["by", "without"]);
const VECTOR_MATCH = new Set(["on", "ignoring"]);
const GROUP_MOD = new Set(["group_left", "group_right"]);
const KEYWORD_OPS = new Set(["and", "or", "unless", "atan2"]);

const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  unless: 2,
  "==": 3,
  "!=": 3,
  ">": 3,
  "<": 3,
  ">=": 3,
  "<=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
  "%": 5,
  atan2: 5,
  "^": 6,
};

class ParseFailure extends Error {}

class Parser {
  private toks: Tok[];
  private i = 0;
  private lang: Lang;

  constructor(toks: Tok[], lang: Lang) {
    this.toks = toks;
    this.lang = lang;
  }

  atEnd(): boolean {
    return this.i >= this.toks.length;
  }

  private peek(offset = 0): Tok | undefined {
    return this.toks[this.i + offset];
  }

  private next(): Tok {
    const t = this.toks[this.i];
    if (!t) throw new ParseFailure("unexpected end of query");
    this.i += 1;
    return t;
  }

  private expect(value: string): Tok {
    const t = this.peek();
    if (!t || t.value !== value) throw new ParseFailure(`expected "${value}"`);
    this.i += 1;
    return t;
  }

  private isValue(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return !!t && t.value === value;
  }

  parseExpression(minPrec = 0): Node {
    let lhs = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      const isKeyword = t.kind === "ident" && KEYWORD_OPS.has(t.value);
      const isSymbol = t.kind === "op" && PRECEDENCE[t.value] !== undefined;
      if (!isKeyword && !isSymbol) break;
      const prec = PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;
      this.i += 1;
      let bool = false;
      if (this.peek()?.kind === "ident" && this.peek()?.value === "bool") {
        bool = true;
        this.i += 1;
      }
      const matching = this.parseMatching();
      const nextMin = t.value === "^" ? prec : prec + 1;
      const rhs = this.parseExpression(nextMin);
      lhs = { kind: "binary", op: t.value, bool, matching, lhs, rhs };
    }
    return lhs;
  }

  /** on(...) / ignoring(...) plus group_left(...) / group_right(...). */
  private parseMatching(): string {
    const parts: string[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== "ident") break;
      if (!VECTOR_MATCH.has(t.value) && !GROUP_MOD.has(t.value)) break;
      this.i += 1;
      if (this.isValue("(")) {
        const labels = this.parseLabelList();
        parts.push(`${t.value} (${labels.join(", ")})`);
      } else {
        parts.push(t.value);
      }
    }
    return parts.join(" ");
  }

  private parseLabelList(): string[] {
    this.expect("(");
    const labels: string[] = [];
    while (!this.atEnd() && !this.isValue(")")) {
      const t = this.next();
      if (t.value === ",") continue;
      labels.push(t.value);
    }
    this.expect(")");
    return labels;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t && t.kind === "op" && (t.value === "-" || t.value === "+")) {
      this.i += 1;
      const operand = this.parseUnary();
      return { kind: "unary", op: t.value, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    const base = this.parsePrimary();
    const stages: Stage[] = [];
    let range = "";
    let step = "";
    let hasStep = false;
    let offset = "";
    let at = "";

    for (;;) {
      const t = this.peek();
      if (!t) break;

      if (this.lang === "logql" && t.kind === "op" && LINE_FILTER_OPS.has(t.value)) {
        this.i += 1;
        stages.push({ kind: "filter", op: t.value, value: this.parseFilterOperand() });
        continue;
      }
      if (
        this.lang === "logql" &&
        t.kind === "op" &&
        (t.value === "!=" || t.value === "!~") &&
        this.peek(1)?.kind === "str"
      ) {
        this.i += 1;
        stages.push({ kind: "filter", op: t.value, value: this.parseFilterOperand() });
        continue;
      }
      if (this.lang === "logql" && t.kind === "op" && t.value === "|") {
        this.i += 1;
        const body = this.collectStageBody();
        if (!body) throw new ParseFailure("empty pipeline stage");
        stages.push({ kind: "pipe", body });
        continue;
      }
      if (t.kind === "punct" && t.value === "[" && !range) {
        this.i += 1;
        const parts = this.collectRange();
        range = parts.range;
        step = parts.step;
        hasStep = parts.hasStep;
        continue;
      }
      if (t.kind === "ident" && t.value === "offset" && !offset) {
        this.i += 1;
        offset = this.parseSignedDuration();
        continue;
      }
      if (t.kind === "op" && t.value === "@" && !at) {
        this.i += 1;
        at = this.parseAtOperand();
        continue;
      }
      break;
    }

    if (stages.length === 0 && !range && !offset && !at) return base;
    return { kind: "expr", base, stages, range, step, hasStep, offset, at };
  }

  private parseFilterOperand(): string {
    const t = this.peek();
    if (!t) throw new ParseFailure("line filter needs an operand");
    if (t.kind === "str") {
      this.i += 1;
      return t.value;
    }
    // ip("..."), a backtick literal, or anything else: collect one token plus
    // an optional parenthesised argument.
    this.i += 1;
    if (this.isValue("(")) {
      const inner = this.collectBracketed("(", ")");
      return `${t.value}(${inner})`;
    }
    return t.value;
  }

  private collectBracketed(open: string, close: string): string {
    this.expect(open);
    const collected: Tok[] = [];
    let depth = 0;
    while (!this.atEnd()) {
      const t = this.peek() as Tok;
      if (t.kind === "punct" && OPENERS.has(t.value)) depth += 1;
      if (t.kind === "punct" && t.value === close && depth === 0) break;
      if (t.kind === "punct" && CLOSERS.has(t.value)) depth -= 1;
      collected.push(t);
      this.i += 1;
    }
    this.expect(close);
    return joinTokens(collected);
  }

  private collectStageBody(): string {
    const collected: Tok[] = [];
    let depth = 0;
    while (!this.atEnd()) {
      const t = this.peek() as Tok;
      if (depth === 0) {
        if (t.kind === "punct" && t.value === "[") break;
        if (t.kind === "punct" && CLOSERS.has(t.value)) break;
        if (t.kind === "op" && (t.value === "|" || LINE_FILTER_OPS.has(t.value))) break;
        if (
          t.kind === "op" &&
          (t.value === "!=" || t.value === "!~") &&
          this.peek(1)?.kind === "str" &&
          collected.length > 0
        ) {
          break;
        }
      }
      if (t.kind === "punct" && OPENERS.has(t.value)) depth += 1;
      else if (t.kind === "punct" && CLOSERS.has(t.value)) depth -= 1;
      collected.push(t);
      this.i += 1;
    }
    return joinTokens(collected);
  }

  private collectRange(): { range: string; step: string; hasStep: boolean } {
    const head: Tok[] = [];
    const tail: Tok[] = [];
    let seenColon = false;
    let depth = 0;
    while (!this.atEnd()) {
      const t = this.peek() as Tok;
      if (t.kind === "punct" && t.value === "]" && depth === 0) break;
      if (t.kind === "punct" && t.value === ":" && depth === 0) {
        seenColon = true;
        this.i += 1;
        continue;
      }
      if (t.kind === "punct" && OPENERS.has(t.value)) depth += 1;
      else if (t.kind === "punct" && CLOSERS.has(t.value)) depth -= 1;
      (seenColon ? tail : head).push(t);
      this.i += 1;
    }
    this.expect("]");
    return { range: joinTokens(head), step: joinTokens(tail), hasStep: seenColon };
  }

  private parseSignedDuration(): string {
    let sign = "";
    const t = this.peek();
    if (t && t.kind === "op" && (t.value === "-" || t.value === "+")) {
      sign = t.value;
      this.i += 1;
    }
    const v = this.peek();
    if (!v) throw new ParseFailure("offset needs a duration");
    this.i += 1;
    return `${sign}${v.value}`;
  }

  private parseAtOperand(): string {
    let sign = "";
    const s = this.peek();
    if (s && s.kind === "op" && (s.value === "-" || s.value === "+")) {
      sign = s.value;
      this.i += 1;
    }
    const t = this.peek();
    if (!t) throw new ParseFailure("@ needs a timestamp");
    this.i += 1;
    if (this.isValue("(")) {
      const inner = this.collectBracketed("(", ")");
      return `${sign}${t.value}(${inner})`;
    }
    return `${sign}${t.value}`;
  }

  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw new ParseFailure("unexpected end of query");

    if (t.kind === "num" || t.kind === "dur") {
      this.i += 1;
      return { kind: "num", text: t.value };
    }
    if (t.kind === "str") {
      this.i += 1;
      return { kind: "str", text: t.value };
    }
    if (t.kind === "punct" && t.value === "(") {
      this.i += 1;
      const inner = this.parseExpression(0);
      this.expect(")");
      return { kind: "paren", inner };
    }
    if (t.kind === "punct" && t.value === "{") {
      return { kind: "selector", metric: "", matchers: this.parseMatchers() };
    }
    if (t.kind === "ident") {
      if (GROUPING.has(t.value) || KEYWORD_OPS.has(t.value)) {
        throw new ParseFailure(`unexpected keyword "${t.value}"`);
      }
      this.i += 1;
      if (AGGREGATORS.has(t.value) && (this.isValue("(") || this.isGrouping())) {
        return this.parseAggregation(t.value);
      }
      if (this.isValue("(")) {
        const call: CallNode = {
          kind: "call",
          name: t.value,
          args: this.parseArgs(),
          clause: "",
          labels: [],
        };
        if (this.isGrouping()) {
          call.clause = this.next().value;
          call.labels = this.parseLabelList();
        }
        return call;
      }
      const matchers = this.isValue("{") ? this.parseMatchers() : [];
      return { kind: "selector", metric: t.value, matchers };
    }
    throw new ParseFailure(`unexpected token "${t.value}"`);
  }

  private isGrouping(): boolean {
    const t = this.peek();
    return !!t && t.kind === "ident" && GROUPING.has(t.value);
  }

  private parseAggregation(name: string): Node {
    let clause = "";
    let labels: string[] = [];
    let clauseAfter = false;
    if (this.isGrouping()) {
      clause = this.next().value;
      labels = this.parseLabelList();
    }
    const args = this.parseArgs();
    if (!clause && this.isGrouping()) {
      clause = this.next().value;
      labels = this.parseLabelList();
      clauseAfter = true;
    }
    return { kind: "aggr", name, clause, labels, clauseAfter, args };
  }

  private parseArgs(): Node[] {
    this.expect("(");
    const args: Node[] = [];
    if (this.isValue(")")) {
      this.expect(")");
      return args;
    }
    for (;;) {
      args.push(this.parseExpression(0));
      if (this.isValue(",")) {
        this.i += 1;
        continue;
      }
      break;
    }
    this.expect(")");
    return args;
  }

  private parseMatchers(): string[] {
    this.expect("{");
    const out: string[] = [];
    let current: Tok[] = [];
    let depth = 0;
    while (!this.atEnd()) {
      const t = this.peek() as Tok;
      if (t.kind === "punct" && t.value === "}" && depth === 0) break;
      if (t.kind === "punct" && t.value === "," && depth === 0) {
        if (current.length > 0) out.push(joinTokens(current));
        current = [];
        this.i += 1;
        continue;
      }
      if (t.kind === "punct" && OPENERS.has(t.value)) depth += 1;
      else if (t.kind === "punct" && CLOSERS.has(t.value)) depth -= 1;
      current.push(t);
      this.i += 1;
    }
    if (current.length > 0) out.push(joinTokens(current));
    this.expect("}");
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Printer                                                             */
/* ------------------------------------------------------------------ */

const CALL_WIDTH = 60;
const MATCHER_WIDTH = 80;

function pad(n: number): string {
  return " ".repeat(n);
}

function stageFlat(s: Stage): string {
  return s.kind === "filter" ? `${s.op} ${s.value}` : `| ${s.body}`;
}

/**
 * The trailing modifiers as they attach directly after the base expression:
 * "[5m] offset 1h @ end()". A range carries no leading space, a bare offset or
 * @ modifier does, so callers can also use `.trimStart()` for a standalone line.
 */
function modifierSuffix(n: ExprNode): string {
  const range = n.range ? `[${n.range}${n.hasStep ? `:${n.step}` : ""}]` : "";
  const extras: string[] = [];
  if (n.offset) extras.push(`offset ${n.offset}`);
  if (n.at) extras.push(`@ ${n.at}`);
  return extras.length > 0 ? `${range} ${extras.join(" ")}` : range;
}

function groupClause(clause: string, labels: string[]): string {
  return `${clause} (${labels.join(", ")})`;
}

/** Everything up to and including the opening parenthesis. */
function aggrHead(n: AggrNode): string {
  if (n.clauseAfter || !n.clause) return `${n.name}(`;
  return `${n.name} ${groupClause(n.clause, n.labels)} (`;
}

function aggrTail(n: AggrNode): string {
  if (!n.clauseAfter || !n.clause) return "";
  return ` ${groupClause(n.clause, n.labels)}`;
}

function callTail(n: CallNode): string {
  return n.clause ? ` ${groupClause(n.clause, n.labels)}` : "";
}

function binaryOpFlat(n: BinaryNode): string {
  return `${n.op}${n.bool ? " bool" : ""}${n.matching ? ` ${n.matching}` : ""}`;
}

function oneLine(n: Node): string {
  switch (n.kind) {
    case "num":
    case "str":
      return n.text;
    case "selector":
      return n.metric + (n.matchers.length > 0 ? `{${n.matchers.join(", ")}}` : "");
    case "call":
      return `${n.name}(${n.args.map(oneLine).join(", ")})${callTail(n)}`;
    case "aggr":
      return `${aggrHead(n)}${n.args.map(oneLine).join(", ")})${aggrTail(n)}`;
    case "paren":
      return `(${oneLine(n.inner)})`;
    case "unary":
      return `${n.op}${oneLine(n.operand)}`;
    case "binary":
      return `${oneLine(n.lhs)} ${binaryOpFlat(n)} ${oneLine(n.rhs)}`;
    case "expr": {
      const stages = n.stages.map((s) => ` ${stageFlat(s)}`).join("");
      const mods = modifierSuffix(n);
      const gap = stages && mods && !mods.startsWith(" ") ? " " : "";
      return `${oneLine(n.base)}${stages}${gap}${mods}`;
    }
  }
}

/** True when the subtree contains a LogQL pipeline, which always breaks. */
function mustBreak(n: Node): boolean {
  switch (n.kind) {
    case "num":
    case "str":
    case "selector":
      return false;
    case "call":
    case "aggr":
      return n.args.some(mustBreak);
    case "paren":
      return mustBreak(n.inner);
    case "unary":
      return mustBreak(n.operand);
    case "binary":
      return mustBreak(n.lhs) || mustBreak(n.rhs);
    case "expr":
      return n.stages.length > 0 || mustBreak(n.base);
  }
}

/**
 * Render a node. The first line carries no indent (the caller supplies it);
 * every continuation line carries its absolute indent.
 */
function render(n: Node, indent: number): string {
  const flat = oneLine(n);

  if (n.kind === "num" || n.kind === "str") return flat;

  if (n.kind === "selector") {
    if (indent + flat.length <= MATCHER_WIDTH || n.matchers.length === 0) return flat;
    const inner = n.matchers.map((m) => `${pad(indent + 2)}${m}`).join(",\n");
    return `${n.metric}{\n${inner}\n${pad(indent)}}`;
  }

  const fits = indent + flat.length <= CALL_WIDTH;

  switch (n.kind) {
    case "call": {
      if (fits && !mustBreak(n)) return flat;
      if (n.args.length === 0) return flat;
      const args = n.args.map((a) => `${pad(indent + 2)}${render(a, indent + 2)}`).join(",\n");
      return `${n.name}(\n${args}\n${pad(indent)})${callTail(n)}`;
    }
    case "aggr": {
      if (fits && !mustBreak(n)) return flat;
      if (n.args.length === 0) return flat;
      const args = n.args.map((a) => `${pad(indent + 2)}${render(a, indent + 2)}`).join(",\n");
      return `${aggrHead(n)}\n${args}\n${pad(indent)})${aggrTail(n)}`;
    }
    case "paren": {
      if (fits && !mustBreak(n)) return flat;
      return `(\n${pad(indent + 2)}${render(n.inner, indent + 2)}\n${pad(indent)})`;
    }
    case "unary": {
      if (fits && !mustBreak(n)) return flat;
      return `${n.op}${render(n.operand, indent)}`;
    }
    case "binary": {
      if (fits && !mustBreak(n)) return flat;
      const lhs = render(n.lhs, indent);
      const rhs = render(n.rhs, indent + 2);
      return `${lhs}\n${pad(indent + 2)}${binaryOpFlat(n)} ${rhs}`;
    }
    case "expr": {
      const mods = modifierSuffix(n);
      if (n.stages.length === 0) return `${render(n.base, indent)}${mods}`;
      if (fits && !mustBreak(n)) return flat;
      const lines = [render(n.base, indent)];
      for (const s of n.stages) lines.push(`${pad(indent + 2)}${stageFlat(s)}`);
      const modLine = mods.trimStart();
      if (modLine) lines.push(`${pad(indent)}${modLine}`);
      return lines.join("\n");
    }
    default:
      return flat;
  }
}

/* ------------------------------------------------------------------ */
/* Explanations                                                        */
/* ------------------------------------------------------------------ */

const FUNCTION_DOCS: Record<string, string> = {
  abs: "absolute value of each sample",
  absent: "returns a 1 series when the input has no series at all",
  absent_over_time: "returns a 1 series when the range window is empty",
  avg_over_time: "arithmetic mean of the samples in the range window",
  bytes_over_time: "number of bytes of log content in the range window",
  bytes_rate: "bytes of log content per second over the range window",
  ceil: "rounds each sample up to the nearest integer",
  changes: "how many times the value changed in the range window",
  clamp: "limits every sample to a minimum and maximum",
  clamp_max: "limits every sample to a maximum",
  clamp_min: "limits every sample to a minimum",
  count_over_time: "number of samples or log lines in the range window",
  delta: "difference between the first and last gauge value in the window",
  deriv: "per-second derivative of a gauge, fitted by least squares",
  exp: "raises e to the power of each sample",
  first_over_time: "first value in the range window",
  floor: "rounds each sample down to the nearest integer",
  histogram_quantile: "estimates a quantile from a set of histogram buckets",
  hour: "hour of the day for each sample, in UTC",
  idelta: "difference between the last two samples in the window",
  increase: "total increase of a counter across the range window",
  irate: "per-second instant rate of increase, from the last two samples only",
  label_join: "builds a new label by concatenating existing label values",
  label_replace: "copies a label into a new one using a regular expression",
  last_over_time: "most recent value in the range window",
  ln: "natural logarithm of each sample",
  log2: "base 2 logarithm of each sample",
  log10: "base 10 logarithm of each sample",
  max_over_time: "largest sample in the range window",
  min_over_time: "smallest sample in the range window",
  predict_linear: "linear prediction of a gauge value some seconds ahead",
  present_over_time: "returns 1 for every series that had any sample in the window",
  quantile_over_time: "quantile of the samples in the range window",
  rate: "per-second average rate of increase across the range window",
  rate_counter: "per-second rate of an unwrapped counter label",
  resets: "how many times a counter reset in the range window",
  round: "rounds each sample to the nearest integer",
  sgn: "sign of each sample: 1, 0, or minus 1",
  sort: "sorts the result ascending by value",
  sort_desc: "sorts the result descending by value",
  sqrt: "square root of each sample",
  scalar: "turns a single series into a plain number",
  stddev_over_time: "standard deviation of the samples in the range window",
  stdvar_over_time: "variance of the samples in the range window",
  sum_over_time: "sum of the samples in the range window",
  time: "the evaluation timestamp as a number",
  timestamp: "the timestamp of each sample as a number",
  vector: "turns a plain number into a single series",
};

const AGGREGATION_DOCS: Record<string, string> = {
  sum: "adds the values together",
  avg: "takes the arithmetic mean of the values",
  min: "keeps the smallest value",
  max: "keeps the largest value",
  count: "counts how many series there are",
  count_values: "counts how many series share each value",
  quantile: "computes a quantile across the series",
  topk: "keeps the largest N series",
  bottomk: "keeps the smallest N series",
  group: "collapses the series to a constant 1",
  stddev: "standard deviation across the series",
  stdvar: "variance across the series",
  limitk: "keeps an arbitrary N series",
  limit_ratio: "keeps a deterministic sample of the series",
};

const BINARY_DOCS: Record<string, string> = {
  "+": "add",
  "-": "subtract",
  "*": "multiply",
  "/": "divide",
  "%": "remainder",
  "^": "raise to the power of",
  atan2: "arc tangent of the two values",
  "==": "keep only values that are equal",
  "!=": "keep only values that differ",
  ">": "keep only values greater than",
  "<": "keep only values less than",
  ">=": "keep only values greater than or equal to",
  "<=": "keep only values less than or equal to",
  and: "keep only left hand series that also exist on the right",
  or: "take the left hand series plus any right hand series missing from it",
  unless: "drop left hand series that also exist on the right",
};

const MATCHER_RE = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(=~|!~|!=|=)\s*([\s\S]*)$/;
const DURATION_PART_RE = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g;
const UNIT_NAMES: Record<string, string> = {
  ms: "millisecond",
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
  y: "year",
};

function humanDuration(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const sign = text.startsWith("-") ? "minus " : "";
  const body = text.replace(/^[+-]/, "");
  const parts: string[] = [];
  DURATION_PART_RE.lastIndex = 0;
  let m = DURATION_PART_RE.exec(body);
  let consumed = 0;
  while (m) {
    consumed += m[0].length;
    const unit = UNIT_NAMES[m[2] as string] ?? m[2];
    parts.push(`${m[1]} ${unit}${m[1] === "1" ? "" : "s"}`);
    m = DURATION_PART_RE.exec(body);
  }
  if (parts.length === 0 || consumed !== body.length) return text;
  return sign + parts.join(" ");
}

function joinAnd(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function explainMatcher(raw: string): string {
  const m = MATCHER_RE.exec(raw.trim());
  if (!m) return raw.trim();
  const [, name, op, value] = m;
  switch (op) {
    case "=":
      return `${name} equals ${value}`;
    case "!=":
      return `${name} does not equal ${value}`;
    case "=~":
      return `${name} matches the regex ${value}`;
    case "!~":
      return `${name} does not match the regex ${value}`;
    default:
      return raw.trim();
  }
}

function explainSelector(n: SelectorNode, lang: Lang): string {
  const parts = n.matchers.map(explainMatcher);
  if (lang === "logql" && !n.metric) {
    return parts.length > 0
      ? `Select the log streams where ${joinAnd(parts)}.`
      : "Select every log stream (no label matchers given).";
  }
  const head = n.metric ? `Select the series named ${n.metric}` : "Select the series";
  return parts.length > 0 ? `${head} where ${joinAnd(parts)}.` : `${head}.`;
}

function explainLineFilter(s: LineFilterStage): string {
  switch (s.op) {
    case "|=":
      return `Keep only log lines containing ${s.value}.`;
    case "!=":
      return `Drop log lines containing ${s.value}.`;
    case "|~":
      return `Keep only log lines matching the regex ${s.value}.`;
    case "!~":
      return `Drop log lines matching the regex ${s.value}.`;
    default:
      return `Line filter ${s.op} ${s.value}.`;
  }
}

const STAGE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*([\s\S]*)$/;

function explainPipe(s: PipeStage): string {
  const m = STAGE_RE.exec(s.body);
  const name = m ? (m[1] as string) : "";
  const rest = m ? (m[2] as string).trim() : "";
  switch (name) {
    case "json":
      return rest
        ? `Parse each line as JSON, extracting ${rest} into labels.`
        : "Parse each line as JSON and turn its fields into labels.";
    case "logfmt":
      return rest
        ? `Parse each line as logfmt, extracting ${rest} into labels.`
        : "Parse each line as logfmt and turn its key and value pairs into labels.";
    case "pattern":
      return `Extract fields from each line with the pattern ${rest}.`;
    case "regexp":
      return `Extract named capture groups from each line with the regex ${rest}.`;
    case "unwrap":
      return `Use ${rest} as the numeric sample value (unwrap).`;
    case "label_format":
      return `Rename or rewrite labels: ${rest}.`;
    case "line_format":
      return `Rewrite each output line as ${rest}.`;
    case "decolorize":
      return "Strip ANSI color codes from each line.";
    case "drop":
      return `Drop the labels ${rest}.`;
    case "keep":
      return `Keep only the labels ${rest}.`;
    case "distinct":
      return `Keep only the first entry per distinct value of ${rest}.`;
    default:
      return `Keep only entries where ${s.body}.`;
  }
}

function isLiteral(n: Node): boolean {
  return n.kind === "num" || n.kind === "str";
}

function explainFunction(n: CallNode): string {
  const doc = FUNCTION_DOCS[n.name];
  const literals = n.args.filter(isLiteral).map(oneLine);
  const note = literals.length > 0 ? ` Given ${joinAnd(literals)}.` : "";
  const grouping = n.clause
    ? ` Results are grouped ${n.clause === "without" ? "by everything except" : "by"} (${n.labels.join(", ")}).`
    : "";
  return doc
    ? `${n.name}: ${doc}.${note}${grouping}`
    : `function ${n.name} (no description).${note}${grouping}`;
}

function explainAggregation(n: AggrNode): string {
  const doc = AGGREGATION_DOCS[n.name] ?? "aggregates the series";
  let grouping = ", across all matching series";
  if (n.clause === "by") grouping = `, grouped by (${n.labels.join(", ")})`;
  else if (n.clause === "without")
    grouping = `, grouped by everything except (${n.labels.join(", ")})`;
  const literals = n.args.filter(isLiteral).map(oneLine);
  const note = literals.length > 0 ? ` Given ${joinAnd(literals)}.` : "";
  return `${n.name}: ${doc}${grouping}.${note}`;
}

function explainNode(n: Node, lang: Lang, rows: string[]): void {
  switch (n.kind) {
    case "num":
    case "str":
      return;
    case "selector":
      rows.push(explainSelector(n, lang));
      return;
    case "paren":
      explainNode(n.inner, lang, rows);
      return;
    case "unary":
      explainNode(n.operand, lang, rows);
      if (n.op === "-") rows.push("Negate the result above.");
      return;
    case "call":
      for (const a of n.args) if (!isLiteral(a)) explainNode(a, lang, rows);
      rows.push(explainFunction(n));
      return;
    case "aggr":
      for (const a of n.args) if (!isLiteral(a)) explainNode(a, lang, rows);
      rows.push(explainAggregation(n));
      return;
    case "binary": {
      explainNode(n.lhs, lang, rows);
      if (!isLiteral(n.rhs)) explainNode(n.rhs, lang, rows);
      const word = BINARY_DOCS[n.op] ?? n.op;
      const match = n.matching ? ` Series are matched with ${n.matching}.` : "";
      const boolNote = n.bool ? " The bool modifier returns 0 or 1 instead of filtering." : "";
      if (isLiteral(n.rhs)) {
        rows.push(
          `Apply "${n.op}" (${word}) to the result above and ${oneLine(n.rhs)}.${boolNote}`,
        );
      } else {
        rows.push(`Combine the two results above with "${n.op}" (${word}).${match}${boolNote}`);
      }
      return;
    }
    case "expr": {
      explainNode(n.base, lang, rows);
      for (const s of n.stages) {
        rows.push(s.kind === "filter" ? explainLineFilter(s) : explainPipe(s));
      }
      if (n.range && n.hasStep) {
        const step = n.step ? humanDuration(n.step) : "the default step";
        rows.push(
          `Subquery: evaluate everything above every ${step} across the last ${humanDuration(n.range)}.`,
        );
      } else if (n.range) {
        rows.push(`Look at a range window covering the last ${humanDuration(n.range)}.`);
      }
      if (n.offset)
        rows.push(`Shift the lookup ${humanDuration(n.offset)} into the past (offset).`);
      if (n.at) rows.push(`Pin the evaluation to ${n.at} instead of the query time (@ modifier).`);
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

const LANG_ALIASES: Record<string, "auto" | Lang> = {
  auto: "auto",
  detect: "auto",
  "": "auto",
  promql: "promql",
  prometheus: "promql",
  prom: "promql",
  metrics: "promql",
  logql: "logql",
  loki: "logql",
  logs: "logql",
  log: "logql",
};

const MODE_ALIASES: Record<string, "format" | "explain" | "both"> = {
  "": "format",
  format: "format",
  formatted: "format",
  pretty: "format",
  prettify: "format",
  explain: "explain",
  explanation: "explain",
  describe: "explain",
  both: "both",
  all: "both",
};

function normalizeLang(raw: unknown): "auto" | Lang {
  const key = String(raw ?? "auto")
    .trim()
    .toLowerCase();
  const hit = LANG_ALIASES[key];
  if (!hit) {
    throw new ToolError(
      "bad-lang",
      `Unknown query language "${String(raw)}".`,
      'Use "auto", "promql", or "logql".',
    );
  }
  return hit;
}

function normalizeMode(raw: unknown): "format" | "explain" | "both" {
  const key = String(raw ?? "format")
    .trim()
    .toLowerCase();
  return MODE_ALIASES[key] ?? "format";
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

interface Analysis {
  lang: Lang;
  comments: string[];
  node: Node | null;
  tokens: Tok[];
}

function analyze(src: string, langOpt: "auto" | Lang): Analysis {
  const toks = tokenize(src);
  checkBalance(toks);
  const comments = toks.filter((t) => t.kind === "comment").map((t) => t.value);
  const tokens = toks.filter((t) => t.kind !== "comment");
  const lang = langOpt === "auto" ? detectLang(tokens) : langOpt;
  let node: Node | null = null;
  if (tokens.length > 0) {
    try {
      const parser = new Parser(tokens, lang);
      const parsed = parser.parseExpression(0);
      if (parser.atEnd()) node = parsed;
    } catch {
      node = null;
    }
  }
  return { lang, comments, node, tokens };
}

/** Pretty print a query. Never throws except on empty or unbalanced input. */
export function formatQuery(src: string, langOpt: "auto" | Lang = "auto"): string {
  const a = analyze(src, langOpt);
  const body = a.node ? render(a.node, 0) : joinTokens(a.tokens);
  const lines = [...a.comments];
  if (body) lines.push(body);
  return lines.join("\n");
}

const LANG_LABEL: Record<Lang, string> = { promql: "PromQL", logql: "LogQL" };

function explainRows(a: Analysis): string[] {
  if (!a.node) {
    return [
      "This query could not be read as one complete expression, so it was normalized but not explained.",
    ];
  }
  const rows: string[] = [];
  explainNode(a.node, a.lang, rows);
  return rows.length > 0 ? rows : ["Nothing to explain: the query is a bare literal value."];
}

export function run(
  input: string | Uint8Array,
  opts: Partial<PromqlFormatterOpts> = {},
): PromqlFormatterResult {
  const src = typeof input === "string" ? input : new TextDecoder().decode(input);
  if (!src.trim()) {
    throw new ToolError(
      "empty-input",
      "Enter a PromQL or LogQL query.",
      'Paste something like sum by (job) (rate(http_requests_total[5m])) or {app="api"} |= "error".',
    );
  }

  const langOpt = normalizeLang(opts.lang);
  const mode = normalizeMode(opts.mode);
  const a = analyze(src, langOpt);
  const formatted = (() => {
    const body = a.node ? render(a.node, 0) : joinTokens(a.tokens);
    const lines = [...a.comments];
    if (body) lines.push(body);
    return lines.join("\n");
  })();

  if (mode === "format") return formatted;

  const rows = explainRows(a);
  const out: Record<string, string> = {};
  if (mode === "both") out["Formatted"] = formatted;
  out["Language"] = `${LANG_LABEL[a.lang]}${langOpt === "auto" ? " (detected)" : ""}`;
  rows.forEach((row, i) => {
    out[`Step ${i + 1}`] = row;
  });
  return out;
}

export default { run } satisfies ToolLogic<
  string | Uint8Array,
  PromqlFormatterResult,
  Partial<PromqlFormatterOpts>
>;
