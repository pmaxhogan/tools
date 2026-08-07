/**
 * The curl API for tools.maxhogan.dev.
 *
 * PROJECT.md sections 1 to 3: server code is stateless and pure request to
 * response. Nothing is stored, nothing is logged, no accounts, no bindings
 * beyond the static asset fetcher. Every endpoint here is the exact same pure
 * `run()` the web page calls, so the third surface is free rather than a
 * reimplementation (rule 27).
 *
 * Routing: /api and /api/* are handled here. Everything else is served
 * straight from the static Astro build by the assets binding, with one
 * exception: /models/* files that were split at build time to fit under the
 * 25 MiB per asset cap are stitched back together here (see reassemble).
 */
import { ToolError, type OptionSpec, type ToolMeta } from '../src/tools/types';

import { meta as baseConverterMeta } from '../src/tools/base-converter/meta';
import { run as baseConverterRun } from '../src/tools/base-converter/index';
import { meta as caseConverterMeta } from '../src/tools/case-converter/meta';
import { run as caseConverterRun } from '../src/tools/case-converter/index';
import { meta as cronParserMeta } from '../src/tools/cron-parser/meta';
import { run as cronParserRun } from '../src/tools/cron-parser/index';
import { meta as csvViewerMeta } from '../src/tools/csv-viewer/meta';
import { run as csvViewerRun } from '../src/tools/csv-viewer/index';
import { meta as dataFormatConverterMeta } from '../src/tools/data-format-converter/meta';
import { run as dataFormatConverterRun } from '../src/tools/data-format-converter/index';
import { meta as decodeAnythingMeta } from '../src/tools/decode-anything/meta';
import { run as decodeAnythingRun } from '../src/tools/decode-anything/index';
import { meta as diffCheckerMeta } from '../src/tools/diff-checker/meta';
import { run as diffCheckerRun } from '../src/tools/diff-checker/index';
import { meta as discordTimestampMeta } from '../src/tools/discord-timestamp/meta';
import { run as discordTimestampRun } from '../src/tools/discord-timestamp/index';
import { meta as durationCalculatorMeta } from '../src/tools/duration-calculator/meta';
import { run as durationCalculatorRun } from '../src/tools/duration-calculator/index';
import { meta as emailHeaderAnalyzerMeta } from '../src/tools/email-header-analyzer/meta';
import { run as emailHeaderAnalyzerRun } from '../src/tools/email-header-analyzer/index';
import { meta as epochConverterMeta } from '../src/tools/epoch-converter/meta';
import { run as epochConverterRun } from '../src/tools/epoch-converter/index';
import { meta as escapeUnescapeMeta } from '../src/tools/escape-unescape/meta';
import { run as escapeUnescapeRun } from '../src/tools/escape-unescape/index';
import { meta as factorioBlueprintDecoderMeta } from '../src/tools/factorio-blueprint-decoder/meta';
import { run as factorioBlueprintDecoderRun } from '../src/tools/factorio-blueprint-decoder/index';
import { meta as figletMeta } from '../src/tools/figlet/meta';
import { run as figletRun } from '../src/tools/figlet/index';
import { meta as hashGeneratorMeta } from '../src/tools/hash-generator/meta';
import { run as hashGeneratorRun } from '../src/tools/hash-generator/index';
import { meta as invisibleCharacterDetectorMeta } from '../src/tools/invisible-character-detector/meta';
import { run as invisibleCharacterDetectorRun } from '../src/tools/invisible-character-detector/index';
import { meta as jsonFormatterMeta } from '../src/tools/json-formatter/meta';
import { run as jsonFormatterRun } from '../src/tools/json-formatter/index';
import { meta as jsonSchemaValidatorMeta } from '../src/tools/json-schema-validator/meta';
import { run as jsonSchemaValidatorRun } from '../src/tools/json-schema-validator/index';
import { meta as jsonToTypescriptMeta } from '../src/tools/json-to-typescript/meta';
import { run as jsonToTypescriptRun } from '../src/tools/json-to-typescript/index';
import { meta as lineSorterMeta } from '../src/tools/line-sorter/meta';
import { run as lineSorterRun } from '../src/tools/line-sorter/index';
import { meta as mojibakeFixerMeta } from '../src/tools/mojibake-fixer/meta';
import { run as mojibakeFixerRun } from '../src/tools/mojibake-fixer/index';
import { meta as oauthScopeDecoderMeta } from '../src/tools/oauth-scope-decoder/meta';
import { run as oauthScopeDecoderRun } from '../src/tools/oauth-scope-decoder/index';
import { meta as placeholderImageMeta } from '../src/tools/placeholder-image/meta';
import { run as placeholderImageRun } from '../src/tools/placeholder-image/index';
import { meta as snowflakeDecoderMeta } from '../src/tools/snowflake-decoder/meta';
import { run as snowflakeDecoderRun } from '../src/tools/snowflake-decoder/index';
import { meta as smartctlAnalyzerMeta } from '../src/tools/smartctl-analyzer/meta';
import { run as smartctlAnalyzerRun } from '../src/tools/smartctl-analyzer/index';
import { meta as sqlFormatterMeta } from '../src/tools/sql-formatter/meta';
import { run as sqlFormatterRun } from '../src/tools/sql-formatter/index';
import { meta as subtitleEditorMeta } from '../src/tools/subtitle-editor/meta';
import { run as subtitleEditorRun } from '../src/tools/subtitle-editor/index';
import { meta as unicodePickerMeta } from '../src/tools/unicode-picker/meta';
import { run as unicodePickerRun } from '../src/tools/unicode-picker/index';
import { meta as urlParserMeta } from '../src/tools/url-parser/meta';
import { run as urlParserRun } from '../src/tools/url-parser/index';
import { meta as userAgentParserMeta } from '../src/tools/user-agent-parser/meta';
import { run as userAgentParserRun } from '../src/tools/user-agent-parser/index';
import { meta as uuidMeta } from '../src/tools/uuid/meta';
import { run as uuidRun } from '../src/tools/uuid/index';
import { meta as weekNumberMeta } from '../src/tools/week-number/meta';
import { run as weekNumberRun } from '../src/tools/week-number/index';

