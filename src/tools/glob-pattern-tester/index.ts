import { ToolError, type ToolLogic } from "../types";

/**
 * A hand rolled glob engine. Every pattern is compiled to a real RegExp, so the
 * "Regex" output row is the exact thing that decided each verdict rather than a
 * separate explanation that could drift from the matcher.
 */

// The semantics, fixed here because implementations disagree. Examples are in
// line comments because a glob such as a/**/b would close a block comment.
//
// * matches any run of characters inside one path segment, never a slash.
// ** is a globstar only when it is a whole segment: a/**/b matches a/b with zero
//    segments between, as well as a/x/b and a/x/y/b.
// A trailing globstar matches everything below the prefix but not the prefix
//    itself, so a/** matches a/x and a/x/y but not a.
// ? matches exactly one character, never a slash.
// Classes never match a slash, including the negated forms [!abc] and [^abc].
// A leading dot in a path segment is hidden from wildcards unless the pattern
//    spells the dot out or the dot option is on.

export interface GlobPatternTesterOpts {
  /** The glob pattern. Several patterns, one per line, are allowed. */
  pattern?: string;
  /** Let wildcards match a leading dot in a path segment. */
  dot?: boolean;
  /** Compare with case. Off compiles the pattern with the i flag. */
  caseSensitive?: boolean;
  /** A pattern with no slash matches the file name at any depth. */
  matchBase?: boolean;
  [key: string]: unknown;
}

export type GlobPatternTesterResult = Record<string, string>;

/** Guard rails so a huge paste or a brace bomb cannot hang the tab. */
const MAX_PATHS = 20000;
const MAX_EXPANSIONS = 10000;

/** Regex metacharacters, minus the slash, which stays bare so the Regex row reads well. */
const SPECIAL = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function escapeLiteral(ch: string): string {
  return SPECIAL.has(ch) ? `\\${ch}` : ch;
}

/** Escape one character so it stays literal inside a character class. */
function escapeClassChar(ch: string): string {
  return "^]\\-[".includes(ch) ? `\\${ch}` : ch;
}

function trailingBackslash(): ToolError {
  return new ToolError(
    "trailing-backslash",
    "The pattern ends with a lone backslash, so there is nothing for it to escape.",
    "Drop the last backslash, or double it to mean a literal backslash.",
  );
}

/**
 * Split a pattern on unescaped slashes. An escaped slash stays inside its
 * segment and later compiles to a literal slash.
 */
function splitSegments(pattern: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      if (i + 1 >= pattern.length) throw trailingBackslash();
      current += ch + pattern.charAt(i + 1);
      i++;
      continue;
    }
    if (ch === "/") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

interface CompiledClass {
  source: string;
  next: number;
}

/**
 * Compile [abc], [a-z], [!abc], or [^abc] starting at `start`, which points at
 * the opening bracket. A closing bracket in first position is a literal, the way
 * a shell reads it. Negated classes exclude the slash explicitly; positive
 * classes drop a bare slash, so no class can swallow a separator.
 */
function compileClass(segment: string, start: number): CompiledClass {
  let i = start + 1;
  let negated = false;
  const lead = segment.charAt(i);
  if (lead === "!" || lead === "^") {
    negated = true;
    i++;
  }
  let body = "";
  let first = true;
  let closed = -1;
  while (i < segment.length) {
    const ch = segment.charAt(i);
    if (ch === "]" && !first) {
      closed = i;
      break;
    }
    if (ch === "\\") {
      if (i + 1 >= segment.length) throw trailingBackslash();
      body += escapeClassChar(segment.charAt(i + 1));
      i += 2;
      first = false;
      continue;
    }
    if (ch === "/" && !negated) {
      i++;
      first = false;
      continue;
    }
    // A hyphen is left bare so ranges keep working; everything else that would
    // change the meaning of the class is escaped. A closing bracket only reaches
    // this branch in first position, where the shell reads it as a literal.
    body += ch === "^" || ch === "[" || ch === "]" ? `\\${ch}` : ch;
    i++;
    first = false;
  }
  if (closed === -1) {
    throw new ToolError(
      "unterminated-class",
      "A character class opened with [ but never closed.",
      "Add the closing bracket, or escape the opening one for a literal bracket.",
    );
  }
  return { source: negated ? `[^/${body}]` : `[${body}]`, next: closed + 1 };
}

