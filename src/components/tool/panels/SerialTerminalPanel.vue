<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, Plug, Send, Trash2, Usb } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  LineAssembler,
  autoDetectBaudHint,
  formatHexDump,
  parseSendInput,
  timestamp,
  type LineEnding,
  type SendMode,
} from "@/tools/serial-terminal/index";
import { downloadText } from "@/lib/download";

/**
 * Bespoke panel for the serial terminal. The Web Serial API only exists in a
 * real browser session, so the device half lives here: requestPort, open,
 * the read loop, setSignals and the writes.
 *
 * Every byte that arrives is handed to the pure layer in
 * `src/tools/serial-terminal` for interpretation: LineAssembler turns the
 * stream into rows (including carriage return redraws, so flashing progress
 * bars behave), formatHexDump renders the raw view, parseSendInput builds the
 * bytes to write, and autoDetectBaudHint decides whether the first sample
 * looks like a baud mismatch. Nothing about that interpretation is duplicated
 * in this file.
 *
 * Nothing here is persisted. The log, the send history and the port itself
 * live in this component's memory only, and closing the tab forgets them.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* Web Serial shapes (not in lib.dom, so declared narrowly here)      */
/* ---------------------------------------------------------------- */

interface SerialOpenOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: "none" | "even" | "odd";
}

