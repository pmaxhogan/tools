<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  MCP_PROTOCOL_VERSION,
  buildHeaders,
  buildInitialize,
  buildInitializedNotification,
  buildPing,
  buildToolCall,
  buildToolsList,
  parseTransportResponse,
  renderParams,
  renderSchemaType,
  summarizeInitialize,
  summarizeToolResult,
} from "@/tools/mcp-inspector/index";
import type {
  InspectorResult,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
} from "@/tools/mcp-inspector/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { recordToRows, type KeyValueRow } from "@/lib/key-value";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Activity, Play, Plug, Trash2, TriangleAlert } from "lucide-vue-next";

/**
 * Bespoke panel for the MCP Inspector: a live Streamable HTTP client.
 *
 * Every JSON-RPC message, header set, and result summary comes from the pure
 * layer in src/tools/mcp-inspector (PROJECT.md rule 27). This panel owns only
 * the two things the pure layer cannot have: the network and the DOM. Both
 * live inside event handlers, so the server rendered shell never calls fetch
 * or touches window.
 *
 * Two ways to reach a server. Direct mode posts from the browser, which needs
 * the server to send CORS headers. Relay mode posts to this site's worker at
 * /api/mcp-relay, which forwards the read only handshake plus tools/call and
 * never forwards credentials.
 */
const props = defineProps<{ meta: ToolMeta }>();

const CLIENT_NAME = "tools.maxhogan.dev MCP Inspector";
const RELAY_ENDPOINT = "/api/mcp-relay";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOOL_PAGES = 10;
const MAX_LOG_ENTRIES = 200;

type Mode = "direct" | "relay";

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "direct", label: "Direct from browser" },
  { value: "relay", label: "Relay through this site" },
];

/* ------------------------------------------------------------------ *
 * local helpers (presentation only, never protocol logic)
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A transport or protocol failure with a fix hint. `corsBlocked` marks the one
 * case the panel can offer a one click way out of: a direct fetch the browser
 * refused before this page could read anything.
 */
class TransportError extends Error {
  fix: string;
  corsBlocked: boolean;

  constructor(message: string, fix = "", corsBlocked = false) {
    super(message);
    this.name = "TransportError";
    this.fix = fix;
    this.corsBlocked = corsBlocked;
  }
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
}

type FieldKind = "string" | "number" | "boolean" | "json";

interface CallField {
  key: string;
  kind: FieldKind;
  required: boolean;
  typeLabel: string;
  description: string;
}

interface PanelError {
  message: string;
  fix: string;
  corsBlocked: boolean;
}

interface LogEntry {
  id: number;
  direction: "sent" | "received";
  label: string;
  body: string;
}

const serverUrl = ref("");
const mode = ref<Mode>("direct");

/** The normalized endpoint the current session belongs to. */
const endpoint = ref("");
const sessionId = ref("");
const protocolVersion = ref(MCP_PROTOCOL_VERSION);

const connecting = ref(false);
const connected = ref(false);
const serverRows = ref<InspectorResult | null>(null);
const tools = ref<McpTool[]>([]);
const toolsLoaded = ref(false);
const connectError = ref<PanelError | null>(null);

const pinging = ref(false);
const pingStatus = ref("");

const selectedTool = ref<McpTool | null>(null);
const fieldValues = ref<Record<string, string | boolean>>({});
const calling = ref(false);
const callRows = ref<InspectorResult | null>(null);
const callIsError = ref(false);
const callError = ref<PanelError | null>(null);

const logEntries = ref<LogEntry[]>([]);
let logCounter = 0;

/** Guards against a stale run finishing after a newer connect started. */
let runSeq = 0;

/* ------------------------------------------------------------------ *
 * the raw log
 * ------------------------------------------------------------------ */

function logMessage(direction: "sent" | "received", label: string, payload: unknown) {
  logEntries.value.push({ id: ++logCounter, direction, label, body: pretty(payload) });
  if (logEntries.value.length > MAX_LOG_ENTRIES) {
    logEntries.value.splice(0, logEntries.value.length - MAX_LOG_ENTRIES);
  }
}

function clearLog() {
  logEntries.value = [];
}

/* ------------------------------------------------------------------ *
 * transport: the only place this panel touches the network
 * ------------------------------------------------------------------ */

interface Exchange {
  /** The MCP server's status, even in relay mode. */
  status: number;
  sessionId: string | null;
  body: string;
}

