import { ToolError, type ToolLogic } from "../types";

/**
 * Regex tester logic.
 *
 * Three separable jobs live here, and the bespoke panel uses all three:
 *
 *  1. `findMatches` enumerates matches with their offsets and capture groups,
 *     which is what the panel needs to paint highlights over the test text.
 *  2. `explainPattern` walks the pattern source and turns it into a readable
 *     list of what each piece does. It never throws: an explanation of a
 *     half typed pattern is still useful, and `buildRegex` is the validator.
 *  3. `applyReplacement` runs the replacement string through the engine so the
 *     preview uses the same $1 and $<name> rules the user's own code will.
 *
 * Two hard caps keep a pathological pattern from locking the tab. The test
 * text is capped at 100 KB and enumeration stops at 5,000 matches. Neither is
 * a defense against catastrophic backtracking in the general case, which is
 * why the FAQ says so plainly rather than promising a guarantee.
 */

/** Test text longer than this is refused, so one paste cannot lock the tab. */
export const MAX_TEST_TEXT = 100_000;

/** Enumeration stops here and reports the result as truncated. */
export const MAX_MATCHES = 5_000;

/** Every flag the JavaScript RegExp constructor accepts, with what it does. */
export const FLAG_MEANINGS: Record<string, string> = {
  d: "record the start and end offset of every capture group",
  g: "find every match, not just the first",
  i: "ignore case",
  m: "^ and $ match at line breaks, not only at the ends of the text",
  s: "the dot also matches a line break",
  u: "treat the pattern as Unicode code points",
  v: "Unicode sets mode, an extended form of the u flag",
  y: "match only at the position where the last match ended",
};

export interface RegexTesterOpts {
  /** The pattern source, without the surrounding slashes. */
  pattern?: string;
  /** Flag letters, for example "gi". */
  flags?: string;
  /** Replacement template using $1, $<name>, $&, $` and $'. */
  replacement?: string;
  [key: string]: unknown;
}

/** One capture group inside one match. */
export interface CaptureGroup {
  /** 1-based group number. */
  number: number;
  /** The (?<name>) name, or null for a plain numbered group. */
  name: string | null;
  /** The captured text, or undefined when the group did not participate. */
  value: string | undefined;
}

/** One match, with everything the panel needs to highlight and list it. */
export interface RegexMatch {
  /** 1-based position in the result list. */
  number: number;
  /** Offset of the first character of the match. */
  start: number;
  /** Offset one past the last character of the match. */
  end: number;
  /** The matched text. */
  value: string;
  groups: CaptureGroup[];
}

export interface MatchSet {
  matches: RegexMatch[];
  /** True when enumeration stopped at MAX_MATCHES. */
  truncated: boolean;
  /** True when the regex scans the whole text (the g or y flag). */
  repeats: boolean;
}

/* ------------------------------------------------------------------ *
 * building the regex                                                  *
 * ------------------------------------------------------------------ */

/** Flag letters this engine understands, used for a friendlier error. */
const KNOWN_FLAGS = "dgimsuvy";

/**
 * Build the RegExp, turning the engine's SyntaxError into a ToolError that
 * says which half of the input is wrong. Flags are checked first because a
 * stray flag letter produces a message about flags that reads as a pattern
 * problem otherwise.
 */