interface SerialPortLike extends EventTarget {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

interface SerialApiLike extends EventTarget {
  requestPort(options?: { filters?: unknown[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

/** Chrome shipped `event.port` before the spec settled on `event.target`. */
interface SerialConnectionEventLike extends Event {
  port?: SerialPortLike;
}

function serialApi(): SerialApiLike | undefined {
  return (navigator as Navigator & { serial?: SerialApiLike }).serial;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Rows kept in memory, and the most the download can contain. */
const MAX_LINES = 5000;
/** Rows actually put in the DOM. Cheap virtualization: render the tail. */
const MAX_RENDER = 1500;
/** Send box history depth. Memory only, never stored. */
const HISTORY_LIMIT = 20;
/** How many bytes to collect before judging the baud rate. */
const BAUD_SAMPLE_BYTES = 256;
const BAUD_SAMPLE_MIN = 32;

const BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];

/* ---------------------------------------------------------------- */
/* port settings                                                     */
/* ---------------------------------------------------------------- */

const baudRate = ref("115200");
const dataBits = ref("8");
const stopBits = ref("1");
const parity = ref("none");
const dtr = ref(true);
const rts = ref(false);

/* ---------------------------------------------------------------- */
/* select specs                                                     */
/* ---------------------------------------------------------------- */

/** Board and common aliases so a search for "esp32" or "arduino" lands. */
const BAUD_SYNONYMS: Record<number, string[]> = {
  9600: ["arduino default", "arduino", "standard"],
  19200: ["19.2k"],
  38400: ["38.4k"],
  57600: ["57.6k"],
  74880: ["esp8266 boot", "esp8266"],
  115200: ["esp32", "most common", "default baud"],
  230400: ["230.4k"],
  460800: ["460.8k"],
  921600: ["fastest", "high speed"],
};

const baudSpec: SelectOptionSpec = {
  kind: "select",
  id: "serial-baud",
  label: "Baud rate",
  default: "115200",
  options: BAUD_RATES.map((rate) => ({
    value: String(rate),
    label: String(rate),
    synonyms: BAUD_SYNONYMS[rate] ?? [],
  })),
};

const dataBitsSpec: SelectOptionSpec = {
  kind: "select",
  id: "serial-databits",
  label: "Data bits",
  default: "8",
  options: [
    { value: "7", label: "7", synonyms: ["seven", "7 bit"] },
    { value: "8", label: "8", synonyms: ["eight", "8 bit", "standard"] },
  ],
};

const stopBitsSpec: SelectOptionSpec = {
  kind: "select",
  id: "serial-stopbits",
  label: "Stop bits",
  default: "1",
  options: [
    { value: "1", label: "1", synonyms: ["one stop bit", "standard"] },
    { value: "2", label: "2", synonyms: ["two stop bits"] },
  ],
};

const paritySpec: SelectOptionSpec = {
  kind: "select",
  id: "serial-parity",
  label: "Parity",
  default: "none",
  options: [
    { value: "none", label: "None", synonyms: ["no parity", "8n1"] },
    { value: "even", label: "Even", synonyms: ["even parity", "8e1"] },
    { value: "odd", label: "Odd", synonyms: ["odd parity", "8o1"] },
  ],
};

const viewSpec: SelectOptionSpec = {
  kind: "select",
  id: "serial-view",
  label: "View",
  default: "text",
  options: [
    { value: "text", label: "Text", synonyms: ["ascii", "plain text"] },
    { value: "hex", label: "Hex", synonyms: ["hexadecimal", "bytes", "raw"] },
  ],
};

const sendModeSpec: SelectOptionSpec = {
  kind: "select",
  id: "serial-mode",
  label: "Mode",
  default: "text",
  options: [
    { value: "text", label: "Text", synonyms: ["ascii", "string"] },
    { value: "hex", label: "Hex", synonyms: ["hexadecimal", "bytes", "raw"] },
  ],
};

const lineEndingSpec: SelectOptionSpec = {
  kind: "select",
  id: "serial-ending",
  label: "Line ending",
  default: "lf",
  options: [
    { value: "none", label: "None", synonyms: ["no line ending", "nothing"] },
    { value: "lf", label: "Newline (LF)", synonyms: ["line feed", "\\n", "unix"] },
    {
      value: "crlf",
      label: "CR and LF",
      synonyms: ["carriage return line feed", "\\r\\n", "windows"],
    },
    { value: "cr", label: "Carriage return", synonyms: ["\\r", "mac classic"] },
  ],
};

/* ---------------------------------------------------------------- */
/* connection state                                                  */
/* ---------------------------------------------------------------- */

const port = shallowRef<SerialPortLike | null>(null);
const connecting = ref(false);
const canReconnect = ref(false);
const errorTitle = ref<string | null>(null);
const errorDetail = ref<string | null>(null);
const baudHint = ref<string | null>(null);
const rxBytes = ref(0);
const txBytes = ref(0);

let lastPort: SerialPortLike | null = null;
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let readLoopDone: Promise<void> | null = null;
let keepReading = false;

const connected = computed(() => port.value !== null);

/* ---------------------------------------------------------------- */
/* the log                                                           */
/* ---------------------------------------------------------------- */

interface LogRow {
  key: number;
  time: string;
  text: string;
  kind: "rx" | "tx" | "note";
}

/**
 * The stores are plain arrays, not refs: a busy port delivers packets far
 * faster than the screen refreshes, so writes go straight into memory and
 * `revision` is bumped once per animation frame to redraw. `visibleRows`
 * reads `revision` so Vue knows when to recompute.
 */
const textStore: LogRow[] = [];
const hexStore: LogRow[] = [];
let liveRow: LogRow | null = null;
const revision = ref(0);
let frame: number | null = null;

const view = ref<"text" | "hex">("text");
const showTimestamps = ref(true);

let assembler = new LineAssembler();
let hexOffset = 0;
let rowKey = 0;
let baudSample: number[] = [];
let baudChecked = false;

function scheduleRender() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    revision.value++;
  });
}

function trim(store: LogRow[]) {
  if (store.length > MAX_LINES) store.splice(0, store.length - MAX_LINES);
}

function pushRow(store: LogRow[], text: string, kind: LogRow["kind"], time: string) {
  rowKey += 1;
  store.push({ key: rowKey, time, text, kind });
  trim(store);
}

/** A status line that belongs in both views, such as "port opened". */
function note(text: string) {
  const time = timestamp(Date.now());
  pushRow(textStore, text, "note", time);
  pushRow(hexStore, text, "note", time);
  scheduleRender();
}

const visibleRows = computed<LogRow[]>(() => {
  void revision.value;
  const store = view.value === "hex" ? hexStore : textStore;
  const rows = store.slice(-MAX_RENDER);
  if (view.value === "text" && liveRow) rows.push(liveRow);
  return rows;
});

const hiddenRowCount = computed(() => {
  void revision.value;
  const store = view.value === "hex" ? hexStore : textStore;
  return Math.max(0, store.length - MAX_RENDER);
});

const isEmpty = computed(() => visibleRows.value.length === 0);

/** Sent rows carry a chevron so an echo is never mistaken for device output. */
function rowBody(row: LogRow): string {
  return row.kind === "tx" ? `> ${row.text}` : row.text;
}

/* ---------------------------------------------------------------- */
/* incoming bytes                                                    */
/* ---------------------------------------------------------------- */

function checkBaud(chunk: Uint8Array) {
  if (baudChecked) return;
  for (let i = 0; i < chunk.length && baudSample.length < BAUD_SAMPLE_BYTES; i++) {
    baudSample.push(chunk[i] as number);
  }
  if (baudSample.length < BAUD_SAMPLE_MIN) return;
  baudChecked = true;
  baudHint.value = autoDetectBaudHint(Uint8Array.from(baudSample));
}

function handleChunk(chunk: Uint8Array) {
  rxBytes.value += chunk.length;
  checkBaud(chunk);

  const time = timestamp(Date.now());

  const dump = formatHexDump(chunk, hexOffset);
  hexOffset += chunk.length;
  for (const line of dump.split("\n")) pushRow(hexStore, line, "rx", time);

  const { lines, replaceLast } = assembler.push(chunk);
  for (const line of lines) pushRow(textStore, line, "rx", time);
  liveRow = replaceLast === undefined ? null : { key: -1, time, text: replaceLast, kind: "rx" };

  scheduleRender();
}

/** Commits whatever the assembler is still holding, so nothing is lost. */
function flushAssembler() {
  const tail = assembler.flush();
  const time = timestamp(Date.now());
  for (const line of tail.lines) pushRow(textStore, line, "rx", time);
  liveRow = null;
  scheduleRender();
}

function resetSession() {
  assembler = new LineAssembler();
  hexOffset = 0;
  baudSample = [];
  baudChecked = false;
  baudHint.value = null;
  rxBytes.value = 0;
  txBytes.value = 0;
}

function clearLog() {
  textStore.length = 0;
  hexStore.length = 0;
  liveRow = null;
  scheduleRender();
}

/* ---------------------------------------------------------------- */
/* connect and disconnect                                            */
/* ---------------------------------------------------------------- */

function setError(title: string, detail: string) {
  errorTitle.value = title;
  errorDetail.value = detail;
}

function clearError() {
  errorTitle.value = null;
  errorDetail.value = null;
}

function describeOpenError(err: unknown): { title: string; detail: string } {
  const name = err instanceof DOMException ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);

