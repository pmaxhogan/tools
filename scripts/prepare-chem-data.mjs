/**
 * Builds the chemistry dataset the Chemistry tools read at runtime. Companion
 * to scripts/prepare-models.mjs and scripts/prepare-pyodide.mjs: pinned public
 * sources, an on-disk cache so a rebuild refetches nothing, deterministic
 * output, gitignored artifacts, and loud per-step logging.
 *
 * Run it directly:
 *
 *   node scripts/prepare-chem-data.mjs             build, using the cache
 *   node scripts/prepare-chem-data.mjs --refresh   ignore the cache, refetch
 *   node scripts/prepare-chem-data.mjs --offline    cache only, fail on a miss
 *
 * Cold run is roughly 10 to 15 minutes (the per compound GHS sweep dominates).
 * Warm run is a few seconds: every network step has a parsed digest next to the
 * raw responses, so nothing large is re-parsed unless a PARSE_VERSION changes.
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
 * ---------------------------------------------------------------------------
 * Output (all under src/tools/_generated/, gitignored)
 * ---------------------------------------------------------------------------
 *
 *   chem-data.ts       CHEMICALS: Chemical[] and CHEM_DATA_META
 *   elements.ts        ELEMENTS: Element[]
 *   ghs-statements.ts  H_STATEMENTS, P_STATEMENTS, PICTOGRAMS
 *   README.md          the shapes and the rebuild command
 *   .gitignore         ignores the whole directory, including the cache
 *   .cache/chem/       raw responses plus parsed digests, gzipped
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
// Scoped to its own subdirectory: other prepare-*.mjs scripts cache under
// src/tools/_generated/.cache/ too, and --refresh clears this path outright.
const cacheDir = join(outDir, ".cache", "chem");

const args = new Set(process.argv.slice(2));
const REFRESH = args.has("--refresh");
const OFFLINE = args.has("--offline");
for (const arg of args) {
  if (arg !== "--refresh" && arg !== "--offline") {
    fail(`unknown flag ${arg}. Supported flags are --refresh and --offline.`);
  }
}
if (REFRESH && OFFLINE) fail("--refresh and --offline cannot be combined.");

/** Bumped by hand when a parser change must invalidate a cached digest. */
const NFPA_PARSE_VERSION = 1;
const WIKI_PARSE_VERSION = 2;
const GHS_PARSE_VERSION = 1;
const PROPS_PARSE_VERSION = 1;

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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`prepare-chem-data: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`prepare-chem-data: ${message}`);
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

/** Every top level Chembox in a page, as [start, end) index pairs. */
function chemboxRegions(text) {
  const regions = [];
  const re = /\{\{\s*Chembox\b/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const end = templateEnd(text, match.index);
    if (end === -1) break;
    regions.push([match.index, end]);
    // Skip the Chembox Identifiers and Chembox Properties inside this one.
    re.lastIndex = end;
  }
  return regions;
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
// Rebuild with \`node scripts/prepare-chem-data.mjs\`. This file is gitignored.
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

function emitReadme(meta, files) {
  const rows = files.map(
    (f) => `| \`${f.name}\` | ${f.bytes.toLocaleString("en-US")} bytes | ${f.what} |`,
  );
  return `# src/tools/_generated

Generated data modules. The chemistry ones are built by
\`scripts/prepare-chem-data.mjs\`; other scripts write their own files here.
Everything in this directory is a build artifact: the directory ignores
itself, nothing in it is committed, and hand edits are lost on the next build.

## Rebuild

\`\`\`
node scripts/prepare-chem-data.mjs             # build, using the on-disk cache
node scripts/prepare-chem-data.mjs --refresh   # ignore the cache and refetch
node scripts/prepare-chem-data.mjs --offline   # cache only, fail on a miss
\`\`\`

A warm build takes a few seconds. A cold build takes roughly 10 to 15 minutes,
almost all of it the per compound GHS sweep, and leaves its responses in
\`src/tools/_generated/.cache/chem/\` so the next build refetches nothing.

## Files

| File | Size | Contents |
| ---- | ---- | -------- |
${rows.join("\n")}

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
writeFileSync(join(outDir, ".gitignore"), "*\n!.gitignore\n");

if (REFRESH && existsSync(cacheDir)) {
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  log("--refresh: cleared the cache");
}
if (OFFLINE) log("--offline: no network requests will be made");

log("step 1/6 periodic table");
const elements = await buildElements();
log(`  ${elements.length} elements`);

log("step 2/6 GHS reference text");
const reference = await buildGhsReference();
log(
  `  ${reference.pictograms.length} pictograms, ` +
    `${Object.keys(reference.hStatements).length} H statements, ` +
    `${Object.keys(reference.pStatements).length} P statements`,
);

log("step 3/6 PubChem NFPA annotations");
const nfpaRows = await buildNfpaRows();
log(
  `  ${nfpaRows.stats.total} annotations, ${nfpaRows.stats.rated} rated, ` +
    `${nfpaRows.stats.withCid} with a CID, ${nfpaRows.stats.specialOnly} carrying only a special symbol`,
);

log("step 4/6 Wikipedia Chembox");
const wikiRows = await buildWikiRows(elements);
log(
  `  ${wikiRows.rows.length} articles parsed, ${wikiRows.stats.rated} rated, ` +
    `${wikiRows.stats.partial} with a partial rating, ${wikiRows.stats.withCid} with a CID`,
);
log(`  NFPA-S values seen: ${wikiRows.specialsSeen.map(([s, n]) => `${s} x${n}`).join(", ")}`);

const cids = new Set();
for (const row of nfpaRows.rows) if (row.cid !== undefined) cids.add(row.cid);
for (const row of wikiRows.rows) if (row.cid !== undefined) cids.add(row.cid);

log(`step 5/6 PubChem facts for ${cids.size} CIDs`);
const facts = await buildPubchemFacts(cids);

log(`step 6/6 GHS classification for ${cids.size} CIDs`);
const ghs = await buildGhsByCid(cids);

const { chemicals, stats } = buildChemicals({
  nfpaRows,
  wikiRows,
  ghsByCid: ghs.byCid,
  facts,
});

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
writeFileSync(join(outDir, "README.md"), emitReadme(meta, written));

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
if (stats.cidCollisions > 0)
  log(`${stats.cidCollisions} Wikipedia articles shared a CID with another row`);
if (ghs.errors > 0) log(`${ghs.errors} GHS requests failed; re-run to fill them in`);
log(`cache: ${cacheDir} (${cacheStat.files} files, ${(cacheStat.bytes / 1e6).toFixed(1)} MB)`);
log(`done in ${seconds}s`);