export function buildRegex(pattern: string, flags: string): RegExp {
  const source = pattern ?? "";
  if (source === "") {
    throw new ToolError(
      "empty-pattern",
      "No pattern to test.",
      "Type a pattern in the box above, for example \\b\\w+@\\w+\\.\\w+\\b for an email address.",
    );
  }

  const flagList = (flags ?? "").split("");
  const unknown = flagList.filter((f) => !KNOWN_FLAGS.includes(f));
  if (unknown.length > 0) {
    throw new ToolError(
      "bad-flags",
      `"${unknown.join("")}" is not a JavaScript regex flag.`,
      `The flags are ${KNOWN_FLAGS.split("").join(", ")}. Remove anything else.`,
    );
  }
  const duplicate = flagList.find((f, i) => flagList.indexOf(f) !== i);
  if (duplicate) {
    throw new ToolError(
      "bad-flags",
      `The flag "${duplicate}" is listed twice.`,
      "Each flag letter may appear only once.",
    );
  }
  if (flagList.includes("u") && flagList.includes("v")) {
    throw new ToolError(
      "bad-flags",
      "The u and v flags cannot be used together.",
      "Keep u for Unicode mode, or v for Unicode sets mode, but not both.",
    );
  }

  try {
    return new RegExp(source, flags ?? "");
  } catch (err) {
    const detail =
      err instanceof Error
        ? err.message.replace(/^Invalid regular expression:\s*/, "")
        : String(err);
    throw new ToolError(
      "bad-pattern",
      `That pattern is not valid: ${detail}`,
      "Check for an unclosed bracket, parenthesis or brace, and remember that a literal ( [ { or / has to be escaped with a backslash.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * capture group names                                                 *
 * ------------------------------------------------------------------ */

/**
 * Group names in group-number order, so `names[0]` belongs to group 1.
 *
 * The RegExp object exposes named groups only through a match's `groups`
 * object, which says nothing about which number a name belongs to, so the
 * source is scanned instead. The scan skips escapes and character class
 * bodies, which is enough to never mistake a bracketed "(" for a group.
 */
export function captureGroupNames(pattern: string): (string | null)[] {
  const names: (string | null)[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch !== "(") continue;
    if (pattern[i + 1] !== "?") {
      names.push(null);
      continue;
    }
    const named = /^\(\?<([^>=!][^>]*)>/.exec(pattern.slice(i));
    if (named) names.push(named[1]!);
    // Every other (? form is non-capturing, so it adds no group number.
  }
  return names;
}

/* ------------------------------------------------------------------ *
 * matching                                                            *
 * ------------------------------------------------------------------ */

/** Reject a test text too large to scan comfortably. */
function checkTextSize(text: string): void {
  if (text.length > MAX_TEST_TEXT) {
    throw new ToolError(
      "input-too-large",
      `The test text is ${text.length.toLocaleString("en-US")} characters, over the ${MAX_TEST_TEXT.toLocaleString("en-US")} character limit.`,
      "Trim the text to the part you actually want to test. The limit exists so a slow pattern cannot lock up the tab.",
    );
  }
}

/**
 * Enumerate matches. A zero length match would otherwise spin forever on a
 * pattern like `a*`, so `lastIndex` is nudged forward by hand whenever the
 * engine reports an empty match, exactly as a hand written scanner has to.
 */
export function findMatches(regex: RegExp, text: string): MatchSet {
  checkTextSize(text);

  const names = captureGroupNames(regex.source);
  const repeats = regex.global || regex.sticky;
  const scanner = new RegExp(
    regex.source,
    regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
  );
  const matches: RegexMatch[] = [];
  let truncated = false;

  scanner.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = scanner.exec(text)) !== null) {
    const value = hit[0];
    matches.push({
      number: matches.length + 1,
      start: hit.index,
      end: hit.index + value.length,
      value,
      groups: names.map((name, i) => ({
        number: i + 1,
        name,
        value: hit![i + 1],
      })),
    });

    if (value === "") scanner.lastIndex += 1;
    if (!repeats) break;
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    if (scanner.lastIndex > text.length) break;
  }

  return { matches, truncated, repeats };
}

/**
 * Run the replacement through the engine so $1, $<name>, $&, $` and $' behave
 * exactly as they do in the user's own `String.replace` call. Without the g
 * flag only the first match is replaced, which is the real behavior and worth
 * seeing rather than papering over.
 */
export function applyReplacement(regex: RegExp, text: string, replacement: string): string {
  checkTextSize(text);
  const runner = new RegExp(regex.source, regex.flags);
  runner.lastIndex = 0;
  return text.replace(runner, replacement);
}

/* ------------------------------------------------------------------ *
 * the explainer                                                       *
 * ------------------------------------------------------------------ */

/** One line of the plain English breakdown. */
export interface RegexToken {
  /** The exact source text this line describes. */
  source: string;
  /** What that piece of the pattern does. */
  description: string;
  /** Group nesting depth, so the panel can indent the body of a group. */
  depth: number;
}

const ESCAPE_MEANINGS: Record<string, string> = {
  d: "any digit, 0 to 9",
  D: "any character that is not a digit",
  w: "any word character: a letter, a digit or an underscore",
  W: "any character that is not a letter, digit or underscore",
  s: "any whitespace: a space, tab, line break or similar",
  S: "any character that is not whitespace",
  b: "a word boundary, the edge between a word character and anything else",
  B: "a position that is not a word boundary",
  n: "a line feed",
  r: "a carriage return",
  t: "a tab",
  f: "a form feed",
  v: "a vertical tab",
  "0": "a null character",
};

/** Describe one character class body, for example the "a-z0-9_" of [a-z0-9_]. */
function describeClassBody(body: string): string {
  const parts: string[] = [];
  const literals: string[] = [];
  const flushLiterals = () => {
    if (literals.length === 0) return;
    parts.push(literals.map((c) => `"${c}"`).join(", "));
    literals.length = 0;
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === "\\") {
      const next = body[i + 1];
      if (next !== undefined) {
        flushLiterals();
        parts.push(ESCAPE_MEANINGS[next] ?? `the literal "${next}"`);
        i += 1;
        continue;
      }
    }
    if (body[i + 1] === "-" && i + 2 < body.length && body[i + 2] !== "]") {
      flushLiterals();
      parts.push(`any character from "${ch}" to "${body[i + 2]}"`);
      i += 2;
      continue;
    }
    literals.push(ch);
  }
  flushLiterals();

  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/** Turn a quantifier into words: "one or more times", "2 to 4 times". */
function describeQuantifier(source: string): string {
  const lazy = source.endsWith("?") && source.length > 1;
  const core = lazy ? source.slice(0, -1) : source;
  let count: string;
  if (core === "*") count = "zero or more times";
  else if (core === "+") count = "one or more times";
  else if (core === "?") count = "zero times or once";
  else {
    const range = /^\{(\d*)(,?)(\d*)\}$/.exec(core);
    const min = range?.[1] ?? "";
    const comma = range?.[2] ?? "";
    const max = range?.[3] ?? "";
    if (comma === "") count = `exactly ${min} times`;
    else if (max === "") count = `${min} or more times`;
    else count = `${min} to ${max} times`;
  }
  const greed = lazy
    ? "as few as possible (lazy)"
    : core === "?"
      ? "preferring once (greedy)"
      : "as many as possible (greedy)";
  return `Repeat the item before it ${count}, ${greed}.`;
}

/** Read a quantifier starting at `i`, or return null when there is none. */
function readQuantifier(pattern: string, i: number): string | null {
  const ch = pattern[i];
  if (ch === "*" || ch === "+" || ch === "?") {
    return pattern[i + 1] === "?" ? `${ch}?` : ch;
  }
  if (ch !== "{") return null;
  const brace = /^\{\d+(,\d*)?\}\??/.exec(pattern.slice(i));
  return brace ? brace[0] : null;
}

/**
 * Tokenize a pattern into readable lines. Deliberately total: an unfinished or
 * invalid pattern still produces a best effort list, because the explanation
 * panel updates on every keystroke while `buildRegex` owns validity.
 */
export function explainPattern(pattern: string): RegexToken[] {
  const tokens: RegexToken[] = [];
  const source = pattern ?? "";
  let depth = 0;
  let groupNumber = 0;
  let literal = "";

  const flushLiteral = () => {
    if (literal === "") return;
    tokens.push({
      source: literal,
      description:
        literal.length === 1 ? `The character "${literal}".` : `The literal text "${literal}".`,
      depth,
    });
    literal = "";
  };

  const push = (text: string, description: string, at = depth) => {
    flushLiteral();
    tokens.push({ source: text, description, depth: at });
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;

    const quantifier = readQuantifier(source, i);
    if (quantifier && (literal !== "" || tokens.length > 0)) {
      // A quantifier binds to one character, so a literal run has to be split:
      // in "abc+" the plus repeats only the "c".
      if (literal.length > 1) {
        const last = literal.slice(-1);
        literal = literal.slice(0, -1);
        flushLiteral();
        literal = last;
      }
      flushLiteral();
      tokens.push({ source: quantifier, description: describeQuantifier(quantifier), depth });
      i += quantifier.length - 1;
      continue;
    }

    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) {
        push("\\", "A trailing backslash, which is not a complete escape.");
        continue;
      }
      const unicodeProp = /^\\([pP])\{([^}]*)\}/.exec(source.slice(i));
      if (unicodeProp) {
        push(
          unicodeProp[0],
          unicodeProp[1] === "p"
            ? `Any character with the Unicode property ${unicodeProp[2]}. Needs the u or v flag.`
            : `Any character without the Unicode property ${unicodeProp[2]}. Needs the u or v flag.`,
        );
        i += unicodeProp[0].length - 1;
        continue;
      }
      const backref = /^\\k<([^>]*)>/.exec(source.slice(i));
      if (backref) {
        push(backref[0], `The same text that the group named "${backref[1]}" captured.`);
        i += backref[0].length - 1;
        continue;
      }
      const hex = /^\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4})/.exec(source.slice(i));
      if (hex) {
        push(hex[0], `The character with the code point written as ${hex[1]}.`);
        i += hex[0].length - 1;
        continue;
      }
      if (/^[1-9]$/.test(next)) {
        push(`\\${next}`, `The same text that capture group ${next} matched.`);
        i += 1;
        continue;
      }
      push(`\\${next}`, `Matches ${ESCAPE_MEANINGS[next] ?? `the literal "${next}"`}.`);
      i += 1;
      continue;
    }

    if (ch === "[") {
      const negated = source[i + 1] === "^";
      let j = i + 1 + (negated ? 1 : 0);
      if (source[j] === "]") j += 1;
      while (j < source.length && source[j] !== "]") {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      const whole = source.slice(i, Math.min(j + 1, source.length));
      const body = source.slice(i + 1 + (negated ? 1 : 0), j);
      push(
        whole,
        negated
          ? `Any single character that is NOT ${describeClassBody(body)}.`
          : `Any single character that is ${describeClassBody(body)}.`,
      );
      i = j;
      continue;
    }

    if (ch === "(") {
      const rest = source.slice(i);
      let opener = "(";
      let description: string;
      const named = /^\(\?<([^>=!][^>]*)>/.exec(rest);
      if (named) {
        groupNumber += 1;
        opener = named[0];
        description = `Start of capture group ${groupNumber}, named "${named[1]}".`;
      } else if (rest.startsWith("(?:")) {
        opener = "(?:";
        description = "Start of a group that is only for grouping, so it captures nothing.";
      } else if (rest.startsWith("(?=")) {
        opener = "(?=";
        description = "Start of a lookahead: what follows must match next, but is not consumed.";
      } else if (rest.startsWith("(?!")) {
        opener = "(?!";
        description = "Start of a negative lookahead: what follows must NOT match next.";
      } else if (rest.startsWith("(?<=")) {
        opener = "(?<=";
        description = "Start of a lookbehind: what follows must match just before this point.";
      } else if (rest.startsWith("(?<!")) {
        opener = "(?<!";
        description =
          "Start of a negative lookbehind: what follows must NOT match just before this point.";
      } else {
        groupNumber += 1;
        description = `Start of capture group ${groupNumber}.`;
      }
      push(opener, description);
      depth += 1;
      i += opener.length - 1;
      continue;
    }

    if (ch === ")") {
      flushLiteral();
      depth = Math.max(0, depth - 1);
      tokens.push({ source: ")", description: "End of the group.", depth });
      continue;
    }

    if (ch === "|") {
      push("|", "Or: either the part before this or the part after it.");
      continue;
    }
    if (ch === "^") {
      push("^", "Start of the text, or start of a line when the m flag is on.");
      continue;
    }
    if (ch === "$") {
      push("$", "End of the text, or end of a line when the m flag is on.");
      continue;
    }
    if (ch === ".") {
      push(".", "Any single character except a line break, unless the s flag is on.");
      continue;
    }

    literal += ch;
  }
  flushLiteral();

  return tokens;
}

