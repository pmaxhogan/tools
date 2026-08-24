import { ToolError, type ToolLogic } from "../types";
import {
  BY_PATTERN,
  BY_PATTERN_LOWER,
  GOOGLE_AUTH_PREFIX,
  PREFIXES,
  RESOURCE_PREFIXES,
  type Risk,
  type ScopeEntry,
} from "./data";

export interface ScopeOpts {
  /** 'risk' sorts most permissive first; 'input' keeps the order you pasted. */
  sort: string;
  /** Hide the low risk rows. The summary still counts them. */
  hideLow: boolean;
  [key: string]: unknown;
}

export type ScopeResult = Record<string, string>;

const RISK_ORDER: Record<Risk, number> = { low: 0, moderate: 1, high: 2, critical: 3 };
const RISK_NAMES: Risk[] = ["critical", "high", "moderate", "low"];

/** One decoded scope, whether it was found in the catalog or guessed at. */
export interface Decoded {
  scope: string;
  provider: string;
  plainEnglish: string;
  risk: Risk;
  riskWhy: string;
  /** True when the catalog had no entry and the read is a heuristic guess. */
  guess: boolean;
}

// ---------------------------------------------------------------- input paths

/** base64url to a UTF-8 string. Throws on anything that is not valid base64url. */
function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const full = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(full);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseJsonSegment(segment: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = decodeBase64Url(segment);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * A JWT is three base64url segments whose first segment decodes to a JSON
 * object with an `alg` header. Checking the header, not just the dots, keeps
 * scope strings like `files.content.read` out of this branch.
 */
function asJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const header = parseJsonSegment(parts[0]);
  if (!header || typeof header.alg !== "string") return null;
  const payload = parseJsonSegment(parts[1]);
  if (!payload)
    throw new ToolError(
      "bad-token",
      "That looks like a JWT, but its payload is not readable JSON.",
      "Copy the whole token, including all three dot separated parts.",
    );
  return payload;
}

/** Pull scopes out of a decoded JWT payload: `scope`, `scp` or `scopes`. */
function scopesFromPayload(payload: Record<string, unknown>): string[] {
  const claim = payload.scope ?? payload.scp ?? payload.scopes;
  if (typeof claim === "string") return splitList(claim);
  if (Array.isArray(claim)) return claim.filter((c): c is string => typeof c === "string");
  throw new ToolError(
    "no-scope-claim",
    "That token decoded cleanly but has no scope, scp or scopes claim in its payload.",
    "Paste the scope list itself, or a token issued with scopes attached.",
  );
}

/** Read the `scope` parameter out of a consent or authorize URL, query or fragment. */
function scopesFromUrl(raw: string): string[] | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const fromQuery = url.searchParams.get("scope");
  if (fromQuery) return splitList(fromQuery);

  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (hash) {
    const fromHash = new URLSearchParams(hash).get("scope");
    if (fromHash) return splitList(fromHash);
  }
  return null;
}