  if (name === "InvalidStateError") {
    return {
      title: "That port is already open.",
      detail:
        "Another tab on this site already has it open. Disconnect there first, or reload this page and try again.",
    };
  }
  if (name === "NetworkError") {
    return {
      title: "The browser could not open that port.",
      detail:
        "A serial port can only be held by one program at a time. The Arduino IDE, PlatformIO, a screen or minicom session, or another browser tab is probably holding it. Close that, then click Connect again.",
    };
  }
  if (name === "SecurityError") {
    return {
      title: "This page is not allowed to use Web Serial.",
      detail:
        "Web Serial only works over a secure connection and outside a restricted frame. Open the page directly over HTTPS and try again.",
    };
  }
  return {
    title: "Could not open the port.",
    detail:
      message ||
      "The port was picked but would not open. Check that the cable carries data, that the USB serial driver is installed, and that nothing else is holding the port.",
  };
}

function portLabel(p: SerialPortLike): string {
  const info = p.getInfo?.() ?? {};
  const hex4 = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
  if (info.usbVendorId === undefined) return "Serial port";
  return `USB device ${hex4(info.usbVendorId)}${
    info.usbProductId === undefined ? "" : `:${hex4(info.usbProductId)}`
  }`;
}

async function readLoop(target: SerialPortLike) {
  while (keepReading && target.readable) {
    const active = target.readable.getReader();
    reader = active;
    try {
      for (;;) {
        const { value, done } = await active.read();
        if (done) break;
        if (value && value.length) handleChunk(value);
      }
    } catch (err) {
      // A read error mid session is almost always the device going away or a
      // framing error from the wrong port settings. Never let it escape as an
      // unhandled rejection.
      keepReading = false;
      const message = err instanceof Error ? err.message : String(err);
      note(`Reading stopped: ${message}`);
    } finally {
      active.releaseLock();
      reader = null;
    }
  }
}

/**
 * Releases everything in the order Web Serial requires: cancel the reader so
 * the pending read resolves, wait for the read loop to release its lock, and
 * only then close the port. `port.close()` rejects while `readable` is still
 * locked, which is the classic way this hangs. The writer is never held
 * between sends, so there is no writable lock to unwind here.
 *
 * `closePort` is false on the unplug path: the device is already gone and
 * closing it just throws.
 */
async function teardown(closePort: boolean) {
  const target = port.value;
  keepReading = false;

  if (reader) {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored; the loop still exits.
    }
  }
  if (readLoopDone) {
    try {
      await readLoopDone;
    } catch {
      // readLoop swallows its own errors; this is belt and braces.
    }
    readLoopDone = null;
  }

