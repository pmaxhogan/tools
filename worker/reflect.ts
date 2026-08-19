/**
 * Request-reflection endpoints:
 *
 * - GET/POST /api/echo: the Echo Endpoint tool. Reflects the request (method,
 *   URL, query, headers, body, and the connection metadata Cloudflare attaches)
 *   as JSON. Nothing is stored; the response is built and forgotten.
 * - GET /api/http-header-inspector: the Header Inspector tool. Returns only the
 *   request headers as a JSON object.
 *
 * Both redact credential-bearing headers so a shared link never leaks a
 * cookie or token, and both are uncacheable by construction.
 */

const REDACT = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api-?key/i;

const REFLECT_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const MAX_ECHO_BODY = 64 * 1024;

function collectHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of request.headers) {
    out[name] = REDACT.test(name) ? `<redacted, ${value.length} chars>` : value;
  }
  return out;
}

interface CfMeta {
  country?: string;
  city?: string;
  region?: string;
  asn?: number;
  asOrganization?: string;
  colo?: string;
  tlsVersion?: string;
  httpProtocol?: string;
  timezone?: string;
}

export async function handleEcho(request: Request, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: REFLECT_HEADERS });
  }
  const cf = ((request as Request & { cf?: CfMeta }).cf ?? {}) as CfMeta;
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams) {
    const prev = query[k];
    if (prev === undefined) query[k] = v;
    else query[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
  }

  let body: string | undefined;
  let bodyBytes: number | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.arrayBuffer();
    bodyBytes = raw.byteLength;
    const slice = raw.byteLength > MAX_ECHO_BODY ? raw.slice(0, MAX_ECHO_BODY) : raw;
    body = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    if (raw.byteLength > MAX_ECHO_BODY)
      body += `\n... (${raw.byteLength - MAX_ECHO_BODY} more bytes)`;
  }

  const echo = {
    method: request.method,
    url: url.toString(),
    path: url.pathname,
    query,
    headers: collectHeaders(request),
    ip: request.headers.get("cf-connecting-ip") ?? undefined,
    country: cf.country,
    city: cf.city,
    region: cf.region,
    asn: cf.asn,
    asOrganization: cf.asOrganization,
    colo: cf.colo,
    tlsVersion: cf.tlsVersion,
    httpProtocol: cf.httpProtocol,
    userAgent: request.headers.get("user-agent") ?? undefined,
    body,
    bodyBytes,
    timestamp: new Date().toISOString(),
  };
  return new Response(JSON.stringify(echo, null, 2) + "\n", {
    status: 200,
    headers: REFLECT_HEADERS,
  });
}

export function handleHeaderInspector(request: Request): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: REFLECT_HEADERS });
  }
  const headers = collectHeaders(request);
  return new Response(JSON.stringify(headers, null, 2) + "\n", {
    status: 200,
    headers: REFLECT_HEADERS,
  });
}
