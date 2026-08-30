/**
 * Builds the chemistry dataset the Chemistry tools read at runtime. Companion
 * to scripts/prepare-models.mjs and scripts/prepare-pyodide.mjs: pinned public
 * sources, an on-disk cache so a rebuild refetches nothing, deterministic
 * output, gitignored artifacts, and loud per-step logging.
 *
 * Run it directly:
 *
 *   node scripts/prepare-chem-data.mjs               build, using the cache
 *   node scripts/prepare-chem-data.mjs --refresh     ignore the cache, refetch
 *   node scripts/prepare-chem-data.mjs --offline     cache only, fail on a miss
 *   node scripts/prepare-chem-data.mjs --no-broad    narrow tier only
 *   node scripts/prepare-chem-data.mjs --budget=90   stop starting work at 90 min
 *   node scripts/prepare-chem-data.mjs --limit=200   smoke test the broad tier
 *
 * Cold run is roughly 45 to 75 minutes, most of it the broad tier's 23,000
 * article read and PubChem's 359 pages of bulk GHS annotations. Warm run is a
 * couple of minutes: every network step has a parsed digest next to the raw
 * responses, so nothing large is re-parsed unless a PARSE_VERSION changes.
 *
 * The run is budgeted rather than open ended. When --budget runs out the GHS
 * sweep stops where it is, the dataset ships without the classifications it did
 * not reach, and CHEM_BROAD_META.counts.withoutGhs records how many are
 * missing so a later run with a warmer cache can finish the job.
 *
 * ---------------------------------------------------------------------------
 * Sources (all fetched at build time only, never at runtime)
 * ---------------------------------------------------------------------------
 *
 *  A. PubChem PUG-View annotations, heading "NFPA Hazard Classification".
 *     851 rows today, 840 from HSDB and 11 from OSHA, 803 carrying a CID.
 *     Public domain (US National Library of Medicine).
 *
 *  B. PubChem PUG-View per compound, heading "GHS Classification". The bulk
 *     annotations endpoint for this heading is 359 pages of 1000 rows, so it is
 *     fetched one CID at a time for the CIDs this dataset actually holds.
 *     Public domain.
 *
 *  C. English Wikipedia Chembox parameters, found with the MediaWiki search API
 *     (hastemplate:Chembox insource:"NFPA-H", about 2,600 articles) and read as
 *     wikitext in batches of 50. CC BY-SA 4.0, attributed in CHEM_DATA_META and
 *     per row through `wikipedia`.
 *
 *  D. PubChem periodic table JSON, 118 elements. Public domain.
 *
 *  E. PubChem compound properties and synonyms for the CIDs above, so a row
 *     that exists only in PubChem still has a display name, a formula and a
 *     molar mass. Public domain.
 *
 *  F. The PubChem GHS reference page, which is the plain text of every H and P
 *     statement plus the nine pictogram names. Public domain.
 *
 *  G. Every English Wikipedia article transcluding Template:Chembox,
 *     Template:Drugbox or Template:Infobox drug, about 23,000 of them, found
 *     with list=embeddedin rather than a search: CirrusSearch refuses an
 *     offset at or past 10,000 and Chembox alone is on 14,700 articles.
 *     Each article is cached trimmed to its infobox. CC BY-SA 4.0.
 *
 *  H. The lead sentence of each of those articles, through prop=extracts,
 *     twenty titles per request. CC BY-SA 4.0.
 *
 *  I. PubChem's bulk GHS Classification annotations, 359 pages of 1,000
 *     records. This is the same data as B for the whole corpus at once, which
 *     is the only way the broad tier is affordable: one request per compound
 *     would be 20,000 requests. Public domain.
 *
 *  J. PubChem compound properties by POST, 200 CIDs a request, and PUG REST
 *     name resolution for a compound whose infobox names no CID. Public domain.
 *
 * ---------------------------------------------------------------------------
 * Output
 * ---------------------------------------------------------------------------
 *
 * The narrow tier, bundled, under src/tools/_generated/:
 *
 *   chem-data.ts       CHEMICALS: Chemical[] and CHEM_DATA_META
 *   elements.ts        ELEMENTS: Element[]
 *   ghs-statements.ts  H_STATEMENTS, P_STATEMENTS, PICTOGRAMS
 *   chem-index.ts      types and helpers for the broad tier, and no data
 *   README.md          the shapes and the rebuild command
 *   .gitignore         ignores .cache/ only: the snapshots are committed
 *   .cache/chem/       raw responses plus parsed digests, gzipped
 *
 * The broad tier, fetched at runtime, under public/data/chem/:
 *
 *   index.json         one [id, name, formula, cas, molarMass, flags] row
 *                      per compound, which is enough to run a search box
 *   0.json .. 63.json  the full records, keyed by id, sharded on id % 64
 *
 * Both are committed. Workers Builds caps a build near twenty minutes and a
 * cold refetch is longer than that, so a deploy imports the dated snapshot.
 * Only .cache/ stays out of git.
 *
 * ---------------------------------------------------------------------------
 * Decisions a future tool author needs to know about
 * ---------------------------------------------------------------------------
 *
 *  - An NFPA rating is emitted only when health, fire and instability all parse
 *    to an integer 0 to 4. PubChem's 11 OSHA rows carry no rating fields at all
 *    and their diamond image code is a placeholder 0-0-0 plus a special, so
 *    they contribute a chemical but never a rating. Half a diamond is worse
 *    than no diamond in a tool people might point at a real drum.
 *  - The special symbol on a PubChem row comes from the diamond image code
 *    ("2-3-4" or "0-0-0-OX"), whose W carries a combining stroke overlay
 *    (U+0335). Combining marks are stripped before the symbol is read.
 *  - A PubChem GHS record holds several independent classifications, one per
 *    notifying body. One is chosen by the fixed GHS_SOURCE_PRIORITY below, so
 *    the result is a single coherent classification rather than the union of
 *    every jurisdiction. The distribution is printed at the end of a run.
 *  - Rows are merged on PubChem CID. When both PubChem and Wikipedia rate the
 *    same compound, PubChem wins `nfpa` and a disagreeing Wikipedia rating is
 *    kept as `nfpaAlt` so a panel can show both.
 *  - Source text is preserved. References, comments, wiki markup and HTML are
 *    stripped, entities are decoded, whitespace is collapsed, and the Unicode
 *    minus sign U+2212 becomes an ASCII hyphen so numbers parse. Nothing else
 *    is rewritten, so a value may still contain an en dash inside a range.
 *
 * No dependencies beyond node builtins.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = join(root, "src", "tools", "_generated");
// The broad tier ships as JSON the browser fetches on demand, so it lives in
// public/ rather than in a module the bundler would pull into a tool chunk.
const dataDir = join(root, "public", "data", "chem");
// Scoped to its own subdirectory: other prepare-*.mjs scripts cache under
// src/tools/_generated/.cache/ too, and --refresh clears this path outright.
const cacheDir = join(outDir, ".cache", "chem");

const args = new Set(process.argv.slice(2));
const REFRESH = args.has("--refresh");
const OFFLINE = args.has("--offline");
const NO_BROAD = args.has("--no-broad");
let BUDGET_MINUTES = 150;
/** Caps the broad tier's article list. For a smoke test, never for a real build. */
let BROAD_LIMIT = 0;
for (const arg of args) {
  const budget = /^--budget=(\d+)$/.exec(arg);
  if (budget) {
    BUDGET_MINUTES = Number(budget[1]);
    continue;
  }
  const limit = /^--limit=(\d+)$/.exec(arg);
  if (limit) {
    BROAD_LIMIT = Number(limit[1]);
    continue;
  }
  if (arg !== "--refresh" && arg !== "--offline" && arg !== "--no-broad") {
    fail(
      `unknown flag ${arg}. Supported flags are --refresh, --offline, --no-broad, ` +
        `--budget=<minutes> and --limit=<articles>.`,
    );
  }
}
if (REFRESH && OFFLINE) fail("--refresh and --offline cannot be combined.");

/** Bumped by hand when a parser change must invalidate a cached digest. */
const NFPA_PARSE_VERSION = 1;
const WIKI_PARSE_VERSION = 2;
const GHS_PARSE_VERSION = 1;
const PROPS_PARSE_VERSION = 1;
const BROAD_PARSE_VERSION = 1;
const GHS_BULK_PARSE_VERSION = 1;
/**
 * The broad tier caches each article trimmed to its infobox rather than whole.
 * 23,000 full articles are about a gigabyte; the boxes are a tenth of that.
 * Bump this when the trimmer itself changes, which is the one edit a cached
 * trim cannot survive.
 */
const WIKI_TRIM_VERSION = 1;

/**
 * Shard key is `id % CHEM_SHARD_COUNT`. CIDs are dense enough that the modulo
 * spreads evenly, which first-letter bucketing does not: a fifth of chemical
 * names start with a digit or the letter "a". 128 rather than 64 because a
 * record averages a little over half a kilobyte, so 64 buckets would put every
 * shard above 200 KB and a person who opens one compound would pay for it.
 */
const CHEM_SHARD_COUNT = 128;

/**
 * A broad tier row with no PubChem CID still needs a numeric key. Real CIDs run
 * to about 1.7e8, so ids at or above this base are this build's own invention
 * and are never a PubChem identifier. Flag bit CHEM_FLAG_CID says which is which.
 */
const SYNTHETIC_ID_BASE = 900000000;

/** Synonyms kept per broad tier record, and the length of a description snippet. */
const BROAD_SYNONYM_LIMIT = 10;
const DESCRIPTION_LIMIT = 200;

/** Target for public/data/chem/**, gzip estimated. Overflow drops fields. */
const SHIP_BUDGET_GZ_BYTES = 5 * 1024 * 1024;

/**
 * The index's own `syn` column: a much smaller cut of the per-record synonyms
 * above, meant for search rather than display. The index is fetched by every
 * visitor who opens the chemical lookup, so it carries a tighter budget of its
 * own (below) rather than riding on the whole tier's 5 MB. `IUPAC_INDEX_MAX_LENGTH`
 * keeps a long systematic name out of the column; the shard's own `synonyms`
 * still carries it uncut.
 */
const INDEX_SYN_LIMIT = 4;
const IUPAC_INDEX_MAX_LENGTH = 40;

/** index.json's own budget. Tighter than SHIP_BUDGET_GZ_BYTES on purpose. */
const INDEX_RAW_BUDGET_BYTES = 2.4 * 1024 * 1024;
const INDEX_GZ_BUDGET_BYTES = 1 * 1024 * 1024;

/** Rows per generated block. See the TS2590 note in emitChemData. */
const ROWS_PER_BLOCK = 400;

/** Identifies this build to the two APIs, as both ask that clients do. */
const USER_AGENT = "tools.maxhogan.dev build (pmaxhogan@gmail.com)";

/**
 * Which notifying body's GHS classification wins when a compound has several.
 * First is the EU harmonised legal classification, then the aggregated ECHA
 * notifications, then the three national or curated inventories. Anything not
 * listed sorts last and is taken in document order.
 */
const GHS_SOURCE_PRIORITY = [
  "Regulation (EC) No 1272/2008 of the European Parliament and of the Council",
  "European Chemicals Agency (ECHA)",
  "Hazardous Substances Data Bank (HSDB)",
  "Hazardous Chemical Information System (HCIS), Safe Work Australia",
  "NITE-CMC",
];

/** The three NFPA 704 special symbols this dataset recognizes. */
const SPECIAL_SYMBOLS = ["OX", "SA", "W"];

/**
 * Reads one white quadrant token. Wikipedia writes combinations several ways,
 * including "W+OX" and the run together "WOX", so a token is consumed greedily.
 * Anything left over means the token is not NFPA 704 at all, which is true of
 * the COR, ALK, ACID, RA, POI and CRYO symbols some articles use: those come
 * back null and the caller counts them as rejected.
 */
function splitSpecialToken(token) {
  const symbols = [];
  let rest = token;
  while (rest.length > 0) {
    const hit = SPECIAL_SYMBOLS.find((symbol) => rest.startsWith(symbol));
    if (!hit) return null;
    if (!symbols.includes(hit)) symbols.push(hit);
    rest = rest.slice(hit.length);
  }
  return symbols;
}

const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov";
const WIKI_API = "https://en.wikipedia.org/w/api.php";

const SOURCE_ATTRIBUTION = [
  {
    name: "PubChem NFPA Hazard Classification annotations (HSDB and OSHA)",
    url: `${PUBCHEM}/rest/pug_view/annotations/heading/NFPA%20Hazard%20Classification/JSON`,
    license: "Public domain (US National Library of Medicine)",
  },
  {
    name: "PubChem GHS Classification",
    url: `${PUBCHEM}/rest/pug_view/data/compound/<CID>/JSON?heading=GHS+Classification`,
    license: "Public domain (US National Library of Medicine)",
  },
  {
    name: "PubChem GHS reference (hazard statements, precautionary statements, pictograms)",
    url: `${PUBCHEM}/ghs/`,
    license: "Public domain (US National Library of Medicine)",
  },
  {
    name: "PubChem periodic table",
    url: `${PUBCHEM}/rest/pug/periodictable/JSON`,
    license: "Public domain (US National Library of Medicine)",
  },
  {
    name: "English Wikipedia Chembox parameters",
    url: "https://en.wikipedia.org/",
    license: "CC BY-SA 4.0",
  },
];

/**
 * The broad tier's attribution. A superset of the narrow tier's, with the three
 * sources only it uses. Kept separate so CHEM_DATA_META keeps describing
 * exactly what went into chem-data.ts.
 */
const BROAD_SOURCE_ATTRIBUTION = [
  ...SOURCE_ATTRIBUTION,
  {
    name: "English Wikipedia Chembox, Drugbox and Infobox drug parameters, and article leads",
    url: "https://en.wikipedia.org/",
    license: "CC BY-SA 4.0",
  },
  {
    name: "PubChem GHS Classification bulk annotations",
    url: `${PUBCHEM}/rest/pug_view/annotations/heading/GHS%20Classification/JSON`,
    license: "Public domain (US National Library of Medicine)",
  },
  {
    name: "PubChem compound properties and name resolution",
    url: `${PUBCHEM}/rest/pug/compound/`,
    license: "Public domain (US National Library of Medicine)",
  },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`prepare-chem-data: ${message}`);
  process.exit(1);
}

const START_MS = Date.now();

/**
 * Progress line carrying a wall clock time and an elapsed second count. The
 * broad tier runs for tens of minutes, and without a timestamp there is no way
 * to tell a slow step from a stalled one while watching the log.
 */
function log(message) {
  const elapsed = ((Date.now() - START_MS) / 1000).toFixed(0).padStart(5, " ");
  const clock = new Date().toISOString().slice(11, 19);
  console.log(`prepare-chem-data ${clock} +${elapsed}s: ${message}`);
}

/** Seconds left before the run should stop starting new network work. */
function budgetLeftMs() {
  return BUDGET_MINUTES * 60 * 1000 - (Date.now() - START_MS);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sorts strings by code point, so the output does not depend on the locale. */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Splits an array into chunks of at most `size`. */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Cache. Everything is gzipped: PubChem and MediaWiki JSON compress about ten
// to one, which keeps a full cold cache in the tens of megabytes.
// ---------------------------------------------------------------------------

function cachePath(rel) {
  return join(cacheDir, `${rel}.gz`);
}

function cacheRead(rel) {
  if (REFRESH) return null;
  const path = cachePath(rel);
  if (!existsSync(path)) return null;
  try {
    return gunzipSync(readFileSync(path));
  } catch {
    // A truncated file from an interrupted run is a miss, not a crash.
    return null;
  }
}

function cacheWrite(rel, buffer) {
  const path = cachePath(rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(buffer, { level: 6 }));
}

function cacheReadJson(rel) {
  const raw = cacheRead(rel);
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function cacheWriteJson(rel, value) {
  cacheWrite(rel, Buffer.from(JSON.stringify(value)));
}

function cacheBytes(dir = cacheDir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = cacheBytes(path);
      files += inner.files;
      bytes += inner.bytes;
    } else {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

// ---------------------------------------------------------------------------
// HTTP. One limiter per host: PubChem asks for no more than five requests a
// second, MediaWiki asks for a descriptive agent and modest concurrency.
// ---------------------------------------------------------------------------

function createLimiter({ concurrency, intervalMs }) {
  let active = 0;
  let nextSlot = 0;
  let interval = intervalMs;
  const queue = [];

  function pump() {
    while (queue.length > 0 && active < concurrency) {
      const job = queue.shift();
      active += 1;
      const now = Date.now();
      const at = Math.max(now, nextSlot);
      nextSlot = at + interval;
      setTimeout(() => {
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      }, at - now);
    }
  }

  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  run.setInterval = (ms) => {
    interval = ms;
  };
  run.interval = () => interval;
  return run;
}

const pubchemLimit = createLimiter({ concurrency: 4, intervalMs: 200 });
const wikiLimit = createLimiter({ concurrency: 2, intervalMs: 150 });

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const ATTEMPTS = 4;

/**
 * PubChem reports its own load in X-Throttling-Control. Anything other than
 * green widens the gap between requests, which is what keeps a 2,600 request
 * sweep from being cut off halfway through.
 */
function applyThrottleHint(header) {
  if (!header) return;
  const red = /\b(Red|Black)\b/.test(header);
  const yellow = /\bYellow\b/.test(header);
  const target = red ? 1000 : yellow ? 450 : 200;
  if (pubchemLimit.interval() !== target) {
    pubchemLimit.setInterval(target);
    log(
      `PubChem throttling is ${red ? "red" : yellow ? "yellow" : "green"}, pacing at ${target}ms`,
    );
  }
}

/**
 * One HTTP GET with retries. Returns { status, body } where body is a Buffer,
 * or { status: 404 } for a definite miss. A request that never succeeds throws,
 * and the caller decides whether that is fatal or a skipped row.
 */
async function httpGet(url, { limiter = pubchemLimit, accept = "application/json" } = {}) {
  if (OFFLINE) fail(`--offline was given but ${url} is not in the cache.`);
  let lastError = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await limiter(() =>
        fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, redirect: "follow" }),
      );
      if (limiter === pubchemLimit) applyThrottleHint(res.headers.get("x-throttling-control"));
      if (res.status === 404) {
        await res.arrayBuffer();
        return { status: 404 };
      }
      if (!res.ok) {
        await res.arrayBuffer();
        if (!RETRY_STATUS.has(res.status)) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        lastError = `HTTP ${res.status} ${res.statusText}`;
      } else {
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
      }
    } catch (err) {
      lastError = err.message;
    }
    if (attempt < ATTEMPTS) await sleep(800 * attempt * attempt);
  }
  throw new Error(`${url} failed after ${ATTEMPTS} attempts: ${lastError}`);
}