export interface Env {
  /** Static assets from the Astro build. The only binding this worker has. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

type Options = Record<string, unknown>;

interface Endpoint {
  meta: ToolMeta;
  run: (input: string, opts: Options) => unknown;
  /** Example input for the /api index. Omitted for tools that take no input. */
  sample?: string;
  /** Example option query string for the /api index, without the leading "?". */
  sampleQuery?: string;
  /** Full replacement for the generated sample command, when a one-liner will not do. */
  sampleCommand?: (base: string) => string;
}

/**
 * Adapts a tool's typed `run` to the uniform shape the router calls. The casts
 * live here so nothing downstream has to know a tool's option type, and tools
 * that ignore their input (generators) still fit the same signature.
 */
function expose<I, O, P>(
  meta: ToolMeta,
  run: (input: I, opts: P) => O | Promise<O>,
  extras: Omit<Endpoint, 'meta' | 'run'> = {},
): Endpoint {
  return {
    meta,
    run: (input, opts) => run(input as unknown as I, opts as unknown as P),
    ...extras,
  };
}

/**
 * Every tool exposed over HTTP, in index order. Tools whose meta has no `http`
 * are absent by construction: adding one here without `http` is filtered out
 * below.
 *
 * Wrangler bundles this worker separately from the Astro client build, so the
 * static imports above cost the site nothing in page weight.
 */
