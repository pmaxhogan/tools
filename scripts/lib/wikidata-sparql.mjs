/**
 * Minimal Wikidata Query Service client for build-time snapshot scripts.
 *
 * Everything here exists to make `node scripts/prepare-wikidata.mjs` cheap to
 * re-run and safe to run in CI:
 *
 *  - Every raw response is cached on disk under
 *    src/tools/_generated/.cache/wikidata/, keyed by a hash of the query text.
 *    A second run of an unchanged script does zero network work. Editing a
 *    query changes its hash, so only that one query refetches.
 *  - Requests are strictly sequential with a politeness gap. WDQS is a shared
 *    public service and parallel hammering earns a 429.
 *  - 429 is honored: Retry-After is respected when present, exponential
 *    backoff otherwise.
 *  - WDQS signals "your query was too expensive" in three different ways
 *    (504, 500 with a TimeoutException in the body, and occasionally a 200
 *    carrying a non-JSON error page). All three are normalized into
 *    WdqsTimeoutError so callers can split the query and retry the halves.
 *  - Every request carries an AbortController deadline so a hung socket can
 *    never stall a build.
 *
 * No dependencies beyond node builtins.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Raw responses live beside the generated modules and are gitignored. */
export const CACHE_DIR = join(root, "src", "tools", "_generated", ".cache", "wikidata");

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "tools.maxhogan.dev build (pmaxhogan@gmail.com)";
/** Hard client side deadline. WDQS gives up at 60s; this is the safety net. */
const REQUEST_TIMEOUT_MS = 90_000;
/** Minimum gap between two requests, to stay a polite client. */
const MIN_GAP_MS = 300;
/** Attempts for transient failures (network drop, 429, non-timeout 5xx). */
const MAX_ATTEMPTS = 5;

/** Thrown when WDQS gave up on a query. Callers respond by splitting it. */
export class WdqsTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "WdqsTimeoutError";
  }
}

/** Thrown in --offline mode when a query has no cached response. */
export class OfflineCacheMissError extends Error {
  constructor(message) {
    super(message);
    this.name = "OfflineCacheMissError";
  }
}

let lastRequestAt = 0;
let requestCount = 0;
let networkMs = 0;
let cacheHits = 0;

/** Cache keys touched this run, used to prune entries left by edited queries. */
const usedKeys = new Set();

/** Counters for the run summary. */
export function stats() {
  return { requests: requestCount, networkMs, cacheHits };
}

/**
 * Deletes cache entries no query asked for this run.
 *
 * The cache is keyed by query text, so every edit to a query orphans its old
 * response instead of replacing it. Left alone that grows without bound: a
 * handful of edits to the city queries is tens of megabytes of dead weight.
 * Only safe to call after a run that exercised every query, which is why the
 * caller guards it on a full build.
 */
