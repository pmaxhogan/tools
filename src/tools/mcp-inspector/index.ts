import { ToolError, type ToolLogic } from "../types";

/** The MCP protocol revision this tool speaks by default. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Revisions a server may legitimately answer with. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** Default JSON-RPC ids, chosen so a manual initialize/list/call run stays readable. */
export const DEFAULT_IDS = {
  initialize: 1,
  toolsList: 2,
  toolsCall: 3,
  ping: 4,
} as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpInspectorOpts {
  /** "parse" summarizes a pasted response, "requests" builds curl commands. */
  mode?: string;
  /** Client name sent in the initialize request built by requests mode. */
  clientName?: string;
  [key: string]: unknown;
}

export type InspectorResult = Record<string, string>;

/* ------------------------------------------------------------------ *
 * Message builders
 * ------------------------------------------------------------------ */

/** The `initialize` request that opens every MCP session. */
export function buildInitialize(
  clientName = "tools.maxhogan.dev MCP Inspector",
  protocolVersion: string = MCP_PROTOCOL_VERSION,
  id: number | string = DEFAULT_IDS.initialize,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  };
}

/** The notification a client must send once initialize succeeds. Never carries an id. */
export function buildInitializedNotification(): JsonRpcNotification {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

/** `tools/list`, optionally continuing a paginated listing. */
export function buildToolsList(
  cursor?: string,
  id: number | string = DEFAULT_IDS.toolsList,
): JsonRpcRequest {
  const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method: "tools/list" };
  if (cursor) msg.params = { cursor };
  return msg;
}

/** `tools/call`. The params key is `arguments`, not `args`. */
export function buildToolCall(
  name: string,
  args: Record<string, unknown> = {},
  id: number | string = DEFAULT_IDS.toolsCall,
): JsonRpcRequest {
  if (!name || !name.trim())
    throw new ToolError(
      "empty-input",
      "A tool call needs a tool name.",
      "Pick a name from tools/list.",
    );
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

/** A liveness check that any MCP server must answer. */
export function buildPing(id: number | string = DEFAULT_IDS.ping): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ping" };
}

/** The headers a Streamable HTTP client must send on every POST. */
export function buildHeaders(
  sessionId?: string,
  protocolVersion: string = MCP_PROTOCOL_VERSION,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return headers;
}

/* ------------------------------------------------------------------ *
 * Transport parsing
 * ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when the body looks like a text/event-stream payload rather than JSON. */
export function isSseBody(text: string): boolean {
  const head = text.replace(/^\uFEFF/, "").trimStart();
  return head.startsWith("event:") || head.startsWith("data:");
}

/**
 * Parse either transport shape of a Streamable HTTP response: a plain JSON body
 * (one message or a batch) or an SSE body where each `data:` line is one
 * JSON-RPC message.
 */
export function parseTransportResponse(text: string): JsonRpcMessage[] {
  const body = (text ?? "").replace(/^\uFEFF/, "").trim();
  if (!body)
    throw new ToolError(
      "bad-response",
      "There is nothing to parse.",
      "Paste the full response body.",
    );

  if (isSseBody(body)) {
    const messages: JsonRpcMessage[] = [];
    for (const rawLine of body.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new ToolError(
          "bad-response",
          "An SSE data line was not valid JSON.",
          "Copy the response body exactly as the server sent it, including every data line.",
        );
      }
      if (!isPlainObject(parsed))
        throw new ToolError(
          "bad-response",
          "An SSE data line held something other than a JSON-RPC object.",
          "Each data line should carry one JSON object.",
        );
      messages.push(parsed as JsonRpcMessage);
    }
    if (messages.length === 0)
      throw new ToolError(
        "bad-response",
        "That looks like an event stream but it has no data lines.",
        "Include the data: lines, not just the event: lines.",
      );
    return messages;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ToolError(
      "bad-response",
      "That is neither valid JSON nor an SSE event stream.",
      "Paste a JSON-RPC response body, or an SSE body with event: and data: lines.",
    );
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const messages: JsonRpcMessage[] = [];
  for (const item of list) {
    if (!isPlainObject(item))
      throw new ToolError(
        "bad-response",
        "A JSON-RPC message must be an object.",
        "Paste the response body, not a bare string or number.",
      );
    messages.push(item as JsonRpcMessage);
  }
  if (messages.length === 0)
    throw new ToolError(
      "bad-response",
      "The batch was empty.",
      "Paste at least one JSON-RPC message.",
    );
  return messages;
}