  flushAssembler();

  if (target && closePort) {
    try {
      await target.close();
    } catch {
      // Already closed or already unplugged: nothing useful to do.
    }
  }

  port.value = null;
}

async function applySignals() {
  const target = port.value;
  if (!target) return;
  try {
    await target.setSignals({ dataTerminalReady: dtr.value, requestToSend: rts.value });
  } catch {
    note("This port would not accept a DTR or RTS change.");
  }
}

async function openPort(target: SerialPortLike) {
  clearError();
  connecting.value = true;
  try {
    await target.open({
      baudRate: Number(baudRate.value),
      dataBits: Number(dataBits.value),
      stopBits: Number(stopBits.value),
      parity: parity.value as "none" | "even" | "odd",
    });
    port.value = target;
    lastPort = target;
    canReconnect.value = false;
    resetSession();
    await applySignals();
    note(
      `Connected at ${baudRate.value} baud, ${dataBits.value}${parity.value === "none" ? "N" : parity.value === "even" ? "E" : "O"}${stopBits.value}.`,
    );
    keepReading = true;
    readLoopDone = readLoop(target);
  } catch (err) {
    const described = describeOpenError(err);
    setError(described.title, described.detail);
  } finally {
    connecting.value = false;
  }
}

async function connect() {
  clearError();
  const api = serialApi();
  if (!api) return;

  let picked: SerialPortLike;
  try {
    picked = await api.requestPort();
  } catch (err) {
    // NotFoundError just means the chooser was dismissed. That is not a fault.
    if (err instanceof DOMException && err.name === "NotFoundError") return;
    const described = describeOpenError(err);
    setError(described.title, described.detail);
    return;
  }

  if (port.value) await teardown(true);
  await openPort(picked);
}

async function disconnect() {
  await teardown(true);
  note("Disconnected. The port is free for other programs again.");
}

async function reconnect() {
  if (!lastPort) return;
  clearError();
  canReconnect.value = false;
  await openPort(lastPort);
}

function handlePortDisconnect(event: Event) {
  const gone = (event as SerialConnectionEventLike).port ?? (event.target as SerialPortLike | null);
  if (!port.value || gone !== port.value) return;
  lastPort = port.value;
  void teardown(false).then(() => {
    canReconnect.value = true;
    setError(
      "The device was unplugged.",
      "Plug it back in, then click Reconnect. The log above is kept.",
    );
  });
}