/** A cached GET. The cache holds the raw bytes, so a parser change costs nothing. */
async function cachedGet(rel, url, options) {
  const cached = cacheRead(rel);
  if (cached) return { status: 200, body: cached, fromCache: true };
  const result = await httpGet(url, options);
  if (result.status === 200) cacheWrite(rel, result.body);
  return result;
}

async function cachedGetJson(rel, url, options) {
  const result = await cachedGet(rel, url, options);
  if (result.status !== 200) return null;
  return JSON.parse(result.body.toString("utf8"));
}

/**
 * One HTTP POST with the same retry policy as httpGet. PubChem's property
 * endpoint takes the CID list in the body, which is what lifts a request from
 * the roughly 100 CIDs a URL can hold to the 200 it documents as the ceiling.
 */
async function httpPost(url, body, { limiter = pubchemLimit } = {}) {
  if (OFFLINE) fail(`--offline was given but ${url} is not in the cache.`);
  let lastError = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await limiter(() =>
        fetch(url, {
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }),
      );
      if (limiter === pubchemLimit) applyThrottleHint(res.headers.get("x-throttling-control"));
      if (res.status === 404) {
        await res.arrayBuffer();
        return { status: 404 };
      }
      if (!res.ok) {
        await res.arrayBuffer();
        if (!RETRY_STATUS.has(res.status)) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        lastError = `HTTP ${res.status} ${res.statusText}`;
      } else {
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
      }
    } catch (err) {
      lastError = err.message;
    }
    if (attempt < ATTEMPTS) await sleep(800 * attempt * attempt);
  }
  throw new Error(`${url} failed after ${ATTEMPTS} attempts: ${lastError}`);
}

async function cachedPostJson(rel, url, body, options) {
  const cached = cacheRead(rel);
  if (cached) return JSON.parse(cached.toString("utf8"));
  const result = await httpPost(url, body, options);
  if (result.status !== 200) return null;
  cacheWrite(rel, result.body);
  return JSON.parse(result.body.toString("utf8"));
}

// ---------------------------------------------------------------------------
// Text cleanup shared by both sources
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  minus: "-",
  deg: "°",
  times: "×",
  middot: "·",
  plusmn: "±",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  prime: "′",
  hellip: "...",
  frac12: "1/2",
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Strips HTML tags, keeping superscript and subscript readable. */
function stripHtml(text) {
  return text
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/<sup>([^<]*)<\/sup>/gi, "^$1")
    .replace(/<sub>([^<]*)<\/sub>/gi, "$1")
    .replace(/<[^>]*>/g, "");
}

/**
 * The Unicode minus sign reads as a minus and parses as NaN, so it becomes an
 * ASCII hyphen. Nothing else about the character content is touched: accented
 * letters are part of plenty of legitimate chemical names.
 */
function normaliseMinus(text) {
  return String(text).replace(/\u2212/g, "-");
}

/**
 * Drops combining marks. Used only where a mark is decoration rather than
 * spelling: PubChem writes the NFPA "no water" W with a combining stroke
 * overlay (U+0335), which no plain comparison would match.
 */
function stripCombining(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC");
}

function collapse(text) {
  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Step D. Periodic table
// ---------------------------------------------------------------------------

/** Period boundaries by atomic number, index 0 is period 1. */
const PERIOD_STARTS = [1, 3, 11, 19, 37, 55, 87];

function periodOf(z) {
  let period = 1;
  for (let i = 0; i < PERIOD_STARTS.length; i += 1) if (z >= PERIOD_STARTS[i]) period = i + 1;
  return period;
}

/**
 * Group 1 to 18, or undefined for the f block (57 to 71 and 89 to 103), which
 * has no group and is laid out as a separate strip.
 */
function groupOf(z) {
  if (z === 1) return 1;
  if (z === 2) return 18;
  if ((z >= 57 && z <= 71) || (z >= 89 && z <= 103)) return undefined;
  if (z >= 3 && z <= 10) return z <= 4 ? z - 2 : z + 8;
  if (z >= 11 && z <= 18) return z <= 12 ? z - 10 : z;
  if (z >= 19 && z <= 36) return z - 18;
  if (z >= 37 && z <= 54) return z - 36;
  if (z === 55 || z === 87) return 1;
  if (z === 56 || z === 88) return 2;
  if (z >= 72 && z <= 86) return z - 68;
  if (z >= 104 && z <= 118) return z - 100;
  return undefined;
}

/** "1.0080" or "[271]" to a number, or undefined when the cell is empty. */
function toNumber(value) {
  if (typeof value !== "string") return undefined;
  const text = normaliseMinus(value)
    .replace(/[[\]()]/g, "")
    .trim();
  if (text === "") return undefined;
  const match = /^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(text);
  if (!match) return undefined;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : undefined;
}

function toText(value) {
  if (typeof value !== "string") return undefined;
  const text = collapse(value);
  return text === "" ? undefined : text;
}

async function buildElements() {
  const table = await cachedGetJson("periodictable.json", `${PUBCHEM}/rest/pug/periodictable/JSON`);
  if (!table) fail("the PubChem periodic table endpoint returned no data.");
  const columns = table.Table.Columns.Column;
  const index = (name) => columns.indexOf(name);
  const at = (cells, name) => cells[index(name)];

  const elements = table.Table.Row.map((row) => {
    const cells = row.Cell;
    const atomicNumber = Number(at(cells, "AtomicNumber"));
    return {
      atomicNumber,
      symbol: at(cells, "Symbol"),
      name: at(cells, "Name"),
      atomicMass: toNumber(at(cells, "AtomicMass")),
      atomicMassText: toText(at(cells, "AtomicMass")),
      period: periodOf(atomicNumber),
      group: groupOf(atomicNumber),
      cpkHexColor: toText(at(cells, "CPKHexColor")),
      electronConfiguration: toText(at(cells, "ElectronConfiguration")),
      electronegativity: toNumber(at(cells, "Electronegativity")),
      atomicRadius: toNumber(at(cells, "AtomicRadius")),
      ionizationEnergy: toNumber(at(cells, "IonizationEnergy")),
      electronAffinity: toNumber(at(cells, "ElectronAffinity")),
      oxidationStates: toText(at(cells, "OxidationStates")),
      standardState: toText(at(cells, "StandardState")),
      meltingPoint: toNumber(at(cells, "MeltingPoint")),
      boilingPoint: toNumber(at(cells, "BoilingPoint")),
      density: toNumber(at(cells, "Density")),
      groupBlock: toText(at(cells, "GroupBlock")),
      yearDiscovered: toText(at(cells, "YearDiscovered")),
    };
  }).sort((a, b) => a.atomicNumber - b.atomicNumber);

  if (elements.length !== 118) {
    fail(`the periodic table returned ${elements.length} elements, expected 118.`);
  }
  return elements;
}

// ---------------------------------------------------------------------------
// Step F. GHS reference page: statement text and pictogram names
// ---------------------------------------------------------------------------

async function buildGhsReference() {
  const result = await cachedGet("ghs-reference.html", `${PUBCHEM}/ghs/`, { accept: "text/html" });
  if (result.status !== 200) fail("the PubChem GHS reference page could not be read.");
  const html = result.body.toString("utf8");

  // Most entries read "<img>Name<br>Hazard class<br>GHS0n", but GHS08 and
  // GHS09 carry no hazard class line, so the pieces are split rather than
  // matched positionally.
  const pictograms = [];
  for (const m of html.matchAll(
    /<span class="pict"><img src="[^"]*\/(GHS\d\d)\.svg">([\s\S]*?)<\/span>/g,
  )) {
    const pieces = m[2]
      .split(/<br\s*\/?>/i)
      .map((piece) => collapse(decodeEntities(stripHtml(piece))))
      .filter(Boolean);
    const code = m[1];
    const trailing = pieces[pieces.length - 1] === code ? pieces.slice(0, -1) : pieces;
    pictograms.push({
      code,
      name: trailing[0] ?? code,
      hazardClass: trailing.length > 1 ? trailing[1] : undefined,
    });
  }

  const hStatements = {};
  for (const m of html.matchAll(
    /<td dl="H-Code" id="(H\d{3})">[^<]*<\/td><td dl="Hazard Statement">([\s\S]*?)<\/td>/g,
  )) {
    const text = collapse(decodeEntities(stripHtml(m[2])));
    if (text) hStatements[m[1]] = text;
  }

  const pStatements = {};
  for (const m of html.matchAll(
    /<b id="(P\d{3}(?:\+P\d{3})*)">[^<]*<\/b>([\s\S]*?)(?:<br>|<\/p>)/g,
  )) {
    const text = collapse(decodeEntities(stripHtml(m[2])));
    if (text) pStatements[m[1]] = text;
  }

  if (pictograms.length !== 9) {
    fail(`the GHS reference page yielded ${pictograms.length} pictograms, expected 9.`);
  }
  if (Object.keys(hStatements).length < 50 || Object.keys(pStatements).length < 50) {
    fail("the GHS reference page yielded too few statements. Its markup probably changed.");
  }
  return { pictograms, hStatements, pStatements };
}

// ---------------------------------------------------------------------------
// Step A. PubChem NFPA annotations
// ---------------------------------------------------------------------------

/** Reads a rating from "3 - Materials that ...". */
function ratingFromString(text) {
  if (typeof text !== "string") return undefined;
  const m = /^\s*([0-4])\b/.exec(normaliseMinus(text));
  return m ? Number(m[1]) : undefined;
}

/** Pulls the special symbol out of a diamond image code such as "0-0-0-OX". */
function specialsFromDiamond(code) {
  if (typeof code !== "string") return [];
  const parts = stripCombining(normaliseMinus(code)).split("-");
  if (parts.length < 4) return [];
  const out = [];
  for (const token of parts
    .slice(3)
    .join(" ")
    .split(/[\s+,/&]+/)) {
    for (const symbol of splitSpecialToken(token.trim().toUpperCase()) ?? []) {
      if (!out.includes(symbol)) out.push(symbol);
    }
  }
  return out;
}

