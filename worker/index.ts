/**
 * The curl API for tools.maxhogan.dev.
 *
 * PROJECT.md sections 1 to 3: server code is stateless and pure request to
 * response. Nothing is stored, nothing is logged, no accounts, no bindings
 * beyond the static asset fetcher. Every endpoint here is the exact same pure
 * `run()` the web page calls, so the third surface is free rather than a
 * reimplementation (rule 27).
 *
 * Routing: only /api and /api/* reach this worker. Everything else is served
 * straight from the static Astro build by the assets binding.
 */
import { ToolError, type OptionSpec, type ToolMeta } from '../src/tools/types';

import { meta as baseConverterMeta } from '../src/tools/base-converter/meta';
import { run as baseConverterRun } from '../src/tools/base-converter/index';
import { meta as caseConverterMeta } from '../src/tools/case-converter/meta';
import { run as caseConverterRun } from '../src/tools/case-converter/index';
import { meta as cronParserMeta } from '../src/tools/cron-parser/meta';
import { run as cronParserRun } from '../src/tools/cron-parser/index';
import { meta as discordTimestampMeta } from '../src/tools/discord-timestamp/meta';
import { run as discordTimestampRun } from '../src/tools/discord-timestamp/index';
import { meta as durationCalculatorMeta } from '../src/tools/duration-calculator/meta';
import { run as durationCalculatorRun } from '../src/tools/duration-calculator/index';
import { meta as epochConverterMeta } from '../src/tools/epoch-converter/meta';
import { run as epochConverterRun } from '../src/tools/epoch-converter/index';
import { meta as escapeUnescapeMeta } from '../src/tools/escape-unescape/meta';
import { run as escapeUnescapeRun } from '../src/tools/escape-unescape/index';
import { meta as figletMeta } from '../src/tools/figlet/meta';
import { run as figletRun } from '../src/tools/figlet/index';
import { meta as hashGeneratorMeta } from '../src/tools/hash-generator/meta';
import { run as hashGeneratorRun } from '../src/tools/hash-generator/index';
import { meta as jsonFormatterMeta } from '../src/tools/json-formatter/meta';
import { run as jsonFormatterRun } from '../src/tools/json-formatter/index';
import { meta as lineSorterMeta } from '../src/tools/line-sorter/meta';
import { run as lineSorterRun } from '../src/tools/line-sorter/index';
import { meta as placeholderImageMeta } from '../src/tools/placeholder-image/meta';
import { run as placeholderImageRun } from '../src/tools/placeholder-image/index';
import { meta as snowflakeDecoderMeta } from '../src/tools/snowflake-decoder/meta';
import { run as snowflakeDecoderRun } from '../src/tools/snowflake-decoder/index';
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
  expose(discordTimestampMeta, discordTimestampRun, { sample: '2026-08-06T21:00:00Z' }),
  expose(durationCalculatorMeta, durationCalculatorRun, { sample: '1h 30m + 45m' }),
  expose(epochConverterMeta, epochConverterRun, {
    sample: '1754521200',
    sampleQuery: 'tz=America/Chicago',
  }),
  expose(escapeUnescapeMeta, escapeUnescapeRun, {
    sample: 'He said "hi"',
    sampleQuery: 'format=json&direction=escape',
  }),
  expose(figletMeta, figletRun, { sample: 'hello', sampleQuery: 'font=Standard' }),
  expose(hashGeneratorMeta, hashGeneratorRun, { sample: 'hello world' }),
  expose(jsonFormatterMeta, jsonFormatterRun, {
    sample: '{"b":1,"a":2}',
    sampleQuery: 'mode=format&indent=2',
  }),
  expose(lineSorterMeta, lineSorterRun, {
    sampleQuery: 'operation=sort-az',
    sampleCommand: (base) =>
      `printf 'banana\\napple\\ncherry\\n' | curl -X POST --data-binary @- "${base}/api/line-sorter?operation=sort-az"`,
  }),
  expose(placeholderImageMeta, placeholderImageRun, { sampleQuery: 'width=600&height=400' }),
  expose(snowflakeDecoderMeta, snowflakeDecoderRun, {
    sample: '175928847299117063',
    sampleQuery: 'platform=discord',
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
    return text(notFoundBody(slug, url.origin), 404);
  }

  const expected = endpoint.meta.http.method;
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  if (method !== expected) {
    const body = [
      `/api/${slug} accepts ${expected}, not ${request.method}.`,
      '',
      expected === 'GET'
        ? `Try: curl "${url.origin}/api/${slug}?input=..."`
        : `Try: curl -X POST --data-binary @file "${url.origin}/api/${slug}"`,
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
          fix: `Check the input and options against ${url.origin}/api, then try again.`,
        },
      },
      500,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const isApi = path === '/api' || path === '/api/' || path.startsWith('/api/');
    if (!isApi) return env.ASSETS.fetch(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'Cache-Control': 'no-store' } });
    }

    if (path === '/api' || path === '/api/') {
      return text(indexBody(url.origin), 200, 'public, max-age=3600');
    }

    let slug = path.slice('/api/'.length).replace(/\/+$/, '');
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // A malformed escape sequence just means no such tool.
    }

    if (slug.includes('/')) return text(notFoundBody(slug, url.origin), 404);

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      return text(`/api/${slug} accepts GET, POST and OPTIONS only.`, 405);
    }

    return handleTool(request, url, slug);
  },
};