const ALL: Endpoint[] = [
  expose(baseConverterMeta, baseConverterRun, { sample: '255', sampleQuery: 'inputBase=auto' }),
  expose(caseConverterMeta, caseConverterRun, { sample: 'parseHTMLDocument' }),
  expose(cronParserMeta, cronParserRun, { sample: '0 9 * * 1-5', sampleQuery: 'tz=UTC' }),
  expose(csvViewerMeta, csvViewerRun, {
    sampleQuery: 'view=stats',
    sampleCommand: (base) =>
      `printf 'name,price\\nwidget,9.50\\ngadget,120\\n' | curl -X POST --data-binary @- "${base}/api/csv-viewer?view=stats"`,
  }),
  expose(dataFormatConverterMeta, dataFormatConverterRun, {
    sampleQuery: 'from=auto&to=yaml',
    sampleCommand: (base) =>
      `printf '{"name":"Ada","tags":["a","b"]}' | curl -X POST --data-binary @- "${base}/api/data-format-converter?to=yaml"`,
  }),
  expose(decodeAnythingMeta, decodeAnythingRun, {
    sample: 'eyJoZWxsbyI6IndvcmxkIn0=',
    sampleQuery: 'maxDepth=10',
  }),
  expose(diffCheckerMeta, diffCheckerRun, {
    sampleQuery: 'mode=lines',
    sampleCommand: (base) =>
      `printf 'a\\nb\\n=====\\na\\nc\\n' | curl -X POST --data-binary @- "${base}/api/diff-checker?mode=lines"`,
  }),
  expose(discordTimestampMeta, discordTimestampRun, { sample: '2026-08-06T21:00:00Z' }),
  expose(durationCalculatorMeta, durationCalculatorRun, { sample: '1h 30m + 45m' }),
  expose(emailHeaderAnalyzerMeta, emailHeaderAnalyzerRun, {
    sampleQuery: 'section=hops',
    sampleCommand: (base) =>
      `curl -X POST --data-binary @headers.txt "${base}/api/email-header-analyzer?section=all"`,
  }),
  expose(epochConverterMeta, epochConverterRun, {
    sample: '1754521200',
    sampleQuery: 'tz=America/Chicago',
  }),
  expose(escapeUnescapeMeta, escapeUnescapeRun, {
    sample: 'He said "hi"',
    sampleQuery: 'format=json&direction=escape',
  }),
  expose(factorioBlueprintDecoderMeta, factorioBlueprintDecoderRun, {
    sampleQuery: 'operation=inspect',
    sampleCommand: (base) =>
      `printf '0eNqrVkrKKU0tKMrMK1GyqlbKTC...' | curl -X POST --data-binary @- "${base}/api/factorio-blueprint-decoder?operation=inspect"`,
  }),
  expose(figletMeta, figletRun, { sample: 'hello', sampleQuery: 'font=Standard' }),
  expose(hashGeneratorMeta, hashGeneratorRun, { sample: 'hello world' }),
  expose(invisibleCharacterDetectorMeta, invisibleCharacterDetectorRun, {
    sample: 'hello​world',
    sampleQuery: 'mode=report',
  }),
  expose(jsonFormatterMeta, jsonFormatterRun, {
    sample: '{"b":1,"a":2}',
    sampleQuery: 'mode=format&indent=2',
  }),
  expose(jsonSchemaValidatorMeta, jsonSchemaValidatorRun, {
    sampleQuery: 'draft=2020-12',
    sampleCommand: (base) =>
      `printf '{"schema":{"type":"object","required":["name"]},"data":{"age":3}}' | curl -X POST --data-binary @- "${base}/api/json-schema-validator"`,
  }),
  expose(jsonToTypescriptMeta, jsonToTypescriptRun, {
    sampleQuery: 'target=typescript&rootName=User',
    sampleCommand: (base) =>
      `printf '{"name":"Ada","langs":["ts"]}' | curl -X POST --data-binary @- "${base}/api/json-to-typescript?target=typescript&rootName=User"`,
  }),
  expose(lineSorterMeta, lineSorterRun, {
    sampleQuery: 'operation=sort-az',
    sampleCommand: (base) =>
      `printf 'banana\\napple\\ncherry\\n' | curl -X POST --data-binary @- "${base}/api/line-sorter?operation=sort-az"`,
  }),
  expose(mojibakeFixerMeta, mojibakeFixerRun, { sample: 'donâ€™t', sampleQuery: 'chain=auto' }),
  expose(oauthScopeDecoderMeta, oauthScopeDecoderRun, {
    sample: 'repo delete_repo read:user',
    sampleQuery: 'sort=risk',
  }),
  expose(placeholderImageMeta, placeholderImageRun, { sampleQuery: 'width=600&height=400' }),
  expose(snowflakeDecoderMeta, snowflakeDecoderRun, {
    sample: '175928847299117063',
    sampleQuery: 'platform=discord',
  }),
  expose(smartctlAnalyzerMeta, smartctlAnalyzerRun, {
    sampleQuery: 'detail=verdict',
    sampleCommand: (base) =>
      `smartctl -a /dev/sda | curl -X POST --data-binary @- "${base}/api/smartctl-analyzer"`,
  }),
  expose(sqlFormatterMeta, sqlFormatterRun, {
    sampleQuery: 'dialect=postgresql&keywordCase=upper',
    sampleCommand: (base) =>
      `printf 'select id,name from users where id=1' | curl -X POST --data-binary @- "${base}/api/sql-formatter?dialect=postgresql"`,
  }),
  expose(subtitleEditorMeta, subtitleEditorRun, {
    sampleQuery: 'operation=shift&offset=%2B2.5',
    sampleCommand: (base) =>
      `printf '1\\n00:00:01,000 --> 00:00:02,000\\nHello\\n' | curl -X POST --data-binary @- "${base}/api/subtitle-editor?operation=shift&offset=%2B2.5"`,
  }),
  expose(unicodePickerMeta, unicodePickerRun, { sample: 'arrow', sampleQuery: 'category=arrows' }),
  expose(urlParserMeta, urlParserRun, { sample: 'https://example.com/a/b?x=1&y=2#frag' }),
  expose(userAgentParserMeta, userAgentParserRun, {
    sample:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  }),
  expose(uuidMeta, uuidRun, { sampleQuery: 'version=v4&count=3' }),
  expose(weekNumberMeta, weekNumberRun, { sample: '2026-08-06' }),
];