async function post(message: JsonRpcRequest | JsonRpcNotification): Promise<Exchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const viaRelay = mode.value === "relay";

  try {
    const target = viaRelay ? RELAY_ENDPOINT : endpoint.value;
    const init = viaRelay
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: endpoint.value,
            message,
            sessionId: sessionId.value || undefined,
            protocolVersion: protocolVersion.value,
          }),
          signal: controller.signal,
        }
      : {
          method: "POST",
          headers: buildHeaders(sessionId.value || undefined, protocolVersion.value),
          body: JSON.stringify(message),
          signal: controller.signal,
        };

    let response: Response;
    try {
      response = await fetch(target, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new TransportError(
          `The request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
          "The server may be slow, asleep, or unreachable from here.",
        );
      }
      if (!viaRelay) {
        throw new TransportError(
          "The browser blocked or could not complete the request.",
          "A server without CORS headers cannot answer a browser directly. Retry through the relay, or add Access-Control-Allow-Origin on the server.",
          true,
        );
      }
      throw new TransportError(
        "The relay could not be reached.",
        "Check your connection and try again.",
      );
    }

    const body = await response.text();
    const session = response.headers.get("Mcp-Session-Id");

    if (viaRelay) {
      const upstream = response.headers.get("X-Relay-Upstream-Status");
      if (upstream === null) {
        // No upstream status means the relay itself refused: { error, message }.
        let message = `The relay refused the request (HTTP ${response.status}).`;
        try {
          const parsed: unknown = JSON.parse(body);
          if (isRecord(parsed) && typeof parsed.message === "string") message = parsed.message;
        } catch {
          // Keep the generic message.
        }
        throw new TransportError(
          message,
          "The relay forwards only https servers and only the read only MCP handshake plus tools/call.",
        );
      }
      return { status: Number(upstream) || response.status, sessionId: session, body };
    }

    return { status: response.status, sessionId: session, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Send a request, log both directions, and return the matching reply. */
async function exchange(message: JsonRpcRequest, label: string): Promise<JsonRpcMessage> {
  logMessage("sent", label, message);
  const res = await post(message);
  if (res.sessionId) sessionId.value = res.sessionId;

  const raw = res.body.trim();
  if (!raw) {
    logMessage("received", `${label} (HTTP ${res.status}, empty body)`, `HTTP ${res.status}`);
    throw new TransportError(
      `The server answered HTTP ${res.status} with an empty body.`,
      "An empty body is valid for a notification, not for a request that expects a result.",
    );
  }

  let messages: JsonRpcMessage[];
  try {
    messages = parseTransportResponse(raw);
  } catch (err) {
    logMessage("received", `${label} (HTTP ${res.status})`, raw);
    const isTool = err instanceof ToolError;
    throw new TransportError(
      res.status >= 400
        ? `The server answered HTTP ${res.status} with a body that is not JSON-RPC.`
        : isTool
          ? err.message
          : "The response body could not be parsed.",
      isTool ? (err.fix ?? "") : "Open the raw log to read exactly what came back.",
    );
  }

  logMessage(
    "received",
    `${label} (HTTP ${res.status})`,
    messages.length === 1 ? messages[0] : messages,
  );

  const wanted = String(message.id);
  const match =
    messages.find((m) => m.id !== undefined && m.id !== null && String(m.id) === wanted) ??
    messages.find((m) => m.result !== undefined || m.error !== undefined);

  if (!match) {
    throw new TransportError(
      "The server sent no answer to that request.",
      "The body carried no result and no error for this message id.",
    );
  }
  if (match.error) {
    throw new TransportError(
      `The server returned a JSON-RPC error: ${match.error.message ?? "no message given"}`,
      match.error.code !== undefined ? `Error code ${match.error.code}.` : "",
    );
  }
  if (match.result === undefined) {
    throw new TransportError(
      "The server's answer had no result field.",
      "Open the raw log to read the full message.",
    );
  }
  return match;
}

/** Notifications carry no id, so nothing is awaited beyond the HTTP round trip. */
async function notify(message: JsonRpcNotification, label: string) {
  logMessage("sent", label, message);
  try {
    const res = await post(message);
    if (res.sessionId) sessionId.value = res.sessionId;
    const raw = res.body.trim();
    logMessage(
      "received",
      `${label} (HTTP ${res.status})`,
      raw || `HTTP ${res.status} with no body, which is what a notification expects.`,
    );
  } catch (err) {
    logMessage("received", `${label} did not go through`, err instanceof Error ? err.message : err);
  }
}

/* ------------------------------------------------------------------ *
 * connect
 * ------------------------------------------------------------------ */

function toPanelError(err: unknown): PanelError {
  if (err instanceof TransportError)
    return { message: err.message, fix: err.fix, corsBlocked: err.corsBlocked };
  if (err instanceof ToolError)
    return { message: err.message, fix: err.fix ?? "", corsBlocked: false };
  return {
    message: err instanceof Error ? err.message : "That request could not be completed.",
    fix: "",
    corsBlocked: false,
  };
}

function toTool(entry: unknown): McpTool | null {
  if (!isRecord(entry)) return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;
  return {
    name,
    title: typeof entry.title === "string" ? entry.title : "",
    description: typeof entry.description === "string" ? entry.description.trim() : "",
    inputSchema: entry.inputSchema,
  };
}

function resetSession() {
  sessionId.value = "";
  protocolVersion.value = MCP_PROTOCOL_VERSION;
  connected.value = false;
  serverRows.value = null;
  tools.value = [];
  toolsLoaded.value = false;
  selectedTool.value = null;
  fieldValues.value = {};
  callRows.value = null;
  callIsError.value = false;
  callError.value = null;
  pingStatus.value = "";
}

function saveFragment() {
  writeFragment({ input: endpoint.value || serverUrl.value.trim(), opts: { mode: mode.value } });
}

function setMode(next: Mode) {
  if (mode.value === next) return;
  mode.value = next;
  if (serverUrl.value.trim()) saveFragment();
}

async function loadTools() {
  const collected: McpTool[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const reply = await exchange(
      buildToolsList(cursor),
      cursor ? "tools/list (next page)" : "tools/list",
    );
    const result = reply.result ?? {};
    const list = Array.isArray(result.tools) ? result.tools : [];
    for (const entry of list) {
      const tool = toTool(entry);
      if (tool) collected.push(tool);
    }
    const next = result.nextCursor;
    if (typeof next === "string" && next) cursor = next;
    else break;
  }

  tools.value = collected;
  toolsLoaded.value = true;
}

async function connect(forcedMode?: Mode) {
  if (forcedMode) mode.value = forcedMode;

  connectError.value = null;
  const raw = serverUrl.value.trim();
  if (!raw) {
    connectError.value = {
      message: "Enter an MCP server URL.",
      fix: "Try https://example.com/mcp.",
      corsBlocked: false,
    };
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    connectError.value = {
      message: `"${raw}" is not a valid URL.`,
      fix: "Enter the full endpoint, like https://example.com/mcp.",
      corsBlocked: false,
    };
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    connectError.value = {
      message: "MCP Streamable HTTP needs an http or https URL.",
      fix: "Use the server's HTTP endpoint, like https://example.com/mcp.",
      corsBlocked: false,
    };
    return;
  }
  if (mode.value === "relay" && parsed.protocol !== "https:") {
    connectError.value = {
      message: "The relay only talks to https servers.",
      fix: "Connect to an http endpoint directly from the browser instead.",
      corsBlocked: false,
    };
    return;
  }

  const runId = ++runSeq;
  resetSession();
  endpoint.value = parsed.toString();
  serverUrl.value = endpoint.value;
  saveFragment();
  connecting.value = true;

  try {
    const reply = await exchange(buildInitialize(CLIENT_NAME), "initialize");
    if (runId !== runSeq) return;

    const result = reply.result ?? {};
    serverRows.value = summarizeInitialize(result);
    const negotiated = result.protocolVersion;
    if (typeof negotiated === "string" && negotiated) protocolVersion.value = negotiated;
    connected.value = true;

    await notify(buildInitializedNotification(), "notifications/initialized");
    if (runId !== runSeq) return;

    await loadTools();
  } catch (err) {
    if (runId !== runSeq) return;
    connectError.value = toPanelError(err);
  } finally {
    if (runId === runSeq) connecting.value = false;
  }
}

async function ping() {
  if (!connected.value) return;
  pinging.value = true;
  pingStatus.value = "";
  try {
    await exchange(buildPing(), "ping");
    pingStatus.value = "The server answered the ping.";
  } catch (err) {
    pingStatus.value = toPanelError(err).message;
  } finally {
    pinging.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * the call form
 * ------------------------------------------------------------------ */

function fieldKind(schema: unknown): FieldKind {
  if (!isRecord(schema)) return "json";
  if (Array.isArray(schema.enum) || "const" in schema) return "string";
  const type = schema.type;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  return "json";
}

const callFields = computed<CallField[]>(() => {
  const schema = selectedTool.value?.inputSchema;
  if (!isRecord(schema)) return [];
  const props_ = schema.properties;
  if (!isRecord(props_)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const keys = Object.keys(props_);
  const ordered = [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k))];
  return ordered.map((key) => {
    const node = props_[key];
    const described =
      isRecord(node) && typeof node.description === "string" ? node.description : "";
    return {
      key,
      kind: fieldKind(node),
      required: required.has(key),
      typeLabel: renderSchemaType(node),
      description: described.trim(),
    };
  });
});

function openTool(tool: McpTool) {
  if (selectedTool.value?.name === tool.name) {
    selectedTool.value = null;
    return;
  }
  selectedTool.value = tool;
  callRows.value = null;
  callIsError.value = false;
  callError.value = null;

  const seeded: Record<string, string | boolean> = {};
  const schema = tool.inputSchema;
  const props_ = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  for (const key of Object.keys(props_)) {
    seeded[key] = fieldKind(props_[key]) === "boolean" ? false : "";
  }
  fieldValues.value = seeded;
}

function textValue(key: string): string {
  const value = fieldValues.value[key];
  return typeof value === "string" ? value : "";
}

function boolValue(key: string): boolean {
  return fieldValues.value[key] === true;
}

function setValue(key: string, value: string | number | boolean) {
  fieldValues.value = {
    ...fieldValues.value,
    [key]: typeof value === "number" ? String(value) : value,
  };
}

function buildArgs(): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of callFields.value) {
    if (field.kind === "boolean") {
      const checked = boolValue(field.key);
      if (checked || field.required) args[field.key] = checked;
      continue;
    }
    const text = textValue(field.key).trim();
    if (!text) {
      if (field.required)
        throw new ToolError(
          "empty-input",
          `"${field.key}" is required.`,
          "Fill in every required parameter before calling the tool.",
        );
      continue;
    }
    if (field.kind === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed))
        throw new ToolError(
          "bad-input",
          `"${field.key}" must be a number.`,
          `"${text}" is not a number.`,
        );
      args[field.key] = parsed;
      continue;
    }
    if (field.kind === "json") {
      try {
        args[field.key] = JSON.parse(text);
      } catch {
        throw new ToolError(
          "bad-input",
          `"${field.key}" must be valid JSON.`,
          "Check the quotes, commas, and brackets. A string value needs its own quotes.",
        );
      }
      continue;
    }
    args[field.key] = text;
  }
  return args;
}

async function callTool() {
  const tool = selectedTool.value;
  if (!tool || !connected.value) return;

  callError.value = null;
  callRows.value = null;
  callIsError.value = false;

  let args: Record<string, unknown>;
  try {
    args = buildArgs();
  } catch (err) {
    callError.value = toPanelError(err);
    return;
  }

  calling.value = true;
  try {
    const reply = await exchange(buildToolCall(tool.name, args), `tools/call ${tool.name}`);
    const result = reply.result ?? {};
    callRows.value = summarizeToolResult(result);
    callIsError.value = result.isError === true;
  } catch (err) {
    callError.value = toPanelError(err);
  } finally {
    calling.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * derived display
 * ------------------------------------------------------------------ */

const busy = computed(() => connecting.value || calling.value || pinging.value);

const sessionLabel = computed(() => (sessionId.value ? sessionId.value : "none issued"));

/**
 * What the handshake told us, plus the session id. The id is tracked separately
 * from the initialize summary because it arrives as a response header rather
 * than in the body, so it is appended here instead of in the logic layer.
 */
const serverGridRows = computed<KeyValueRow[]>(() =>
  serverRows.value
    ? [...recordToRows(serverRows.value), { key: "Session id", value: sessionLabel.value }]
    : [],
);

/** Direct mode can only read the session header when the server exposes it. */
const sessionHeaderHidden = computed(
  () => connected.value && mode.value === "direct" && !sessionId.value,
);

const paramsFor = (tool: McpTool) => renderParams(tool.inputSchema);

/* ------------------------------------------------------------------ *
 * fragment prefill: read once on mount, never auto connect
 * ------------------------------------------------------------------ */

onMounted(() => {
  const state = readFragment();
  if (state.input) serverUrl.value = state.input;
  if (state.opts["mode"] === "relay") mode.value = "relay";
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- connection -->
    <form class="flex flex-col gap-3" @submit.prevent="connect()">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label for="mcp-url" class="text-xs text-muted-foreground">MCP server endpoint</Label>
          <Input
            id="mcp-url"
            v-model="serverUrl"
            type="url"
            placeholder="https://example.com/mcp"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :aria-invalid="connectError ? 'true' : undefined"
          />
        </div>

        <div class="flex items-center gap-2">
          <Button type="submit" :disabled="busy">
            <Plug class="size-3.5" aria-hidden="true" />
            {{ connecting ? "Connecting..." : connected ? "Reconnect" : "Connect" }}
          </Button>
          <Button v-if="connected" type="button" variant="outline" :disabled="busy" @click="ping()">
            <Activity class="size-3.5" aria-hidden="true" />
            Ping
          </Button>
        </div>
      </div>

      <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend class="mb-1.5 text-xs text-muted-foreground">Connection mode</legend>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="option in MODE_OPTIONS"
            :key="option.value"
            class="flex cursor-pointer items-center gap-2 rounded-[10px] border px-3 py-2 text-sm transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--ring)]"
            :class="
              mode === option.value
                ? 'border-primary bg-[image:var(--grad-brand-soft)] text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent'
            "
          >
            <input
              type="radio"
              name="mcp-mode"
              class="sr-only"
              :value="option.value"
              :checked="mode === option.value"
              @change="setMode(option.value)"
            />
            {{ option.label }}
          </label>
        </div>
        <p class="text-xs text-muted-foreground">
          {{
            mode === "direct"
              ? "Your browser posts straight to the server, so the server must send CORS headers."
              : "This site's worker forwards the request for servers without CORS headers. It relays only the read only handshake plus tools/call, over https, and never forwards credentials."
          }}
        </p>
      </fieldset>

      <ErrorBanner v-if="connectError" :message="connectError.message" :hint="connectError.fix">
        <Button
          v-if="connectError.corsBlocked"
          type="button"
          size="sm"
          variant="outline"
          @click="connect('relay')"
        >
          Retry through the relay
        </Button>
      </ErrorBanner>

      <p class="text-xs text-muted-foreground">
        Authentication headers are not supported: this client connects to unauthenticated servers
        only, and the relay never forwards an Authorization header, a cookie, or any other
        credential.
      </p>
      <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
        {{ props.meta.privacyNote }}
      </p>
    </form>

    <!-- server info -->
    <section v-if="serverRows" class="flex flex-col gap-2">
      <h3 class="text-[17px] font-semibold">Server</h3>
      <KeyValueGrid :rows="serverGridRows" class="shadow-[var(--sh-inset)]" />
      <p v-if="sessionHeaderHidden" class="text-xs text-muted-foreground">
        No Mcp-Session-Id header was readable. A server that issues one must also list it in
        Access-Control-Expose-Headers, otherwise the browser hides it and later requests may be
        rejected. The relay always passes that header through.
      </p>
      <p v-if="pingStatus" role="status" class="text-xs text-muted-foreground">{{ pingStatus }}</p>
    </section>

    <!-- tools -->
    <section v-if="connected" class="flex flex-col gap-2">
      <h3 class="text-[17px] font-semibold">
        Tools<span v-if="toolsLoaded" class="text-muted-foreground"> ({{ tools.length }})</span>
      </h3>

      <p v-if="!toolsLoaded && connecting" class="text-xs text-muted-foreground">
        Listing tools...
      </p>
      <p v-else-if="toolsLoaded && tools.length === 0" class="text-xs text-muted-foreground">
        This server advertises no tools.
      </p>

      <ul v-if="tools.length" class="flex flex-col gap-2">
        <li
          v-for="tool in tools"
          :key="tool.name"
          class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="font-mono text-sm break-words">{{ tool.name }}</span>
              <span v-if="tool.title" class="text-xs text-muted-foreground">{{ tool.title }}</span>
            </div>
            <Button
              type="button"
              size="sm"
              :variant="selectedTool?.name === tool.name ? 'secondary' : 'outline'"
              :disabled="busy"
              @click="openTool(tool)"
            >
              {{ selectedTool?.name === tool.name ? "Close" : "Call" }}
            </Button>
          </div>

          <p class="text-xs text-muted-foreground">
            {{ tool.description || "No description." }}
          </p>

          <details class="rounded-[8px] bg-card px-3 py-2">
            <summary class="cursor-pointer text-xs text-muted-foreground">Parameters</summary>
            <p class="mt-2 font-mono text-xs break-words whitespace-pre-wrap">
              {{ paramsFor(tool) }}
            </p>
          </details>

          <!-- call form -->
          <form
            v-if="selectedTool?.name === tool.name"
            class="flex flex-col gap-3 rounded-[10px] bg-card p-3"
            @submit.prevent="callTool()"
          >
            <p v-if="callFields.length === 0" class="text-xs text-muted-foreground">
              This tool takes no parameters.
            </p>

            <div
              v-for="field in callFields"
              :key="`${tool.name}-${field.key}`"
              class="flex flex-col gap-1.5"
            >
              <Label
                :for="`mcp-arg-${tool.name}-${field.key}`"
                class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              >
                <span class="font-mono text-foreground">{{ field.key }}</span>
                <span>{{ field.typeLabel }}</span>
                <span v-if="field.required" class="text-destructive">required</span>
              </Label>

              <div v-if="field.kind === 'boolean'" class="flex items-center gap-2">
                <Checkbox
                  :id="`mcp-arg-${tool.name}-${field.key}`"
                  :model-value="boolValue(field.key)"
                  @update:model-value="(v: unknown) => setValue(field.key, v === true)"
                />
                <span class="text-xs text-muted-foreground">
                  {{ boolValue(field.key) ? "true" : "false" }}
                </span>
              </div>

              <Textarea
                v-else-if="field.kind === 'json'"
                :id="`mcp-arg-${tool.name}-${field.key}`"
                :model-value="textValue(field.key)"
                class="font-mono text-xs"
                rows="3"
                spellcheck="false"
                placeholder='JSON value, for example ["one", "two"]'
                @update:model-value="(v) => setValue(field.key, v)"
              />

              <Input
                v-else
                :id="`mcp-arg-${tool.name}-${field.key}`"
                :model-value="textValue(field.key)"
                :type="field.kind === 'number' ? 'number' : 'text'"
                autocomplete="off"
                spellcheck="false"
                :placeholder="field.typeLabel"
                @update:model-value="(v) => setValue(field.key, v)"
              />

              <p v-if="field.description" class="text-xs text-muted-foreground">
                {{ field.description }}
              </p>
            </div>

            <div class="flex items-center gap-2">
              <Button type="submit" size="sm" :disabled="busy">
                <Play class="size-3.5" aria-hidden="true" />
                {{ calling ? "Calling..." : "Call" }}
              </Button>
            </div>

            <ErrorBanner v-if="callError" :message="callError.message" :hint="callError.fix" />

            <div
              v-else-if="callRows"
              class="flex flex-col gap-2 rounded-[8px] border p-3"
              :class="callIsError ? 'border-destructive/40' : 'border-border'"
            >
              <span
                v-if="callIsError"
                class="flex items-center gap-2 text-xs font-semibold text-destructive"
              >
                <TriangleAlert class="size-3.5" aria-hidden="true" />
                The tool reported an error result.
              </span>
              <KeyValueGrid :record="callRows" :columns="2" dense />
            </div>
          </form>
        </li>
      </ul>
    </section>

    <p v-else-if="!connectError && !connecting" class="text-xs text-muted-foreground">
      Enter an MCP server endpoint and press Connect. This page runs the handshake for you:
      initialize, notifications/initialized, then tools/list, and every message lands in the raw log
      below.
    </p>

    <!-- raw log -->
    <details class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
      <summary class="cursor-pointer text-sm text-muted-foreground">
        Raw JSON-RPC log ({{ logEntries.length }})
      </summary>
      <div class="mt-3 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground">Oldest first, newest at the bottom.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="logEntries.length === 0"
            @click="clearLog()"
          >
            <Trash2 class="size-3.5" aria-hidden="true" />
            Clear
          </Button>
        </div>

        <p v-if="logEntries.length === 0" class="text-xs text-muted-foreground">
          Nothing has been sent yet.
        </p>

        <div
          v-for="entry in logEntries"
          :key="entry.id"
          class="flex flex-col gap-1 rounded-[8px] bg-card p-3"
        >
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {{ entry.direction === "sent" ? "sent" : "received" }} · {{ entry.label }}
          </span>
          <pre
            class="overflow-x-auto font-mono text-xs whitespace-pre-wrap"
          ><code>{{ entry.body }}</code></pre>
        </div>
      </div>
    </details>
  </div>
</template>
