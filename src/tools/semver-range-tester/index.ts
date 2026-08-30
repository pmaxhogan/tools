/**
 * A hand rolled semver parser, comparator, and range satisfier that follows npm
 * (node-semver) semantics. Nothing is imported for it: the site ships no semver
 * dependency, and the grammar is small enough to own outright.
 *
 * The interesting part is the prerelease inclusion rule at the bottom, which is
 * the thing people get wrong when they reason about ranges by hand.
 */
import { ToolError, type ToolLogic } from "../types";

export interface SemverRangeTesterOpts {
  /** The range expression, for example "^1.2.3 || >=2 <3". */
  range?: string;
  /** Let prerelease versions satisfy comparators that carry no prerelease. */
  includePrerelease?: boolean | string;
  [key: string]: unknown;
}

export type SemverRangeTesterResult = Record<string, string>;

/** Guard against a paste large enough to lock the tab up. */
const MAX_VERSIONS = 5000;

/** A numeric identifier: no leading zeros, exactly as the spec requires. */
const NUM = "(?:0|[1-9]\\d*)";
/** A prerelease identifier: numeric, or alphanumeric with at least one non digit. */
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][a-zA-Z0-9-]*)";
const PRERELEASE = `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?`;
/** Build metadata is parsed so it is accepted, then dropped: it never affects precedence. */
const BUILD = "(?:\\+(?:[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?";
/** A complete version, with the leading "v" or "=" npm tolerates. */
const FULL = new RegExp(`^=?v?(${NUM})\\.(${NUM})\\.(${NUM})${PRERELEASE}${BUILD}$`);
/** A field of a partial version inside a range: a number, or an x placeholder. */
const XNUM = "(?:[xX*]|0|[1-9]\\d*)";
/** A partial version as it appears inside a range: 1, 1.2, 1.2.3, 1.x, 1.2.3-beta.2, *. */
const PARTIAL = new RegExp(
  `^=?v?(${XNUM})(?:\\.(${XNUM})(?:\\.(${XNUM})${PRERELEASE}${BUILD})?)?$`,
);

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot separated identifiers, numeric ones as numbers. Empty for a release. */
  prerelease: Array<string | number>;
  /** The text this was parsed from, echoed back so the user recognizes their line. */
  raw: string;
}

/** Parse one complete version. Returns null rather than throwing so callers can word the error. */
export function parseVersion(raw: string): SemVer | null {
  const trimmed = raw.trim();
  const m = FULL.exec(trimmed);
  if (!m) return null;
  const prerelease = m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
    raw: trimmed,
  };
}

/** Numeric identifiers compare numerically and always sort below alphanumeric ones. */
function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two prerelease identifier lists. A version carrying a prerelease is
 * lower than the same version without one, and when every shared field ties the
 * longer list wins.
 */
export function comparePrerelease(a: Array<string | number>, b: Array<string | number>): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; ; i += 1) {
    if (i >= a.length && i >= b.length) return 0;
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const c = compareIdentifiers(a[i], b[i]);
    if (c !== 0) return c;
  }
}

/** Full semver precedence. Build metadata is already gone by this point. */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

type Op = ">" | ">=" | "<" | "<=" | "=";

export interface Comparator {
  /** The "*" comparator, which matches every release. */
  any: boolean;
  op: Op;
  version: SemVer;
  /** Normalized display text, for example ">=1.2.3" or "*". */
  text: string;
}

interface Parts {
  M: string;
  m?: string;
  p?: string;
  pr?: string;
}

function isX(part: string | undefined): boolean {
  return part === undefined || part === "" || part === "x" || part === "X" || part === "*";
}

/** Split a range atom such as "1.2.x" or "0.0.3-beta" into its fields. */
function atomParts(atom: string): Parts | null {
  const m = PARTIAL.exec(atom);
  if (!m) return null;
  return { M: m[1], m: m[2], p: m[3], pr: m[4] };
}

function tail(pr: string | undefined): string {
  return pr ? `-${pr}` : "";
}

/**
 * Caret: allow changes that do not modify the leftmost non zero field. The 0.x
 * rules are the ones people misremember, so they are spelled out here:
 * ^0.2.3 stays inside 0.2, and ^0.0.3 stays on 0.0.3 exactly.
 */