const ENDPOINTS: Endpoint[] = ALL.filter((e) => e.meta.http);

const BY_SLUG: Map<string, Endpoint> = new Map(ENDPOINTS.map((e) => [e.meta.slug, e]));

/**
 * Tools whose output changes between identical requests. Everything else is a
 * pure function of its input and is safe for shared caches.
 */
const NON_DETERMINISTIC = new Set(['uuid-generator']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function withCharset(contentType: string): string {
  if (/charset=/i.test(contentType)) return contentType;
  if (/^text\/|json$|\+json$|\+xml$/i.test(contentType)) return `${contentType}; charset=utf-8`;
  return contentType;
}

function respond(body: string, status: number, contentType: string, cache: string): Response {
  return new Response(body, {
    status,
    headers: {
      ...CORS,
      'Content-Type': withCharset(contentType),
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function text(body: string, status = 200, cache = 'no-store'): Response {
  return respond(body, status, 'text/plain', cache);
}

function json(value: unknown, status = 200, cache = 'no-store'): Response {
  return respond(`${JSON.stringify(value, null, 2)}\n`, status, 'application/json', cache);
}

/** Human-readable summary of one option, for the plain-text index. */
function describeOption(o: OptionSpec): string {
  if (o.kind === 'select') {
    const choices = o.choices.map((c) => c.value);
    const detail =
      choices.length <= 6 ? `one of: ${choices.join(', ')}` : `${choices.length} choices`;
    return `${o.id}=${o.default} (${detail})`;
  }
  if (o.kind === 'boolean') return `${o.id}=${o.default} (true or false)`;
  if (o.kind === 'number' || o.kind === 'slider') {
    const range =
      o.min !== undefined || o.max !== undefined
        ? ` (${o.min ?? 'any'} to ${o.max ?? 'any'})`
        : ' (number)';
    return `${o.id}=${o.default}${range}`;
  }
  return `${o.id}=${o.default === '' ? '""' : o.default} (text)`;
}

function sampleCommand(e: Endpoint, base: string): string {
  if (e.sampleCommand) return e.sampleCommand(base);
  const method = e.meta.http?.method ?? 'GET';
  const query = e.sampleQuery ? e.sampleQuery : '';
  if (method === 'POST') {
    const url = query ? `${base}/api/${e.meta.slug}?${query}` : `${base}/api/${e.meta.slug}`;
    const body = (e.sample ?? '').replace(/'/g, `'\\''`);
    return `curl -X POST --data-binary '${body}' "${url}"`;
  }
  const parts: string[] = [];
  if (e.sample !== undefined) parts.push(`input=${encodeURIComponent(e.sample)}`);
  if (query) parts.push(query);
  const url = parts.length
    ? `${base}/api/${e.meta.slug}?${parts.join('&')}`
    : `${base}/api/${e.meta.slug}`;
  return `curl "${url}"`;
}

/**
 * Base URL for the examples we print. Production is always https, so an http
 * request still gets copy-pasteable https commands. Local dev keeps its own
 * scheme and port.
 */
function baseUrl(url: URL): string {
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(url.host);
  return isLocal ? url.origin : `https://${url.host}`;
}

/** The discoverability surface: `curl https://tools.maxhogan.dev/api`. */
function indexBody(base: string): string {
  const lines: string[] = [
    'tools.maxhogan.dev curl API',
    '',
    'Stateless and pure. Your input is never stored and never logged, and every',
    'response is computed from the request alone. Same code as the web pages.',
    '',
    '  GET  /api                 this index',
    '  GET  /api/<tool>          input comes from the "input" query param',
    '  POST /api/<tool>          input is the raw request body',
    '',
    'Options are extra query params. Any option you leave out uses its default.',
    'Errors return HTTP 400 and a JSON body with a code, a message, and a fix.',
    '',
    `${ENDPOINTS.length} endpoints:`,
    '',
  ];

  for (const e of ENDPOINTS) {
    const method = e.meta.http?.method ?? 'GET';
    lines.push(`${method} /api/${e.meta.slug}`);
    lines.push(`  ${e.meta.description}`);
    const options = e.meta.options ?? [];
    if (options.length) {
      lines.push(`  options: ${options.map(describeOption).join(', ')}`);
    }
    lines.push(`  ${sampleCommand(e, base)}`);
    lines.push('');
  }

  lines.push('Source: https://github.com/pmaxhogan/tools (MIT).');
  lines.push('');
  return lines.join('\n');
}

function notFoundBody(slug: string, base: string): string {
  const known = ENDPOINTS.map((e) => `  ${e.meta.http?.method ?? 'GET'} /api/${e.meta.slug}`);
  return [
    slug
      ? `No API endpoint named "${slug}".`
      : 'No API endpoint at that path.',
    '',
    'Some tools run only in the browser, so they have no endpoint here.',
    'These are the ones you can curl:',
    '',
    ...known,
    '',
    `Full index with examples: curl ${base}/api`,
    '',
  ].join('\n');
}

/**
 * Query params to tool options: defaults from meta first, then whatever the
 * caller sent, coerced to the declared kind. Params with no matching option
 * pass through as strings so a tool can read an option its meta does not
 * declare yet.
 */
function readOptions(meta: ToolMeta, params: URLSearchParams): Options {
  const specs = meta.options ?? [];
  const opts: Options = {};
  for (const spec of specs) opts[spec.id] = spec.default;

  for (const [key, raw] of params) {
    if (key === 'input') continue;
    const spec = specs.find((s) => s.id === key);
    if (!spec) {
      opts[key] = raw;
      continue;
    }
    if (spec.kind === 'number' || spec.kind === 'slider') {
      const n = Number(raw);
      opts[key] = Number.isFinite(n) ? n : spec.default;
    } else if (spec.kind === 'boolean') {
      const v = raw.trim().toLowerCase();
      opts[key] = v === 'true' || v === '1' || v === 'yes' || v === '';
    } else {
      opts[key] = raw;
    }
  }
  return opts;
}

function cacheFor(meta: ToolMeta): string {
  if (NON_DETERMINISTIC.has(meta.slug)) return 'no-store';
  // A cached POST response can legally be reused for a later GET on the same
  // URI, and the bodies differ, so POST endpoints stay uncached.
  if (meta.http?.method === 'POST') return 'no-store';
  return 'public, max-age=3600';
}

async function handleTool(request: Request, url: URL, slug: string): Promise<Response> {
  const endpoint = BY_SLUG.get(slug);
  if (!endpoint || !endpoint.meta.http) {
    return text(notFoundBody(slug, baseUrl(url)), 404);
  }

  const expected = endpoint.meta.http.method;
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  if (method !== expected) {
    const body = [
      `/api/${slug} accepts ${expected}, not ${request.method}.`,
      '',
      expected === 'GET'
        ? `Try: curl "${baseUrl(url)}/api/${slug}?input=..."`
        : `Try: curl -X POST --data-binary @file "${baseUrl(url)}/api/${slug}"`,
      '',
    ].join('\n');
    return new Response(body, {
      status: 405,
      headers: {
        ...CORS,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        Allow: `${expected}, OPTIONS`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const input = expected === 'POST' ? await request.text() : (url.searchParams.get('input') ?? '');
  const opts = readOptions(endpoint.meta, url.searchParams);
  const cache = cacheFor(endpoint.meta);

  try {
    const result = await endpoint.run(input, opts);
    if (typeof result === 'string') {
      return respond(result, 200, endpoint.meta.http.contentType, cache);
    }
    return json(result, 200, cache);
  } catch (err) {
    if (err instanceof ToolError) {
      return json({ error: { code: err.code, message: err.message, fix: err.fix } }, 400);
    }
    return json(
      {
        error: {
          code: 'internal-error',
          message: 'This tool failed to run on that input.',
          fix: `Check the input and options against ${baseUrl(url)}/api, then try again.`,
        },
      },
      500,
    );
  }
}

/**
 * Model weights, reassembled.
 *
 * scripts/prepare-models.mjs splits any model file over Cloudflare's 25 MiB
 * per asset limit into `<name>.part0..N` plus a `<name>.chunks.json` manifest,
 * and deletes the oversized original. The two large Whisper decoders are the
 * only files this affects today.
 *
 * transformers.js issues plain GETs against `/models/<id>/<file>` and cannot
 * be handed preassembled bytes, so the stitching has to happen on this side of
 * the wire. Parts are fetched one at a time and piped straight through, so a
 * 51 MiB decoder never sits in worker memory.
 */

/**
 * Two Workers runtime globals. Declared locally rather than pulling in
 * @cloudflare/workers-types, which this project does not otherwise need.
 */
declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expectedLength: number | bigint);
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ChunkManifest {
  totalBytes: number;
  parts: { name: string; bytes: number }[];
}

/** Part names come from a build artifact, but treat them as untrusted anyway. */
const SAFE_PART_NAME = /^[A-Za-z0-9._-]+$/;

function modelHeaders(totalBytes: number): Record<string, string> {
  return {
    ...CORS,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(totalBytes),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * Serves one /models/* path. Small files exist as real assets and are passed
 * through untouched; a 404 means the file may have been chunked, so look for
 * its manifest and stream the parts back as one body.
 *
 * Range is deliberately not supported: transformers.js never sends one, and
 * answering a Range request with the full 200 body is allowed.
 */
async function handleModelAsset(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const direct = await env.ASSETS.fetch(request);
  if (direct.status !== 404) return direct;

  const manifestUrl = new URL(`${url.pathname}.chunks.json`, url.origin);
  const manifestRes = await env.ASSETS.fetch(new Request(manifestUrl.toString()));
  if (!manifestRes.ok) return direct;

  let manifest: ChunkManifest;
  try {
    manifest = (await manifestRes.json()) as ChunkManifest;
  } catch {
    return direct;
  }

  const parts = manifest.parts ?? [];
  if (!parts.length || !parts.every((p) => SAFE_PART_NAME.test(p.name))) return direct;

  const dir = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  const partUrls = parts.map((p) => new URL(dir + p.name, url.origin).toString());
  const headers = modelHeaders(manifest.totalBytes);

  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });

  // FixedLengthStream is what keeps Content-Length on a streamed body, and it
  // errors if the parts do not add up to totalBytes, which is a free check
  // that the build staged a complete set.
  const { readable, writable } = new FixedLengthStream(manifest.totalBytes);

  const pump = (async () => {
    try {
      for (const partUrl of partUrls) {
        const res = await env.ASSETS.fetch(new Request(partUrl));
        if (!res.ok || !res.body) throw new Error(`missing part ${partUrl}`);
        await res.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch {
      // Aborting leaves the client with a truncated body it can detect from
      // the declared Content-Length, which is the honest failure mode here.
      await writable.abort().catch(() => {});
    }
  })();
  ctx.waitUntil(pump);

  return new Response(readable, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const isApi = path === '/api' || path === '/api/' || path.startsWith('/api/');
    if (!isApi) {
      if (
        path.startsWith('/models/') &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        !path.includes('..')
      ) {
        return handleModelAsset(request, url, env, ctx);
      }
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }

    if (path === '/api' || path === '/api/') {
      return text(indexBody(baseUrl(url)), 200, 'public, max-age=3600');
    }

    let slug = path.slice('/api/'.length).replace(/\/+$/, '');
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // A malformed escape sequence just means no such tool.
    }

    if (slug.includes('/')) return text(notFoundBody(slug, baseUrl(url)), 404);

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      return text(`/api/${slug} accepts GET, POST and OPTIONS only.`, 405);
    }

    return handleTool(request, url, slug);
  },
};