async function buildNfpaRows() {
  const digestKey = `digest/pubchem-nfpa.v${NFPA_PARSE_VERSION}.json`;
  const digest = cacheReadJson(digestKey);
  if (digest) return digest;

  const annotations = [];
  let page = 1;
  // Assigned from the first response, before the loop condition reads it.
  let totalPages;
  do {
    const url = `${PUBCHEM}/rest/pug_view/annotations/heading/NFPA%20Hazard%20Classification/JSON?page=${page}`;
    const json = await cachedGetJson(`pubchem-nfpa/page-${page}.json`, url);
    if (!json) fail(`the NFPA annotations endpoint returned nothing for page ${page}.`);
    totalPages = Number(json.Annotations.TotalPages ?? 1);
    annotations.push(...(json.Annotations.Annotation ?? []));
    page += 1;
  } while (page <= totalPages);

  const rows = [];
  const stats = { total: annotations.length, withCid: 0, multiCid: 0, rated: 0, specialOnly: 0 };
  for (const ann of annotations) {
    const cids = ann.LinkedRecords?.CID ?? [];
    if (cids.length > 0) stats.withCid += 1;
    if (cids.length > 1) stats.multiCid += 1;

    const byName = new Map();
    for (const item of ann.Data ?? []) {
      if (!byName.has(item.Name)) byName.set(item.Name, item.Value?.StringWithMarkup ?? []);
    }
    const diamond = byName.get("NFPA 704 Diamond")?.[0]?.Markup?.[0]?.Extra ?? "";
    const h = ratingFromString(byName.get("NFPA Health Rating")?.[0]?.String);
    const f = ratingFromString(byName.get("NFPA Fire Rating")?.[0]?.String);
    const r = ratingFromString(byName.get("NFPA Instability Rating")?.[0]?.String);

    // The diamond code is a cross check, not the source of truth: PubChem's
    // OSHA rows carry a placeholder 0-0-0 with no rating fields behind it.
    const rated = h !== undefined && f !== undefined && r !== undefined;
    if (rated) stats.rated += 1;
    else if (specialsFromDiamond(diamond).length > 0) stats.specialOnly += 1;

    const source = ann.SourceName?.includes("Occupational") ? "OSHA" : "HSDB";
    rows.push({
      sourceId: String(ann.SourceID ?? ""),
      source,
      name: collapse(String(ann.Name ?? "")),
      url: ann.URL ?? "",
      cid: cids.length > 0 ? Number(cids[0]) : undefined,
      nfpa: rated ? { h, f, r, special: specialsFromDiamond(diamond), source } : undefined,
    });
  }

  const result = { rows, stats };
  cacheWriteJson(digestKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Step C. Wikipedia Chembox
// ---------------------------------------------------------------------------

/** Returns the index just past the `{{ ... }}` that starts at `start`. */
function templateEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth += 1;
      i += 1;
    } else if (text[i] === "}" && text[i + 1] === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Splits template content at its top level pipes. Nested templates, wiki links
 * and wikitables all contain pipes of their own, so each is tracked.
 *
 * A wikitable marker is only a wikitable marker at the start of a line, which
 * is the rule the wikitext parser itself uses. Without that condition a
 * template ending in an empty parameter, "{{IPAc-en|l|i|n|}}", reads its "|}}"
 * as a table close, the brace depth never returns to zero, and every parameter
 * after it is swallowed into one value.
 */
function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let link = 0;
  let table = 0;
  let start = 0;
  const atLineStart = (i) => {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (inner[j] === "\n") return true;
      if (inner[j] !== " " && inner[j] !== "\t") return false;
    }
    return true;
  };
  for (let i = 0; i < inner.length; i += 1) {
    const a = inner[i];
    const b = inner[i + 1];
    if (a === "{" && b === "{") {
      depth += 1;
      i += 1;
    } else if (a === "}" && b === "}") {
      depth -= 1;
      i += 1;
    } else if (a === "[" && b === "[") {
      link += 1;
      i += 1;
    } else if (a === "]" && b === "]") {
      link -= 1;
      i += 1;
    } else if (a === "{" && b === "|" && atLineStart(i)) {
      table += 1;
      i += 1;
    } else if (a === "|" && b === "}" && atLineStart(i)) {
      table -= 1;
      i += 1;
    } else if (a === "|" && depth <= 0 && link <= 0 && table <= 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

/**
 * Every top level template matching `re` in a page, as [start, end) index
 * pairs. `re` must be global and must match the opening `{{` of the template.
 */
function templateRegions(text, re) {
  const regions = [];
  let match;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    const end = templateEnd(text, match.index);
    if (end === -1) break;
    regions.push([match.index, end]);
    // Skip the nested subtemplates (Chembox Identifiers and the like).
    re.lastIndex = end;
  }
  return regions;
}

/** Every top level Chembox in a page, as [start, end) index pairs. */
function chemboxRegions(text) {
  return templateRegions(text, /\{\{\s*Chembox\b/gi);
}

/**
 * The infobox templates the broad tier reads. Chembox is the general chemical
 * box; Drugbox is a redirect to Infobox drug and both spellings are still in
 * use across articles, so both are matched.
 */
const BROAD_BOX_RE = /\{\{\s*(Chembox|Drugbox|Infobox[ _]drug)\b/gi;

/** Every top level Chembox, Drugbox or Infobox drug in a page. */
function broadBoxRegions(text) {
  return templateRegions(text, new RegExp(BROAD_BOX_RE.source, "gi"));
}

/**
 * Flattens one Chembox and its Section subtemplates into a parameter map.
 * First definition wins, which keeps the outer Name and IUPACName ahead of any
 * repeat inside a section.
 */
function flattenChembox(inner) {
  const params = new Map();
  const visit = (body) => {
    for (const part of splitTopLevel(body).slice(1)) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key === "") continue;
      if (/^\{\{\s*Chembox\b/i.test(value)) {
        const innerEnd = templateEnd(value, 0);
        if (innerEnd !== -1) visit(value.slice(2, innerEnd - 2));
        continue;
      }
      if (!params.has(key)) params.set(key, value);
    }
  };
  visit(inner);
  return params;
}

/**
 * The parameters of the page's Chembox. A few articles carry two of them, one
 * per isomer or per related compound, with the rating in the second, so the
 * first box that actually declares NFPA-H wins and the first box overall is the
 * fallback.
 */
function chemboxParams(wikitext) {
  const text = wikitext.replace(/<!--[\s\S]*?-->/g, "");
  let first = null;
  for (const [start, end] of chemboxRegions(text)) {
    const params = flattenChembox(text.slice(start + 2, end - 2));
    if (first === null) first = params;
    const health = params.get("NFPA-H");
    if (typeof health === "string" && health.trim() !== "") return params;
  }
  return first ?? new Map();
}

/**
 * Expands the handful of templates that carry real content and drops the rest,
 * which are citation and verification markers. Innermost first, so nesting
 * resolves without recursion.
 */
function expandTemplates(text) {
  let out = text;
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    out = out.replace(/\{\{([^{}]*)\}\}/g, (whole, body) => {
      changed = true;
      const parts = splitTopLevel(`|${body}`).slice(1);
      const name = String(parts.shift() ?? "")
        .trim()
        .toLowerCase();
      const positional = parts
        .filter((p) => !/^\s*[A-Za-z][\w-]*\s*=/.test(p))
        .map((p) => p.trim());
      switch (name) {
        case "chem":
        case "chem2":
          return positional.join("");
        case "convert":
        case "cvt":
        case "val":
          return positional.slice(0, 2).join(" ");
        case "ubl":
        case "ubli":
        case "unbulleted list":
        case "plainlist":
        case "flatlist":
        case "hlist":
        case "cslist":
          return positional.join("; ");
        case "sub":
          return positional.join("");
        case "sup":
          return `^${positional.join("")}`;
        case "sc":
        case "smallcaps":
        case "nowrap":
        case "nobr":
        case "abbr":
        case "lang":
          return positional[positional.length - 1] ?? "";
        case "frac":
        case "fraction":
          return positional.join("/");
        default:
          return "";
      }
    });
    if (!changed) break;
  }
  return out;
}

/** Turns a raw Chembox parameter value into plain readable text. */
function cleanWikiValue(raw) {
  if (typeof raw !== "string") return "";
  let text = raw;
  text = text.replace(/<ref[^>]*\/>/gi, "");
  text = text.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = expandTemplates(text);
  text = text.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1");
  text = text.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1").replace(/\[https?:\/\/\S+\]/g, "");
  text = stripHtml(text);
  text = text.replace(/'{2,5}/g, "");
  text = decodeEntities(text);
  text = normaliseMinus(text);
  text = text.replace(/\(\s*\)/g, " ").replace(/\[\s*\]/g, " ");
  text = collapse(text);
  text = text.replace(/^[;,*\s]+/, "").replace(/[;,*\s]+$/, "");
  return text;
}

/**
 * Splits an OtherNames value into individual synonyms. Line breaks and list
 * bullets become separators before the templates expand, because the list
 * templates join their own items with the same separator.
 */
function splitNames(raw) {
  if (typeof raw !== "string") return [];
  const listed = raw.replace(/<br\s*\/?>/gi, ";").replace(/^\s*\*+/gm, ";");
  return expandTemplates(listed)
    .split(/[;\n]/)
    .map((piece) => cleanWikiValue(piece))
    .filter(Boolean);
}

function firstNumber(text) {
  const m = /-?\d[\d,]*\.?\d*/.exec(normaliseMinus(String(text)).replace(/,(?=\d{3}\b)/g, ""));
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Renders a temperature parameter. The `...C` family is Celsius by definition,
 * so a bare number gains its unit; anything else is passed through as written.
 */
function temperatureText(params, celsiusKey, plainKey) {
  const celsius = cleanWikiValue(params.get(celsiusKey) ?? "");
  if (celsius && /^[-+]?[\d.,]+(\s*(to|and)\s*[-+]?[\d.,]+)?$/.test(celsius)) {
    return `${celsius} °C`;
  }
  if (celsius) return celsius;
  const plain = cleanWikiValue(params.get(plainKey) ?? "");
  return plain || undefined;
}

const NOT_A_VALUE = /^(n\/?a|none|unknown|-|\?|nil)$/i;

function usable(text) {
  return typeof text === "string" && text !== "" && !NOT_A_VALUE.test(text);
}

async function wikiSearchTitles() {
  const titles = [];
  let offset = 0;
  let totalHits = 0;
  for (let round = 0; round < 20; round += 1) {
    const url = new URL(WIKI_API);
    url.search = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      list: "search",
      srsearch: 'hastemplate:Chembox insource:"NFPA-H"',
      srnamespace: "0",
      srlimit: "500",
      srinfo: "totalhits",
      srprop: "",
      sroffset: String(offset),
    }).toString();
    const json = await cachedGetJson(`wiki-search/offset-${offset}.json`, url.toString(), {
      limiter: wikiLimit,
    });
    if (!json) fail(`the Wikipedia search API returned nothing at offset ${offset}.`);
    totalHits = json.query?.searchinfo?.totalhits ?? totalHits;
    for (const hit of json.query?.search ?? []) titles.push(hit.title);
    const next = json.continue?.sroffset;
    if (next === undefined) break;
    offset = next;
  }
  const unique = [...new Set(titles)].sort(compareStrings);
  log(`Wikipedia search matched ${totalHits} articles, listed ${unique.length}`);
  return unique;
}

async function buildWikiRows(elements) {
  const massBySymbol = new Map(elements.map((e) => [e.symbol, e.atomicMass]));
  const titles = await wikiSearchTitles();
  const digestKey = `digest/wikipedia.v${WIKI_PARSE_VERSION}.${sha256(titles.join("")).slice(0, 16)}.json`;
  const digest = cacheReadJson(digestKey);
  if (digest) return digest;

  const batches = chunk(titles, 50);
  const wikitexts = new Map();
  let done = 0;
  for (const batch of batches) {
    const key = sha256(batch.join("")).slice(0, 24);
    const url = new URL(WIKI_API);
    url.search = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: batch.join("|"),
    }).toString();
    const json = await cachedGetJson(`wiki-content/${key}.json`, url.toString(), {
      limiter: wikiLimit,
    });
    if (!json) fail("the Wikipedia content API returned nothing for a batch of titles.");
    for (const page of json.query?.pages ?? []) {
      const content = page.revisions?.[0]?.slots?.main?.content;
      if (typeof content === "string") wikitexts.set(page.title, content);
    }
    done += batch.length;
    if (done % 500 < 50) log(`Wikipedia wikitext ${done}/${titles.length}`);
  }

  const rows = [];
  const specialsSeen = new Map();
  const stats = { pages: wikitexts.size, rated: 0, partial: 0, withCid: 0, withCas: 0 };

  for (const title of [...wikitexts.keys()].sort(compareStrings)) {
    const params = chemboxParams(wikitexts.get(title));
    if (params.size === 0) continue;

    const h = ratingFromString(cleanWikiValue(params.get("NFPA-H") ?? ""));
    const f = ratingFromString(cleanWikiValue(params.get("NFPA-F") ?? ""));
    const r = ratingFromString(cleanWikiValue(params.get("NFPA-R") ?? params.get("NFPA-I") ?? ""));

    const rawSpecial = cleanWikiValue(params.get("NFPA-S") ?? "");
    const special = [];
    if (rawSpecial) {
      for (const token of stripCombining(rawSpecial).split(/[\s+,/&]+/)) {
        const symbol = token.trim().toUpperCase();
        if (symbol === "") continue;
        specialsSeen.set(symbol, (specialsSeen.get(symbol) ?? 0) + 1);
        for (const known of splitSpecialToken(symbol) ?? []) {
          if (!special.includes(known)) special.push(known);
        }
      }
    }

    const rated = h !== undefined && f !== undefined && r !== undefined;
    if (rated) stats.rated += 1;
    else if (h !== undefined || f !== undefined || r !== undefined) stats.partial += 1;

    const casRaw = cleanWikiValue(params.get("CASNo") ?? "");
    const cas = /(\d{2,7}-\d{2}-\d)/.exec(casRaw)?.[1];
    if (cas) stats.withCas += 1;

    const cidRaw = cleanWikiValue(params.get("PubChem") ?? "");
    const cid = /^(\d{1,9})$/.test(cidRaw) ? Number(cidRaw) : undefined;
    if (cid !== undefined) stats.withCid += 1;

    // The Chembox element count form, `|C=3|H=6|O=1`, is exact where present.
    const counts = [];
    for (const [key, value] of params) {
      if (!/^[A-Z][a-z]?$/.test(key)) continue;
      if (!massBySymbol.has(key)) continue;
      const n = Number(cleanWikiValue(value));
      if (Number.isInteger(n) && n > 0 && n < 1000) counts.push([key, n]);
    }
    let countFormula;
    let countMass;
    if (counts.length > 0 && counts.every(([symbol]) => massBySymbol.get(symbol) !== undefined)) {
      countFormula = counts.map(([symbol, n]) => (n === 1 ? symbol : `${symbol}${n}`)).join("");
      countMass =
        Math.round(counts.reduce((sum, [s, n]) => sum + massBySymbol.get(s) * n, 0) * 1000) / 1000;
    }

    let formula = cleanWikiValue(
      params.get("Formula") ?? params.get("ChemFormula") ?? params.get("chemical formula") ?? "",
    );
    formula = formula.split(/[,;]/)[0].trim();
    if (!usable(formula)) formula = countFormula;

    const molarMassText = cleanWikiValue(params.get("MolarMass") ?? "");
    const molarMass = usable(molarMassText) ? firstNumber(molarMassText) : countMass;

    const iupac = cleanWikiValue(params.get("IUPACName") ?? "");
    const systematic = cleanWikiValue(params.get("SystematicName") ?? "");
    const synonyms = [iupac, systematic, ...splitNames(params.get("OtherNames") ?? "")].filter(
      usable,
    );

    const props = {
      density: cleanWikiValue(params.get("Density") ?? "") || undefined,
      meltingPoint: temperatureText(params, "MeltingPtC", "MeltingPt"),
      boilingPoint: temperatureText(params, "BoilingPtC", "BoilingPt"),
      flashPoint: temperatureText(params, "FlashPtC", "FlashPt"),
    };

    rows.push({
      title,
      cid,
      cas,
      formula: usable(formula) ? formula : undefined,
      molarMass: Number.isFinite(molarMass) ? molarMass : undefined,
      synonyms,
      nfpa: rated ? { h, f, r, special, source: "Wikipedia" } : undefined,
      props: Object.fromEntries(Object.entries(props).filter(([, v]) => usable(v))),
    });
  }

  const result = {
    rows,
    stats,
    specialsSeen: [...specialsSeen].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0])),
  };
  cacheWriteJson(digestKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Step B. GHS classification, one CID at a time
// ---------------------------------------------------------------------------

/** Collects every "GHS Classification" section, however deeply nested. */
function ghsSections(sections, out = []) {
  for (const section of sections ?? []) {
    if (section.TOCHeading === "GHS Classification" && section.Information) out.push(section);
    if (section.Section) ghsSections(section.Section, out);
  }
  return out;
}

/** The order PubChem writes a single classification's fields in. */
const GHS_FIELD_ORDER = [
  "Note",
  "Pictogram(s)",
  "Signal",
  "GHS Hazard Statements",
  "Precautionary Statement Codes",
  "ECHA C&L Notifications Summary",
];

function ghsFieldRank(name) {
  const i = GHS_FIELD_ORDER.indexOf(name);
  return i === -1 ? GHS_FIELD_ORDER.length : i;
}

/**
 * Splits one section's Information entries into blocks, where a block is one
 * notifying body's classification. PubChem stacks several notifications under a
 * single reference number, so a block also ends whenever the field order stops
 * increasing: that is where the next record begins.
 */
function ghsBlocks(section, referenceNames) {
  const blocks = [];
  let current = null;
  let lastRank = -1;
  for (const info of section.Information ?? []) {
    const source = referenceNames.get(info.ReferenceNumber) ?? "Unknown";
    const rank = ghsFieldRank(info.Name);
    const restart =
      current === null || current.reference !== info.ReferenceNumber || rank <= lastRank;
    if (restart) {
      current = { reference: info.ReferenceNumber, source, entries: [] };
      blocks.push(current);
    }
    lastRank = rank;
    current.entries.push(info);
  }
  return blocks;
}

function extractGhsBlock(block) {
  const pictograms = [];
  let signal;
  const h = [];
  const p = [];

  for (const info of block.entries) {
    const strings = info.Value?.StringWithMarkup ?? [];
    if (info.Name === "Pictogram(s)") {
      for (const swm of strings) {
        for (const markup of swm.Markup ?? []) {
          const code = /\/images\/ghs\/(GHS\d\d)\.svg/.exec(markup.URL ?? "")?.[1];
          if (code && !pictograms.includes(code)) pictograms.push(code);
        }
      }
    } else if (info.Name === "Signal") {
      const value = collapse(strings[0]?.String ?? "");
      if (value === "Danger" || value === "Warning") signal = value;
    } else if (info.Name === "GHS Hazard Statements") {
      for (const swm of strings) {
        const raw = collapse(decodeEntities(swm.String ?? ""));
        // "H225: text" and the ECHA form "H225 (> 99.9%): text".
        const m = /^(H\d{3})\s*(?:\([^)]*\)\s*)?:\s*(.+)$/.exec(raw);
        if (!m) continue;
        if (!h.some((s) => s.code === m[1])) h.push({ code: m[1], text: m[2].trim() });
      }
    } else if (info.Name === "Precautionary Statement Codes") {
      for (const swm of strings) {
        for (const markup of swm.Markup ?? []) {
          const code = /\/ghs\/#(P\d{3}(?:\+P\d{3})*)/.exec(markup.URL ?? "")?.[1];
          if (code && !p.includes(code)) p.push(code);
        }
        if ((swm.Markup ?? []).length === 0) {
          for (const m of (swm.String ?? "").matchAll(/\bP\d{3}(?:\+P\d{3})*/g)) {
            if (!p.includes(m[0])) p.push(m[0]);
          }
        }
      }
    }
  }

  if (pictograms.length === 0 && signal === undefined && h.length === 0) return null;
  return { pictograms, signal, h, p, source: block.source };
}

/** 0 for a classification that carries a pictogram or a signal word, 1 otherwise. */
function completeness(value) {
  return value.pictograms.length > 0 || value.signal !== undefined ? 0 : 1;
}

function extractGhs(record) {
  const referenceNames = new Map(
    (record.Reference ?? []).map((ref) => [ref.ReferenceNumber, ref.SourceName ?? "Unknown"]),
  );
  const blocks = [];
  for (const section of ghsSections(record.Section)) {
    blocks.push(...ghsBlocks(section, referenceNames));
  }
  const rank = (source) => {
    const i = GHS_SOURCE_PRIORITY.indexOf(source);
    return i === -1 ? GHS_SOURCE_PRIORITY.length : i;
  };
  const extracted = blocks
    .map((block, index) => ({ value: extractGhsBlock(block), source: block.source, index }))
    .filter((entry) => entry.value !== null);
  extracted.sort(
    (a, b) =>
      rank(a.source) - rank(b.source) ||
      completeness(a.value) - completeness(b.value) ||
      a.index - b.index,
  );
  return extracted.length > 0 ? extracted[0].value : null;
}

async function buildGhsByCid(cids) {
  const sorted = [...cids].sort((a, b) => a - b);
  const digestKey = `digest/ghs.v${GHS_PARSE_VERSION}.${sha256(sorted.join(",")).slice(0, 16)}.json`;
  const digest = cacheReadJson(digestKey);
  if (digest) {
    return { byCid: new Map(digest.entries), sourceCounts: digest.sourceCounts, errors: 0 };
  }

  const byCid = new Map();
  const sourceCounts = new Map();
  let done = 0;
  let errors = 0;
  let fetched = 0;

  const work = sorted.map((cid) => async () => {
    const rel = `ghs/${cid}.json`;
    let record = null;
    const cached = cacheRead(rel);
    if (cached) {
      const parsed = JSON.parse(cached.toString("utf8"));
      record = parsed.__none ? null : parsed.Record;
    } else {
      try {
        const result = await httpGet(
          `${PUBCHEM}/rest/pug_view/data/compound/${cid}/JSON?heading=GHS+Classification`,
        );
        fetched += 1;
        if (result.status === 404) {
          // A definite miss is worth remembering. A transient failure is not.
          cacheWrite(rel, Buffer.from('{"__none":true}'));
        } else {
          cacheWrite(rel, result.body);
          record = JSON.parse(result.body.toString("utf8")).Record;
        }
      } catch (err) {
        errors += 1;
        if (errors <= 5) log(`GHS for CID ${cid} could not be read: ${err.message}`);
      }
    }
    if (record) {
      const ghs = extractGhs(record);
      if (ghs) {
        byCid.set(cid, ghs);
        sourceCounts.set(ghs.source, (sourceCounts.get(ghs.source) ?? 0) + 1);
      }
    }
    done += 1;
    if (done % 200 === 0) {
      log(`GHS ${done}/${sorted.length} compounds (${byCid.size} classified, ${errors} failed)`);
    }
  });

  // The limiter already bounds concurrency, so the whole list can be started.
  await Promise.all(work.map((fn) => fn()));

  if (errors === 0) {
    cacheWriteJson(digestKey, {
      entries: [...byCid].sort((a, b) => a[0] - b[0]),
      sourceCounts: [...sourceCounts].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0])),
    });
  } else {
    log(`${errors} GHS requests failed, so the parsed digest was not written`);
  }
  log(`GHS done: ${byCid.size} classified, ${fetched} newly fetched, ${errors} failed`);
  return {
    byCid,
    sourceCounts: [...sourceCounts].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0])),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Step E. PubChem properties and synonyms
// ---------------------------------------------------------------------------

/**
 * Registry numbers, database accessions and machine strings are not synonyms.
 * Every prefix pattern demands digits or an explicit separator, because a bare
 * prefix list would throw away real names: "Undecane" starts with UN and
 * "Ecgonine" with EC.
 */