/**
 * Compile one path segment (no unescaped slashes) to a regex fragment. When
 * dotfiles are hidden and the segment opens with a wildcard, the fragment gets a
 * lookahead so it cannot match a leading dot.
 */
function compileSegment(segment: string, dot: boolean): string {
  let body = "";
  let i = 0;
  let opensWithWildcard = false;
  while (i < segment.length) {
    const ch = segment.charAt(i);
    const atStart = i === 0;
    if (ch === "\\") {
      if (i + 1 >= segment.length) throw trailingBackslash();
      body += escapeLiteral(segment.charAt(i + 1));
      i += 2;
      continue;
    }
    if (ch === "*") {
      // A run of stars inside a segment is just one star; a whole segment of two
      // stars was already handled by the caller as a globstar.
      while (segment.charAt(i) === "*") i++;
      body += "[^/]*";
      if (atStart) opensWithWildcard = true;
      continue;
    }
    if (ch === "?") {
      body += "[^/]";
      if (atStart) opensWithWildcard = true;
      i++;
      continue;
    }
    if (ch === "[") {
      const cls = compileClass(segment, i);
      body += cls.source;
      if (atStart) opensWithWildcard = true;
      i = cls.next;
      continue;
    }
    body += escapeLiteral(ch);
    i++;
  }
  return !dot && opensWithWildcard ? `(?!\\.)${body}` : body;
}

/** Compile a whole brace free pattern to an unanchored regex source. */
function compileBody(pattern: string, dot: boolean): string {
  const segments = splitSegments(pattern);
  const seg = dot ? "[^/]*" : "(?!\\.)[^/]*";
  let source = "";
  let needSeparator = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const last = i === segments.length - 1;
    if (segment === "**") {
      if (last) {
        // Everything below, at least one segment deep.
        source += needSeparator ? `/${seg}(?:/${seg})*` : `${seg}(?:/${seg})*`;
      } else {
        // Zero or more segments, separator included, so "a/**/b" matches "a/b".
        source += needSeparator ? `(?:/${seg})*/` : `(?:${seg}/)*`;
      }
      needSeparator = false;
      continue;
    }
    if (needSeparator) source += "/";
    source += compileSegment(segment, dot);
    needSeparator = true;
  }
  return source;
}

/** Does this pattern contain a slash that is not escaped? */
function hasSlash(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "/") return true;
  }
  return false;
}

interface BraceGroup {
  start: number;
  end: number;
  alternatives: string[];
}

/**
 * Find the first brace group worth expanding. A brace pair with no top level
 * comma stays literal, the way a shell treats a lone {a}. An opening brace that
 * lists alternatives but never closes is a typo, so it raises an error instead
 * of quietly matching a literal brace.
 */
function findBraceGroup(pattern: string): BraceGroup | null {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch !== "{") continue;

    const alternatives: string[] = [];
    let current = "";
    let depth = 0;
    let sawComma = false;
    let closed = -1;
    for (let j = i + 1; j < pattern.length; j++) {
      const c = pattern.charAt(j);
      if (c === "\\") {
        current += c + pattern.charAt(j + 1);
        j++;
        continue;
      }
      if (c === "{") {
        depth++;
        current += c;
        continue;
      }
      if (c === "}") {
        if (depth === 0) {
          closed = j;
          break;
        }
        depth--;
        current += c;
        continue;
      }
      if (c === "," && depth === 0) {
        alternatives.push(current);
        current = "";
        sawComma = true;
        continue;
      }
      current += c;
    }

    if (closed === -1) {
      if (sawComma) {
        throw new ToolError(
          "unterminated-brace",
          "A brace group opened with { and lists alternatives but never closes.",
          "Add the closing brace, for example {ts,tsx}, or escape the opening one.",
        );
      }
      continue;
    }
    if (!sawComma) continue;
    alternatives.push(current);
    return { start: i, end: closed, alternatives };
  }
  return null;
}