function caretRange(parts: Parts, z: string): string {
  const { M, m, p, pr } = parts;
  if (isX(M)) return "*";
  if (isX(m)) return `>=${M}.0.0${z} <${Number(M) + 1}.0.0-0`;
  if (isX(p)) {
    if (M === "0") return `>=${M}.${m}.0${z} <${M}.${Number(m) + 1}.0-0`;
    return `>=${M}.${m}.0${z} <${Number(M) + 1}.0.0-0`;
  }
  const lower = `>=${M}.${m}.${p}${tail(pr)}`;
  if (M === "0" && m === "0") return `${lower} <${M}.${m}.${Number(p) + 1}-0`;
  if (M === "0") return `${lower} <${M}.${Number(m) + 1}.0-0`;
  return `${lower} <${Number(M) + 1}.0.0-0`;
}

/** Tilde: allow patch level changes when a minor is given, minor level changes when it is not. */
function tildeRange(parts: Parts, z: string): string {
  const { M, m, p, pr } = parts;
  if (isX(M)) return "*";
  if (isX(m)) return `>=${M}.0.0${z} <${Number(M) + 1}.0.0-0`;
  if (isX(p)) return `>=${M}.${m}.0${z} <${M}.${Number(m) + 1}.0-0`;
  return `>=${M}.${m}.${p}${tail(pr)} <${M}.${Number(m) + 1}.0-0`;
}

/** A bare version, an x-range, or a plain comparator such as ">=1.2" or "<1.x". */
function plainRange(op: string, parts: Parts, z: string): string {
  const { M, m, p, pr } = parts;
  const anyX = isX(M) || isX(m) || isX(p);
  let gtlt = op === "=" && anyX ? "" : op;

  if (isX(M)) {
    // ">*" and "<*" ask for a version outside every version, so nothing matches.
    return gtlt === ">" || gtlt === "<" ? "<0.0.0-0" : "*";
  }

  if (gtlt !== "" && anyX) {
    let major = Number(M);
    let minor = isX(m) ? 0 : Number(m);
    const patch = 0;
    if (gtlt === ">") {
      gtlt = ">=";
      if (isX(m)) {
        major += 1;
        minor = 0;
      } else {
        minor += 1;
      }
    } else if (gtlt === "<=") {
      gtlt = "<";
      if (isX(m)) major += 1;
      else minor += 1;
    }
    return `${gtlt}${major}.${minor}.${patch}${gtlt === "<" ? "-0" : z}`;
  }

  if (isX(m)) return `>=${M}.0.0${z} <${Number(M) + 1}.0.0-0`;
  if (isX(p)) return `>=${M}.${m}.0${z} <${M}.${Number(m) + 1}.0-0`;
  return `${gtlt || "="}${M}.${m}.${p}${tail(pr)}`;
}

const OPERATOR = /^(>=|<=|>|<|=|\^|~>|~)/;

function badAtom(token: string): ToolError {
  return new ToolError(
    "bad-range",
    `"${token}" is not a comparator this range parser understands.`,
    'Comparators look like ^1.2.3, ~1.2, >=1.2.7, <1.3.0, 1.x, or "1.2.3 - 2.3.4".',
  );
}

/** Turn one whitespace separated range atom into normalized comparator text. */
function desugarAtom(token: string, z: string): string {
  const opMatch = OPERATOR.exec(token);
  const op = opMatch ? opMatch[1] : "";
  const parts = atomParts(token.slice(op.length));
  if (!parts) throw badAtom(token);
  if (op === "^") return caretRange(parts, z);
  if (op === "~" || op === "~>") return tildeRange(parts, z);
  return plainRange(op, parts, z);
}

/**
 * "1.2.3 - 2.3.4" means an inclusive span. A partial lower bound fills its
 * missing fields with zeros; a partial upper bound becomes an exclusive bound on
 * the next field up, so "1.2.3 - 2.3" ends just before 2.4.0.
 */