/* ------------------------------------------------------------------ *
 * JSON Schema rendering
 * ------------------------------------------------------------------ */

function quoteLiteral(v: unknown): string {
  return typeof v === "string" ? `'${v}'` : JSON.stringify(v);
}

/** Render one JSON Schema node as a compact type label, one nesting level deep. */
export function renderSchemaType(schema: unknown, depth = 0): string {
  if (!isPlainObject(schema)) return "any";

  if (Array.isArray(schema.enum) && schema.enum.length)
    return schema.enum.map(quoteLiteral).join("|");
  if ("const" in schema) return quoteLiteral(schema.const);

  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length)
    return union.map((branch) => renderSchemaType(branch, depth + 1)).join("|");

  const type = schema.type;
  if (Array.isArray(type)) return type.map(String).join("|");

  if (type === "array") {
    const items = renderSchemaType(schema.items, depth + 1);
    return items === "any" ? "array" : `${items}[]`;
  }

  if (type === "object" || (!type && isPlainObject(schema.properties))) {
    const props = schema.properties;
    if (depth >= 1 || !isPlainObject(props) || Object.keys(props).length === 0) return "object";
    const inner = Object.keys(props)
      .map((key) => `${key}: ${renderSchemaType(props[key], depth + 1)}`)
      .join(", ");
    return `object{${inner}}`;
  }

  return typeof type === "string" ? type : "any";
}

/**
 * Render an inputSchema's properties as "city: string (required), units: 'metric'|'imperial'".
 * Required properties come first so the call site reads in the order you must fill it.
 */
export function renderParams(inputSchema: unknown): string {
  if (!isPlainObject(inputSchema)) return "none";
  const props = inputSchema.properties;
  if (!isPlainObject(props) || Object.keys(props).length === 0) return "none";
  const required = new Set(
    Array.isArray(inputSchema.required) ? inputSchema.required.map(String) : [],
  );
  const keys = Object.keys(props);
  const ordered = [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k))];
  return ordered
    .map((key) => {
      const label = `${key}: ${renderSchemaType(props[key])}`;
      return required.has(key) ? `${label} (required)` : label;
    })
    .join(", ");
}

/* ------------------------------------------------------------------ *
 * Result summaries
 * ------------------------------------------------------------------ */