const JUNK_SYNONYM = [
  /^\d{2,7}-\d{2}-\d$/,
  /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/,
  /^InChI=/i,
  /^(CHEBI|CHEMBL|DTXSID|DTXCID|MFCD|NSC|UNII|EINECS|AI3|BRN|CCRIS|HSDB|NCGC|SCHEMBL|WLN|AKOS|BDBM|SMR|MLS|STL|CID|SID|FEMA|EPA|OSHA)[\s:_-]?\d+\S*$/i,
  /^(EC|UN|CAS|RTECS|KEGG|ChemSpider)[\s:_-]\S*$/i,
  /^Q\d+$/,
  /^(?=.*\d)[0-9A-Z]{10}$/,
  /^[A-Za-z][A-Za-z ]*:\s*\d+$/,
  /^[A-Z]{1,4}[- ]?\d{3,}$/,
  /^\d+$/,
  /^[\d\s.,;:+*=/\\[\]()#@-]+$/,
];

function isJunkSynonym(text) {
  if (text.length < 2 || text.length > 60) return true;
  return JUNK_SYNONYM.some((re) => re.test(text));
}

async function buildPubchemFacts(cids) {
  const sorted = [...cids].sort((a, b) => a - b);
  const digestKey = `digest/props.v${PROPS_PARSE_VERSION}.${sha256(sorted.join(",")).slice(0, 16)}.json`;
  const digest = cacheReadJson(digestKey);
  if (digest) return new Map(digest);

  const facts = new Map();
  const batches = chunk(sorted, 100);
  let done = 0;

  for (const batch of batches) {
    const list = batch.join(",");
    const key = sha256(list).slice(0, 24);
    const props = await cachedGetJson(
      `pubchem-props/${key}.json`,
      `${PUBCHEM}/rest/pug/compound/cid/${list}/property/MolecularFormula,MolecularWeight,IUPACName,Title/JSON`,
    );
    for (const row of props?.PropertyTable?.Properties ?? []) {
      const cid = Number(row.CID);
      const entry = facts.get(cid) ?? { synonyms: [] };
      if (row.Title) entry.title = collapse(String(row.Title));
      if (row.MolecularFormula) entry.formula = collapse(String(row.MolecularFormula));
      const mass = Number(row.MolecularWeight);
      if (Number.isFinite(mass)) entry.molarMass = mass;
      if (row.IUPACName) entry.iupacName = collapse(String(row.IUPACName));
      facts.set(cid, entry);
    }

    const syn = await cachedGetJson(
      `pubchem-synonyms/${key}.json`,
      `${PUBCHEM}/rest/pug/compound/cid/${list}/synonyms/JSON`,
    );
    for (const row of syn?.InformationList?.Information ?? []) {
      const cid = Number(row.CID);
      const entry = facts.get(cid) ?? { synonyms: [] };
      const kept = [];
      for (const raw of row.Synonym ?? []) {
        const text = collapse(String(raw));
        if (isJunkSynonym(text)) continue;
        if (kept.some((k) => k.toLowerCase() === text.toLowerCase())) continue;
        kept.push(text);
        if (kept.length >= 8) break;
      }
      entry.synonyms = kept;
      facts.set(cid, entry);
    }

    done += batch.length;
    log(`PubChem facts ${done}/${sorted.length}`);
  }

  cacheWriteJson(
    digestKey,
    [...facts].sort((a, b) => a[0] - b[0]),
  );
  return facts;
}

// ---------------------------------------------------------------------------
// Steps G to K. The broad tier: every article carrying a Chembox, a Drugbox or
// an Infobox drug, whether or not it declares an NFPA rating.
//
// The narrow tier above ships inside the JavaScript bundle, so it has to stay
// small. This tier ships as JSON under public/data/chem/ and is fetched on
// demand, so it can be an order of magnitude larger without costing a byte on
// a page that never opens the chemical lookup.
// ---------------------------------------------------------------------------

/**
 * Articles transcluding one template, through list=embeddedin.
 *
 * Not through list=search with `hastemplate:`, which is how the narrow tier
 * finds its 2,600 articles: CirrusSearch refuses an offset at or past 10,000
 * ("cirrussearch-offset-too-large"), and Chembox alone is on about 14,700
 * articles. embeddedin pages through templatelinks instead, which has no such
 * ceiling and is also the authoritative list rather than a search index.
 */
async function embeddedInTitles(template) {
  const titles = [];
  let cont;
  for (let round = 0; round < 200; round += 1) {
    const params = {
      action: "query",
      format: "json",
      formatversion: "2",
      list: "embeddedin",
      eititle: template,
      einamespace: "0",
      eifilterredir: "nonredirects",
      eilimit: "500",
    };
    if (cont) params.eicontinue = cont;
    const url = new URL(WIKI_API);
    url.search = new URLSearchParams(params).toString();
    const key = `${template.replace(/[^A-Za-z0-9]+/g, "-")}/${cont ? sha256(cont).slice(0, 16) : "start"}`;
    const json = await cachedGetJson(`wiki-embeddedin/${key}.json`, url.toString(), {
      limiter: wikiLimit,
    });
    if (!json) fail(`the Wikipedia embeddedin API returned nothing for ${template}.`);
    for (const page of json.query?.embeddedin ?? []) titles.push(page.title);
    cont = json.continue?.eicontinue;
    if (!cont) break;
  }
  log(`  ${template}: ${titles.length} articles`);
  return titles;
}

async function broadCandidateTitles() {
  const all = [];
  for (const template of ["Template:Chembox", "Template:Drugbox", "Template:Infobox drug"]) {
    all.push(...(await embeddedInTitles(template)));
  }
  // Drugbox is a redirect to Infobox drug and plenty of articles transclude
  // both a Chembox and a drug box, so the union is well short of the sum.
  const unique = [...new Set(all)].sort(compareStrings);
  log(`  ${all.length} transclusions, ${unique.length} distinct articles`);
  if (BROAD_LIMIT > 0) {
    log(`  --limit: keeping the first ${BROAD_LIMIT}. This is a smoke test, not a real build.`);
    return unique.slice(0, BROAD_LIMIT);
  }
  return unique;
}

/**
 * The infobox regions of an article, joined, with comments already removed.
 * Caching this rather than the article is what keeps the broad tier's cache in
 * the tens of megabytes instead of near a gigabyte: a Chembox is a few
 * kilobytes and the article around it is not read at all.
 */
function trimToBoxes(wikitext) {
  const text = wikitext.replace(/<!--[\s\S]*?-->/g, "");
  const pieces = [];
  for (const [start, end] of broadBoxRegions(text)) pieces.push(text.slice(start, end));
  return pieces.join("\n");
}

async function fetchBroadWikitext(titles) {
  const boxes = new Map();
  const batches = chunk(titles, 50);
  let done = 0;
  let fetched = 0;
  for (const batch of batches) {
    const key = sha256(batch.join("")).slice(0, 24);
    const rel = `wiki-broad/v${WIKI_TRIM_VERSION}/${key}.json`;
    let trimmed = cacheReadJson(rel);
    if (!trimmed) {
      const url = new URL(WIKI_API);
      url.search = new URLSearchParams({
        action: "query",
        format: "json",
        formatversion: "2",
        prop: "revisions",
        rvprop: "content",
        rvslots: "main",
        titles: batch.join("|"),
      }).toString();
      const result = await httpGet(url.toString(), { limiter: wikiLimit });
      if (result.status !== 200) fail("the Wikipedia content API returned nothing for a batch.");
      const json = JSON.parse(result.body.toString("utf8"));
      trimmed = {};
      for (const page of json.query?.pages ?? []) {
        const content = page.revisions?.[0]?.slots?.main?.content;
        if (typeof content !== "string") continue;
        const box = trimToBoxes(content);
        if (box) trimmed[page.title] = box;
      }
      cacheWriteJson(rel, trimmed);
      fetched += 1;
    }
    for (const [title, box] of Object.entries(trimmed)) boxes.set(title, box);
    done += batch.length;
    if (done % 2000 < 50) {
      log(`  wikitext ${done}/${titles.length} articles, ${boxes.size} with a box`);
    }
  }
  log(`  wikitext done: ${boxes.size} boxes, ${fetched}/${batches.length} batches newly fetched`);
  return boxes;
}

/**
 * Looks a parameter up by any of several spellings. Chembox and Infobox drug
 * name the same fact differently ("CASNo" against "CAS_number"), and articles
 * are inconsistent about case, so an exact hit is tried first and a case and
 * separator insensitive one second.
 */
function paramGet(params, ...aliases) {
  for (const alias of aliases) {
    const hit = params.get(alias);
    if (typeof hit === "string" && hit.trim() !== "") return hit;
  }
  const loose = new Map();
  for (const [key, value] of params) {
    const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!loose.has(k)) loose.set(k, value);
  }
  for (const alias of aliases) {
    const hit = loose.get(alias.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (typeof hit === "string" && hit.trim() !== "") return hit;
  }
  return "";
}

/**
 * The parameters of an article's infobox, plus which kind of box it was. A box
 * that declares NFPA-H wins, exactly as in the narrow tier; otherwise the first
 * box wins, and a drug box is only reported as a drug box when no Chembox on
 * the page carried the data.
 */
function broadBoxParams(boxText) {
  let first = null;
  for (const [start, end] of broadBoxRegions(boxText)) {
    const head = boxText.slice(start, start + 40);
    const kind = /Chembox/i.test(head) ? "chembox" : "drug";
    const params = flattenChembox(boxText.slice(start + 2, end - 2));
    if (params.size === 0) continue;
    if (first === null) first = { kind, params };
    const health = params.get("NFPA-H");
    if (typeof health === "string" && health.trim() !== "") return { kind, params };
  }
  return first;
}

/** Reads the `|C=6|H=6` element count form into a formula and an exact mass. */
function countsToFormula(params, massBySymbol) {
  const counts = [];
  for (const [key, value] of params) {
    if (!/^[A-Z][a-z]?$/.test(key)) continue;
    if (!massBySymbol.has(key)) continue;
    const n = Number(cleanWikiValue(value));
    if (Number.isInteger(n) && n > 0 && n < 1000) counts.push([key, n]);
  }
  if (counts.length === 0) return {};
  if (!counts.every(([symbol]) => massBySymbol.get(symbol) !== undefined)) return {};
  return {
    formula: counts.map(([symbol, n]) => (n === 1 ? symbol : `${symbol}${n}`)).join(""),
    molarMass:
      Math.round(counts.reduce((sum, [s, n]) => sum + massBySymbol.get(s) * n, 0) * 1000) / 1000,
  };
}

function parseBroadArticle(title, boxText, massBySymbol) {
  const box = broadBoxParams(boxText);
  if (!box) return null;
  const { kind, params } = box;

  const casRaw = cleanWikiValue(paramGet(params, "CASNo", "CAS_number", "CASNumber", "CAS"));
  const cas = /(\d{2,7}-\d{2}-\d)/.exec(casRaw)?.[1];

  const cidRaw = cleanWikiValue(paramGet(params, "PubChem", "PubChemCID", "pubchem_cid"));
  const cid = /^(\d{1,9})$/.test(cidRaw) ? Number(cidRaw) : undefined;

  const derived = countsToFormula(params, massBySymbol);
  let formula = cleanWikiValue(
    paramGet(params, "Formula", "ChemFormula", "chemical formula", "chemical_formula"),
  );
  formula = formula.split(/[,;]/)[0].trim();
  if (!looksLikeFormula(formula)) formula = derived.formula;

  const molarMassText = cleanWikiValue(paramGet(params, "MolarMass", "molecular_weight"));
  const molarMass = usable(molarMassText) ? firstNumber(molarMassText) : derived.molarMass;

  const iupac = cleanWikiValue(paramGet(params, "IUPACName", "IUPAC_name"));
  const systematic = cleanWikiValue(paramGet(params, "SystematicName"));
  const synonyms = [
    iupac,
    systematic,
    ...splitNames(paramGet(params, "OtherNames", "synonyms")),
    ...splitNames(paramGet(params, "tradename")),
  ].filter(usable);

  const h = ratingFromString(cleanWikiValue(params.get("NFPA-H") ?? ""));
  const f = ratingFromString(cleanWikiValue(params.get("NFPA-F") ?? ""));
  const r = ratingFromString(cleanWikiValue(params.get("NFPA-R") ?? params.get("NFPA-I") ?? ""));
  const rawSpecial = cleanWikiValue(params.get("NFPA-S") ?? "");
  const special = [];
  for (const token of stripCombining(rawSpecial).split(/[\s+,/&]+/)) {
    const symbol = token.trim().toUpperCase();
    if (symbol === "") continue;
    for (const known of splitSpecialToken(symbol) ?? []) {
      if (!special.includes(known)) special.push(known);
    }
  }
  const rated = h !== undefined && f !== undefined && r !== undefined;

  const props = {
    density: cleanWikiValue(params.get("Density") ?? "") || undefined,
    meltingPoint: temperatureText(params, "MeltingPtC", "MeltingPt"),
    boilingPoint: temperatureText(params, "BoilingPtC", "BoilingPt"),
    flashPoint: temperatureText(params, "FlashPtC", "FlashPt"),
  };

  return {
    title,
    isDrug: kind === "drug",
    cid,
    cas,
    formula: looksLikeFormula(formula) ? formula : undefined,
    molarMass: Number.isFinite(molarMass) ? molarMass : undefined,
    iupacName: usable(iupac) ? iupac : undefined,
    synonyms,
    nfpa: rated ? { h, f, r, special, source: "Wikipedia" } : undefined,
    props: Object.fromEntries(Object.entries(props).filter(([, v]) => usable(v))),
  };
}

async function buildBroadRows(titles, elements) {
  const massBySymbol = new Map(elements.map((e) => [e.symbol, e.atomicMass]));
  const boxes = await fetchBroadWikitext(titles);
  const digestKey = `digest/broad.v${BROAD_PARSE_VERSION}.${sha256(titles.join("")).slice(0, 16)}.json`;
  const digest = cacheReadJson(digestKey);
  if (digest) {
    log(`  reusing the parsed digest: ${digest.length} rows`);
    return digest;
  }
  const rows = [];
  for (const title of [...boxes.keys()].sort(compareStrings)) {
    const row = parseBroadArticle(title, boxes.get(title), massBySymbol);
    if (row) rows.push(row);
  }
  cacheWriteJson(digestKey, rows);
  return rows;
}

/**
 * Fills in a CID for rows that carry none, by asking PubChem to resolve the CAS
 * number and then the article title. One request each, which is why this step
 * is budgeted: it is skipped for a row with neither, and it stops early rather
 * than eat the time the GHS sweep needs.
 */
async function resolveBroadCids(rows, budgetMs) {
  const pending = rows.filter((row) => row.cid === undefined);
  // A CAS number resolves precisely; a title is a guess, so CAS goes first and
  // the order is otherwise stable so a resumed run picks up where it left off.
  const queue = [
    ...pending.filter((row) => row.cas).sort((a, b) => compareStrings(a.title, b.title)),
    ...pending.filter((row) => !row.cas).sort((a, b) => compareStrings(a.title, b.title)),
  ];
  const deadline = Date.now() + budgetMs;
  let resolved = 0;
  let asked = 0;
  let stoppedAt = -1;

  for (let i = 0; i < queue.length; i += 1) {
    const row = queue[i];
    const terms = [];
    if (row.cas) terms.push(row.cas);
    // A parenthesised disambiguator is never part of the compound's name.
    const bare = row.title.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (bare && bare.length <= 80) terms.push(bare);

    for (const term of terms) {
      const rel = `pubchem-name/${sha256(term).slice(0, 24)}.json`;
      let json = cacheReadJson(rel);
      if (!json) {
        if (Date.now() > deadline) {
          stoppedAt = i;
          break;
        }
        try {
          const result = await httpGet(
            `${PUBCHEM}/rest/pug/compound/name/${encodeURIComponent(term)}/cids/JSON`,
          );
          asked += 1;
          // A definite miss is worth remembering; a transient failure is not.
          json = result.status === 404 ? { __none: true } : JSON.parse(result.body.toString("utf8"));
          cacheWriteJson(rel, json);
        } catch {
          break;
        }
      }
      const cid = json?.IdentifierList?.CID?.[0];
      if (Number.isInteger(cid) && cid > 0) {
        row.cid = cid;
        row.cidFrom = row.cas === term ? "cas" : "name";
        resolved += 1;
        break;
      }
    }
    if (stoppedAt !== -1) break;
  }
  log(
    `  resolved ${resolved} CIDs from ${asked} lookups over ${queue.length} rows` +
      (stoppedAt === -1
        ? ""
        : `, stopped at ${stoppedAt} with ${queue.length - stoppedAt} left for a later run`),
  );
  return { resolved, asked, unresolved: rows.filter((r) => r.cid === undefined).length };
}

/**
 * PubChem compound properties for every CID, 200 at a time through the POST
 * form of the property endpoint. Two hundred CIDs per request turns 20,000
 * compounds into 100 requests.
 */
async function buildBroadProps(cids) {
  const sorted = [...cids].sort((a, b) => a - b);
  const digestKey = `digest/broadprops.v${PROPS_PARSE_VERSION}.${sha256(sorted.join(",")).slice(0, 16)}.json`;
  const digest = cacheReadJson(digestKey);
  if (digest) return new Map(digest);

  const facts = new Map();
  const batches = chunk(sorted, 200);
  let done = 0;
  for (const batch of batches) {
    const key = sha256(batch.join(",")).slice(0, 24);
    const json = await cachedPostJson(
      `pubchem-bulkprops/${key}.json`,
      `${PUBCHEM}/rest/pug/compound/cid/property/MolecularFormula,MolecularWeight,IUPACName,Title,ExactMass/JSON`,
      new URLSearchParams({ cid: batch.join(",") }).toString(),
    );
    for (const row of json?.PropertyTable?.Properties ?? []) {
      const cid = Number(row.CID);
      const entry = {};
      if (row.Title) entry.title = collapse(String(row.Title));
      if (row.MolecularFormula) entry.formula = collapse(String(row.MolecularFormula));
      if (row.IUPACName) entry.iupacName = collapse(String(row.IUPACName));
      const mass = Number(row.MolecularWeight);
      if (Number.isFinite(mass)) entry.molarMass = mass;
      const exact = Number(row.ExactMass);
      if (Number.isFinite(exact)) entry.exactMass = exact;
      facts.set(cid, entry);
    }
    done += batch.length;
    if (done % 4000 < 200) log(`  properties ${done}/${sorted.length}`);
  }
  log(`  properties done: ${facts.size}/${sorted.length} CIDs answered`);
  cacheWriteJson(
    digestKey,
    [...facts].sort((a, b) => a[0] - b[0]),
  );
  return facts;
}

/**
 * GHS classification for the whole PubChem corpus, from the bulk annotations
 * endpoint: 359 pages of 1,000 records rather than one request per compound.
 *
 * The narrow tier still uses the per compound endpoint, because its cache is
 * already warm and its output is a shipped module that should not move. This
 * tier could not: 20,000 individual requests is over an hour even when PubChem
 * stays green, and the same data is 359 requests here. Each record is already
 * one notifying body's classification, so the block splitting the per compound
 * parser needs is unnecessary and only the source priority is applied.
 */
async function buildGhsBulk(wanted) {
  const byCid = new Map();
  const sourceCounts = new Map();
  const candidates = new Map();

  const rank = (source) => {
    const i = GHS_SOURCE_PRIORITY.indexOf(source);
    return i === -1 ? GHS_SOURCE_PRIORITY.length : i;
  };

  const parsePage = (json) => {
    const out = [];
    for (const ann of json.Annotations?.Annotation ?? []) {
      const cids = ann.LinkedRecords?.CID ?? [];
      if (cids.length === 0) continue;
      const value = extractGhsBlock({
        entries: ann.Data ?? [],
        source: ann.SourceName ?? "Unknown",
      });
      if (!value) continue;
      out.push({
        cids: cids.map(Number),
        anid: Number(ann.ANID ?? 0),
        source: value.source,
        pictograms: value.pictograms,
        signal: value.signal,
        h: value.h.map((x) => x.code),
        p: value.p,
      });
    }
    return out;
  };

  const absorb = (entries) => {
    for (const entry of entries) {
      for (const cid of entry.cids) {
        if (!wanted.has(cid)) continue;
        const list = candidates.get(cid);
        if (list) list.push(entry);
        else candidates.set(cid, [entry]);
      }
    }
  };

  const pageUrl = (n) =>
    `${PUBCHEM}/rest/pug_view/annotations/heading/GHS%20Classification/JSON?page=${n}`;

  const loadPage = async (n) => {
    const digestRel = `digest/ghs-bulk/v${GHS_BULK_PARSE_VERSION}/page-${n}.json`;
    const cachedDigest = cacheReadJson(digestRel);
    if (cachedDigest) return { entries: cachedDigest, fetched: false };
    // The raw page is kept as well, so a parser change costs a reparse rather
    // than another three gigabytes of downloads.
    const raw = cacheRead(`ghs-bulk/page-${n}.json`);
    if (raw) {
      const entries = parsePage(JSON.parse(raw.toString("utf8")));
      cacheWriteJson(digestRel, entries);
      return { entries, fetched: false };
    }
    const result = await httpGet(pageUrl(n));
    if (result.status !== 200) return { entries: [], fetched: true };
    cacheWrite(`ghs-bulk/page-${n}.json`, result.body);
    const entries = parsePage(JSON.parse(result.body.toString("utf8")));
    cacheWriteJson(digestRel, entries);
    return { entries, fetched: true };
  };

  const firstPage = await loadPage(1);
  absorb(firstPage.entries);
  let totalPages = cacheReadJson("ghs-bulk/total-pages.json")?.total;
  if (!totalPages) {
    const raw = cacheRead("ghs-bulk/page-1.json");
    totalPages = Number(JSON.parse(raw.toString("utf8")).Annotations?.TotalPages ?? 1);
    cacheWriteJson("ghs-bulk/total-pages.json", { total: totalPages });
  }
  log(`  ${totalPages} pages of bulk GHS annotations`);

  let done = 1;
  let truncatedAt = 0;
  const pages = [];
  for (let n = 2; n <= totalPages; n += 1) pages.push(n);
  // Four at a time: the limiter paces the requests, but PubChem takes ten to
  // fifteen seconds to generate each page, so the concurrency is what matters.
  for (const group of chunk(pages, 4)) {
    if (budgetLeftMs() < 3 * 60 * 1000) {
      truncatedAt = done;
      log(`  budget nearly spent, stopping the GHS sweep after ${done}/${totalPages} pages`);
      break;
    }
    const results = await Promise.all(group.map((n) => loadPage(n)));
    for (const result of results) absorb(result.entries);
    done += group.length;
    if (done % 40 < 4) log(`  GHS pages ${done}/${totalPages}, ${candidates.size} CIDs matched`);
  }

  for (const [cid, list] of candidates) {
    const best = [...list].sort(
      (a, b) =>
        rank(a.source) - rank(b.source) ||
        completeness(a) - completeness(b) ||
        a.anid - b.anid ||
        compareStrings(a.source, b.source),
    )[0];
    byCid.set(cid, { pictograms: best.pictograms, signal: best.signal, h: best.h, p: best.p });
    sourceCounts.set(best.source, (sourceCounts.get(best.source) ?? 0) + 1);
  }
  log(`  GHS done: ${byCid.size} of ${wanted.size} wanted CIDs classified`);
  return {
    byCid,
    truncatedAt,
    totalPages,
    sourceCounts: [...sourceCounts].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0])),
  };
}