/** Split a scope list on whitespace, commas and the odd JSON punctuation. */
function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((t) => t.replace(/^["'[\]{}]+|["'[\]{}]+$/g, "").trim())
    .filter(Boolean);
}

/**
 * Work out what the user pasted and return the scope strings, deduplicated
 * with first-seen order preserved.
 */
export function extractScopes(input: string): string[] {
  const raw = (input ?? "").trim();
  if (!raw)
    throw new ToolError(
      "empty-input",
      "There is nothing to decode.",
      "Paste a scope list, an OAuth consent URL, or an access token that carries scopes.",
    );

  let tokens: string[] | null = null;
  const single = raw.replace(/^Bearer\s+/i, "").trim();
  const isOneToken = !/\s/.test(single);

  if (isOneToken) {
    const payload = asJwtPayload(single);
    if (payload) tokens = scopesFromPayload(payload);
  }

  if (!tokens && /^https?:\/\//i.test(raw.split(/\s+/)[0])) {
    // A bare Google scope is also a URL, so only treat it as a consent URL
    // when a scope parameter is actually present.
    const first = raw.split(/\s+/)[0];
    tokens = scopesFromUrl(first);
  }

  if (!tokens) tokens = splitList(raw);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }

  if (!out.length)
    throw new ToolError(
      "empty-input",
      "No scopes were found in that input.",
      "Paste a scope list, an OAuth consent URL, or an access token that carries scopes.",
    );

  return out;
}

// ---------------------------------------------------------------- lookup

/** Candidate spellings of one scope, most specific first. */
function candidates(scope: string): string[] {
  const list = [scope];
  for (const prefix of RESOURCE_PREFIXES) {
    if (scope.startsWith(prefix)) list.push(scope.slice(prefix.length));
  }
  if (!/^https?:\/\//i.test(scope)) list.push(GOOGLE_AUTH_PREFIX + scope);
  return list;
}

/** Exact match, then longest matching prefix pattern. Null when unknown. */
export function lookup(scope: string): ScopeEntry | null {
  const forms = candidates(scope);
  for (const form of forms) {
    const hit = BY_PATTERN.get(form);
    if (hit) return hit;
  }
  for (const form of forms) {
    const hit = BY_PATTERN_LOWER.get(form.toLowerCase());
    if (hit) return hit;
  }
  for (const entry of PREFIXES) {
    const stem = entry.pattern.slice(0, -1);
    if (forms.some((f) => f.startsWith(stem))) return entry;
  }
  return null;
}

/**
 * A light, honest read of an unknown scope name. Every result is labeled as a
 * guess in the output; the point is to say what the words usually mean, not to
 * pretend the catalog covers it.
 */
export function guessUnknown(scope: string): { risk: Risk; suggests: string; why: string } {
  const s = scope.toLowerCase();
  const wide = /\.all\b|\.all$|:all\b|\*/.test(s);
  const isAdmin = /(^|[._:/-])admin|superuser|owner|root/.test(s);
  const isDelete = /delete|destroy|purge|wipe/.test(s);
  const isWrite = /write|modify|update|create|manage|edit|send|post|publish|full/.test(s);
  const isRead = /read|view|list|get|readonly|read_only|\.ro\b/.test(s);

  const parts: string[] = [];
  if (isAdmin) parts.push("administrative control rather than access to your own data");
  if (isDelete) parts.push("the ability to delete things");
  if (isWrite && !isDelete) parts.push("writing or changing data, not only reading it");
  if (isRead && !isWrite && !isDelete) parts.push("reading data without changing it");
  if (wide) parts.push("a scope that spans every record rather than only yours");
  if (!parts.length) parts.push("access whose breadth the name does not make clear");

  let level = 1; // moderate by default
  if (isRead && !isWrite && !isDelete && !isAdmin) level = 0;
  if (isWrite) level = 1;
  if (isDelete || isAdmin) level = 2;
  if (wide) level = Math.min(3, level + 1);
  const risk = (["low", "moderate", "high", "critical"] as Risk[])[level];

  const whyBits: string[] = [];
  if (wide)
    whyBits.push(
      "the .All suffix or wildcard usually means every record in the account, not only yours",
    );
  if (isAdmin) whyBits.push("admin in a scope name usually means it acts on other people too");
  if (isDelete) whyBits.push("deletion is rarely reversible");
  if (!whyBits.length)
    whyBits.push("the risk shown is inferred from the words in the name and could be wrong");

  const why = whyBits.join("; ");
  return {
    risk,
    suggests: parts.join(", "),
    why: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
  };
}

export function decode(scope: string): Decoded {
  const entry = lookup(scope);
  if (entry)
    return {
      scope,
      provider: entry.provider,
      plainEnglish: entry.plainEnglish,
      risk: entry.risk,
      riskWhy: entry.riskWhy,
      guess: false,
    };

  const g = guessUnknown(scope);
  return {
    scope,
    provider: "Unrecognized",
    plainEnglish: `Not in the catalog. The name suggests ${g.suggests}.`,
    risk: g.risk,
    riskWhy: g.why,
    guess: true,
  };
}

// ---------------------------------------------------------------- output

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function breakdown(rows: Decoded[]): string {
  const counts = RISK_NAMES.map(
    (r) => [r, rows.filter((d) => d.risk === r).length] as const,
  ).filter(([, n]) => n > 0);
  return counts.map(([r, n]) => `${n} ${r}`).join(", ");
}

function providerSummary(rows: Decoded[]): string {
  const counts = new Map<string, number>();
  for (const d of rows) {
    if (d.guess) continue;
    counts.set(d.provider, (counts.get(d.provider) ?? 0) + 1);
  }
  if (!counts.size) return "no provider recognized";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p]) => p)
    .join(", ");
}

