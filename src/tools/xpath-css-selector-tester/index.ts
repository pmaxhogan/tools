import { ToolError, type ToolLogic } from "../types";

/**
 * XPath and CSS selector tester logic.
 *
 * Matching HTML needs a real HTML parser and a real XPath engine, and the only
 * good ones are the two the browser already ships: DOMParser plus
 * querySelectorAll, and Document.evaluate. Neither exists in Node, and rule 27
 * keeps the DOM out of a logic layer anyway, so this module never touches one.
 * Instead every query goes through a `SelectorEngine`: anything that can turn
 * (html, selector, mode) into a list of plain `RawMatch` records. The panel
 * hands in an adapter built on DOMParser, and the tests hand in a small fake.
 *
 * What stays here is everything that is not the engine: reading the mode,
 * validating the selector before it reaches a parser that would report the
 * failure as an opaque DOMException, explaining the selector in plain English,
 * formatting matches into rows, and turning an engine error into an actionable
 * ToolError. That is the part worth testing, and it is all pure.
 */

/** HTML longer than this is refused, so one paste cannot lock the tab. */
export const MAX_HTML = 500_000;

/** Matches reported before the list is cut off. */
export const DEFAULT_MAX_MATCHES = 200;

/** The two things a selector can be written in. */
export type SelectorMode = "css" | "xpath";

/** What one matched node looks like once the engine has flattened it. */
export interface RawMatch {
  /**
   * "element" for a node with a tag, "attribute" for an XPath attribute node,
   * "text" for a text node, and "value" for an XPath expression that returned
   * a string, number, or boolean rather than a node set.
   */
  kind: "element" | "attribute" | "text" | "value";
  /** Tag name for an element, attribute name for an attribute. */
  name?: string;
  /** Serialized markup for an element, or the value for everything else. */
  markup: string;
  /** Visible text of an element. */
  text?: string;
  /** A CSS path back to the node, for example "html > body > ul > li:nth-of-type(2)". */
  path?: string;
  /** The element's attributes, in source order. */
  attributes?: Record<string, string>;
}

/**
 * The narrow slice of the browser this tool needs. `query` throws whatever the
 * underlying API throws; `engineError` below turns that into a ToolError.
 */
export interface SelectorEngine {
  query(html: string, selector: string, mode: SelectorMode): RawMatch[];
}

export interface XPathCssOpts {
  /** The selector or expression to run. */
  selector?: string;
  /** "css" or "xpath". */
  mode?: string;
  /** Include the serialized markup of every match. */
  showMarkup?: boolean;
  /** Stop the list after this many matches. */
  maxMatches?: number;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * mode and selector validation                                        *
 * ------------------------------------------------------------------ */

/** Read the mode option, defaulting to CSS, and reject anything else. */
export function parseMode(raw: unknown): SelectorMode {
  const value = String(raw ?? "css").toLowerCase();
  if (value === "" || value === "css") return "css";
  if (value === "xpath") return "xpath";
  throw new ToolError(
    "bad-mode",
    `"${value}" is not a selector mode.`,
    'Set the Mode option to "css" for a CSS selector or "xpath" for an XPath expression.',
  );
}

/** Which brackets have to close, and what to call them in an error. */
const PAIRS: Record<string, { close: string; name: string }> = {
  "(": { close: ")", name: "parenthesis" },
  "[": { close: "]", name: "bracket" },
};

/**
 * Catch the unbalanced bracket and unterminated quote cases before the
 * selector reaches the browser, which reports both as the same unhelpful
 * "is not a valid selector" string with no position.
 */
export function validateSelector(selector: string, mode: SelectorMode): void {
  const text = String(selector ?? "");
  if (text.trim() === "") {
    throw new ToolError(
      "empty-selector",
      "No selector to run.",
      mode === "css"
        ? 'Type a CSS selector, for example "article h2.title".'
        : "Type an XPath expression, for example \"//article//h2[@class='title']\".",
    );
  }

  const stack: string[] = [];
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (PAIRS[ch]) {
      stack.push(ch);
      continue;
    }
    if (ch === ")" || ch === "]") {
      const open = stack.pop();
      if (!open || PAIRS[open]!.close !== ch) {
        throw new ToolError(
          "unbalanced-selector",
          `The "${ch}" at position ${i} does not close anything.`,
          "Remove the stray closing bracket, or add the opening one it belongs to.",
        );
      }
    }
  }

  if (quote) {
    throw new ToolError(
      "unterminated-quote",
      `A ${quote === '"' ? "double" : "single"} quote is opened but never closed.`,
      "Close the quoted value, or escape the quote with a backslash if it is meant to be literal.",
    );
  }
  if (stack.length > 0) {
    const open = stack[stack.length - 1]!;
    throw new ToolError(
      "unbalanced-selector",
      `An opening ${PAIRS[open]!.name} is never closed.`,
      `Add the matching "${PAIRS[open]!.close}".`,
    );
  }