function handlePortConnect(event: Event) {
  const back = (event as SerialConnectionEventLike).port ?? (event.target as SerialPortLike | null);
  if (lastPort && back === lastPort && !port.value) canReconnect.value = true;
}

/* ---------------------------------------------------------------- */
/* sending                                                           */
/* ---------------------------------------------------------------- */

const sendText = ref("");
const sendMode = ref<SendMode>("text");
const lineEnding = ref<LineEnding>("lf");
const sendError = ref<{ message: string; fix?: string } | null>(null);

const history: string[] = [];
let historyIndex = -1;

function pushHistory(entry: string) {
  if (!entry) return;
  const existing = history.indexOf(entry);
  if (existing !== -1) history.splice(existing, 1);
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  historyIndex = -1;
}

function recallHistory(step: number) {
  if (!history.length) return;
  const next = historyIndex + step;
  if (next < 0) {
    historyIndex = -1;
    sendText.value = "";
    return;
  }
  historyIndex = Math.min(next, history.length - 1);
  sendText.value = history[historyIndex] as string;
}

async function writeBytes(bytes: Uint8Array) {
  const target = port.value;
  if (!target?.writable) throw new Error("The port is not open for writing.");
  const writer = target.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    // Released immediately so the port never sits with a locked writable,
    // which is what makes close() hang.
    writer.releaseLock();
  }
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

async function send() {
  sendError.value = null;
  if (!connected.value) return;

  let bytes: Uint8Array;
  const typed = sendText.value;
  try {
    bytes = parseSendInput(typed, sendMode.value, lineEnding.value);
  } catch (err) {
    sendError.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : String(err) };
    return;
  }

  try {
    await writeBytes(bytes);
  } catch (err) {
    sendError.value = {
      message: err instanceof Error ? err.message : String(err),
      fix: "Check that the device is still plugged in, then connect again.",
    };
    return;
  }

  txBytes.value += bytes.length;
  const time = timestamp(Date.now());
  pushRow(textStore, sendMode.value === "hex" ? hexOf(bytes) : typed, "tx", time);
  for (const line of formatHexDump(bytes, 0).split("\n")) pushRow(hexStore, line, "tx", time);
  scheduleRender();

  pushHistory(typed);
  sendText.value = "";
}

/* ---------------------------------------------------------------- */
/* download                                                          */
/* ---------------------------------------------------------------- */

function downloadLog() {
  const store = view.value === "hex" ? hexStore : textStore;
  const rows = liveRow && view.value === "text" ? [...store, liveRow] : store;
  const body = rows.map((r) => `${r.time} ${rowBody(r)}`).join("\n");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadText(`${body}\n`, `serial-log-${stamp}.txt`);
}

/* ---------------------------------------------------------------- */
/* auto scroll                                                       */
/* ---------------------------------------------------------------- */

const logEl = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);

function onLogScroll() {
  const el = logEl.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

watch(visibleRows, async () => {
  if (!stickToBottom.value) return;
  await nextTick();
  const el = logEl.value;
  if (el) el.scrollTop = el.scrollHeight;
});

watch([dtr, rts], () => {
  if (connected.value) void applySignals();
});

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  const api = serialApi();
  if (!api) return;
  api.addEventListener("disconnect", handlePortDisconnect);
  api.addEventListener("connect", handlePortConnect);
});