/** Expand every brace group breadth first, capped so a brace bomb cannot run away. */
function expandBraces(pattern: string): string[] {
  const done: string[] = [];
  const queue: string[] = [pattern];
  while (queue.length > 0) {
    const item = queue.shift()!;
    const group = findBraceGroup(item);
    if (!group) {
      done.push(item);
      continue;
    }
    const prefix = item.slice(0, group.start);
    const suffix = item.slice(group.end + 1);
    for (const alternative of group.alternatives) queue.push(prefix + alternative + suffix);
    if (queue.length + done.length > MAX_EXPANSIONS) {
      throw new ToolError(
        "brace-explosion",
        `This pattern expands to more than ${MAX_EXPANSIONS} variants.`,
        "Use fewer brace groups, or split the pattern over several lines.",
      );
    }
  }
  return done;
}

interface CompiledPattern {
  pattern: string;
  negated: boolean;
  source: string;
  regex: RegExp;
}

interface Settings {
  dot: boolean;
  caseSensitive: boolean;
  matchBase: boolean;
}

/** Compile one pattern line, honoring a leading exclamation mark as an exclusion. */
function compilePattern(line: string, settings: Settings): CompiledPattern {
  let negated = false;
  let body = line;
  if (body.startsWith("!")) {
    negated = true;
    body = body.slice(1);
  }
  if (body.length === 0) {
    throw new ToolError(
      "empty-pattern",
      "A pattern line has nothing but an exclamation mark.",
      "Write the glob after the exclamation mark, for example !**/*.test.ts.",
    );
  }

  const sources = expandBraces(body).map((expanded) => {
    const withBase = settings.matchBase && !hasSlash(expanded) ? `**/${expanded}` : expanded;
    return compileBody(withBase, settings.dot);
  });

  const source = sources.length === 1 ? `^${sources[0]}$` : `^(?:${sources.join("|")})$`;
  return {
    pattern: line,
    negated,
    source,
    regex: new RegExp(source, settings.caseSensitive ? "" : "i"),
  };
}

function countPhrase(matched: number, total: number): string {
  const noun = total === 1 ? "path" : "paths";
  const verb = total === 1 ? "matches" : "match";
  return `${matched} of ${total} ${noun} ${verb}`;
}

function block(paths: string[], total: number): string {
  if (paths.length === 0) return "(none)";
  return `${paths.length} of ${total}\n${paths.join("\n")}`;
}

export function run(input: string, opts: GlobPatternTesterOpts): GlobPatternTesterResult {
  const settings: Settings = {
    dot: opts?.dot === true,
    caseSensitive: opts?.caseSensitive !== false,
    matchBase: opts?.matchBase === true,
  };

  const patternLines = (opts?.pattern ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (patternLines.length === 0) {
    throw new ToolError(
      "empty-pattern",
      "Enter a glob pattern to test against.",
      'Try "src/**/*.{ts,tsx}" or "**/*.test.js".',
    );
  }

  const paths = (input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (paths.length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter at least one file path to test.",
      "Paste one path per line, for example src/lib/format.ts.",
    );
  }
  if (paths.length > MAX_PATHS) {
    throw new ToolError(
      "too-many-paths",
      `That is ${paths.length} paths, and this tool handles ${MAX_PATHS} at a time.`,
      `Test the list in chunks of ${MAX_PATHS} lines or fewer.`,
    );
  }

  const compiled = patternLines.map((line) => compilePattern(line, settings));
  const includes = compiled.filter((entry) => !entry.negated);
  const excludes = compiled.filter((entry) => entry.negated);

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const path of paths) {
    // With only exclusions written, every path starts included, the way an
    // ignore file reads.
    const included = includes.length === 0 || includes.some((entry) => entry.regex.test(path));
    const excluded = excludes.some((entry) => entry.regex.test(path));
    if (included && !excluded) matched.push(path);
    else unmatched.push(path);
  }

  const first = compiled[0]!;
  const regexRows =
    compiled.length === 1 && !first.negated
      ? first.source
      : compiled
          .map(
            (entry) =>
              `${entry.negated ? "exclude" : "include"} ${entry.pattern} -> ${entry.source}`,
          )
          .join("\n");

  return {
    Matched: block(matched, paths.length),
    "Not matched": block(unmatched, paths.length),
    Summary: countPhrase(matched.length, paths.length),
    Regex: settings.caseSensitive ? regexRows : `${regexRows}\n(compiled with the i flag)`,
  };
}

export default { run } satisfies ToolLogic<string, GlobPatternTesterResult, GlobPatternTesterOpts>;
