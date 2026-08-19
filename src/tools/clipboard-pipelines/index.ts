import { ToolError, type ToolLogic } from "../types";

/**
 * Clipboard Pipelines: a self-contained catalog of pure text transforms plus a
 * tiny engine that applies an ordered chain of them to one block of text.
 *
 * This is deliberately NOT the "pipelines" tool (which chains whole site tools
 * through an injected registry loader). Everything here is local, synchronous,
 * and dependency free, so a saved chain runs the instant text is pasted.
 *
 * Design notes worth knowing before adding a step:
 *
 * - Every step is pure and deterministic. No locale-sensitive collation, no
 *   clock, no randomness.
 * - Steps that cannot fail return the text unchanged rather than throwing, so a
 *   long chain is resilient to one odd input (json-pretty is the main example).
 *   Steps whose whole job is a decode (url-decode, base64-decode) do throw,
 *   because silently returning garbage there hides a real mistake.
 * - Arguments are single strings. A step that wants two values packs them into
 *   one separator based form (replace uses "find//replacement").
 */

/** One transform in the catalog. */
export interface StepDef {
  /** Stable id used in a chain string. */
  id: string;
  /** Short human label for the chain builder. */
  label: string;
  /** One line of user facing explanation, including any argument format. */
  description: string;
  /** The transform itself. Pure, synchronous, deterministic. */
  apply: (text: string, arg?: string) => string;
  /** True when the step reads `arg`. */
  hasArg?: boolean;
  /** Label for the argument field. */
  argLabel?: string;
  /** Example value for the argument field. */
  argPlaceholder?: string;
}

/** One parsed chain entry: a step id and its optional argument. */
export interface ChainStep {
  id: string;
  arg?: string;
}

export interface ClipboardPipelineOpts {
  /** Newline or comma separated tokens: `stepId` or `stepId:urlEncodedArg`. */
  chain: string;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Strip combining marks after NFD decomposition, so "café" becomes "cafe". */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

function foldDiacritics(text: string): string {
  return text.normalize("NFD").replace(COMBINING_MARKS, "");
}

/**
 * Code unit comparison of the lowercased lines, with the raw line as the tie
 * breaker. Deliberately avoids localeCompare: collation differs between
 * runtimes and ICU builds, and a saved pipeline must produce the same bytes
 * everywhere.
 */
function compareLines(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return binary;
}

function titleCaseWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Greedy word wrap of one line at `width` columns. Over-long words stand alone. */
function wrapOneLine(line: string, width: number): string {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current !== "") out.push(current);
  return out.join("\n");
}

