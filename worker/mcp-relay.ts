/**
 * POST /api/mcp-relay: a deliberately narrow pass-through for the MCP
 * Inspector tool, for MCP servers that do not send CORS headers. This is NOT
 * a general proxy:
 *
 * - POST only, JSON only, and the inner message must be JSON-RPC 2.0 with a
 *   method on a short allowlist (the read-only MCP handshake plus tool calls).
 * - https targets only, DNS names only (no IP literals), and obviously
 *   internal hostnames are refused.
 * - Authorization and Cookie style credentials are never forwarded; servers
 *   that need auth are client-direct only.
 * - Small caps both directions and a short timeout, so the endpoint is
 *   useless as a bulk relay.
 */

const ALLOWED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
  "ping",
]);

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;

/**
 * Unlike the stateless /api/<tool> endpoints, the relay is NOT for third
 * parties: only the MCP Inspector page may call it, so CORS is pinned to the
 * site's own origin (plus localhost for dev) instead of "*". Without this, any
 * website could make its visitors' browsers relay traffic through here.
 */
const ALLOWED_ORIGINS =
  /^(https:\/\/tools\.maxhogan\.dev|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

function relayCors(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, X-Relay-Upstream-Status",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (ALLOWED_ORIGINS.test(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function relayError(request: Request, status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }, null, 2) + "\n", {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...relayCors(request) },
  });
}

/**
 * First-line filter only. The real boundary is the Workers runtime itself:
 * fetch from a Worker cannot reach non-publicly-routable addresses (RFC1918,
 * loopback, link-local), so a public DNS name that rebinds to a private IP
 * still has nowhere to go. These checks just fail the obvious cases with a
 * clear message instead of a confusing connection error.
 */
function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (h.endsWith(".home.arpa") || h.endsWith(".in-addr.arpa") || h.endsWith(".ip6.arpa"))
    return true;
  // IPv6 literal (URL keeps the brackets in hostname) or anything with a colon.
  if (h.includes(":") || h.startsWith("[")) return true;
  // IPv4 literal, including bare-number forms like 2130706433.
  if (/^\d+(\.\d+){0,3}$/.test(h)) return true;
  // A public server has a dot in its DNS name; single labels are internal.
  if (!h.includes(".")) return true;
  return false;
}

interface RelayBody {
  url?: unknown;
  message?: unknown;
  sessionId?: unknown;
  protocolVersion?: unknown;
}

export async function handleMcpRelay(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: relayCors(request) });
  }
  if (request.method !== "POST") {
    return relayError(request, 405, "method-not-allowed", "POST a JSON body: { url, message }.");
  }

  // Browser requests must come from the site itself. Requests without an
  // Origin header (curl, server-side scripts) are allowed; a foreign Origin is
  // refused outright so third-party pages cannot even fire blind relays.
  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.test(origin)) {
    return relayError(request, 403, "forbidden-origin", "The relay only serves its own site.");
  }

  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) {
    return relayError(
      request,
      413,
      "too-large",
      `Request body is capped at ${MAX_REQUEST_BYTES} bytes.`,
    );
  }

  let body: RelayBody;
  try {
    body = JSON.parse(raw) as RelayBody;
  } catch {
    return relayError(request, 400, "bad-json", "The body must be JSON: { url, message }.");
  }

  if (typeof body.url !== "string") {
    return relayError(request, 400, "missing-url", 'Provide the MCP server URL as "url".');
  }
  let target: URL;
  try {
    target = new URL(body.url);
  } catch {
    return relayError(request, 400, "bad-url", `"${body.url}" is not a valid URL.`);
  }
  if (target.protocol !== "https:") {
    return relayError(request, 400, "https-only", "The relay only talks to https MCP servers.");
  }
  if (target.username || target.password) {
    return relayError(request, 400, "no-credentials", "Credentials in the URL are not forwarded.");
  }
  if (isBlockedHostname(target.hostname)) {
    return relayError(
      request,
      400,
      "blocked-host",
      "IP literals and internal hostnames are refused. Local servers do not need the relay: connect to them directly from the page.",
    );
  }

  const msg = body.message as { jsonrpc?: unknown; method?: unknown } | null | undefined;
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return relayError(request, 400, "bad-message", 'The "message" must be a JSON-RPC 2.0 object.');
  }
  if (typeof msg.method !== "string" || !ALLOWED_METHODS.has(msg.method)) {
    return relayError(
      request,
      400,
      "method-not-relayed",
      `Only these MCP methods are relayed: ${[...ALLOWED_METHODS].join(", ")}.`,
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (typeof body.protocolVersion === "string" && body.protocolVersion.length <= 32) {
    headers["MCP-Protocol-Version"] = body.protocolVersion;
  }
  if (typeof body.sessionId === "string" && body.sessionId.length <= 256) {
    headers["Mcp-Session-Id"] = body.sessionId;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
      // Workers fetch accepts only "follow" or "manual"; "error" throws at the
      // edge. Manual plus an explicit status check gives the same guarantee:
      // the relay never follows a redirect to a host it did not vet.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "fetch failed";
    return relayError(
      request,
      502,
      "upstream-unreachable",
      `Could not reach the server: ${reason}`,
    );
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return relayError(
      request,
      502,
      "upstream-redirect",
      `The server answered with a ${upstream.status} redirect, which the relay does not follow. Use the final URL directly.`,
    );
  }

  let textBody: string;
  try {
    textBody = await upstream.text();
  } catch {
    return relayError(request, 502, "upstream-body", "Could not read the server's response.");
  }
  if (textBody.length > MAX_RESPONSE_BYTES) {
    return relayError(
      request,
      502,
      "response-too-large",
      `The server's response exceeds the relay cap of ${MAX_RESPONSE_BYTES} bytes.`,
    );
  }

  const out = new Headers(relayCors(request));
  out.set("Content-Type", upstream.headers.get("Content-Type") ?? "application/json");
  out.set("X-Relay-Upstream-Status", String(upstream.status));
  const session = upstream.headers.get("Mcp-Session-Id");
  if (session) out.set("Mcp-Session-Id", session);
  return new Response(textBody, { status: upstream.status, headers: out });
}