onUnmounted(() => {
  const api = serialApi();
  api?.removeEventListener("disconnect", handlePortDisconnect);
  api?.removeEventListener("connect", handlePortConnect);
  if (frame !== null) cancelAnimationFrame(frame);
  void teardown(true);
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- connection -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center gap-3">
        <Button v-if="!connected" size="lg" :disabled="connecting" @click="connect">
          <Usb class="size-4" aria-hidden="true" />
          {{ connecting ? "Waiting for the browser…" : "Connect a device" }}
        </Button>
        <Button v-else size="lg" variant="secondary" @click="disconnect"> Disconnect </Button>

        <Button
          v-if="!connected && canReconnect"
          variant="outline"
          :disabled="connecting"
          @click="reconnect"
        >
          <Plug class="size-4" aria-hidden="true" />
          Reconnect
        </Button>

        <span v-if="connected && port" class="text-sm text-muted-foreground">
          {{ portLabel(port) }} at {{ baudRate }} baud
        </span>
      </div>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="serial-baud" class="text-xs text-muted-foreground">Baud rate</Label>
          <fieldset :disabled="connected" class="m-0 min-w-0 border-0 p-0">
            <SearchableSelect id="serial-baud" v-model="baudRate" :spec="baudSpec" />
          </fieldset>
        </div>

        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="serial-dtr" class="w-fit cursor-pointer text-xs text-muted-foreground"
            >DTR</Label
          >
          <Switch id="serial-dtr" v-model="dtr" />
        </div>

        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="serial-rts" class="w-fit cursor-pointer text-xs text-muted-foreground"
            >RTS</Label
          >
          <Switch id="serial-rts" v-model="rts" />
        </div>
      </div>

      <details class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
        <summary class="cursor-pointer text-sm text-muted-foreground">
          Framing: data bits, stop bits, parity
        </summary>
        <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="serial-databits" class="text-xs text-muted-foreground">Data bits</Label>
            <fieldset :disabled="connected" class="m-0 min-w-0 border-0 p-0">
              <SearchableSelect id="serial-databits" v-model="dataBits" :spec="dataBitsSpec" />
            </fieldset>
          </div>

          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="serial-stopbits" class="text-xs text-muted-foreground">Stop bits</Label>
            <fieldset :disabled="connected" class="m-0 min-w-0 border-0 p-0">
              <SearchableSelect id="serial-stopbits" v-model="stopBits" :spec="stopBitsSpec" />
            </fieldset>
          </div>

          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="serial-parity" class="text-xs text-muted-foreground">Parity</Label>
            <fieldset :disabled="connected" class="m-0 min-w-0 border-0 p-0">
              <SearchableSelect id="serial-parity" v-model="parity" :spec="paritySpec" />
            </fieldset>
          </div>
        </div>
        <p class="mt-3 text-xs text-muted-foreground">
          8N1 suits almost every microcontroller. Change these only if the datasheet says so, and
          disconnect first: the port settings are fixed while it is open.
        </p>
      </details>

      <p class="text-xs text-muted-foreground">
        Everything runs in this tab: your files and inputs never leave your device. A serial port
        can only be held by one program at a time, so close the Arduino IDE, PlatformIO or a screen
        session before connecting here. Many boards reset when DTR or RTS changes, which is the auto
        reset circuit doing its job.
      </p>

      <div
        v-if="errorTitle"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">
          {{ errorTitle }}
        </p>
        <p v-if="errorDetail" class="mt-1 text-muted-foreground">
          {{ errorDetail }}
        </p>
      </div>
    </div>

    <!-- terminal -->
    <div class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <Label for="serial-view" class="text-xs text-muted-foreground">View</Label>
          <SearchableSelect
            id="serial-view"
            class="w-28"
            :spec="viewSpec"
            :model-value="view"
            @update:model-value="(v) => (view = v === 'hex' ? 'hex' : 'text')"
          />
        </div>

        <div class="flex items-center gap-2">
          <Switch id="serial-timestamps" v-model="showTimestamps" />
          <Label for="serial-timestamps" class="cursor-pointer text-xs text-muted-foreground"
            >Timestamps</Label
          >
        </div>

        <Button variant="ghost" size="sm" @click="clearLog">
          <Trash2 class="size-3.5" aria-hidden="true" />
          Clear
        </Button>

        <Button variant="outline" size="sm" :disabled="isEmpty" @click="downloadLog">
          <Download class="size-3.5" aria-hidden="true" />
          Download log
        </Button>

        <span class="ml-auto text-xs text-muted-foreground tabular-nums">
          {{ rxBytes }} in, {{ txBytes }} out
        </span>
      </div>

      <div
        v-if="baudHint"
        role="status"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-muted-foreground"
      >
        {{ baudHint }}
      </div>

      <p v-if="hiddenRowCount" class="text-xs text-muted-foreground">
        Showing the most recent {{ MAX_RENDER }} rows. {{ hiddenRowCount }} older rows are still in
        the download, and anything past {{ MAX_LINES }} rows is dropped.
      </p>

      <div
        ref="logEl"
        class="h-[420px] overflow-auto rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
        tabindex="0"
        role="log"
        aria-label="Serial output"
        @scroll="onLogScroll"
      >
        <p v-if="isEmpty" class="py-6 text-center text-sm text-muted-foreground">
          {{
            connected
              ? "Connected. Nothing has arrived yet: press the reset button on the board, or send it something."
              : "Not connected. Click Connect a device and pick your board."
          }}
        </p>

        <div
          v-for="row in visibleRows"
          :key="row.key"
          class="font-mono text-xs leading-[1.5]"
          :class="[
            view === 'hex' ? 'whitespace-pre' : 'whitespace-pre-wrap break-all',
            row.kind === 'tx'
              ? 'text-primary'
              : row.kind === 'note'
                ? 'text-muted-foreground italic'
                : '',
          ]"
        >
          <span v-if="showTimestamps" class="text-muted-foreground select-none"
            >{{ row.time }} </span
          >{{ rowBody(row) }}
        </div>
      </div>

      <p v-if="!stickToBottom" class="text-xs text-muted-foreground">
        Scrolled up, so the view is held still. Scroll back to the bottom to follow the live output
        again.
      </p>
    </div>

    <!-- send -->
    <div class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <Label for="serial-send" class="text-xs text-muted-foreground">Send</Label>
          <Input
            id="serial-send"
            v-model="sendText"
            class="h-9 font-mono"
            spellcheck="false"
            autocomplete="off"
            :disabled="!connected"
            :placeholder="sendMode === 'hex' ? '7E 00 0A or 0x7E,0x00' : 'AT'"
            @keydown.enter.prevent="send"
            @keydown.up.prevent="recallHistory(1)"
            @keydown.down.prevent="recallHistory(-1)"
          />
        </div>

        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="serial-mode" class="text-xs text-muted-foreground">Mode</Label>
          <SearchableSelect
            id="serial-mode"
            class="w-24"
            :spec="sendModeSpec"
            :model-value="sendMode"
            @update:model-value="(v) => (sendMode = v as SendMode)"
          />
        </div>

        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="serial-ending" class="text-xs text-muted-foreground">Line ending</Label>
          <SearchableSelect
            id="serial-ending"
            class="w-32"
            :spec="lineEndingSpec"
            :model-value="lineEnding"
            @update:model-value="(v) => (lineEnding = v as LineEnding)"
          />
        </div>

        <Button :disabled="!connected" @click="send">
          <Send class="size-4" aria-hidden="true" />
          Send
        </Button>
      </div>

      <p class="text-xs text-muted-foreground">
        Press
        <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono text-[11px]"
          >Enter</kbd
        >
        to send and
        <kbd class="rounded-[8px] border bg-secondary px-1.5 py-0.5 font-mono text-[11px]">↑</kbd>
        to walk back through the last {{ HISTORY_LIMIT }} things you sent. That history lives in
        this tab's memory only and is gone when you close it.
      </p>

      <div
        v-if="sendError"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">
          {{ sendError.message }}
        </p>
        <p v-if="sendError.fix" class="mt-1 text-muted-foreground">
          {{ sendError.fix }}
        </p>
      </div>
    </div>
  </div>
</template>