  if (mode === "xpath" && text.trim().startsWith("///")) {
    throw new ToolError(
      "bad-xpath",
      'XPath has no "///" step.',
      'Use "//" to search the whole document, or "/" for a direct child step.',
    );
  }
}

/**
 * Turn whatever the browser threw into a ToolError that names the mode. A
 * failed `querySelectorAll` and a failed `evaluate` both surface as a
 * DOMException whose message quotes the selector back without saying what is
 * wrong with it, so the fix hint has to carry the useful part.
 */
export function engineError(err: unknown, mode: SelectorMode, selector: string): ToolError {
  if (err instanceof ToolError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return mode === "css"
    ? new ToolError(
        "bad-css-selector",
        `The browser rejected this CSS selector: ${detail}`,
        `Check "${selector}" for a stray comma, an unknown pseudo class, or an XPath style // that CSS does not understand.`,
      )
    : new ToolError(
        "bad-xpath",
        `The browser rejected this XPath expression: ${detail}`,
        `Check "${selector}" for a misspelled function, an unclosed predicate, or a CSS style . and # that XPath does not understand.`,
      );
}

/** Reject an HTML document too large to parse comfortably. */
export function checkHtmlSize(html: string): void {
  if (html.length > MAX_HTML) {
    throw new ToolError(
      "input-too-large",
      `The HTML is ${html.length.toLocaleString("en-US")} characters, over the ${MAX_HTML.toLocaleString("en-US")} character limit.`,
      "Paste the section of the page you actually want to query rather than the whole document.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * the explainer                                                       *
 * ------------------------------------------------------------------ */

/** One line of the plain English breakdown of a selector. */
export interface SelectorPart {
  /** The exact source text this line describes. */
  source: string;
  /** What that piece selects. */
  description: string;
}

const CSS_COMBINATORS: Record<string, string> = {
  ">": "then a direct child that is",
  "+": "then the very next sibling, which is",
  "~": "then any later sibling that is",
  ",": "or, as a separate selector",
};

/** Describe one compound CSS selector such as "ul.menu > li:first-child". */
function describeCssCompound(compound: string): string {
  const parts: string[] = [];
  const tag = /^[*a-zA-Z][\w-]*/.exec(compound);
  if (tag) parts.push(tag[0] === "*" ? "any element" : `a <${tag[0]}> element`);
  else parts.push("any element");

  // Ids, classes and pseudo classes are read from the compound with the
  // attribute selectors removed, so a value like [href$=".pdf"] is not
  // mistaken for a class named pdf.
  const outside = compound.replace(/\[[^\]]*\]/g, "");
  for (const m of outside.matchAll(/#([\w-]+)/g)) parts.push(`with the id "${m[1]}"`);
  for (const m of outside.matchAll(/\.([\w-]+)/g)) parts.push(`with the class "${m[1]}"`);
  for (const m of compound.matchAll(/\[([^\]]*)\]/g)) {
    const body = m[1] ?? "";
    const attr = /^\s*([\w-]+)\s*([~^|$*]?=)?\s*(.*?)\s*$/.exec(body);
    if (!attr) {
      parts.push(`with the attribute condition [${body}]`);
      continue;
    }
    const name = attr[1];
    const op = attr[2];
    const value = (attr[3] ?? "").replace(/^["']|["']$/g, "");
    if (!op) parts.push(`that has a ${name} attribute`);
    else if (op === "=") parts.push(`whose ${name} is exactly "${value}"`);
    else if (op === "^=") parts.push(`whose ${name} starts with "${value}"`);
    else if (op === "$=") parts.push(`whose ${name} ends with "${value}"`);
    else if (op === "*=") parts.push(`whose ${name} contains "${value}"`);
    else if (op === "~=")
      parts.push(`whose ${name} is a space separated list containing "${value}"`);
    else if (op === "|=") parts.push(`whose ${name} is "${value}" or starts with "${value}-"`);
  }
  for (const m of outside.matchAll(/(::?[\w-]+)(\([^)]*\))?/g)) {
    parts.push(`matching ${m[1]}${m[2] ?? ""}`);
  }
  return parts.join(", ");
}

/** Break a CSS selector into readable lines. Never throws. */
function explainCss(selector: string): SelectorPart[] {
  const parts: SelectorPart[] = [];
  // Split on combinators while keeping them, ignoring anything inside
  // brackets, parentheses, or quotes.
  let buffer = "";
  let depth = 0;
  let quote = "";
  const flush = () => {
    const compound = buffer.trim();
    buffer = "";
    if (compound === "") return;
    parts.push({ source: compound, description: describeCssCompound(compound) });
  };

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]!;
    if (quote) {
      buffer += ch;
      if (ch === "\\") {
        buffer += selector[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && CSS_COMBINATORS[ch]) {
      flush();
      parts.push({ source: ch, description: CSS_COMBINATORS[ch]! });
      continue;
    }
    if (depth === 0 && /\s/.test(ch)) {
      const next = selector.slice(i).trim()[0];
      if (buffer.trim() !== "" && next && !CSS_COMBINATORS[next]) {
        flush();
        parts.push({ source: "(space)", description: "then anywhere inside it" });
      }
      continue;
    }
    buffer += ch;
  }
  flush();
  return parts;
}

/** Describe one XPath predicate such as "@class='x'" or "1". */
function describeXPathPredicate(body: string): string {
  const trimmed = body.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n === 1 ? "taking only the first one" : `taking only number ${n}`;
  }
  if (trimmed === "last()") return "taking only the last one";
  const attrEquals = /^@([\w:-]+)\s*=\s*["'](.*)["']$/.exec(trimmed);
  if (attrEquals) return `whose ${attrEquals[1]} attribute is exactly "${attrEquals[2]}"`;
  const attrExists = /^@([\w:-]+)$/.exec(trimmed);
  if (attrExists) return `that has a ${attrExists[1]} attribute`;
  const contains = /^contains\(\s*(.+?)\s*,\s*["'](.*)["']\s*\)$/.exec(trimmed);
  if (contains) return `where ${contains[1]} contains "${contains[2]}"`;
  const textEquals = /^text\(\)\s*=\s*["'](.*)["']$/.exec(trimmed);
  if (textEquals) return `whose text is exactly "${textEquals[1]}"`;
  return `matching the condition ${trimmed}`;
}

/** Break an XPath expression into readable lines. Never throws. */
function explainXPath(expression: string): SelectorPart[] {
  const parts: SelectorPart[] = [];
  const source = expression.trim();
  let i = 0;

  if (source.startsWith("//")) {
    parts.push({ source: "//", description: "Search the whole document, at any depth." });
    i = 2;
  } else if (source.startsWith("/")) {
    parts.push({ source: "/", description: "Start at the document root." });
    i = 1;
  }

  while (i < source.length) {
    // One step runs to the next unbracketed slash.
    let j = i;
    let depth = 0;
    let quote = "";
    while (j < source.length) {
      const ch = source[j]!;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[" || ch === "(") depth += 1;
      else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === "/" && depth === 0) break;
      j += 1;
    }
    const step = source.slice(i, j);
    if (step !== "") {
      const predicates = [...step.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] ?? "");
      const head = step.replace(/\[[^\]]*\]/g, "");
      let description: string;
      if (head === "*") description = "Any element";
      else if (head === "text()") description = "The text inside it";
      else if (head === "node()") description = "Any node, element or text";
      else if (head === ".") description = "The current node";
      else if (head === "..") description = "The parent node";
      else if (head.startsWith("@")) description = `The ${head.slice(1)} attribute`;
      else if (head.includes("::")) {
        const [axis, name] = head.split("::");
        description = `Move along the ${axis} axis to ${name === "*" ? "any element" : `<${name}> elements`}`;
      } else description = `A <${head}> element`;
      const suffix = predicates.map((p) => describeXPathPredicate(p)).join(", ");
      parts.push({
        source: step,
        description: suffix ? `${description}, ${suffix}.` : `${description}.`,
      });
    }

    if (source.slice(j, j + 2) === "//") {
      parts.push({ source: "//", description: "then anywhere below it" });
      i = j + 2;
    } else if (source[j] === "/") {
      parts.push({ source: "/", description: "then a direct child" });
      i = j + 1;
    } else {
      i = j + 1;
    }
  }

  return parts;
}

/**
 * Plain English breakdown of a selector. Deliberately total: it runs on every
 * keystroke while the engine owns validity, so an unfinished selector still
 * produces a best effort list instead of an exception.
 */
export function explainSelector(selector: string, mode: SelectorMode): SelectorPart[] {
  const text = String(selector ?? "").trim();
  if (text === "") return [];
  return mode === "css" ? explainCss(text) : explainXPath(text);
}

/* ------------------------------------------------------------------ *
 * formatting                                                          *
 * ------------------------------------------------------------------ */

/** Collapse whitespace and shorten, so a match row stays on one line. */
export function preview(text: string, cap = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/** "1. <li class=\"item\">  html > body > ul > li:nth-of-type(1)  Buy milk" */
function matchLine(match: RawMatch, index: number): string {
  const head =
    match.kind === "element"
      ? `<${match.name ?? "?"}>`
      : match.kind === "attribute"
        ? `@${match.name ?? "?"}`
        : match.kind === "text"
          ? "text()"
          : "value";
  const bits = [`${index + 1}. ${head}`];
  if (match.path) bits.push(match.path);
  const body = match.kind === "element" ? (match.text ?? "") : match.markup;
  if (body.trim() !== "") bits.push(preview(body));
  return bits.join("  ");
}

/** Clamp a count option into range without ever returning NaN. */
export function clampMatches(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MAX_MATCHES;
  return Math.min(5000, Math.max(1, n));
}

/**
 * Turn the engine's matches into the labeled rows the shell and the panel
 * both show. Kept separate from `queryWith` so the formatting is testable on
 * its own with no engine at all.
 */
export function formatMatches(
  matches: RawMatch[],
  selector: string,
  mode: SelectorMode,
  opts: { showMarkup?: boolean; maxMatches?: number } = {},
): Record<string, string> {
  const cap = clampMatches(opts.maxMatches ?? DEFAULT_MAX_MATCHES);
  const shown = matches.slice(0, cap);
  const truncated = matches.length > shown.length;

  const out: Record<string, string> = {
    Mode: mode === "css" ? "CSS selector" : "XPath expression",
    Selector: selector,
    Matches:
      matches.length === 0
        ? "No matches"
        : `${matches.length} ${matches.length === 1 ? "match" : "matches"}${truncated ? `, showing the first ${shown.length}` : ""}`,
  };

  if (shown.length > 0) {
    out["Match list"] = shown.map((m, i) => matchLine(m, i)).join("\n");
    if (opts.showMarkup) {
      out.Markup = shown.map((m, i) => `${i + 1}. ${m.markup}`).join("\n");
    }
  }

  const parts = explainSelector(selector, mode);
  if (parts.length > 0) {
    out.Explanation = parts.map((p) => `${p.source}  ${p.description}`).join("\n");
  }

  return out;
}

/**
 * The whole query, from raw HTML to labeled rows, with the engine injected.
 * The panel calls this with a DOMParser backed adapter; the tests call it with
 * a fake, which is what keeps this layer pure and node testable.
 */
export function queryWith(
  html: string,
  engine: SelectorEngine,
  opts: XPathCssOpts,
): Record<string, string> {
  const text = String(html ?? "");
  const mode = parseMode(opts?.mode);
  const selector = String(opts?.selector ?? "");

  validateSelector(selector, mode);
  checkHtmlSize(text);
  if (text.trim() === "") {
    throw new ToolError(
      "empty-input",
      "No HTML to query.",
      "Paste the markup you want to test the selector against into the input box.",
    );
  }

  let matches: RawMatch[];
  try {
    matches = engine.query(text, selector, mode);
  } catch (err) {
    throw engineError(err, mode, selector);
  }

  return formatMatches(matches, selector, mode, {
    showMarkup: opts?.showMarkup === true,
    maxMatches: typeof opts?.maxMatches === "number" ? opts.maxMatches : undefined,
  });
}

/* ------------------------------------------------------------------ *
 * run                                                                 *
 * ------------------------------------------------------------------ */

/**
 * The pure surface on the tool. Real matching needs an HTML parser and an
 * XPath engine, which only exist inside a browser tab, so this function does
 * every part of the job that does not: it reads the mode, checks the selector
 * for the mistakes a parser would report as an opaque exception, and explains
 * in plain English what the selector asks for. The panel on this page runs the
 * same checks and then hands the selector to the browser's own engines through
 * `queryWith`, so the two never disagree about whether a selector is valid.
 */
export function run(input: string, opts: XPathCssOpts): Record<string, string> {
  const html = String(input ?? "");
  const mode = parseMode(opts?.mode);
  const selector = String(opts?.selector ?? "");

  validateSelector(selector, mode);
  checkHtmlSize(html);

  const parts = explainSelector(selector, mode);
  const out: Record<string, string> = {
    Mode: mode === "css" ? "CSS selector" : "XPath expression",
    Selector: selector,
    Valid: `The syntax checks pass, so ${mode === "css" ? "querySelectorAll" : "document.evaluate"} will accept this.`,
  };
  if (parts.length > 0) {
    out["In plain English"] = parts.map((p) => `${p.source}  ${p.description}`).join("\n");
  }
  out["Run it"] =
    html.trim() === ""
      ? "Paste your HTML into the panel above to see every match highlighted with its path and text."
      : `Your ${html.length.toLocaleString("en-US")} characters of HTML are matched in the panel above, which runs the browser's own parser and XPath engine in this tab.`;
  out["Why the split"] =
    "Matching needs a real HTML parser and a real XPath engine, and the good ones are the two your browser already ships. This function stays free of them so it can be tested and reused, and the panel supplies the engine.";

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, XPathCssOpts>;
