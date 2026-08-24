import { COUNTRIES, WIKIDATA_META, type Country } from "../_generated/wikidata-countries";
import { ToolError, type ToolLogic } from "../types";

/**
 * Country code lookup: one search box over the 255 living ISO 3166-1
 * alpha-2 holders in the Wikidata snapshot.
 *
 * Matches an ISO 3166-1 alpha-2, alpha-3, or numeric code, an English name
 * or official name, a calling code written with a leading "+", or a top
 * level domain written with a leading ".". Everything is case-insensitive
 * except the two symbol-prefixed forms, whose values are compared as-is.
 *
 * Scoring gives every field its own tier so an exact code always beats a
 * partial name match, and a plain-name query still finds prefix and
 * substring hits. A tie at the top score (two countries sharing the same
 * calling code, several names containing the same substring) is reported
 * as ambiguous rather than guessed at.
 */

export type CountryMatchField =
  "name" | "officialName" | "iso2" | "iso3" | "isoNumeric" | "callingCode" | "tld";

export interface CountryMatch {
  country: Country;
  /** Higher is better. Exact code or name 1000 down to 230 for a loose substring hit. */
  score: number;
  matchedOn: CountryMatchField;
}

function byName(a: Country, b: Country): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.iso2 < b.iso2 ? -1 : a.iso2 > b.iso2 ? 1 : 0;
}

/** Strips leading zeros so "004" and "4" compare equal. Digits only. */
function normalizeNumeric(s: string): string {
  return s.replace(/^0+(?=\d)/, "");
}

function scoreOne(c: Country, q: string, raw: string): CountryMatch | undefined {
  if (raw.startsWith("+")) {
    return c.callingCodes.includes(raw)
      ? { country: c, score: 900, matchedOn: "callingCode" }
      : undefined;
  }
  if (raw.startsWith(".")) {
    return c.tlds.some((t) => t.toLowerCase() === q)
      ? { country: c, score: 900, matchedOn: "tld" }
      : undefined;
  }

  const name = c.name.toLowerCase();
  const official = c.officialName?.toLowerCase();
  const iso2 = c.iso2.toLowerCase();
  const iso3 = c.iso3?.toLowerCase();

  if (name === q) return { country: c, score: 1000, matchedOn: "name" };
  if (official === q) return { country: c, score: 990, matchedOn: "officialName" };
  if (iso2 === q) return { country: c, score: 980, matchedOn: "iso2" };
  if (iso3 === q) return { country: c, score: 970, matchedOn: "iso3" };
  if (c.isoNumeric && /^\d+$/.test(raw) && normalizeNumeric(c.isoNumeric) === normalizeNumeric(raw))
    return { country: c, score: 960, matchedOn: "isoNumeric" };
  if (name.startsWith(q)) return { country: c, score: 500, matchedOn: "name" };
  if (official?.startsWith(q)) return { country: c, score: 480, matchedOn: "officialName" };
  if (name.includes(q)) return { country: c, score: 250, matchedOn: "name" };
  if (official?.includes(q)) return { country: c, score: 230, matchedOn: "officialName" };
  return undefined;
}

/**
 * Ranked matches for a code, name, calling code, or TLD. Best first, ties
 * broken alphabetically by name then by ISO alpha-2 so the order never
 * depends on the platform's collation.
 */