function hyphenRange(lowText: string, highText: string, z: string): string {
  const low = atomParts(lowText);
  if (!low) throw badAtom(lowText);
  const high = atomParts(highText);
  if (!high) throw badAtom(highText);

  // An all x bound on either side means that side is unbounded, hence the "".
  const lower = isX(low.M)
    ? ""
    : isX(low.m)
      ? `>=${low.M}.0.0${z}`
      : isX(low.p)
        ? `>=${low.M}.${low.m}.0${z}`
        : `>=${low.M}.${low.m}.${low.p}${tail(low.pr)}`;

  const upper = isX(high.M)
    ? ""
    : isX(high.m)
      ? `<${Number(high.M) + 1}.0.0-0`
      : isX(high.p)
        ? `<${high.M}.${Number(high.m) + 1}.0-0`
        : `<=${high.M}.${high.m}.${high.p}${tail(high.pr)}`;

  if (!lower && !upper) return "*";
  if (lower && upper) {
    const lowVersion = parseVersion(lower.slice(2));
    const highVersion = parseVersion(upper.replace(/^<=?/, ""));
    if (lowVersion && highVersion && compareVersions(lowVersion, highVersion) > 0) {
      throw new ToolError(
        "inverted-range",
        `The hyphen range "${lowText} - ${highText}" runs backwards, so no version can satisfy it.`,
        `Put the lower bound first and write "${highText} - ${lowText}".`,
      );
    }
  }
  return [lower, upper].filter((piece) => piece !== "").join(" ");
}

function anyComparator(): Comparator {
  return {
    any: true,
    op: ">=",
    version: { major: 0, minor: 0, patch: 0, prerelease: [], raw: "0.0.0" },
    text: "*",
  };
}

/** Read back one normalized comparator string produced by the desugar helpers. */
function toComparator(text: string): Comparator {
  if (text === "*") return anyComparator();
  const m = /^(>=|<=|>|<|=)(.+)$/.exec(text);
  const version = m ? parseVersion(m[2]) : null;
  if (!m || !version) throw badAtom(text);
  return { any: false, op: m[1] as Op, version, text };
}

/**
 * Parse a full range into OR'd sets of AND'd comparators.
 *
 * An empty comparator set means "any version" in semver, which is why an empty
 * segment between two pipes becomes "*". A completely blank range is rejected
 * one level up instead, because a blank range field is a user who has not typed
 * anything yet rather than a user asking for everything.
 */
export function parseRange(rangeText: string, z: string): Comparator[][] {
  const sets: Comparator[][] = [];
  for (const rawSegment of rangeText.split("||")) {
    // A space after an operator is tolerated, so ">= 1.2.3" reads as ">=1.2.3".
    const segment = rawSegment.trim().replace(/(>=|<=|>|<|=|\^|~>|~)\s+/g, "$1");
    if (segment === "") {
      sets.push([anyComparator()]);
      continue;
    }
    const tokens = segment.split(/\s+/);
    const normalized =
      tokens.length === 3 && tokens[1] === "-"
        ? hyphenRange(tokens[0], tokens[2], z)
        : tokens.map((token) => desugarAtom(token, z)).join(" ");

    const pieces = normalized.split(/\s+/).filter((piece) => piece !== "");
    const comparators = pieces.map(toComparator);
    // "*" constrains nothing beside a real comparator, so it only survives alone.
    const real = comparators.filter((c) => !c.any);
    sets.push(real.length > 0 ? real : [comparators[0]]);
  }
  return sets;
}

function testComparator(v: SemVer, c: Comparator): boolean {
  if (c.any) return true;
  const cmp = compareVersions(v, c.version);
  switch (c.op) {
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    default:
      return cmp === 0;
  }
}

/**
 * The prerelease inclusion rule, and the reason 1.2.4-alpha does not satisfy
 * >=1.2.3 even though it compares as greater. A version carrying a prerelease
 * only satisfies a comparator set when some comparator in that same set also
 * carries a prerelease and pins the same major, minor, and patch. The rule is
 * per comparator set, so "^1.2.3-beta.2 || >=2" opts in to 1.2.3 prereleases
 * without opting in to 2.x ones.
 */
export function setSatisfies(v: SemVer, set: Comparator[], includePrerelease: boolean): boolean {
  for (const c of set) {
    if (!testComparator(v, c)) return false;
  }
  if (v.prerelease.length === 0 || includePrerelease) return true;
  for (const c of set) {
    if (c.any) continue;
    if (c.version.prerelease.length === 0) continue;
    if (c.version.major === v.major && c.version.minor === v.minor && c.version.patch === v.patch) {
      return true;
    }
  }
  return false;
}