function parseWidth(arg: string | undefined): number {
  const n = Number.parseInt((arg ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 80;
}

const HTML_ENTITIES: [RegExp, string][] = [
  [/&nbsp;/g, " "],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#0*39;/g, "'"],
  [/&apos;/g, "'"],
  // &amp; must be last so "&amp;lt;" does not become "<".
  [/&amp;/g, "&"],
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;

/* -------------------------------------------------------------------------- */
/* The catalog                                                                */
/* -------------------------------------------------------------------------- */

export const STEPS: StepDef[] = [
  {
    id: "trim",
    label: "Trim",
    description: "Removes whitespace from the start and end of the whole text.",
    apply: (text) => text.trim(),
  },
  {
    id: "collapse-whitespace",
    label: "Collapse whitespace",
    description:
      "Collapses runs of spaces and tabs inside each line to one space and trims each line. Line breaks are kept.",
    apply: (text) =>
      splitLines(text)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .join("\n"),
  },
  {
    id: "strip-blank-lines",
    label: "Strip blank lines",
    description: "Drops every line that is empty or only whitespace.",
    apply: (text) =>
      splitLines(text)
        .filter((line) => line.trim() !== "")
        .join("\n"),
  },
  {
    id: "to-lowercase",
    label: "Lowercase",
    description: "Converts the whole text to lower case.",
    apply: (text) => text.toLowerCase(),
  },
  {
    id: "to-uppercase",
    label: "Uppercase",
    description: "Converts the whole text to upper case.",
    apply: (text) => text.toUpperCase(),
  },
  {
    id: "title-case",
    label: "Title case",
    description: "Capitalizes the first letter of every word and lowercases the rest.",
    apply: (text) => text.replace(/\S+/g, titleCaseWord),
  },
  {
    id: "remove-diacritics",
    label: "Remove diacritics",
    description: 'Folds accented letters to their plain ASCII base, so "café" becomes "cafe".',
    apply: (text) => foldDiacritics(text),
  },
  {
    id: "sort-lines-az",
    label: "Sort lines A to Z",
    description: "Sorts lines ascending, ignoring case, with an exact tie breaker.",
    apply: (text) => splitLines(text).sort(compareLines).join("\n"),
  },
  {
    id: "sort-lines-za",
    label: "Sort lines Z to A",
    description: "Sorts lines descending, ignoring case, with an exact tie breaker.",
    apply: (text) =>
      splitLines(text)
        .sort((a, b) => compareLines(b, a))
        .join("\n"),
  },
  {
    id: "reverse-lines",
    label: "Reverse line order",
    description: "Puts the last line first and the first line last.",
    apply: (text) => splitLines(text).reverse().join("\n"),
  },
  {
    id: "dedupe-lines",
    label: "Remove duplicate lines",
    description: "Keeps the first occurrence of each exact line and drops later repeats.",
    apply: (text) => dedupe(splitLines(text)).join("\n"),
  },
  {
    id: "number-lines",
    label: "Number lines",
    description: 'Prefixes every line with its position, as "1. line".',
    apply: (text) =>
      splitLines(text)
        .map((line, i) => `${i + 1}. ${line}`)
        .join("\n"),
  },
  {
    id: "strip-html-tags",
    label: "Strip HTML tags",
    description: "Removes every angle bracket tag and decodes the common HTML entities.",
    apply: (text) => {
      let out = text.replace(/<[^>]*>/g, "");
      for (const [pattern, replacement] of HTML_ENTITIES) out = out.replace(pattern, replacement);
      return out;
    },
  },
  {
    id: "url-encode",
    label: "URL encode",
    description: "Percent encodes the text the way encodeURIComponent does.",
    apply: (text) => encodeURIComponent(text),
  },
  {
    id: "url-decode",
    label: "URL decode",
    description: "Decodes percent escapes. Fails loudly on a malformed escape like a bare %.",
    apply: (text) => {
      try {
        return decodeURIComponent(text);
      } catch {
        throw new ToolError(
          "invalid-url-encoding",
          "The text is not valid percent encoded data.",
          "Check for a bare % that is not followed by two hex digits.",
        );
      }
    },
  },
  {
    id: "base64-encode",
    label: "Base64 encode",
    description: "Encodes the text as standard base64, using UTF-8 bytes.",
    apply: (text) => btoa(bytesToBinary(new TextEncoder().encode(text))),
  },
  {
    id: "base64-decode",
    label: "Base64 decode",
    description:
      "Decodes standard or URL safe base64 back to UTF-8 text. Fails loudly on invalid base64.",
    apply: (text) => {
      const cleaned = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
      if (cleaned === "") return "";
      const badBase64 = new ToolError(
        "invalid-base64",
        "The text is not valid base64.",
        "Base64 uses A-Z, a-z, 0-9, + and / with optional = padding.",
      );
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) throw badBase64;
      let binary: string;
      try {
        binary = atob(cleaned);
      } catch {
        throw badBase64;
      }
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    },
  },
  {
    id: "escape-json-string",
    label: "Escape as JSON string",
    description:
      "Escapes quotes, backslashes, and newlines and wraps the result in double quotes, ready to paste as a JSON value.",
    apply: (text) => JSON.stringify(text),
  },
  {
    id: "slugify",
    label: "Slugify",
    description:
      "Turns each line into a URL slug: lower case, accents folded, everything else joined with hyphens.",
    apply: (text) =>
      splitLines(text)
        .map((line) =>
          foldDiacritics(line)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, ""),
        )
        .join("\n"),
  },
  {
    id: "wrap-lines",
    label: "Wrap lines",
    description: "Word wraps each line at the given width. Defaults to 80 columns.",
    hasArg: true,
    argLabel: "Width",
    argPlaceholder: "80",
    apply: (text, arg) => {
      const width = parseWidth(arg);
      return splitLines(text)
        .map((line) => wrapOneLine(line, width))
        .join("\n");
    },
  },
  {
    id: "prefix-lines",
    label: "Prefix lines",
    description: 'Adds the given text to the start of every line, for example "> " to quote.',
    hasArg: true,
    argLabel: "Prefix",
    argPlaceholder: "> ",
    apply: (text, arg) =>
      splitLines(text)
        .map((line) => `${arg ?? ""}${line}`)
        .join("\n"),
  },
  {
    id: "suffix-lines",
    label: "Suffix lines",
    description: 'Adds the given text to the end of every line, for example "," to build a list.',
    hasArg: true,
    argLabel: "Suffix",
    argPlaceholder: ",",
    apply: (text, arg) =>
      splitLines(text)
        .map((line) => `${line}${arg ?? ""}`)
        .join("\n"),
  },
  {
    id: "replace",
    label: "Find and replace",
    description:
      'Replaces every occurrence of plain text. Write the argument as "find//replacement"; with no //, the text is deleted.',
    hasArg: true,
    argLabel: "find//replacement",
    argPlaceholder: "foo//bar",
    apply: (text, arg) => {
      const spec = arg ?? "";
      const at = spec.indexOf("//");
      const find = at === -1 ? spec : spec.slice(0, at);
      const replacement = at === -1 ? "" : spec.slice(at + 2);
      if (find === "") return text;
      return text.split(find).join(replacement);
    },
  },
  {
    id: "extract-emails",
    label: "Extract email addresses",
    description: "Keeps only the email addresses found in the text, one per line, deduplicated.",
    apply: (text) => dedupe(text.match(EMAIL_RE) ?? []).join("\n"),
  },
  {
    id: "extract-urls",
    label: "Extract URLs",
    description:
      "Keeps only the http and https links found in the text, one per line, deduplicated.",
    apply: (text) =>
      dedupe((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""))).join("\n"),
  },
  {
    id: "json-pretty",
    label: "Pretty print JSON",
    description:
      "Reformats valid JSON with two space indentation. Text that is not JSON passes through unchanged so the rest of the chain still runs.",
    apply: (text) => {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return text;
      }
    },
  },
  {
    id: "count-report",
    label: "Count report",
    description: "Replaces the text with a character, word, and line count.",
    apply: (text) => {
      const chars = text.length;
      const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
      const lines = text === "" ? 0 : splitLines(text).length;
      return `chars: ${chars}\nwords: ${words}\nlines: ${lines}`;
    },
  },
];