export function findCountry(text: string, limit = 10): CountryMatch[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const q = raw.toLowerCase();

  const out: CountryMatch[] = [];
  for (const c of COUNTRIES) {
    const hit = scoreOne(c, q, raw);
    if (hit) out.push(hit);
  }
  out.sort((a, b) => b.score - a.score || byName(a.country, b.country));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Looser suggestions for a query that matched nothing. Shortens each word of
 * the query one letter at a time down to three and returns the first stem
 * that turns up any country name, so a typo still finds a nearby country.
 * Only ever runs on the error path.
 */
export function suggestions(text: string, limit = 3): Country[] {
  const words = String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  for (const word of words) {
    for (let length = word.length; length >= 3; length--) {
      const stem = word.slice(0, length);
      const hits = COUNTRIES.filter((c) => c.name.toLowerCase().includes(stem));
      if (hits.length) return hits.sort(byName).slice(0, limit);
    }
  }
  return [];
}

export function wikipediaUrl(c: Country): string | undefined {
  if (!c.wikipedia) return undefined;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(c.wikipedia.replace(/ /g, "_"))}`;
}

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The full data sheet for one country, ready for the record renderer. */
export function describeCountry(c: Country): Record<string, string> {
  const out: Record<string, string> = { Name: c.name };
  if (c.officialName && c.officialName !== c.name) out["Official name"] = c.officialName;
  out["ISO 3166-1 alpha-2"] = c.iso2;
  out["ISO 3166-1 alpha-3"] = c.iso3 ?? "Not recorded";
  out["ISO 3166-1 numeric"] = c.isoNumeric ?? "Not recorded";
  out["Calling code"] = c.callingCodes.length ? c.callingCodes.join(", ") : "Not recorded";
  out["Currency"] = c.currencies.length
    ? c.currencies
        .map((cur) =>
          cur.code ? `${cur.code} (${cur.name ?? "name not recorded"})` : (cur.name ?? "Unnamed"),
        )
        .join(", ")
    : "Not recorded";
  out["Top level domain"] = c.tlds.length ? c.tlds.join(", ") : "Not recorded";
  out["Time zone"] = c.timeZones.length ? c.timeZones.join(", ") : "Not recorded";
  if (c.ianaTimeZones.length) out["IANA time zone"] = c.ianaTimeZones.join(", ");
  out["Drives on the"] = c.drivingSide ? capitalize(c.drivingSide) : "Not recorded";
  out["Plug types"] = c.plugTypes.length ? c.plugTypes.join(", ") : "Not recorded";
  out["Capital"] = c.capital ?? "Not recorded";
  out["Continent"] = c.continent ?? "Not recorded";
  out["Population"] =
    c.population !== undefined ? c.population.toLocaleString("en-US") : "Not recorded";
  out["Area"] =
    c.areaKm2 !== undefined
      ? `${c.areaKm2.toLocaleString("en-US", { maximumFractionDigits: 0 })} km²`
      : "Not recorded";
  if (c.demonym) out["Demonym"] = c.demonym;
  if (c.flagEmoji) out["Flag"] = c.flagEmoji;
  const wiki = wikipediaUrl(c);
  if (wiki) out["Wikipedia"] = wiki;
  out["Source"] = `Wikidata, CC0 1.0. Snapshot built ${WIKIDATA_META.builtAt.slice(0, 10)}.`;
  return out;
}

export function run(input: string, _opts?: Record<string, unknown>): Record<string, string> {
  const text = String(input ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "No country to look up.",
      'Type an ISO code like "DE", a country name, a calling code like "+49", or a TLD like ".de".',
    );

  const matches = findCountry(text, 10);
  if (!matches.length) {
    const guesses = suggestions(text);
    throw new ToolError(
      "no-match",
      `Nothing matches "${text}".`,
      guesses.length
        ? `Did you mean ${guesses.map((c) => c.name).join(", ")}?`
        : "Try an ISO 3166-1 alpha-2 or alpha-3 code, a country name, a calling code, or a top level domain.",
    );
  }

  const top = matches[0]!;
  const runnerUp = matches[1];
  const tied =
    runnerUp !== undefined &&
    runnerUp.score === top.score &&
    runnerUp.country.iso2 !== top.country.iso2;
  if (tied)
    throw new ToolError(
      "ambiguous",
      `"${text}" matches ${matches.length === 10 ? "10 or more" : matches.length} countries equally well.`,
      `Try one of ${matches
        .slice(0, 3)
        .map((m) => m.country.name)
        .join(", ")}.`,
    );

  return describeCountry(top.country);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Record<string, unknown>>;