function advice(rows: Decoded[]): string {
  const scopes = rows.map((d) => d.scope.toLowerCase());
  const lines = ["Risk here describes what a scope permits, not a claim that this app misuses it."];

  const offline = scopes.filter((s) => /offline[._]access|refresh_token/.test(s));
  if (offline.length)
    lines.push(
      `${offline[0]} keeps the granted access working while you are offline, using a refresh token that lasts until you revoke the app in your account settings.`,
    );

  const canWrite = rows.some(
    (d) =>
      /\b(create|change|write|send|upload|post|manage|add|assign|grant|overwrite)\b/i.test(
        d.plainEnglish,
      ) || /write|modify|manage/i.test(d.scope),
  );
  const canDelete = rows.some(
    (d) => /\bdelete\b|\bwipe\b/i.test(d.plainEnglish) || /delete|destroy/i.test(d.scope),
  );
  if (canWrite && canDelete)
    lines.push(
      "This list pairs write access with the ability to delete, so a mistake or a compromise removes data rather than just exposing it.",
    );

  if (rows.some((d) => /(^|[._:/-])admin/i.test(d.scope) || /admin/i.test(d.provider)))
    lines.push(
      "Scopes with admin in the name act on the whole workspace or organization, including people who never saw this consent screen.",
    );

  const criticals = rows.filter((d) => d.risk === "critical").length;
  if (criticals)
    lines.push(
      `${plural(criticals, "scope")} here ${criticals === 1 ? "is" : "are"} wide enough that granting ${criticals === 1 ? "it" : "them"} is close to handing over the account, so grant ${criticals === 1 ? "it" : "them"} only to software you would trust with everything.`,
    );

  const guesses = rows.filter((d) => d.guess).length;
  if (guesses)
    lines.push(
      `${plural(guesses, "scope")} ${guesses === 1 ? "is" : "are"} not in the catalog, so ${guesses === 1 ? "that row is an informed guess" : "those rows are informed guesses"}. ${guesses === 1 ? "Check it" : "Check those"} against the official documentation for that provider before deciding.`,
    );

  if (lines.length === 1)
    lines.push(
      "Nothing on this list stands out. It is still worth checking that every scope matches something the app actually needs.",
    );

  return lines.join(" ");
}

export function run(input: string, opts: ScopeOpts): ScopeResult {
  const scopes = extractScopes(input);
  const rows = scopes.map(decode);

  const sortMode = String(opts?.sort ?? "risk");
  const ordered =
    sortMode === "input"
      ? rows
      : rows
          .map((d, i) => ({ d, i }))
          .sort((a, b) => RISK_ORDER[b.d.risk] - RISK_ORDER[a.d.risk] || a.i - b.i)
          .map((x) => x.d);

  const hideLow = opts?.hideLow === true;
  const shown = hideLow ? ordered.filter((d) => d.risk !== "low") : ordered;
  const hidden = ordered.length - shown.length;

  const overall = RISK_NAMES.find((r) => rows.some((d) => d.risk === r)) ?? "low";

  const out: ScopeResult = {};
  let summary = `${plural(rows.length, "scope")} · ${providerSummary(rows)} · overall risk: ${overall} (${breakdown(rows)})`;
  if (hidden > 0)
    summary += ` ${plural(hidden, "low risk row")} hidden; the counts above still include them.`;
  out["Access summary"] = summary;

  for (const d of shown) {
    const lead = d.guess ? "" : `${d.provider} · `;
    out[d.scope] =
      `${lead}${d.plainEnglish} (risk: ${d.risk}${d.guess ? ", a guess" : ""}) ${d.riskWhy}`;
  }

  out["Things to check"] = advice(rows);
  return out;
}

export default { run } satisfies ToolLogic<string, ScopeResult, ScopeOpts>;