/** One row of the cheat sheet the panel renders. */
export interface CheatSheetEntry {
  token: string;
  meaning: string;
}

/** A cheat sheet section, grouped so the panel can lay it out in columns. */
export interface CheatSheetSection {
  title: string;
  entries: CheatSheetEntry[];
}

/** The reference table shown under the tester. Static, so it stays here. */
export const CHEAT_SHEET: CheatSheetSection[] = [
  {
    title: "Characters",
    entries: [
      { token: ".", meaning: "Any character except a line break" },
      { token: "\\d", meaning: "A digit, 0 to 9" },
      { token: "\\D", meaning: "Anything that is not a digit" },
      { token: "\\w", meaning: "A letter, digit or underscore" },
      { token: "\\W", meaning: "Anything that is not a word character" },
      { token: "\\s", meaning: "Whitespace: space, tab, line break" },
      { token: "\\S", meaning: "Anything that is not whitespace" },
      { token: "\\uFFFF", meaning: "A character by its code point" },
    ],
  },
  {
    title: "Sets and groups",
    entries: [
      { token: "[abc]", meaning: "Any one of a, b or c" },
      { token: "[^abc]", meaning: "Any character except a, b or c" },
      { token: "[a-z]", meaning: "Any character in the range a to z" },
      { token: "(...)", meaning: "A numbered capture group" },
      { token: "(?<name>...)", meaning: "A named capture group" },
      { token: "(?:...)", meaning: "Group without capturing" },
      { token: "a|b", meaning: "Either a or b" },
      { token: "\\1", meaning: "The text group 1 already matched" },
    ],
  },
  {
    title: "Repetition",
    entries: [
      { token: "*", meaning: "Zero or more" },
      { token: "+", meaning: "One or more" },
      { token: "?", meaning: "Zero or one" },
      { token: "{3}", meaning: "Exactly three" },
      { token: "{2,}", meaning: "Two or more" },
      { token: "{2,5}", meaning: "Between two and five" },
      { token: "*?", meaning: "Lazy: as few as possible" },
    ],
  },
  {
    title: "Anchors and lookaround",
    entries: [
      { token: "^", meaning: "Start of the text or line" },
      { token: "$", meaning: "End of the text or line" },
      { token: "\\b", meaning: "A word boundary" },
      { token: "\\B", meaning: "Not a word boundary" },
      { token: "(?=...)", meaning: "Lookahead: must follow" },
      { token: "(?!...)", meaning: "Negative lookahead: must not follow" },
      { token: "(?<=...)", meaning: "Lookbehind: must precede" },
      { token: "(?<!...)", meaning: "Negative lookbehind: must not precede" },
    ],
  },
  {
    title: "Replacement",
    entries: [
      { token: "$1", meaning: "Capture group 1" },
      { token: "$<name>", meaning: "A named capture group" },
      { token: "$&", meaning: "The whole match" },
      { token: "$`", meaning: "The text before the match" },
      { token: "$'", meaning: "The text after the match" },
      { token: "$$", meaning: "A literal dollar sign" },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * run                                                                 *
 * ------------------------------------------------------------------ */

/** Show a control character as an escape so a match list stays on one line. */
function showable(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** "1=\"foo\", name=\"bar\"", or an empty string when a match has no groups. */
function groupSummary(match: RegexMatch): string {
  return match.groups
    .filter((g) => g.value !== undefined)
    .map((g) => `${g.name ?? g.number}="${showable(g.value!)}"`)
    .join(", ");
}

/** Flags spelled out: "g (find every match), i (ignore case)". */
export function describeFlags(flags: string): string {
  if (!flags) return "none";
  return flags
    .split("")
    .map((f) => `${f} (${FLAG_MEANINGS[f] ?? "unknown flag"})`)
    .join(", ");
}

/**
 * The generic surface on the tool: pattern plus flags against the pasted test
 * text, reported as labeled rows. The page uses a bespoke panel that paints
 * the same matches over the text itself, and both call the functions above,
 * so the two can never disagree about what matched.
 */
export function run(input: string, opts: RegexTesterOpts): Record<string, string> {
  const text = String(input ?? "");
  const pattern = String(opts?.pattern ?? "");
  const flags = String(opts?.flags ?? "g");
  const replacement = String(opts?.replacement ?? "");

  const regex = buildRegex(pattern, flags);

  if (text === "") {
    throw new ToolError(
      "empty-input",
      "No test text to match against.",
      "Paste the text you want to search into the input box. The pattern goes in the Pattern option.",
    );
  }

  const { matches, truncated } = findMatches(regex, text);
  const tokens = explainPattern(pattern);

  const out: Record<string, string> = {
    Pattern: `/${pattern}/${flags}`,
    Flags: describeFlags(flags),
    Matches:
      matches.length === 0
        ? "No matches"
        : `${matches.length} ${matches.length === 1 ? "match" : "matches"}${truncated ? ` (stopped at the ${MAX_MATCHES.toLocaleString("en-US")} match limit)` : ""}`,
  };

  if (matches.length > 0) {
    out["Match list"] = matches
      .map((m) => {
        const groups = groupSummary(m);
        return `${m.number}. [${m.start}-${m.end}] "${showable(m.value)}"${groups ? `  ${groups}` : ""}`;
      })
      .join("\n");
  }

  out.Explanation = tokens
    .map((t) => `${"  ".repeat(t.depth)}${t.source}  ${t.description}`)
    .join("\n");

  if (replacement !== "") {
    out["Replace preview"] = applyReplacement(regex, text, replacement);
  }

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, RegexTesterOpts>;