export function satisfies(v: SemVer, sets: Comparator[][], includePrerelease: boolean): boolean {
  return sets.some((set) => setSatisfies(v, set, includePrerelease));
}

/**
 * The version half of a comparator, for prose. The trailing "-0" on an upper
 * bound is a parser detail that means "and no prerelease of it either", so it
 * stays in the parsed range row and comes out of the readable one.
 */
function boundText(c: Comparator): string {
  return c.text.replace(/^(>=|<=|>|<|=)/, "").replace(/-0$/, "");
}

function phrase(c: Comparator): string {
  if (c.any) return "any version";
  const v = boundText(c);
  switch (c.op) {
    case ">=":
      return `${v} or newer`;
    case ">":
      return `newer than ${v}`;
    case "<":
      return `below ${v}`;
    case "<=":
      return `${v} or older`;
    default:
      return `exactly ${v}`;
  }
}

function describeSet(set: Comparator[]): string {
  if (set.length === 1 && set[0].any) return "any version";
  if (set.length === 1 && set[0].text === "<0.0.0-0") return "nothing, no version can match this";
  const lower = set.filter((c) => c.op === ">=" || c.op === ">");
  const upper = set.filter((c) => c.op === "<" || c.op === "<=");
  if (set.length === 2 && lower.length === 1 && upper.length === 1) {
    return `${phrase(lower[0])}, but ${phrase(upper[0])}`;
  }
  return set.map(phrase).join(" and ");
}

/** Options arrive as real booleans from the panel and as strings from a shared link. */
function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "1" || value === "yes";
  return false;
}

function listRow(items: SemVer[], total: number): string {
  const head = `${items.length} of ${total}`;
  if (items.length === 0) return `${head}\n(none)`;
  return `${head}\n${items.map((v) => v.raw).join("\n")}`;
}

export function run(input: string, opts: SemverRangeTesterOpts): SemverRangeTesterResult {
  const rangeText = (opts?.range ?? "").trim().replace(/\s+/g, " ");
  if (rangeText === "") {
    throw new ToolError(
      "empty-range",
      "Enter a semver range to test against.",
      'Try "^1.2.3", ">=1.2.7 <1.3.0", or "*" to accept any version.',
    );
  }

  const includePrerelease = toBool(opts?.includePrerelease);
  // With prereleases included, an implicit field opens at "-0" so 1.x admits 1.0.0-alpha.
  const z = includePrerelease ? "-0" : "";

  const lines = (input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter at least one version to test.",
      "Paste one version per line, for example 1.2.3.",
    );
  }
  if (lines.length > MAX_VERSIONS) {
    throw new ToolError(
      "too-many-versions",
      `That is ${lines.length} versions, and this tool tests at most ${MAX_VERSIONS} at a time.`,
      "Trim the list and run it again.",
    );
  }

  const versions: SemVer[] = [];
  for (const line of lines) {
    const parsed = parseVersion(line);
    if (!parsed) {
      throw new ToolError(
        "bad-version",
        `"${line}" is not a valid semver version.`,
        "Versions need all three numbers, as in 1.2.3, with an optional -prerelease and +build.",
      );
    }
    versions.push(parsed);
  }

  const sets = parseRange(rangeText, z);

  const passing: SemVer[] = [];
  const failing: SemVer[] = [];
  for (const version of versions) {
    if (satisfies(version, sets, includePrerelease)) passing.push(version);
    else failing.push(version);
  }

  let max: SemVer | null = null;
  let min: SemVer | null = null;
  for (const version of passing) {
    if (max === null || compareVersions(version, max) > 0) max = version;
    if (min === null || compareVersions(version, min) < 0) min = version;
  }

  const sorted = [...versions].sort(compareVersions);

  return {
    Range: rangeText,
    "Parsed range": sets.map((set) => set.map((c) => c.text).join(" ")).join(" || "),
    "In plain English": sets.map(describeSet).join("; or "),
    Satisfies: listRow(passing, versions.length),
    "Does not satisfy": listRow(failing, versions.length),
    "Max satisfying": max ? max.raw : "(none)",
    "Min satisfying": min ? min.raw : "(none)",
    Sorted: sorted.map((v) => v.raw).join("\n"),
  };
}

export default { run } satisfies ToolLogic<string, SemverRangeTesterResult, SemverRangeTesterOpts>;