const STEP_BY_ID = new Map<string, StepDef>(STEPS.map((s) => [s.id, s]));

/** Look up one step by id. Returns undefined for an unknown id. */
export function findStep(id: string): StepDef | undefined {
  return STEP_BY_ID.get(id);
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

export interface Preset {
  id: string;
  label: string;
  chain: string;
}

export const PRESETS: Preset[] = [
  {
    id: "clean-paste",
    label: "Clean paste",
    chain: "trim,collapse-whitespace,strip-blank-lines",
  },
  {
    id: "markdown-slug",
    label: "Markdown slug",
    chain: "to-lowercase,slugify",
  },
  {
    id: "sort-dedupe",
    label: "Sort and dedupe",
    chain: "sort-lines-az,dedupe-lines",
  },
  {
    id: "quote-for-email",
    label: "Quote for email",
    chain: "trim,collapse-whitespace,prefix-lines:%3E%20",
  },
  {
    id: "html-to-text",
    label: "HTML to plain text",
    chain: "strip-html-tags,collapse-whitespace,strip-blank-lines",
  },
  {
    id: "harvest-links",
    label: "Harvest links",
    chain: "extract-urls,dedupe-lines,sort-lines-az",
  },
];

/* -------------------------------------------------------------------------- */
/* The engine                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse a chain string into ordered steps.
 *
 * Tokens are separated by newlines or commas. Each token is `stepId` or
 * `stepId:arg`, split on the FIRST colon so an argument may contain colons.
 * Arguments are URL decoded, which is how a comma, a newline, or a leading
 * space survives the token format. A malformed escape is kept verbatim rather
 * than failing the whole chain.
 */
export function parseChain(chain: string): ChainStep[] {
  return (chain ?? "")
    .split(/[\n,]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .map((token) => {
      const at = token.indexOf(":");
      if (at === -1) return { id: token };
      const id = token.slice(0, at).trim();
      const raw = token.slice(at + 1);
      let arg: string;
      try {
        arg = decodeURIComponent(raw);
      } catch {
        arg = raw;
      }
      return { id, arg };
    });
}

/**
 * Apply an ordered list of steps to text. This is the single execution path:
 * `run` parses a chain string and calls straight into it, and a chain builder
 * panel can hand structured steps in without stringifying them first.
 */
export function applyChain(text: string, steps: ChainStep[]): string {
  if (!steps || steps.length === 0)
    throw new ToolError(
      "empty-chain",
      "Add at least one transform to the pipeline.",
      "Pick transforms to build a chain.",
    );

  for (const step of steps) {
    if (!STEP_BY_ID.has(step.id))
      throw new ToolError(
        "unknown-step",
        `No transform named "${step.id}".`,
        "Remove it from the chain or check the id.",
      );
  }

  let out = text ?? "";
  for (const step of steps) {
    out = STEP_BY_ID.get(step.id)!.apply(out, step.arg);
  }
  return out;
}

/**
 * Run a saved pipeline over pasted text.
 *
 * Empty input is not an error: most transforms are meaningful on an empty
 * string, and a pipeline that runs on paste should never blow up just because
 * the clipboard was empty.
 */
export function run(input: string, opts: ClipboardPipelineOpts): string {
  const chain = typeof opts?.chain === "string" ? opts.chain : "";
  return applyChain(input ?? "", parseChain(chain));
}

export default { run } satisfies ToolLogic<string, string, ClipboardPipelineOpts>;