/**
 * A one sentence lead from each article, through prop=extracts. Twenty titles
 * per request, so 23,000 articles is about 1,150 cheap requests rather than one
 * per compound. Nothing else is fetched for it.
 */
async function fetchBroadDescriptions(titles) {
  const out = new Map();
  const batches = chunk([...titles].sort(compareStrings), 20);
  let done = 0;
  for (const batch of batches) {
    if (budgetLeftMs() < 60 * 1000) {
      log(`  budget nearly spent, stopping descriptions after ${done}/${titles.length}`);
      break;
    }
    const key = sha256(batch.join("")).slice(0, 24);
    const url = new URL(WIKI_API);
    url.search = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "extracts",
      exintro: "1",
      explaintext: "1",
      exlimit: "20",
      titles: batch.join("|"),
    }).toString();
    const json = await cachedGetJson(`wiki-extracts/${key}.json`, url.toString(), {
      limiter: wikiLimit,
    });
    for (const page of json?.query?.pages ?? []) {
      const snippet = truncateSnippet(collapse(String(page.extract ?? "")));
      if (snippet) out.set(page.title, snippet);
    }
    done += batch.length;
    if (done % 4000 < 20) log(`  descriptions ${done}/${titles.length}`);
  }
  log(`  descriptions done: ${out.size} snippets`);
  return out;
}

