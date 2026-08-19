/**
 * Importing the polyfill for its side effect installs URLPattern on the global
 * ONLY when the runtime has none of its own, so the bare global below is the
 * browser's native implementation where it exists (Chrome, Deno) and the
 * polyfill everywhere else, including the Node test run.
 */
import "urlpattern-polyfill";
import { ToolError, type ToolLogic } from "../types";

/** The shape URLPattern.exec returns on a match. */
type PatternResult = NonNullable<ReturnType<URLPattern["exec"]>>;

export interface UrlpatternTesterOpts {
  /** The URLPattern string, e.g. "/users/:id" or "https://:sub.example.com/*". */
  pattern?: string;
  /** Optional base URL, used for relative patterns and relative test URLs. */
  baseURL?: string;
  [key: string]: unknown;
}

export type UrlpatternTesterResult = Record<string, string>;

/** The URL components a URLPattern matches on, in URL order. */
const COMPONENTS = [
  "protocol",
  "username",
  "password",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;

/**
 * Drop the noise groups. Every wildcard component that matched nothing still
 * reports an index group of "" (for example `username.groups.0`), which tells
 * the user nothing. Named groups always stay, even when they matched empty.
 */
function isInteresting(name: string, value: string): boolean {
  return !/^\d+$/.test(name) || value !== "";
}

/** Collect the interesting groups of one exec result as "component.groups.name" rows. */
function groupRows(result: PatternResult): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const component of COMPONENTS) {
    const part = result[component];
    if (!part) continue;
    for (const [name, raw] of Object.entries(part.groups ?? {})) {
      const value = raw ?? "";
      if (isInteresting(name, value)) rows.push([`${component}.groups.${name}`, value]);
    }
  }
  return rows;
}

/** One-line echo of the parsed pattern, with wildcard-only components omitted. */
function describePattern(pattern: URLPattern): string {
  const parts = COMPONENTS.map((component) => [component, pattern[component]] as const).filter(
    ([, value]) => value && value !== "*",
  );
  if (parts.length === 0) return "* (every component matches anything)";
  return parts.map(([name, value]) => `${name}=${value}`).join(", ");
}

/** Build the pattern, turning a construction TypeError into an actionable ToolError. */
function createPattern(source: string, baseURL: string): URLPattern {
  try {
    return baseURL ? new URLPattern(source, baseURL) : new URLPattern(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const needsBase = /base url/i.test(message);
    throw new ToolError(
      "bad-pattern",
      message,
      needsBase
        ? "A relative pattern needs a base, so fill in the Base URL option, for example https://example.com."
        : "Check the URLPattern syntax. Named groups are :name, wildcards are *.",
    );
  }
}

export function run(input: string, opts: UrlpatternTesterOpts): UrlpatternTesterResult {
  const patternSource = (opts?.pattern ?? "").trim();
  if (!patternSource) {
    throw new ToolError(
      "empty-pattern",
      "Enter a URLPattern to test against.",
      'Try "/users/:id" or "https://:sub.example.com/*".',
    );
  }

  const baseURL = (opts?.baseURL ?? "").trim();

  const urls = (input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (urls.length === 0) {
    throw new ToolError(
      "empty-input",
      "Enter at least one URL to test.",
      "Paste a URL like https://example.com/users/42.",
    );
  }

  const pattern = createPattern(patternSource, baseURL);

  function testOne(url: string): { matched: boolean; result: PatternResult | null } {
    const matched = baseURL ? pattern.test(url, baseURL) : pattern.test(url);
    if (!matched) return { matched, result: null };
    const result = baseURL ? pattern.exec(url, baseURL) : pattern.exec(url);
    return { matched, result };
  }

  const out: UrlpatternTesterResult = {};
  out["Pattern"] = describePattern(pattern);
  if (baseURL) out["Base URL"] = baseURL;

  if (urls.length === 1) {
    const url = urls[0];
    const { matched, result } = testOne(url);
    out["URL"] = url;
    out["Match"] = matched ? "yes" : "no";

    if (result) {
      const rows = groupRows(result);
      if (rows.length === 0) {
        out["Groups"] = "(none)";
      } else {
        for (const [key, value] of rows) out[key] = value;
      }
    }
    return out;
  }

  let matches = 0;
  const rows: Array<[string, string]> = [];
  const seen = new Map<string, number>();

  for (const url of urls) {
    const { matched, result } = testOne(url);
    if (matched) matches += 1;

    const inline = result
      ? groupRows(result)
          .map(([key, value]) => `${key.replace(".groups.", ".")}=${value}`)
          .join(", ")
      : "";

    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    const label = n === 1 ? url : `${url} [${n}]`;
    rows.push([label, matched ? (inline ? `match: ${inline}` : "match") : "no match"]);
  }

  out["Summary"] = `${matches} of ${urls.length} URLs matched.`;
  for (const [key, value] of rows) out[key] = value;

  return out;
}

export default { run } satisfies ToolLogic<string, UrlpatternTesterResult, UrlpatternTesterOpts>;