export function pruneCache() {
  if (!existsSync(CACHE_DIR)) return 0;
  let removed = 0;
  for (const name of readdirSync(CACHE_DIR)) {
    if (!name.endsWith(".json")) continue;
    if (usedKeys.has(name.slice(0, -5))) continue;
    rmSync(join(CACHE_DIR, name));
    removed += 1;
  }
  return removed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheKey(query) {
  return createHash("sha256").update(query, "utf8").digest("hex").slice(0, 40);
}

/** True when a body looks like one of the several WDQS timeout dialects. */
function looksLikeTimeout(status, body) {
  if (status === 504) return true;
  if (status !== 500 && status !== 502 && status !== 503) return false;
  return /timeout|TimeoutException|QueryTimeout|ExecutionException/i.test(body);
}

async function requestOnce(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/sparql-results+json",
        "Content-Type": "application/sparql-query; charset=utf-8",
        "User-Agent": USER_AGENT,
      },
      body: query,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text, retryAfter: res.headers.get("retry-after") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one SPARQL query and returns its `results.bindings` array.
 *
 * @param {string} query SPARQL text. Its exact bytes are the cache key.
 * @param {object} [options]
 * @param {string} [options.label] Short name used in log lines.
 * @param {boolean} [options.refresh] Ignore any cached response.
 * @param {boolean} [options.offline] Never touch the network.
 * @returns {Promise<Array<Record<string, { value: string, type: string }>>>}
 */
export async function sparql(query, options = {}) {
  const { label = "query", refresh = false, offline = false } = options;
  const key = cacheKey(query);
  const path = join(CACHE_DIR, `${key}.json`);
  usedKeys.add(key);

  if (!refresh && existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(cached.bindings)) {
        cacheHits += 1;
        console.log(`prepare-wikidata:   ${label} cached (${cached.bindings.length} rows)`);
        return cached.bindings;
      }
    } catch {
      // A corrupt cache entry is simply refetched.
    }
  }

  if (offline) {
    throw new OfflineCacheMissError(
      `${label} has no cached response and --offline was requested. ` +
        "Run without --offline once to populate src/tools/_generated/.cache/wikidata.",
    );
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const gap = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (gap > 0) await sleep(gap);

    const started = Date.now();
    let response;
    try {
      response = await requestOnce(query);
    } catch (err) {
      lastRequestAt = Date.now();
      networkMs += Date.now() - started;
      requestCount += 1;
      if (err.name === "AbortError") {
        throw new WdqsTimeoutError(`${label} exceeded the ${REQUEST_TIMEOUT_MS}ms client deadline`);
      }
      lastError = err;
      const waitMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      console.warn(
        `prepare-wikidata:   ${label} attempt ${attempt} network error (${err.message}), retrying in ${waitMs}ms`,
      );
      await sleep(waitMs);
      continue;
    }

    const elapsed = Date.now() - started;
    lastRequestAt = Date.now();
    networkMs += elapsed;
    requestCount += 1;

    const { status, text, retryAfter } = response;

    if (status === 429) {
      const headerWait = Number.parseInt(retryAfter ?? "", 10);
      const waitMs = Number.isFinite(headerWait)
        ? Math.min(120_000, headerWait * 1000)
        : Math.min(60_000, 2000 * 2 ** (attempt - 1));
      console.warn(`prepare-wikidata:   ${label} rate limited, waiting ${waitMs}ms`);
      await sleep(waitMs);
      lastError = new Error("HTTP 429");
      continue;
    }

    if (looksLikeTimeout(status, text)) {
      throw new WdqsTimeoutError(`${label} timed out server side (HTTP ${status})`);
    }

    if (!(status >= 200 && status < 300)) {
      // A 4xx is a bad query and will never succeed. Fail loudly and at once.
      if (status >= 400 && status < 500) {
        throw new Error(
          `${label} rejected with HTTP ${status}: ${text.slice(0, 500).replace(/\s+/g, " ")}`,
        );
      }
      lastError = new Error(`HTTP ${status}`);
      const waitMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      console.warn(`prepare-wikidata:   ${label} HTTP ${status}, retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // A 200 that is not JSON is WDQS returning an HTML error page, which in
      // practice means the query blew its budget.
      throw new WdqsTimeoutError(
        `${label} returned a non-JSON 200 body, which WDQS uses for over-budget queries`,
      );
    }

    const bindings = json?.results?.bindings;
    if (!Array.isArray(bindings)) {
      throw new Error(`${label} returned a response with no results.bindings`);
    }

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ label, fetchedAt: new Date().toISOString(), query, bindings })}\n`,
    );
    console.log(`prepare-wikidata:   ${label} ${elapsed}ms (${bindings.length} rows)`);
    return bindings;
  }

  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

/**
 * Runs a query that is split into shards, subdividing any shard WDQS refuses.
 *
 * `build(shard)` returns the SPARQL text for one shard. `split(shard)` returns
 * either null (this shard cannot be divided any further, so give up) or an
 * array of smaller shards. Results from every shard are concatenated, and the
 * caller sorts the merged output, so shard order does not affect the result.
 *
 * @template S
 * @param {S[]} shards
 * @param {(shard: S) => string} build
 * @param {(shard: S) => S[] | null} split
 * @param {(shard: S) => string} name
 * @param {object} options passed through to sparql()
 */
export async function sparqlSharded(shards, build, split, name, options = {}) {
  const rows = [];
  const queue = [...shards];
  while (queue.length > 0) {
    const shard = queue.shift();
    try {
      rows.push(...(await sparql(build(shard), { ...options, label: name(shard) })));
    } catch (err) {
      if (!(err instanceof WdqsTimeoutError)) throw err;
      const parts = split(shard);
      if (!parts || parts.length === 0) {
        throw new Error(`${name(shard)} timed out and cannot be split any further`, {
          cause: err,
        });
      }
      console.warn(
        `prepare-wikidata:   ${name(shard)} timed out, splitting into ${parts.length} shards`,
      );
      queue.unshift(...parts);
    }
  }
  return rows;
}