/** The lead's first sentence, or its first DESCRIPTION_LIMIT characters. */
function truncateSnippet(text) {
  if (!text) return "";
  const cleaned = text.replace(/\s*\([^()]{0,40}\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= DESCRIPTION_LIMIT) return cleaned;
  const sentence = /^(.{40,200}?[.!?])\s/.exec(cleaned);
  if (sentence) return sentence[1];
  const cut = cleaned.slice(0, DESCRIPTION_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > 60 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}...`;
}

/**
 * Case and punctuation insensitive key for "is this the same name written a
 * different way". Used only to keep a `syn` entry from repeating the display
 * name; `isJunkSynonym` already screens out registry numbers and the like.
 */
function normaliseForDedup(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Up to INDEX_SYN_LIMIT alternative names for the compact index's `syn`
 * column: PubChem's Title first when it differs from the display name, then a
 * short IUPAC name, then the best of the record's own gathered synonyms
 * (Wikipedia's OtherNames and tradename, already ordered that way) and finally
 * any other Wikipedia title merged into this record. Near duplicates of the
 * name and junk (CAS numbers, registry ids) are excluded exactly as the
 * shard's own `synonyms` field excludes them.
 */
function pickIndexSynonyms({ name, iupacName, rawSynonyms, alsoWikipedia }, fact) {
  const seen = new Set([normaliseForDedup(name)]);
  const out = [];
  const consider = (text) => {
    if (out.length >= INDEX_SYN_LIMIT) return;
    if (typeof text !== "string") return;
    const clean = collapse(text);
    if (!usable(clean) || isJunkSynonym(clean)) return;
    const key = normaliseForDedup(clean);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  consider(fact?.title);
  const iupac = iupacName ?? fact?.iupacName;
  if (typeof iupac === "string" && iupac.length < IUPAC_INDEX_MAX_LENGTH) consider(iupac);
  for (const synonym of rawSynonyms) consider(synonym);
  for (const alt of alsoWikipedia) consider(alt);
  return out;
}

/**
 * Folds the parsed articles into one record per compound, deduplicating on
 * PubChem CID first, then CAS number, then normalized name, in that order. A
 * later duplicate fills gaps in the record already kept rather than replacing
 * it, so the article that sorted first stays the canonical one.
 */
function buildBroadRecords({ rows, props, ghsByCid, descriptions }) {
  const byCid = new Map();
  const byCas = new Map();
  const byName = new Map();
  const records = [];
  const stats = { mergedCid: 0, mergedCas: 0, mergedName: 0, dropped: 0 };

  const fill = (target, row) => {
    target.cas = target.cas ?? row.cas;
    target.formula = target.formula ?? row.formula;
    target.molarMass = target.molarMass ?? row.molarMass;
    target.iupacName = target.iupacName ?? row.iupacName;
    target.nfpa = target.nfpa ?? row.nfpa;
    target.isDrug = target.isDrug || row.isDrug;
    if (row.cid !== undefined && target.cid === undefined) target.cid = row.cid;
    for (const synonym of row.synonyms) target.synonyms.push(synonym);
    for (const [key, value] of Object.entries(row.props)) target.props[key] ??= value;
    if (!target.alsoWikipedia.includes(row.title)) target.alsoWikipedia.push(row.title);
  };

  // Sorted by title so the run is deterministic and the canonical article for a
  // duplicated compound never depends on fetch order.
  for (const row of [...rows].sort((a, b) => compareStrings(a.title, b.title))) {
    const nameKey = normaliseName(row.title);
    // Name matching is the last resort, and only for a row that identifies
    // itself no other way. normaliseName strips parentheticals, so
    // "Lead(II) acetate" and "Lead(IV) acetate" both reduce to "lead acetate",
    // as do "(E)-Stilbene" and "(Z)-Stilbene": merging those would throw a real
    // compound away. A CID or a CAS number that matched nothing already is
    // evidence of a distinct compound, so such a row is always kept as new.
    const identified = row.cid !== undefined || row.cas !== undefined;
    let existing;
    if (row.cid !== undefined && byCid.has(row.cid)) {
      existing = byCid.get(row.cid);
      stats.mergedCid += 1;
    } else if (row.cas && byCas.has(row.cas)) {
      existing = byCas.get(row.cas);
      stats.mergedCas += 1;
    } else if (!identified && nameKey && byName.has(nameKey)) {
      existing = byName.get(nameKey);
      stats.mergedName += 1;
    }
    if (existing) {
      fill(existing, row);
      continue;
    }
    const record = {
      cid: row.cid,
      wikipedia: row.title,
      alsoWikipedia: [],
      isDrug: row.isDrug,
      cas: row.cas,
      formula: row.formula,
      molarMass: row.molarMass,
      iupacName: row.iupacName,
      synonyms: [...row.synonyms],
      nfpa: row.nfpa,
      props: { ...row.props },
    };
    records.push(record);
    if (row.cid !== undefined) byCid.set(row.cid, record);
    if (row.cas) byCas.set(row.cas, record);
    if (nameKey) byName.set(nameKey, record);
  }

  // The synthetic ids only work while they stay clear of PubChem's real ones.
  // The highest CID this build saw is around 5e8, so 9e8 has room, but that is
  // an assumption about someone else's identifier space and it is worth an
  // assertion rather than a silent collision years from now.
  for (const record of records) {
    if (record.cid !== undefined && record.cid >= SYNTHETIC_ID_BASE) {
      fail(
        `PubChem CID ${record.cid} has reached SYNTHETIC_ID_BASE (${SYNTHETIC_ID_BASE}). ` +
          "Raise the base, and remember that doing so renumbers every CID-less row.",
      );
    }
  }

  // PubChem's own title, formula and mass are more consistent than a Chembox's,
  // so they fill gaps; the article title stays the display name, because that
  // is the name a person searching for the compound is likely to type.
  let synthetic = SYNTHETIC_ID_BASE;
  const finished = [];
  for (const record of records) {
    const fact = record.cid !== undefined ? props.get(record.cid) : undefined;
    const name = record.wikipedia;
    const ghs = record.cid !== undefined ? ghsByCid.get(record.cid) : undefined;

    const synonyms = [];
    const seen = new Set([name.toLowerCase()]);
    for (const raw of [
      fact?.title,
      record.iupacName,
      fact?.iupacName,
      ...record.synonyms,
      ...record.alsoWikipedia,
    ]) {
      if (typeof raw !== "string") continue;
      const text = collapse(raw);
      if (!usable(text) || isJunkSynonym(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      synonyms.push(text);
      if (synonyms.length >= BROAD_SYNONYM_LIMIT) break;
    }

    const formula = looksLikeFormula(record.formula) ? record.formula : fact?.formula;
    const molarMass = record.molarMass ?? fact?.molarMass;
    // Not written to the shard: only indexRow reads it, so it never touches
    // shardRecord's output and shard bytes do not move when this changes.
    const indexSyn = pickIndexSynonyms(
      {
        name,
        iupacName: record.iupacName,
        rawSynonyms: record.synonyms,
        alsoWikipedia: record.alsoWikipedia,
      },
      fact,
    );
    const out = {
      id: record.cid ?? (synthetic += 1),
      hasCid: record.cid !== undefined,
      name,
      formula: usable(formula) ? formula : undefined,
      cas: record.cas,
      molarMass: Number.isFinite(molarMass) ? Math.round(molarMass * 1000) / 1000 : undefined,
      exactMass: fact?.exactMass,
      isDrug: record.isDrug,
      wikipedia: record.wikipedia,
      description: descriptions.get(record.wikipedia) || undefined,
      synonyms,
      indexSyn,
      nfpa: record.nfpa,
      ghs,
      props: Object.keys(record.props).length > 0 ? record.props : undefined,
    };
    // A row with nothing but a title is noise in a search box.
    // A lead sentence alone is not enough: Infobox drug is also on articles
    // about drug classes and combination products, which carry no chemistry
    // and are only noise in a compound search.
    if (
      out.formula === undefined &&
      out.cas === undefined &&
      out.molarMass === undefined &&
      out.nfpa === undefined &&
      out.ghs === undefined
    ) {
      stats.dropped += 1;
      continue;
    }
    finished.push(out);
  }

  finished.sort((a, b) => a.id - b.id);
  return { records: finished, stats };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * True for a value that reads as a chemical formula rather than a sentence.
 * Hydrate dots, brackets and charge markers are all allowed; a space is not,
 * because that is where a Chembox has started explaining itself.
 */
function looksLikeFormula(text) {
  if (!usable(text)) return false;
  if (text.length > 60) return false;
  return /^[A-Za-z0-9()[\]{}\u00b7.,+^*-]+$/.test(text);
}

function sameRating(a, b) {
  if (!a || !b) return false;
  return (
    a.h === b.h &&
    a.f === b.f &&
    a.r === b.r &&
    a.special.length === b.special.length &&
    a.special.every((s, i) => s === b.special[i])
  );
}

function normaliseName(text) {
  return text
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mergeSynonyms(lists, name) {
  const seen = new Set([name.toLowerCase()]);
  const out = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const text = collapse(String(raw));
      if (!usable(text) || isJunkSynonym(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function buildChemicals({ nfpaRows, wikiRows, ghsByCid, facts }) {
  /** Rows keyed by CID first, then by Wikipedia title, then by PubChem source id. */
  const byCid = new Map();
  const extras = [];
  const stats = {
    cidCollisions: 0,
    merged: 0,
    disagreements: 0,
    dropped: 0,
  };

  for (const row of nfpaRows.rows) {
    const fact = row.cid !== undefined ? facts.get(row.cid) : undefined;
    const record = {
      id:
        row.cid !== undefined
          ? `cid:${row.cid}`
          : `${row.source === "OSHA" ? "osha" : "hsdb"}:${row.sourceId}`,
      name: fact?.title ?? row.name,
      pubchemNames: [fact?.title, row.name, fact?.iupacName, ...(fact?.synonyms ?? [])],
      cid: row.cid,
      formula: fact?.formula,
      molarMass: fact?.molarMass,
      nfpa: row.nfpa,
      wikiNfpa: undefined,
      wikipedia: undefined,
      wikiNames: [],
      cas: undefined,
      props: undefined,
    };
    if (row.cid === undefined) {
      extras.push(record);
      continue;
    }
    const existing = byCid.get(row.cid);
    if (existing) {
      // Two PubChem annotations for one compound: keep the rated one.
      if (!existing.nfpa && record.nfpa) byCid.set(row.cid, record);
      continue;
    }
    byCid.set(row.cid, record);
  }

  const wikiByTitle = new Map();
  for (const row of wikiRows.rows) {
    const target = row.cid !== undefined ? byCid.get(row.cid) : undefined;
    if (target) {
      if (target.wikipedia !== undefined) {
        stats.cidCollisions += 1;
        target.wikiNames.push(row.title);
        continue;
      }
      stats.merged += 1;
      target.wikipedia = row.title;
      target.name = row.title;
      target.wikiNames.push(...row.synonyms);
      target.cas = target.cas ?? row.cas;
      target.formula = looksLikeFormula(row.formula) ? row.formula : target.formula;
      target.molarMass = target.molarMass ?? row.molarMass;
      target.props = target.props ?? row.props;
      if (row.nfpa) {
        if (!target.nfpa) target.nfpa = row.nfpa;
        else if (!sameRating(target.nfpa, row.nfpa)) {
          target.wikiNfpa = row.nfpa;
          stats.disagreements += 1;
        }
      }
      continue;
    }

    const fact = row.cid !== undefined ? facts.get(row.cid) : undefined;
    const record = {
      id: row.cid !== undefined ? `cid:${row.cid}` : `wp:${row.title}`,
      name: row.title,
      pubchemNames: fact ? [fact.title, fact.iupacName, ...(fact.synonyms ?? [])] : [],
      cid: row.cid,
      formula: looksLikeFormula(row.formula) ? row.formula : fact?.formula,
      molarMass: row.molarMass ?? fact?.molarMass,
      nfpa: row.nfpa,
      wikiNfpa: undefined,
      wikipedia: row.title,
      wikiNames: row.synonyms,
      cas: row.cas,
      props: row.props,
    };
    if (row.cid !== undefined) {
      const clash = byCid.get(row.cid);
      if (clash) {
        stats.cidCollisions += 1;
        clash.wikiNames.push(row.title);
        continue;
      }
      byCid.set(row.cid, record);
    } else {
      if (wikiByTitle.has(row.title)) continue;
      wikiByTitle.set(row.title, record);
    }
  }

  const wikipediaTitles = new Map();
  for (const row of wikiRows.rows) {
    const key = normaliseName(row.title);
    if (key && !wikipediaTitles.has(key)) wikipediaTitles.set(key, row.title);
  }

  const all = [...byCid.values(), ...wikiByTitle.values(), ...extras];
  const chemicals = [];

  for (const record of all) {
    // A PubChem-only row borrows a Wikipedia link when a title matches exactly.
    if (!record.wikipedia) {
      for (const candidate of [record.name, ...record.pubchemNames]) {
        if (!candidate) continue;
        const title = wikipediaTitles.get(normaliseName(String(candidate)));
        if (title) {
          record.wikipedia = title;
          break;
        }
      }
    }

    const ghs = record.cid !== undefined ? ghsByCid.get(record.cid) : undefined;
    const chemical = {
      id: record.id,
      name: record.name,
      synonyms: mergeSynonyms([record.pubchemNames, record.wikiNames], record.name),
      cas: record.cas,
      formula: usable(record.formula) ? record.formula : undefined,
      molarMass: Number.isFinite(record.molarMass) ? record.molarMass : undefined,
      cid: record.cid,
      wikipedia: record.wikipedia,
      nfpa: record.nfpa,
      nfpaAlt: record.wikiNfpa,
      ghs: ghs ? { pictograms: ghs.pictograms, signal: ghs.signal, h: ghs.h, p: ghs.p } : undefined,
      props:
        record.props && Object.keys(record.props).length > 0
          ? {
              density: record.props.density,
              meltingPoint: record.props.meltingPoint,
              boilingPoint: record.props.boilingPoint,
              flashPoint: record.props.flashPoint,
            }
          : undefined,
    };
    chemicals.push(chemical);
  }

  // A search hit whose Chembox gave up nothing useful is noise in every one of
  // the five tools, so it does not ship.
  const kept = chemicals.filter(
    (c) =>
      c.nfpa !== undefined ||
      c.ghs !== undefined ||
      c.cas !== undefined ||
      c.formula !== undefined ||
      c.molarMass !== undefined ||
      c.props !== undefined,
  );
  stats.dropped = chemicals.length - kept.length;

  kept.sort(
    (a, b) =>
      compareStrings(a.name.toLowerCase(), b.name.toLowerCase()) || compareStrings(a.id, b.id),
  );
  return { chemicals: kept, stats };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const BANNER = (script) => `// Generated by scripts/${script}. Do not edit by hand.
// Rebuild with \`node scripts/prepare-chem-data.mjs\`. This file is a committed
// snapshot: Workers Builds will not refetch it, so the build imports what is
// in git and this script is the refresh path.
`;

function lit(value) {
  return JSON.stringify(value);
}

function emitElements(elements) {
  const lines = elements.map((e) => {
    const parts = [
      `atomicNumber: ${e.atomicNumber}`,
      `symbol: ${lit(e.symbol)}`,
      `name: ${lit(e.name)}`,
    ];
    if (e.atomicMass !== undefined) parts.push(`atomicMass: ${e.atomicMass}`);
    if (e.atomicMassText !== undefined) parts.push(`atomicMassText: ${lit(e.atomicMassText)}`);
    parts.push(`period: ${e.period}`);
    if (e.group !== undefined) parts.push(`group: ${e.group}`);
    for (const [key, value] of [
      ["cpkHexColor", e.cpkHexColor],
      ["electronConfiguration", e.electronConfiguration],
      ["oxidationStates", e.oxidationStates],
      ["standardState", e.standardState],
      ["groupBlock", e.groupBlock],
      ["yearDiscovered", e.yearDiscovered],
    ]) {
      if (value !== undefined) parts.push(`${key}: ${lit(value)}`);
    }
    for (const [key, value] of [
      ["electronegativity", e.electronegativity],
      ["atomicRadius", e.atomicRadius],
      ["ionizationEnergy", e.ionizationEnergy],
      ["electronAffinity", e.electronAffinity],
      ["meltingPoint", e.meltingPoint],
      ["boilingPoint", e.boilingPoint],
      ["density", e.density],
    ]) {
      if (value !== undefined) parts.push(`${key}: ${value}`);
    }
    return `  { ${parts.join(", ")} },`;
  });

  return `${BANNER("prepare-chem-data.mjs")}
/**
 * The 118 elements, from the PubChem periodic table (public domain).
 *
 * Every numeric field is omitted rather than zeroed when PubChem has no value,
 * which is common for the synthetic elements at the end of period 7.
 * \`period\` and \`group\` are derived from the atomic number, not fetched;
 * \`group\` is absent for the f block (57 to 71 and 89 to 103).
 * \`atomicMassText\` keeps PubChem's own string, so a tool can show the exact
 * published precision rather than a re-rendered number.
 */
export interface Element {
  atomicNumber: number;
  symbol: string;
  name: string;
  /** Standard atomic weight, parsed from PubChem's string. */
  atomicMass?: number;
  /** PubChem's atomic mass exactly as published. */
  atomicMassText?: string;
  /** 1 to 7, derived from the atomic number. */
  period: number;
  /** 1 to 18, derived from the atomic number. Absent for the f block. */
  group?: number;
  /** CPK color as six hex digits, without a leading hash. */
  cpkHexColor?: string;
  electronConfiguration?: string;
  oxidationStates?: string;
  /** "Solid", "Liquid", "Gas", or a phrase such as "Expected to be a Gas". */
  standardState?: string;
  /** PubChem's category, for example "Nonmetal", "Noble gas", "Lanthanide". */
  groupBlock?: string;
  /** A year, or a word such as "Ancient". */
  yearDiscovered?: string;
  /** Pauling electronegativity. */
  electronegativity?: number;
  /** Van der Waals radius, in picometres. */
  atomicRadius?: number;
  /** First ionization energy, in electronvolts. */
  ionizationEnergy?: number;
  /** Electron affinity, in electronvolts. */
  electronAffinity?: number;
  /** Melting point, in kelvin. */
  meltingPoint?: number;
  /** Boiling point, in kelvin. */
  boilingPoint?: number;
  /** Density, in grams per cubic centimeter. */
  density?: number;
}

export const ELEMENTS: Element[] = [
${lines.join("\n")}
];
`;
}

function emitGhsStatements(reference) {
  const hLines = Object.keys(reference.hStatements)
    .sort(compareStrings)
    .map((code) => `  ${lit(code)}: ${lit(reference.hStatements[code])},`);
  const pLines = Object.keys(reference.pStatements)
    .sort(compareStrings)
    .map((code) => `  ${lit(code)}: ${lit(reference.pStatements[code])},`);
  const pictLines = reference.pictograms.map((p) => {
    const parts = [`code: ${lit(p.code)}`, `name: ${lit(p.name)}`];
    if (p.hazardClass !== undefined) parts.push(`hazardClass: ${lit(p.hazardClass)}`);
    return `  { ${parts.join(", ")} },`;
  });

  return `${BANNER("prepare-chem-data.mjs")}
/**
 * The GHS reference text, from the PubChem GHS page (public domain), which
 * tracks the 11th revised edition of the UN purple book.
 *
 * H_STATEMENTS is the canonical wording of every hazard statement. A row in
 * CHEMICALS carries its own copy of the text as the notifying body worded it,
 * so the two can differ in case and in the trailing hazard class note. Show the
 * row's text when reporting what was notified, and H_STATEMENTS when showing
 * what a code means in general.
 *
 * P_STATEMENTS covers plain and combination codes, for example both "P210" and
 * "P305+P351+P338". Statements marked "(Obsolete)" were removed in a later
 * revision and are kept because older safety data sheets still cite them.
 */
export interface GhsPictogram {
  /** "GHS01" through "GHS09". */
  code: string;
  /** The symbol's name, for example "Exploding Bomb". */
  name: string;
  /** The hazard family it marks, for example "Explosives". Absent for GHS08 and GHS09. */
  hazardClass?: string;
}

export const PICTOGRAMS: GhsPictogram[] = [
${pictLines.join("\n")}
];

export const H_STATEMENTS: Record<string, string> = {
${hLines.join("\n")}
};

export const P_STATEMENTS: Record<string, string> = {
${pLines.join("\n")}
};
`;
}

function emitChemData(chemicals, meta) {
  // Hazard statements, pictogram sets and precautionary sets all repeat
  // heavily across rows, so each distinct one is written once and referenced.
  // The exported types are unchanged. Everything pooled is read only, which
  // is true of a generated dataset anyway.
  const statements = new Map();
  const statementOrder = [];
  const pools = { pictograms: new Map(), precautionary: new Map() };
  const poolOrders = { pictograms: [], precautionary: [] };

  const intern = (which, value) => {
    const key = JSON.stringify(value);
    let index = pools[which].get(key);
    if (index === undefined) {
      index = poolOrders[which].length;
      pools[which].set(key, index);
      poolOrders[which].push(key);
    }
    return index;
  };

  const statementKey = (x) => x.code + String.fromCharCode(0) + x.text;
  for (const c of chemicals) {
    for (const statement of c.ghs?.h ?? []) {
      const key = statementKey(statement);
      if (!statements.has(key)) {
        statements.set(key, statementOrder.length);
        statementOrder.push(statement);
      }
    }
    if (c.ghs) {
      intern("pictograms", c.ghs.pictograms);
      intern("precautionary", c.ghs.p);
    }
  }
  const poolLines = statementOrder.map((x) => `  { code: ${lit(x.code)}, text: ${lit(x.text)} },`);
  const pictLines = poolOrders.pictograms.map((key) => `  ${key},`);
  const precLines = poolOrders.precautionary.map((key) => `  ${key},`);

  const rowLines = chemicals.map((c) => {
    const parts = [`id: ${lit(c.id)}`, `name: ${lit(c.name)}`, `synonyms: ${lit(c.synonyms)}`];
    if (c.cas !== undefined) parts.push(`cas: ${lit(c.cas)}`);
    if (c.formula !== undefined) parts.push(`formula: ${lit(c.formula)}`);
    if (c.molarMass !== undefined) parts.push(`molarMass: ${c.molarMass}`);
    if (c.cid !== undefined) parts.push(`cid: ${c.cid}`);
    if (c.wikipedia !== undefined) parts.push(`wikipedia: ${lit(c.wikipedia)}`);
    const rating = (n) =>
      `{ h: ${n.h}, f: ${n.f}, r: ${n.r}, special: ${lit(n.special)}, source: ${lit(n.source)} }`;
    if (c.nfpa) parts.push(`nfpa: ${rating(c.nfpa)}`);
    if (c.nfpaAlt) parts.push(`nfpaAlt: ${rating(c.nfpaAlt)}`);
    if (c.ghs) {
      const ghsParts = [`pictograms: G[${intern("pictograms", c.ghs.pictograms)}]`];
      if (c.ghs.signal !== undefined) ghsParts.push(`signal: ${lit(c.ghs.signal)}`);
      const refs = c.ghs.h.map((x) => `S[${statements.get(statementKey(x))}]`);
      ghsParts.push(`h: [${refs.join(", ")}]`);
      ghsParts.push(`p: P[${intern("precautionary", c.ghs.p)}]`);
      parts.push(`ghs: { ${ghsParts.join(", ")} }`);
    }
    if (c.props) {
      const propParts = [];
      for (const key of ["density", "meltingPoint", "boilingPoint", "flashPoint"]) {
        if (c.props[key] !== undefined) propParts.push(`${key}: ${lit(c.props[key])}`);
      }
      if (propParts.length > 0) parts.push(`props: { ${propParts.join(", ")} }`);
    }
    return `  { ${parts.join(", ")} },`;
  });

  // TypeScript gives up on a single array literal of three thousand object
  // literals with differing optional keys: TS2590, "union type that is too
  // complex to represent". Splitting the rows into blocks keeps each literal
  // small enough to check, and the exported array is still one Chemical[].
  const blocks = chunk(rowLines, ROWS_PER_BLOCK);
  const blockDecls = blocks
    .map((block, i) => `const C${i}: Chemical[] = [\n${block.join("\n")}\n];`)
    .join("\n\n");
  const blockSpread = blocks.map((_, i) => `...C${i}`).join(", ");

  return `${BANNER("prepare-chem-data.mjs")}
/**
 * Chemicals with an NFPA 704 rating, a GHS classification, or both.
 *
 * Rows are merged on PubChem CID, so one row can carry both a PubChem rating
 * and a Wikipedia article. When the two sources disagree on the diamond,
 * PubChem is \`nfpa\` and Wikipedia is \`nfpaAlt\`, so a panel can show both
 * rather than pick a winner silently.
 *
 * Ids are stable: "cid:180" when a PubChem CID is known, "wp:Acetone" for a
 * Wikipedia article with no CID, and "hsdb:30" or "osha:235" for a PubChem
 * annotation that links to no compound record.
 *
 * This dataset is a reference, never a basis for a workplace safety decision.
 * Verify against the safety data sheet, NFPA 704 itself, and the authority
 * having jurisdiction.
 */
export interface HazardStatement {
  /** "H225" and so on. */
  code: string;
  /** The statement as the notifying body worded it. */
  text: string;
}

export interface NfpaRating {
  /** Blue quadrant, health. */
  h: 0 | 1 | 2 | 3 | 4;
  /** Red quadrant, flammability. */
  f: 0 | 1 | 2 | 3 | 4;
  /** Yellow quadrant, instability. */
  r: 0 | 1 | 2 | 3 | 4;
  /** White quadrant. W means no water, OX oxidiser, SA simple asphyxiant. */
  special: ("W" | "OX" | "SA")[];
  source: "HSDB" | "OSHA" | "Wikipedia";
}

export interface GhsClassification {
  /** "GHS01" through "GHS09". */
  pictograms: string[];
  signal?: "Danger" | "Warning";
  h: HazardStatement[];
  /** Precautionary codes, plain and combination, for example "P305+P351+P338". */
  p: string[];
}

export interface ChemicalProperties {
  /** Free text as published, units included. */
  density?: string;
  meltingPoint?: string;
  boilingPoint?: string;
  flashPoint?: string;
}

export interface Chemical {
  /** "cid:180", "wp:Acetone", "hsdb:30" or "osha:235". */
  id: string;
  name: string;
  /** Up to eight, registry numbers and machine strings removed. */
  synonyms: string[];
  cas?: string;
  formula?: string;
  /** Grams per mole. */
  molarMass?: number;
  cid?: number;
  /** English Wikipedia article title, not a URL. */
  wikipedia?: string;
  nfpa?: NfpaRating;
  /** Wikipedia's rating, present only when it disagrees with \`nfpa\`. */
  nfpaAlt?: NfpaRating;
  ghs?: GhsClassification;
  props?: ChemicalProperties;
}

// The three pools below hold every distinct hazard statement, pictogram set
// and precautionary set exactly once, and the rows reference them by index.
// That is what keeps this file about a third smaller than the same data
// written out inline. Treat everything here as read only.
const S: HazardStatement[] = [
${poolLines.join("\n")}
];

const G: string[][] = [
${pictLines.join("\n")}
];

const P: string[][] = [
${precLines.join("\n")}
];

${blockDecls}

/** Every chemical, sorted by name. */
export const CHEMICALS: Chemical[] = [${blockSpread}];

export const CHEM_DATA_META = ${JSON.stringify(meta, null, 2)};
`;
}

// ---------------------------------------------------------------------------
// Emit: the broad tier's lazily fetched JSON, and the module of types that
// describes it. No bulk data goes into the module, which is the whole point:
// a page that never opens the chemical lookup pays nothing for 20,000 rows.
// ---------------------------------------------------------------------------

const CHEM_FLAGS = { nfpa: 1, ghs: 2, drug: 4, cid: 8, wikipedia: 16, description: 32 };

function chemFlags(record) {
  return (
    (record.nfpa ? CHEM_FLAGS.nfpa : 0) |
    (record.ghs ? CHEM_FLAGS.ghs : 0) |
    (record.isDrug ? CHEM_FLAGS.drug : 0) |
    (record.hasCid ? CHEM_FLAGS.cid : 0) |
    (record.wikipedia ? CHEM_FLAGS.wikipedia : 0) |
    (record.description ? CHEM_FLAGS.description : 0)
  );
}

/**
 * One shard record. Keys are written in a fixed order so two builds of the same
 * data are byte identical, and absent fields are omitted rather than nulled.
 */
function shardRecord(record, { synonyms, descriptions }) {
  const out = {};
  out.name = record.name;
  if (record.formula !== undefined) out.formula = record.formula;
  if (record.cas !== undefined) out.cas = record.cas;
  if (record.molarMass !== undefined) out.molarMass = record.molarMass;
  if (record.exactMass !== undefined) out.exactMass = record.exactMass;
  if (record.hasCid) out.cid = record.id;
  if (record.wikipedia !== undefined) out.wikipedia = record.wikipedia;
  if (descriptions && record.description !== undefined) out.description = record.description;
  if (record.isDrug) out.isDrug = true;
  if (synonyms && record.synonyms.length > 0) out.synonyms = record.synonyms;
  if (record.nfpa) {
    out.nfpa = {
      h: record.nfpa.h,
      f: record.nfpa.f,
      r: record.nfpa.r,
      special: record.nfpa.special,
      source: record.nfpa.source,
    };
  }
  if (record.ghs) {
    const ghs = { pictograms: record.ghs.pictograms };
    if (record.ghs.signal !== undefined) ghs.signal = record.ghs.signal;
    ghs.h = record.ghs.h;
    ghs.p = record.ghs.p;
    out.ghs = ghs;
  }
  if (record.props) {
    const props = {};
    for (const key of ["density", "meltingPoint", "boilingPoint", "flashPoint"]) {
      if (record.props[key] !== undefined) props[key] = record.props[key];
    }
    if (Object.keys(props).length > 0) out.props = props;
  }
  return out;
}

/**
 * The index row: [id, name, formula, cas, molarMass, flags, syn?]. `syn` is
 * omitted, not emitted empty, when `synCap` is 0 or the record has nothing to
 * offer, so an older 6 element row and a syn-less row this build chose to ship
 * both read the same way to a consumer that only checks `row.length > 6`.
 */
function indexRow(record, synCap) {
  const row = [
    record.id,
    record.name,
    record.formula ?? "",
    record.cas ?? "",
    record.molarMass ?? 0,
    chemFlags(record),
  ];
  if (synCap > 0 && record.indexSyn && record.indexSyn.length > 0) {
    row.push(record.indexSyn.slice(0, synCap));
  }
  return row;
}

/**
 * Renders index.json, on its own, tighter budget: INDEX_SYN_LIMIT synonyms
 * per row if that fits INDEX_RAW_BUDGET_BYTES and INDEX_GZ_BUDGET_BYTES, else
 * 3, then 2, then none at all. This runs once, ahead of the shard level
 * synonyms/descriptions budget in renderBroadFilesWithinBudget below, because
 * the index's cap does not depend on what the shards end up carrying.
 */
function buildIndexJson(records) {
  const attempts = [INDEX_SYN_LIMIT, 3, 2, 0];
  let last;
  for (const cap of attempts) {
    const body = Buffer.from(JSON.stringify(records.map((r) => indexRow(r, cap))));
    const gz = gzipSync(body, { level: 9 }).length;
    last = { body, gz, synCap: cap };
    const fits = body.length <= INDEX_RAW_BUDGET_BYTES && gz <= INDEX_GZ_BUDGET_BYTES;
    if (fits || cap === 0) {
      if (cap < INDEX_SYN_LIMIT) {
        log(
          `  index.json with up to ${INDEX_SYN_LIMIT} synonyms per row was over its ` +
            `${(INDEX_RAW_BUDGET_BYTES / 1e6).toFixed(1)} MB raw / ` +
            `${(INDEX_GZ_BUDGET_BYTES / 1e6).toFixed(1)} MB gz budget; shipping ` +
            (cap === 0 ? "no syn column instead" : `at most ${cap} synonym${cap === 1 ? "" : "s"} per row instead`),
        );
      }
      return last;
    }
    log(
      `  index.json with up to ${cap} synonyms: ${(body.length / 1e6).toFixed(2)} MB raw, ` +
        `${(gz / 1e6).toFixed(2)} MB gz, over budget, retrying with fewer`,
    );
  }
  return last;
}

function renderBroadFiles(records, options, indexResult) {
  const shards = new Map();
  for (const record of records) {
    const bucket = record.id % CHEM_SHARD_COUNT;
    let shard = shards.get(bucket);
    if (!shard) {
      shard = {};
      shards.set(bucket, shard);
    }
    shard[String(record.id)] = shardRecord(record, options);
  }
  const files = [
    { name: "index.json", body: indexResult.body, bytes: indexResult.body.length, gz: indexResult.gz },
  ];
  for (let bucket = 0; bucket < CHEM_SHARD_COUNT; bucket += 1) {
    files.push({
      name: `${bucket}.json`,
      body: Buffer.from(JSON.stringify(shards.get(bucket) ?? {})),
    });
  }
  let bytes = 0;
  let gz = 0;
  for (const file of files) {
    if (file.bytes === undefined) {
      file.bytes = file.body.length;
      file.gz = gzipSync(file.body, { level: 9 }).length;
    }
    bytes += file.bytes;
    gz += file.gz;
  }
  return { files, bytes, gz };
}

/**
 * Renders the shipped JSON, dropping fields if it will not fit. index.json's
 * own `syn` column is sized first, against its own tighter budget (see
 * buildIndexJson); then, against the whole tier's budget, shard synonyms go
 * first because a name search still works without them through the index,
 * then description snippets, which are the next largest and the least load
 * bearing.
 */
function renderBroadFilesWithinBudget(records) {
  const indexResult = buildIndexJson(records);
  const attempts = [
    { synonyms: true, descriptions: true, dropped: [] },
    { synonyms: false, descriptions: true, dropped: ["synonyms"] },
    { synonyms: false, descriptions: false, dropped: ["synonyms", "descriptions"] },
  ];
  let last;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    last = {
      ...renderBroadFiles(records, attempt, indexResult),
      dropped: attempt.dropped,
      indexSynCap: indexResult.synCap,
    };
    if (last.gz <= SHIP_BUDGET_GZ_BYTES) return last;
    const next = attempts[i + 1];
    log(
      `  ${(last.gz / 1e6).toFixed(2)} MB gzipped is over the ` +
        `${(SHIP_BUDGET_GZ_BYTES / 1e6).toFixed(1)} MB budget` +
        (next
          ? `, dropping ${next.dropped[next.dropped.length - 1]}`
          : ", and there is nothing left to drop"),
    );
  }
  return last;
}

function emitChemIndex(meta) {
  return `${BANNER("prepare-chem-data.mjs")}
/**
 * Types and helpers for the broad chemistry dataset, which is fetched at
 * runtime rather than bundled.
 *
 * This module deliberately holds no data. \`CHEMICALS\` in ./chem-data is the
 * narrow tier: about ${meta.narrowChemicals.toLocaleString("en-US")} compounds that carry an NFPA rating or a GHS
 * classification, small enough to ship inside the tool's JavaScript. The broad
 * tier is ${meta.counts.compounds.toLocaleString("en-US")} compounds, every English Wikipedia article with a
 * Chembox, a Drugbox or an Infobox drug, and it lives in ${CHEM_SHARD_COUNT + 1} JSON files under
 * \`/data/chem/\`. Importing this module costs a couple of hundred bytes.
 *
 * The intended flow for a panel is two fetches:
 *
 *   1. \`CHEM_INDEX_URL\` once, for every compound's id, name, formula, CAS
 *      number, molar mass and up to a few alternative names. That is enough
 *      to run a search box that also answers to a synonym.
 *   2. \`chemShardUrl(id)\` for the one compound the person picked, which
 *      returns a ${CHEM_SHARD_COUNT}th of the corpus and holds the full record.
 *
 * Neither is precached by the service worker: scripts/generate-sw.mjs skips
 * everything under \`/data/\`, so both are ordinary network fetches that the
 * browser's HTTP cache handles.
 *
 * This dataset is a reference, never a basis for a workplace safety decision.
 * Verify against the safety data sheet, NFPA 704 itself, and the authority
 * having jurisdiction.
 */

/** The compact index, one row per compound, sorted by id. */
export const CHEM_INDEX_URL = "/data/chem/index.json";

/** How many shards the full records are split across. */
export const CHEM_SHARD_COUNT = ${CHEM_SHARD_COUNT};

/**
 * A row in the index. A tuple rather than an object, because ${meta.counts.compounds.toLocaleString("en-US")} objects
 * with seven named keys each is roughly three times the bytes over the wire.
 *
 *   [id, name, formula, cas, molarMass, flags, syn?]
 *
 * \`formula\` and \`cas\` are the empty string when unknown, and \`molarMass\`
 * is 0 when unknown, so that the JSON stays compact. \`syn\` is up to
 * ${meta.indexSynLimit} alternative names (PubChem's title when it differs from
 * \`name\`, a short IUPAC name, then the best of the compound's own gathered
 * synonyms), present only on a row that has one worth showing; an older 6
 * element row and a row this build chose to ship without one both simply
 * lack it, so read it as \`row[6] ?? []\` rather than assuming it is there.
 * ${meta.indexSynCap < meta.indexSynLimit ? `This build shipped at most ${meta.indexSynCap} per row: the full ${meta.indexSynLimit} would have exceeded index.json's own size budget.` : `This build shipped the full ${meta.indexSynLimit} per row.`}
 * Read every field through the helpers below rather than testing the
 * sentinels by hand.
 */
export type ChemIndexRow = [
  id: number,
  name: string,
  formula: string,
  cas: string,
  molarMass: number,
  flags: number,
  syn?: string[],
];

/** The parsed index: every row, in id order. */
export type ChemIndex = ChemIndexRow[];

/**
 * Bit flags in \`ChemIndexRow[5]\`. \`Cid\` says the id is a real PubChem CID;
 * a compound this build could not resolve to one keeps a synthetic id at or
 * above ${SYNTHETIC_ID_BASE.toLocaleString("en-US")}, which is well past PubChem's range.
 */
export const CHEM_FLAG_NFPA = ${CHEM_FLAGS.nfpa};
export const CHEM_FLAG_GHS = ${CHEM_FLAGS.ghs};
export const CHEM_FLAG_DRUG = ${CHEM_FLAGS.drug};
export const CHEM_FLAG_CID = ${CHEM_FLAGS.cid};
export const CHEM_FLAG_WIKIPEDIA = ${CHEM_FLAGS.wikipedia};
export const CHEM_FLAG_DESCRIPTION = ${CHEM_FLAGS.description};

export const CHEM_SYNTHETIC_ID_BASE = ${SYNTHETIC_ID_BASE};

/** The URL of the shard holding the full record for \`id\`. */
export function chemShardUrl(id: number): string {
  return \`/data/chem/\${id % CHEM_SHARD_COUNT}.json\`;
}

/** A parsed shard, keyed by id as a string. */
export type ChemShard = Record<string, ChemRecord>;

/** The full record for \`id\` in a fetched shard, or undefined if absent. */
export function chemRecordFrom(shard: ChemShard, id: number): ChemRecord | undefined {
  return shard[String(id)];
}

export function chemHasNfpa(row: ChemIndexRow): boolean {
  return (row[5] & CHEM_FLAG_NFPA) !== 0;
}

export function chemHasGhs(row: ChemIndexRow): boolean {
  return (row[5] & CHEM_FLAG_GHS) !== 0;
}

export function chemIsDrug(row: ChemIndexRow): boolean {
  return (row[5] & CHEM_FLAG_DRUG) !== 0;
}

/** The PubChem CID, or undefined when this build could not resolve one. */
export function chemCid(row: ChemIndexRow): number | undefined {
  return (row[5] & CHEM_FLAG_CID) !== 0 ? row[0] : undefined;
}

export interface ChemNfpaRating {
  /** Blue quadrant, health. */
  h: 0 | 1 | 2 | 3 | 4;
  /** Red quadrant, flammability. */
  f: 0 | 1 | 2 | 3 | 4;
  /** Yellow quadrant, instability. */
  r: 0 | 1 | 2 | 3 | 4;
  /** White quadrant. W means no water, OX oxidiser, SA simple asphyxiant. */
  special: ("W" | "OX" | "SA")[];
  source: "Wikipedia";
}

/**
 * A GHS classification. Unlike \`GhsClassification\` in ./chem-data, the hazard
 * statements are codes without their text: the canonical wording of every code
 * is already in \`H_STATEMENTS\` from ./ghs-statements, which is bundled and
 * small, and repeating it per compound cost more than the whole index does.
 */
export interface ChemGhs {
  /** "GHS01" through "GHS09". */
  pictograms: string[];
  signal?: "Danger" | "Warning";
  /** Hazard codes, for example "H225". Text is in H_STATEMENTS. */
  h: string[];
  /** Precautionary codes, plain and combination, for example "P305+P351+P338". */
  p: string[];
}

export interface ChemRecordProperties {
  /** Free text as published, units included. */
  density?: string;
  meltingPoint?: string;
  boilingPoint?: string;
  flashPoint?: string;
}

/** A full record, as stored in a shard. The id is the shard's key. */
export interface ChemRecord {
  name: string;
  formula?: string;
  cas?: string;
  /** Grams per mole. */
  molarMass?: number;
  /** Monoisotopic mass, from PubChem. */
  exactMass?: number;
  /** Present only when the id is a real PubChem CID. */
  cid?: number;
  /** English Wikipedia article title, not a URL. */
  wikipedia?: string;
  /** One sentence from the article's lead. */
  description?: string;
  /** True when the article carried a Drugbox or an Infobox drug. */
  isDrug?: boolean;
  synonyms?: string[];
  nfpa?: ChemNfpaRating;
  ghs?: ChemGhs;
  props?: ChemRecordProperties;
}

export const CHEM_BROAD_META = ${JSON.stringify(meta, null, 2)} as const;
`;
}

function emitReadme(meta, files, broadMeta, shipped) {
  const rows = files.map(
    (f) => `| \`${f.name}\` | ${f.bytes.toLocaleString("en-US")} bytes | ${f.what} |`,
  );
  const broadSection = broadMeta
    ? `
## The broad tier: public/data/chem/

\`chem-data.ts\` is the narrow tier, ${meta.counts.chemicals.toLocaleString("en-US")} compounds that carry an NFPA
rating or a GHS classification. It is imported directly, so it ships inside the
tool's JavaScript and has to stay small.

The broad tier is ${broadMeta.counts.compounds.toLocaleString("en-US")} compounds: every English Wikipedia article with a
Chembox, a Drugbox or an Infobox drug. It is too large to bundle, so it ships as
${broadMeta.shards + 1} JSON files the browser fetches on demand, and
\`chem-index.ts\` holds only the types and helpers for reading them.

\`\`\`ts
import {
  CHEM_INDEX_URL, chemShardUrl, chemRecordFrom, chemHasNfpa, chemHasGhs,
  chemIsDrug, chemCid, CHEM_BROAD_META,
  type ChemIndexRow, type ChemRecord, type ChemShard,
} from "@/tools/_generated/chem-index";

const index: ChemIndexRow[] = await (await fetch(CHEM_INDEX_URL)).json();
const row = index.find((r) => r[1] === "Acetone");
const shard: ChemShard = await (await fetch(chemShardUrl(row[0]))).json();
const record: ChemRecord | undefined = chemRecordFrom(shard, row[0]);
\`\`\`

| File | Size | Gzipped | Contents |
| ---- | ---- | ------- | -------- |
| \`public/data/chem/index.json\` | ${shipped.files[0].bytes.toLocaleString("en-US")} bytes | ${shipped.files[0].gz.toLocaleString("en-US")} bytes | one \`[id, name, formula, cas, molarMass, flags, syn?]\` row per compound |
| \`public/data/chem/<0..${broadMeta.shards - 1}>.json\` | ${(shipped.bytes - shipped.files[0].bytes).toLocaleString("en-US")} bytes total | ${(shipped.gz - shipped.files[0].gz).toLocaleString("en-US")} bytes total | full records, keyed by id, sharded by \`id % ${broadMeta.shards}\` |

- The index is enough to run a search box. Fetch one shard only once someone
  picks a compound; it is a ${broadMeta.shards}th of the corpus.
- \`id\` is the PubChem CID when the \`CHEM_FLAG_CID\` bit is set. A compound
  this build could not resolve to a CID keeps a synthetic id at or above
  ${SYNTHETIC_ID_BASE.toLocaleString("en-US")}, which is well past PubChem's range, so the
  modulo sharding still works and no id ever collides with a real CID.
- \`syn\`, the index's 7th column, is up to ${broadMeta.indexSynLimit} alternative names per
  compound (PubChem's title, a short IUPAC name, then the best of the compound's own
  synonyms), present only when the row has one worth showing. It is what lets a query
  like "table salt" or "sulfuric acid" reach a compound whose Wikipedia article title
  reads differently, without a shard fetch. index.json carries its own tighter budget,
  ${(INDEX_RAW_BUDGET_BYTES / 1e6).toFixed(1)} MB raw and ${(INDEX_GZ_BUDGET_BYTES / 1e6).toFixed(1)} MB gzipped, separate from the whole tier's
  budget above; this build shipped ${broadMeta.indexSynCap} per row${broadMeta.indexSynCap < broadMeta.indexSynLimit ? ", cut down from the full amount to fit" : ""}.
- \`ghs.h\` here is codes only. \`H_STATEMENTS\` in \`ghs-statements.ts\` has
  the canonical wording, and repeating it per compound cost more than the whole
  index does.
- Nothing under \`/data/\` is precached by the service worker
  (\`scripts/generate-sw.mjs\` skips that prefix), so both fetches are ordinary
  network requests served from the browser's HTTP cache on a repeat visit.
- \`CHEM_BROAD_META.ghsSweepComplete\` is the resume signal. When it is true,
  every page of PubChem's bulk GHS annotations was read and
  \`counts.withoutGhs\` is simply how many compounds PubChem has never
  classified, which is most of them. When it is false, \`--budget\` cut the
  sweep short and a rerun with a warmer cache will classify more.
${broadMeta.droppedFields.length > 0 ? `- Dropped to stay inside the size budget: ${broadMeta.droppedFields.join(", ")}.\n` : ""}
`
    : "";

  return `# src/tools/_generated

Generated data modules. The chemistry ones are built by
\`scripts/prepare-chem-data.mjs\`; other scripts write their own files here.
Hand edits are lost on the next build.

These are committed, dated snapshots, not throwaway build output. Workers
Builds caps a build near twenty minutes and a cold refetch is longer than
that, so a deploy imports what is in git and this script is the refresh path.
Only \`.cache/\`, the raw fetches, stays out of git.

## Rebuild

\`\`\`
node scripts/prepare-chem-data.mjs               # build, using the on-disk cache
node scripts/prepare-chem-data.mjs --refresh     # ignore the cache and refetch
node scripts/prepare-chem-data.mjs --offline     # cache only, fail on a miss
node scripts/prepare-chem-data.mjs --no-broad    # narrow tier only
node scripts/prepare-chem-data.mjs --budget=90   # stop starting work after 90 minutes
\`\`\`

A warm build takes a couple of minutes, almost all of it re-reading the cached
GHS pages. A cold build takes roughly 45 to 75 minutes: the broad tier reads
about 23,000 Wikipedia articles and every page of PubChem's bulk GHS
annotations. Everything lands in \`src/tools/_generated/.cache/chem/\` so the
next build refetches nothing, and \`--budget\` bounds a run that has to stop
early: it ships what finished and records the shortfall in the meta.

## Files

| File | Size | Contents |
| ---- | ---- | -------- |
${rows.join("\n")}
${broadSection}
## Shapes

\`\`\`ts
import { CHEMICALS, CHEM_DATA_META, type Chemical } from "@/tools/_generated/chem-data";
import { ELEMENTS, type Element } from "@/tools/_generated/elements";
import { H_STATEMENTS, P_STATEMENTS, PICTOGRAMS } from "@/tools/_generated/ghs-statements";
\`\`\`

- \`Chemical\` carries \`id\`, \`name\`, \`synonyms\`, and the optional \`cas\`,
  \`formula\`, \`molarMass\`, \`cid\`, \`wikipedia\`, \`nfpa\`, \`nfpaAlt\`,
  \`ghs\` and \`props\`. Ids are \`cid:180\`, \`wp:Acetone\`, \`hsdb:30\` or
  \`osha:235\`, and are stable across builds.
- \`nfpa\` is present only when health, fire and instability all parse to 0 to 4.
  \`nfpaAlt\` holds Wikipedia's rating when it disagrees with PubChem's.
- \`ghs.h\` entries are worded by the notifying body. \`H_STATEMENTS\` holds the
  canonical UN wording for the same code, so the two can differ.
- \`Element\` omits a numeric field rather than zeroing it. \`period\` and
  \`group\` are derived from the atomic number; \`group\` is absent for the
  f block.
- \`CHEM_DATA_META\` carries \`builtAt\`, \`counts\` and \`sources\`, including
  the attribution each source requires.
- Hazard statements, pictogram sets and precautionary sets are pooled and
  shared between rows, so two chemicals can hold the same array instance.
  Treat every value here as read only and copy before sorting or mutating.
- A compound often carries several GHS classifications, one per notifying
  body. One is chosen, in the order listed under \`ghsSourcePriority\` in
  \`CHEM_DATA_META\`, so a row is one coherent classification rather than the
  union of every jurisdiction.

## Attribution

${meta.sources.map((s) => `- ${s.name}: ${s.license}`).join("\n")}

Wikipedia content is CC BY-SA 4.0. Any surface that shows a Wikipedia derived
value has to credit the article, which is what the \`wikipedia\` field is for.

## Reference only

Nothing here is a basis for a workplace safety decision. Verify against the
safety data sheet, NFPA 704 itself, and the authority having jurisdiction.
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = Date.now();
mkdirSync(outDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

// The emitted modules and the shipped JSON ARE committed, as of the 2026-08-23
// decision: Workers Builds caps a build near 20 minutes and a cold refetch is
// longer than that, so a deploy imports the dated snapshot rather than
// rebuilding it. Only the raw fetch cache stays out of git. Writing "*" here,
// which this script used to do, would quietly untrack the whole dataset.
writeFileSync(
  join(outDir, ".gitignore"),
  `# The .cache/ tree (raw fetches) never lands in git; the emitted snapshot
# modules DO: Workers Builds caps builds around 20 minutes and a cold refetch
# takes longer, so deploys import the committed, dated snapshots and
# scripts/prepare-chem-data.mjs / prepare-wikidata.mjs are the refresh path.
.cache/
`,
);

if (REFRESH && existsSync(cacheDir)) {
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  log("--refresh: cleared the cache");
}
if (OFFLINE) log("--offline: no network requests will be made");

log("step 1/11 periodic table");
const elements = await buildElements();
log(`  ${elements.length} elements`);

log("step 2/11 GHS reference text");
const reference = await buildGhsReference();
log(
  `  ${reference.pictograms.length} pictograms, ` +
    `${Object.keys(reference.hStatements).length} H statements, ` +
    `${Object.keys(reference.pStatements).length} P statements`,
);

log("step 3/11 PubChem NFPA annotations");
const nfpaRows = await buildNfpaRows();
log(
  `  ${nfpaRows.stats.total} annotations, ${nfpaRows.stats.rated} rated, ` +
    `${nfpaRows.stats.withCid} with a CID, ${nfpaRows.stats.specialOnly} carrying only a special symbol`,
);

log("step 4/11 Wikipedia Chembox");
const wikiRows = await buildWikiRows(elements);
log(
  `  ${wikiRows.rows.length} articles parsed, ${wikiRows.stats.rated} rated, ` +
    `${wikiRows.stats.partial} with a partial rating, ${wikiRows.stats.withCid} with a CID`,
);
log(`  NFPA-S values seen: ${wikiRows.specialsSeen.map(([s, n]) => `${s} x${n}`).join(", ")}`);

const cids = new Set();
for (const row of nfpaRows.rows) if (row.cid !== undefined) cids.add(row.cid);
for (const row of wikiRows.rows) if (row.cid !== undefined) cids.add(row.cid);

log(`step 5/11 PubChem facts for ${cids.size} CIDs`);
const facts = await buildPubchemFacts(cids);

log(`step 6/11 GHS classification for ${cids.size} CIDs`);
const ghs = await buildGhsByCid(cids);

const { chemicals, stats } = buildChemicals({
  nfpaRows,
  wikiRows,
  ghsByCid: ghs.byCid,
  facts,
});

// ---------------------------------------------------------------------------
// The broad tier. Everything above stays exactly as it was: chem-data.ts is
// imported by five tools and its cache is warm, so it is neither refetched nor
// reshaped here. This tier is additive and ships separately.
// ---------------------------------------------------------------------------

let broad = null;
if (NO_BROAD) {
  log("--no-broad: skipping the broad tier");
} else {
  log("step 7/11 Wikipedia infobox transclusions");
  const broadTitles = await broadCandidateTitles();

  log(`step 8/11 infobox wikitext for ${broadTitles.length} articles`);
  const broadRows = await buildBroadRows(broadTitles, elements);
  log(
    `  ${broadRows.length} boxes parsed, ` +
      `${broadRows.filter((r) => r.isDrug).length} drug boxes, ` +
      `${broadRows.filter((r) => r.cid !== undefined).length} with a CID in the box, ` +
      `${broadRows.filter((r) => r.cas).length} with a CAS number, ` +
      `${broadRows.filter((r) => r.nfpa).length} rated`,
  );

  // A quarter of what is left, so the GHS sweep is never starved by lookups
  // that only improve a row rather than create one.
  log("step 9/11 resolving missing PubChem CIDs");
  const resolution = await resolveBroadCids(broadRows, Math.max(0, budgetLeftMs() * 0.25));

  const broadCids = new Set();
  for (const row of broadRows) if (row.cid !== undefined) broadCids.add(row.cid);

  log(`step 10/11 PubChem properties for ${broadCids.size} CIDs`);
  const broadProps = await buildBroadProps(broadCids);

  log(`step 11/11 bulk GHS annotations, wanting ${broadCids.size} CIDs`);
  const broadGhs = await buildGhsBulk(broadCids);

  log("article lead snippets");
  const descriptions = await fetchBroadDescriptions(broadRows.map((r) => r.title));

  const built = buildBroadRecords({
    rows: broadRows,
    props: broadProps,
    ghsByCid: broadGhs.byCid,
    descriptions,
  });
  broad = { ...built, resolution, ghs: broadGhs, titles: broadTitles.length };
}

const counts = {
  chemicals: chemicals.length,
  withNfpa: chemicals.filter((c) => c.nfpa).length,
  withNfpaAlt: chemicals.filter((c) => c.nfpaAlt).length,
  withGhs: chemicals.filter((c) => c.ghs).length,
  withCas: chemicals.filter((c) => c.cas).length,
  withFormula: chemicals.filter((c) => c.formula).length,
  withMolarMass: chemicals.filter((c) => c.molarMass !== undefined).length,
  withCid: chemicals.filter((c) => c.cid !== undefined).length,
  withWikipedia: chemicals.filter((c) => c.wikipedia).length,
  withProps: chemicals.filter((c) => c.props).length,
  nfpaFromPubChem: chemicals.filter((c) => c.nfpa && c.nfpa.source !== "Wikipedia").length,
  nfpaFromWikipedia: chemicals.filter((c) => c.nfpa && c.nfpa.source === "Wikipedia").length,
  mergedAcrossSources: stats.merged,
  elements: elements.length,
  hStatements: Object.keys(reference.hStatements).length,
  pStatements: Object.keys(reference.pStatements).length,
  pictograms: reference.pictograms.length,
};

const meta = {
  // A date rather than a timestamp, so two builds on one day are byte identical.
  builtAt: new Date().toISOString().slice(0, 10),
  counts,
  sources: SOURCE_ATTRIBUTION,
  ghsSourcePriority: GHS_SOURCE_PRIORITY,
  notes: [
    "Reference only. Verify against the safety data sheet, NFPA 704 and the authority having jurisdiction.",
    "Wikipedia derived values are CC BY-SA 4.0 and must credit the article named in the wikipedia field.",
  ],
};

const outputs = [
  {
    name: "chem-data.ts",
    body: emitChemData(chemicals, meta),
    what: "CHEMICALS and CHEM_DATA_META",
  },
  { name: "elements.ts", body: emitElements(elements), what: "ELEMENTS, the 118 elements" },
  {
    name: "ghs-statements.ts",
    body: emitGhsStatements(reference),
    what: "H_STATEMENTS, P_STATEMENTS and PICTOGRAMS",
  },
];

const written = [];
for (const file of outputs) {
  writeFileSync(join(outDir, file.name), file.body);
  written.push({ name: file.name, bytes: Buffer.byteLength(file.body), what: file.what });
}
let broadMeta = null;
let shipped = null;
if (broad) {
  const records = broad.records;
  shipped = renderBroadFilesWithinBudget(records);

  const withGhs = records.filter((r) => r.ghs).length;
  broadMeta = {
    // A date rather than a timestamp, so two builds on one day are identical.
    builtAt: meta.builtAt,
    /** The narrow tier, for the doc comment. Not a count of this dataset. */
    narrowChemicals: chemicals.length,
    shards: CHEM_SHARD_COUNT,
    /** index.json's columns, in order. The last is optional; see ChemIndexRow's doc comment. */
    columns: ["id", "name", "formula", "cas", "molarMass", "flags", "syn"],
    /** How many alternative names index.json's `syn` column carries at most. */
    indexSynLimit: INDEX_SYN_LIMIT,
    /**
     * How many it actually shipped with in this build: INDEX_SYN_LIMIT unless
     * index.json's own size budget forced a cut, in which case it is 3, 2 or 0.
     */
    indexSynCap: shipped.indexSynCap,
    counts: {
      compounds: records.length,
      withNfpa: records.filter((r) => r.nfpa).length,
      withGhs,
      /**
       * Compounds with no GHS classification. Read it together with
       * `ghsSweepComplete`: when that is true this is simply how many compounds
       * PubChem has never classified, which is most of them, and a rerun will
       * not change it. Only when it is false is this a resume signal.
       */
      withoutGhs: records.length - withGhs,
      drugs: records.filter((r) => r.isDrug).length,
      withCid: records.filter((r) => r.hasCid).length,
      withCas: records.filter((r) => r.cas !== undefined).length,
      withFormula: records.filter((r) => r.formula !== undefined).length,
      withMolarMass: records.filter((r) => r.molarMass !== undefined).length,
      withDescription: records.filter((r) => r.description !== undefined).length,
      /** Compounds whose index row carries at least one `syn` entry. */
      withIndexSyn: records.filter((r) => r.indexSyn && r.indexSyn.length > 0).length,
      articlesRead: broad.titles,
    },
    /**
     * True when the GHS sweep read every page of PubChem's bulk annotations.
     * False means --budget cut it short and a rerun with a warmer cache will
     * classify more compounds.
     */
    ghsSweepComplete: broad.ghs.truncatedAt === 0,
    /** Pages of bulk GHS annotations read, out of the total PubChem offers. */
    ghsPagesRead: broad.ghs.truncatedAt === 0 ? broad.ghs.totalPages : broad.ghs.truncatedAt,
    ghsPagesTotal: broad.ghs.totalPages,
    /** Fields left out to stay inside the size budget. Empty when nothing was. */
    droppedFields: shipped.dropped,
    ghsSourcePriority: GHS_SOURCE_PRIORITY,
    sources: BROAD_SOURCE_ATTRIBUTION,
    notes: [
      "Reference only. Verify against the safety data sheet, NFPA 704 and the authority having jurisdiction.",
      "Wikipedia derived values are CC BY-SA 4.0 and must credit the article named in the wikipedia field.",
      "Hazard statements are codes only. H_STATEMENTS in ./ghs-statements holds the canonical wording.",
    ],
  };

  // Stale shards from an earlier scheme would be served forever otherwise.
  for (const entry of existsSync(dataDir) ? readdirSync(dataDir) : []) {
    if (entry.endsWith(".json")) rmSync(join(dataDir, entry), { force: true });
  }
  for (const file of shipped.files) writeFileSync(join(dataDir, file.name), file.body);

  const body = emitChemIndex(broadMeta);
  writeFileSync(join(outDir, "chem-index.ts"), body);
  written.push({
    name: "chem-index.ts",
    bytes: Buffer.byteLength(body),
    what: "types and helpers for the lazily fetched broad dataset, no bulk data",
  });
}

writeFileSync(join(outDir, "README.md"), emitReadme(meta, written, broadMeta, shipped));

const cacheStat = cacheBytes();
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const specialCounts = new Map();
for (const c of chemicals) {
  const key = c.nfpa?.special.length ? c.nfpa.special.join("+") : "(none)";
  if (c.nfpa) specialCounts.set(key, (specialCounts.get(key) ?? 0) + 1);
}

log("--------------------------------------------------------------");
for (const file of written) log(`${file.name}: ${file.bytes.toLocaleString("en-US")} bytes`);
log(
  `chemicals ${counts.chemicals}, with NFPA ${counts.withNfpa} ` +
    `(PubChem ${counts.nfpaFromPubChem}, Wikipedia ${counts.nfpaFromWikipedia}), ` +
    `with GHS ${counts.withGhs}, with CAS ${counts.withCas}, ` +
    `with Wikipedia ${counts.withWikipedia}, merged ${stats.merged}, ` +
    `NFPA disagreements ${counts.withNfpaAlt}`,
);
log(
  `special symbols: ${[...specialCounts]
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ")}`,
);
log(`GHS block sources: ${ghs.sourceCounts.map(([s, n]) => `${s} ${n}`).join(" | ")}`);
if (broad && broadMeta) {
  const c = broadMeta.counts;
  log("--------------------------------------------------------------");
  log(
    `broad tier: ${c.compounds} compounds from ${c.articlesRead} articles ` +
      `(${broad.stats.dropped} dropped as empty, merged ${broad.stats.mergedCid} on CID, ` +
      `${broad.stats.mergedCas} on CAS, ${broad.stats.mergedName} on name)`,
  );
  log(
    `  with NFPA ${c.withNfpa}, with GHS ${c.withGhs}, without GHS ${c.withoutGhs}, ` +
      `drugs ${c.drugs}, with CID ${c.withCid}, with CAS ${c.withCas}, ` +
      `with formula ${c.withFormula}, with molar mass ${c.withMolarMass}, ` +
      `with a description ${c.withDescription}, with an index synonym ${c.withIndexSyn}`,
  );
  log(
    `  index.json syn column: up to ${broadMeta.indexSynLimit} per row, shipped at most ` +
      `${broadMeta.indexSynCap}${broadMeta.indexSynCap < broadMeta.indexSynLimit ? " (cut to fit its own size budget)" : ""}`,
  );
  log(`  broad GHS sources: ${broad.ghs.sourceCounts.map(([s, n]) => `${s} ${n}`).join(" | ")}`);
  const shardSizes = shipped.files.slice(1).map((f) => f.bytes);
  log(
    `  public/data/chem: ${(shipped.bytes / 1e6).toFixed(2)} MB raw, ` +
      `${(shipped.gz / 1e6).toFixed(2)} MB gzipped, ` +
      `index ${(shipped.files[0].bytes / 1e3).toFixed(0)} KB ` +
      `(${(shipped.files[0].gz / 1e3).toFixed(0)} KB gz), ` +
      `shards ${(Math.min(...shardSizes) / 1e3).toFixed(0)} to ` +
      `${(Math.max(...shardSizes) / 1e3).toFixed(0)} KB`,
  );
  if (broadMeta.droppedFields.length > 0) {
    log(`  dropped to fit the budget: ${broadMeta.droppedFields.join(", ")}`);
  }
  if (broad.ghs.truncatedAt > 0) {
    log(
      `  the GHS sweep stopped at page ${broad.ghs.truncatedAt} of ${broad.ghs.totalPages}; ` +
        `re-run to fill the remaining ${broadMeta.counts.withoutGhs} compounds`,
    );
  }
  if (broad.resolution.unresolved > 0) {
    log(`  ${broad.resolution.unresolved} compounds still have no PubChem CID`);
  }
}
if (stats.cidCollisions > 0)
  log(`${stats.cidCollisions} Wikipedia articles shared a CID with another row`);
if (ghs.errors > 0) log(`${ghs.errors} GHS requests failed; re-run to fill them in`);
log(`cache: ${cacheDir} (${cacheStat.files} files, ${(cacheStat.bytes / 1e6).toFixed(1)} MB)`);
log(`done in ${seconds}s`);