function oneLine(text: unknown, max = 160): string {
  if (typeof text !== "string" || !text.trim()) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function describeCapabilities(caps: unknown): string {
  if (!isPlainObject(caps) || Object.keys(caps).length === 0) return "none advertised";
  return Object.keys(caps)
    .map((name) => {
      const body = caps[name];
      if (!isPlainObject(body)) return name;
      const flags = Object.keys(body).filter((k) => body[k] === true);
      return flags.length ? `${name} (${flags.join(", ")})` : name;
    })
    .join(", ");
}

/** Readable rows for an `initialize` result. */
export function summarizeInitialize(result: unknown): InspectorResult {
  const r = isPlainObject(result) ? result : {};
  const info = isPlainObject(r.serverInfo) ? r.serverInfo : {};
  const version = typeof r.protocolVersion === "string" ? r.protocolVersion : "";
  const rows: InspectorResult = {
    "Server name": typeof info.name === "string" && info.name ? info.name : "not reported",
    "Server version":
      typeof info.version === "string" && info.version ? info.version : "not reported",
    "Protocol version": version
      ? SUPPORTED_PROTOCOL_VERSIONS.includes(version)
        ? version
        : `${version} (not a revision this inspector knows)`
      : "not reported",
    Capabilities: describeCapabilities(r.capabilities),
  };
  if (typeof info.title === "string" && info.title) rows["Server title"] = info.title;
  if (typeof r.instructions === "string" && r.instructions)
    rows.Instructions = r.instructions.trim();
  return rows;
}

/** Readable rows for a `tools/list` result: one row per tool. */
export function summarizeTools(result: unknown): InspectorResult {
  const r = isPlainObject(result) ? result : {};
  const tools = Array.isArray(r.tools) ? r.tools : [];
  const rows: InspectorResult = { "Tool count": String(tools.length) };
  if (typeof r.nextCursor === "string" && r.nextCursor) rows["Next cursor"] = r.nextCursor;
  if (tools.length === 0) {
    rows.Tools = "This server advertises no tools.";
    return rows;
  }
  tools.forEach((entry, index) => {
    const tool = isPlainObject(entry) ? entry : {};
    const name = typeof tool.name === "string" && tool.name ? tool.name : `tool ${index + 1}`;
    const description = oneLine(tool.description) || "No description.";
    const params = renderParams(tool.inputSchema);
    let key = name;
    let n = 2;
    while (key in rows) key = `${name} (${n++})`;
    rows[key] = `${description}\nParams: ${params}`;
  });
  return rows;
}

/** Readable rows for a `tools/call` result: text blocks, error flag, structured payload. */
export function summarizeToolResult(result: unknown): InspectorResult {
  const r = isPlainObject(result) ? result : {};
  const content = Array.isArray(r.content) ? r.content : [];
  const texts: string[] = [];
  const kinds: Record<string, number> = {};
  for (const entry of content) {
    const block = isPlainObject(entry) ? entry : {};
    const type = typeof block.type === "string" ? block.type : "unknown";
    kinds[type] = (kinds[type] ?? 0) + 1;
    if (type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  const rows: InspectorResult = {
    "Is error": r.isError === true ? "yes" : "no",
    "Content blocks": content.length
      ? Object.entries(kinds)
          .map(([type, count]) => `${count} ${type}`)
          .join(", ")
      : "none",
  };
  if (texts.length) rows.Text = texts.join("\n\n");
  if ("structuredContent" in r) rows["Structured content"] = pretty(r.structuredContent);
  return rows;
}

/* ------------------------------------------------------------------ *
 * Message routing
 * ------------------------------------------------------------------ */

/** Guess which MCP result shape a payload is: initialize, tools list, tool result, or unknown. */
export function detectResultKind(
  result: unknown,
): "initialize" | "tools-list" | "tool-result" | "unknown" {
  if (!isPlainObject(result)) return "unknown";
  if (isPlainObject(result.serverInfo) || typeof result.protocolVersion === "string")
    return "initialize";
  if (Array.isArray(result.tools)) return "tools-list";
  if (Array.isArray(result.content) || "structuredContent" in result || "isError" in result)
    return "tool-result";
  return "unknown";
}

/** Summarize one JSON-RPC message, whichever direction it travelled. */
export function summarizeMessage(message: JsonRpcMessage): InspectorResult {
  if (message.error) {
    const rows: InspectorResult = {
      "Message type": "error response",
      "Error code": String(message.error.code ?? "not reported"),
      "Error message": message.error.message ?? "not reported",
    };
    if (message.error.data !== undefined) rows["Error data"] = pretty(message.error.data);
    if (message.id !== undefined && message.id !== null) rows["Request id"] = String(message.id);
    return rows;
  }

  if (message.result !== undefined) {
    const kind = detectResultKind(message.result);
    const head: InspectorResult = {
      "Message type":
        kind === "initialize"
          ? "initialize result"
          : kind === "tools-list"
            ? "tools/list result"
            : kind === "tool-result"
              ? "tools/call result"
              : "result",
    };
    if (message.id !== undefined && message.id !== null) head["Request id"] = String(message.id);
    if (kind === "initialize") return { ...head, ...summarizeInitialize(message.result) };
    if (kind === "tools-list") return { ...head, ...summarizeTools(message.result) };
    if (kind === "tool-result") return { ...head, ...summarizeToolResult(message.result) };
    return { ...head, Result: pretty(message.result) };
  }

  if (typeof message.method === "string") {
    const rows: InspectorResult = {
      "Message type":
        message.id === undefined || message.id === null
          ? "notification from the server"
          : "request from the server",
      Method: message.method,
    };
    if (message.params !== undefined) rows.Params = pretty(message.params);
    return rows;
  }

  throw new ToolError(
    "bad-response",
    "That JSON has no result, error, or method, so it is not a JSON-RPC message.",
    "Paste the whole response body from the MCP server.",
  );
}

/* ------------------------------------------------------------------ *
 * curl builders
 * ------------------------------------------------------------------ */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One line of curl for a JSON-RPC message against a Streamable HTTP endpoint. */
export function buildCurl(
  url: string,
  message: JsonRpcRequest | JsonRpcNotification,
  headers: Record<string, string>,
  extraFlags: string[] = [],
): string {
  const parts = ["curl", ...extraFlags, "-X", "POST", shellQuote(url)];
  for (const [name, value] of Object.entries(headers))
    parts.push("-H", shellQuote(`${name}: ${value}`));
  parts.push("-d", shellQuote(JSON.stringify(message)));
  return parts.join(" ");
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ToolError(
      "bad-url",
      `"${trimmed}" is not a valid URL.`,
      "Enter the full endpoint, like https://example.com/mcp.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ToolError(
      "bad-url",
      `MCP Streamable HTTP needs an http or https URL, not ${parsed.protocol.replace(":", "")}.`,
      "Use the server's HTTP endpoint, like https://example.com/mcp.",
    );
  return parsed.toString();
}

/** The three curl commands that open a session and list a server's tools. */
export function buildRequestPlan(url: string, clientName?: string): InspectorResult {
  const endpoint = normalizeUrl(url);
  const session = "<session-id>";
  const openHeaders = buildHeaders();
  const sessionHeaders = buildHeaders(session);
  return {
    Endpoint: endpoint,
    "1. Initialize": buildCurl(endpoint, buildInitialize(clientName), openHeaders, ["-i"]),
    "2. Initialized notification": buildCurl(
      endpoint,
      buildInitializedNotification(),
      sessionHeaders,
    ),
    "3. List tools": buildCurl(endpoint, buildToolsList(), sessionHeaders),
    "4. Call a tool": buildCurl(
      endpoint,
      buildToolCall("TOOL_NAME", { example: "value" }),
      sessionHeaders,
    ),
    Ping: buildCurl(endpoint, buildPing(), sessionHeaders),
    "Session id": `Step 1 uses -i so you can read the response headers. Copy the Mcp-Session-Id value the server returns and replace ${session} in every later command. Servers that do not issue a session id need no replacement, so drop that header.`,
    "Protocol version": `${MCP_PROTOCOL_VERSION}. Servers answering ${SUPPORTED_PROTOCOL_VERSIONS.filter((v) => v !== MCP_PROTOCOL_VERSION).join(" or ")} are also understood.`,
  };
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export function run(input: string, opts: McpInspectorOpts = {}): InspectorResult {
  const mode = opts.mode === "requests" ? "requests" : "parse";
  const raw = (input ?? "").trim();

  if (!raw)
    throw new ToolError(
      "empty-input",
      mode === "requests" ? "Enter an MCP server URL." : "Paste an MCP response body to summarize.",
      mode === "requests"
        ? "Try https://example.com/mcp."
        : "Copy the JSON or SSE body the server returned.",
    );

  if (mode === "requests") {
    const clientName =
      typeof opts.clientName === "string" && opts.clientName.trim()
        ? opts.clientName.trim()
        : undefined;
    return buildRequestPlan(raw, clientName);
  }

  const messages = parseTransportResponse(raw);
  if (messages.length === 1) return summarizeMessage(messages[0]);

  const rows: InspectorResult = { "Messages in body": String(messages.length) };
  messages.forEach((message, index) => {
    const summary = summarizeMessage(message);
    for (const [key, value] of Object.entries(summary)) rows[`${index + 1}. ${key}`] = value;
  });
  return rows;
}

export default { run } satisfies ToolLogic<string, InspectorResult, McpInspectorOpts>;
