<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Bluetooth, Download, Plug, Trash2 } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SUPPORTED_SERVICES,
  downsampleForChart,
  formatValue,
  parseCharacteristic,
  ringBufferPush,
  toCsv,
  uuidName,
  type CsvRow,
} from "@/tools/ble-sensor-dashboard/index";

/**
 * Bespoke panel for the BLE Sensor Dashboard. Web Bluetooth only exists in a
 * real browser session, so the radio half lives here: requestDevice, the GATT
 * connect, service and characteristic discovery, the notification
 * subscriptions and the polling reads.
 *
 * Every characteristic value is handed to the pure layer in
 * `src/tools/ble-sensor-dashboard` for decoding, so the live charts and any
 * saved capture agree on what a payload means. Nothing here is persisted: the
 * readings, the charts and the device live in this component's memory only and
 * are gone when the tab closes.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* Web Bluetooth shapes (not in lib.dom, so declared narrowly here)  */
/* ---------------------------------------------------------------- */

interface GattProperties {
  read: boolean;
  notify: boolean;
  indicate: boolean;
}

interface GattCharacteristicLike extends EventTarget {
  uuid: string;
  properties: GattProperties;
  value?: DataView;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<GattCharacteristicLike>;
  stopNotifications(): Promise<GattCharacteristicLike>;
}

interface GattServiceLike {
  uuid: string;
  getCharacteristics(): Promise<GattCharacteristicLike[]>;
}

interface GattServerLike {
  connected: boolean;
  connect(): Promise<GattServerLike>;
  disconnect(): void;
  getPrimaryServices(): Promise<GattServiceLike[]>;
}

interface BluetoothDeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: GattServerLike;
  watchAdvertisements?: () => Promise<void>;
}

interface RequestDeviceOptions {
  acceptAllDevices?: boolean;
  optionalServices?: (number | string)[];
}

interface BluetoothLike {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDeviceLike>;
}

interface AdvertisementEventLike extends Event {
  rssi?: number;
}

function bluetoothApi(): BluetoothLike | undefined {
  return (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Points kept per field. At one reading a second this is well over an hour. */
const MAX_POINTS = 5000;
/** Readings kept for the CSV export, across every field. */
const MAX_LOG = 50000;
/** Reconnect attempts before giving up. */
const RECONNECT_TRIES = 5;
const RECONNECT_DELAY_MS = 1500;
const CHART_HEIGHT = 76;

const WINDOW_CHOICES = [
  { value: "60000", label: "1 minute" },
  { value: "300000", label: "5 minutes" },
  { value: "900000", label: "15 minutes" },
];
const POLL_CHOICES = [
  { value: "1000", label: "1 second" },
  { value: "2000", label: "2 seconds" },
  { value: "5000", label: "5 seconds" },
  { value: "10000", label: "10 seconds" },
];

/* ---------------------------------------------------------------- */
/* series model                                                      */
/* ---------------------------------------------------------------- */

interface Point {
  t: number;
  v: number;
}

interface Series {
  key: string;
  charUuid: string;
  charName: string;
  fieldName: string;
  unit: string;
  numeric: boolean;
  points: Point[];
  last: number | string;
  lastAt: number;
}

/**
 * Series live in a plain Map, not a ref: a chatty sensor can deliver readings
 * faster than the screen refreshes, so ingestion writes straight to memory and
 * `revision` is bumped once per animation frame to redraw. The template reads
 * `revision` through the computed lists so Vue knows when to recompute.
 */
const seriesMap = new Map<string, Series>();
const sessionLog: CsvRow[] = [];
const revision = ref(0);
let frame: number | null = null;

const windowMs = ref("300000");
const pollMs = ref("2000");
const autoReconnect = ref(true);

const canvasEls = new Map<string, HTMLCanvasElement>();

function scheduleRender() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    revision.value++;
    drawCharts();
  });
}

const seriesList = computed<Series[]>(() => {
  void revision.value;
  return [...seriesMap.values()];
});

const numericSeries = computed(() => seriesList.value.filter((s) => s.numeric));
const textSeries = computed(() => seriesList.value.filter((s) => !s.numeric));

const readingCount = computed(() => {
  void revision.value;
  return sessionLog.length;
});

const batteryLevel = computed(() => {
  const battery = seriesList.value.find((s) => s.fieldName === "Battery level");
  return battery && typeof battery.last === "number" ? battery.last : null;
});

function seriesKey(charUuid: string, fieldName: string): string {
  return `${charUuid}::${fieldName}`;
}

function ingestField(
  charUuid: string,
  charName: string,
  fieldName: string,
  value: number | string,
  unit: string,
  t: number,
) {
  const key = seriesKey(charUuid, fieldName);
  const numeric = typeof value === "number" && Number.isFinite(value);
  let series = seriesMap.get(key);
  if (!series) {
    series = {
      key,
      charUuid,
      charName,
      fieldName,
      unit,
      numeric,
      points: [],
      last: value,
      lastAt: t,
    };
    seriesMap.set(key, series);
  }
  series.last = value;
  series.lastAt = t;
  series.unit = unit;
  // A field that has ever produced a number stays chartable.
  if (numeric) {
    series.numeric = true;
    ringBufferPush(series.points, { t, v: value as number }, MAX_POINTS);
  }
  ringBufferPush(sessionLog, { t, name: `${charName} / ${fieldName}`, value }, MAX_LOG);
}

function handleReading(charUuid: string, view: DataView) {
  const charName = uuidName(charUuid);
  const parsed = parseCharacteristic(charUuid, view);
  const t = Date.now();
  for (const field of parsed.fields) {
    ingestField(charUuid, charName, field.name, field.value, field.unit, t);
  }
  scheduleRender();
}

/* ---------------------------------------------------------------- */
/* connection state                                                  */
/* ---------------------------------------------------------------- */

type State = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

const state = ref<State>("idle");
const deviceName = ref<string>("");
const rssi = ref<number | null>(null);
const discovered = ref<{ name: string; mode: string }[]>([]);
const errorTitle = ref<string | null>(null);
const errorDetail = ref<string | null>(null);

const connected = computed(() => state.value === "connected");
const busy = computed(() => state.value === "connecting" || state.value === "reconnecting");

let device: BluetoothDeviceLike | null = null;
const subscribed: GattCharacteristicLike[] = [];
const pollList: GattCharacteristicLike[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let intentionalDisconnect = false;

function setError(title: string, detail: string) {
  errorTitle.value = title;
  errorDetail.value = detail;
}

function clearError() {
  errorTitle.value = null;
  errorDetail.value = null;
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  if (pollList.length === 0) return;
  pollTimer = setInterval(() => {
    if (!connected.value) return;
    for (const char of pollList) {
      char
        .readValue()
        .then((view) => handleReading(char.uuid, view))
        .catch(() => {
          // A read can fail transiently while a device is busy; the next tick retries.
        });
    }
  }, Number(pollMs.value));
}

function onCharValue(event: Event) {
  const char = event.target as GattCharacteristicLike | null;
  if (char?.value) handleReading(char.uuid, char.value);
}

async function setupCharacteristic(char: GattCharacteristicLike) {
  const name = uuidName(char.uuid);
  const props = char.properties;
  if (props.notify || props.indicate) {
    char.addEventListener("characteristicvaluechanged", onCharValue);
    try {
      await char.startNotifications();
      subscribed.push(char);
      discovered.value.push({ name, mode: "live" });
    } catch {
      discovered.value.push({ name, mode: "unavailable" });
    }
  } else if (props.read) {
    pollList.push(char);
    discovered.value.push({ name, mode: "polled" });
    try {
      handleReading(char.uuid, await char.readValue());
    } catch {
      // The first read can fail; polling will pick it up.
    }
  }
}

async function discover(server: GattServerLike) {
  discovered.value = [];
  subscribed.length = 0;
  pollList.length = 0;
  let services: GattServiceLike[];
  try {
    services = await server.getPrimaryServices();
  } catch {
    services = [];
  }
  for (const service of services) {
    let chars: GattCharacteristicLike[];
    try {
      chars = await service.getCharacteristics();
    } catch {
      // One blocked service should not kill discovery of the rest.
      continue;
    }
    for (const char of chars) {
      // Discovery is sequential so a slow device is not hit with a burst.
      await setupCharacteristic(char);
    }
  }
  startPolling();
}

async function watchRssi(target: BluetoothDeviceLike) {
  if (typeof target.watchAdvertisements !== "function") return;
  target.addEventListener("advertisementreceived", (event: Event) => {
    const value = (event as AdvertisementEventLike).rssi;
    if (typeof value === "number") rssi.value = value;
  });
  try {
    await target.watchAdvertisements();
  } catch {
    // Advertisement watching is still flag gated in some builds; drop it quietly.
  }
}

async function connectGatt(target: BluetoothDeviceLike, reconnecting: boolean) {
  const server = target.gatt;
  if (!server) {
    setError("This device has no GATT server.", "It cannot expose readable characteristics.");
    state.value = "disconnected";
    return;
  }
  state.value = reconnecting ? "reconnecting" : "connecting";
  await server.connect();
  await discover(server);
  state.value = "connected";
  void watchRssi(target);
}

function describeError(err: unknown): { title: string; detail: string } {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "SecurityError") {
    return {
      title: "This page is not allowed to use Web Bluetooth.",
      detail:
        "Web Bluetooth only works over a secure connection and outside a restricted frame. Open the page directly over HTTPS and try again.",
    };
  }
  if (name === "NetworkError") {
    return {
      title: "The device would not connect.",
      detail:
        "It may be out of range, already paired to another app, or asleep. Bring it close, wake it, and try again.",
    };
  }
  return {
    title: "Could not connect to the device.",
    detail: err instanceof Error ? err.message : String(err),
  };
}

async function connect() {
  clearError();
  const api = bluetoothApi();
  if (!api) return;

  let picked: BluetoothDeviceLike;
  try {
    picked = await api.requestDevice({
      // acceptAllDevices needs optionalServices, or a connected device exposes
      // none of its services to the page.
      acceptAllDevices: true,
      optionalServices: SUPPORTED_SERVICES,
    });
  } catch (err) {
    // NotFoundError just means the chooser was dismissed, which is not a fault.
    if (err instanceof DOMException && err.name === "NotFoundError") return;
    const described = describeError(err);
    setError(described.title, described.detail);
    return;
  }

  // A brand new device starts a fresh session.
  seriesMap.clear();
  sessionLog.length = 0;
  rssi.value = null;
  revision.value++;

  device = picked;
  deviceName.value = picked.name || "Unnamed device";
  intentionalDisconnect = false;
  picked.addEventListener("gattserverdisconnected", onDisconnected);

  try {
    await connectGatt(picked, false);
  } catch (err) {
    const described = describeError(err);
    setError(described.title, described.detail);
    state.value = "disconnected";
  }
}

async function reconnectLoop() {
  if (!device) return;
  for (let attempt = 1; attempt <= RECONNECT_TRIES; attempt++) {
    if (intentionalDisconnect) return;
    try {
      await connectGatt(device, true);
      clearError();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }
  state.value = "disconnected";
  setError(
    "Lost the device and could not reconnect.",
    "It may be out of range or powered off. Click Connect a sensor to start again. The charts so far are kept.",
  );
}

function onDisconnected() {
  stopPolling();
  if (intentionalDisconnect || !autoReconnect.value || !device) {
    state.value = "disconnected";
    return;
  }
  setError(
    "The device dropped off.",
    "Auto reconnect is on, so it is trying to come back. The charts so far are kept.",
  );
  void reconnectLoop();
}

async function teardown() {
  intentionalDisconnect = true;
  stopPolling();
  for (const char of subscribed) {
    char.removeEventListener("characteristicvaluechanged", onCharValue);
    try {
      await char.stopNotifications();
    } catch {
      // The device may already be gone; nothing useful to do.
    }
  }
  subscribed.length = 0;
  pollList.length = 0;
  if (device) {
    device.removeEventListener("gattserverdisconnected", onDisconnected);
    try {
      device.gatt?.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

async function disconnect() {
  await teardown();
  device = null;
  state.value = "disconnected";
  clearError();
}

function clearCharts() {
  seriesMap.clear();
  sessionLog.length = 0;
  canvasEls.clear();
  revision.value++;
}

/* ---------------------------------------------------------------- */
/* CSV export                                                        */
/* ---------------------------------------------------------------- */

function exportCsv() {
  if (sessionLog.length === 0) return;
  const csv = toCsv(sessionLog);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const blob = new Blob([`${csv}\n`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ble-session-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------- */
/* charts                                                            */
/* ---------------------------------------------------------------- */

interface Theme {
  text: string;
  muted: string;
  border: string;
  accent: string;
  well: string;
}

function readTheme(el: HTMLElement): Theme {
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    text: pick("--foreground", "#1b1917"),
    muted: pick("--muted-foreground", "#79726b"),
    border: pick("--border", "#e7e2da"),
    accent: pick("--primary", "#5b4bd6"),
    well: pick("--secondary", "#f0ede8"),
  };
}

function bindCanvas(key: string) {
  return (el: unknown) => {
    if (el instanceof HTMLCanvasElement) canvasEls.set(key, el);
    else canvasEls.delete(key);
  };
}

const wrapper = ref<HTMLElement>();

function drawSeries(canvas: HTMLCanvasElement, series: Series, theme: Theme, now: number) {
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const cssWidth = Math.max(120, canvas.clientWidth || 240);
  const cssHeight = CHART_HEIGHT;
  const backingW = Math.round(cssWidth * dpr);
  const backingH = Math.round(cssHeight * dpr);
  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW;
    canvas.height = backingH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = theme.well;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const span = Number(windowMs.value);
  const from = now - span;
  const windowed = series.points.filter((p) => p.t >= from);

  const pad = 8;
  const plotW = cssWidth - pad * 2;
  const plotH = cssHeight - pad * 2;

  if (windowed.length < 2) {
    ctx.fillStyle = theme.muted;
    ctx.font = '11px "Geist", ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for readings…", cssWidth / 2, cssHeight / 2);
    return;
  }

  // Thin the visible points to roughly one per horizontal pixel so a long
  // window never draws tens of thousands of line segments.
  const points = downsampleForChart(windowed, Math.max(2, Math.round(plotW)));

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const range = max - min;

  const xAt = (t: number) => pad + ((t - from) / span) * plotW;
  const yAt = (v: number) => pad + (1 - (v - min) / range) * plotH;

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Point;
    const x = xAt(p.t);
    const y = yAt(p.v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Min and max guide labels down the right edge.
  ctx.fillStyle = theme.muted;
  ctx.font = '10px "Geist Mono", ui-monospace, monospace';
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(String(Math.round(max * 100) / 100), cssWidth - 4, 3);
  ctx.textBaseline = "bottom";
  ctx.fillText(String(Math.round(min * 100) / 100), cssWidth - 4, cssHeight - 3);
}

function drawCharts() {
  const el = wrapper.value;
  if (!el) return;
  const theme = readTheme(el);
  const now = Date.now();
  for (const series of seriesMap.values()) {
    if (!series.numeric) continue;
    const canvas = canvasEls.get(series.key);
    if (canvas) drawSeries(canvas, series, theme, now);
  }
}

/* ---------------------------------------------------------------- */
/* display helpers                                                   */
/* ---------------------------------------------------------------- */

function displayValue(series: Series): string {
  return formatValue(series.last);
}

const stateLabel = computed(() => {
  switch (state.value) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting…";
    case "disconnected":
      return "Disconnected";
    default:
      return "Not connected";
  }
});

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

let ticker: ReturnType<typeof setInterval> | null = null;
let themeWatcher: MutationObserver | null = null;

onMounted(() => {
  // A slow one second repaint keeps the rolling window scrolling even when no
  // new readings arrive, so an idle chart still advances in time.
  ticker = setInterval(() => {
    if (seriesMap.size) scheduleRender();
  }, 1000);
  themeWatcher = new MutationObserver(() => drawCharts());
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
});

onUnmounted(() => {
  if (frame !== null) cancelAnimationFrame(frame);
  if (ticker !== null) clearInterval(ticker);
  themeWatcher?.disconnect();
  themeWatcher = null;
  void teardown();
});
</script>

<template>
  <div ref="wrapper" class="flex flex-col gap-4">
    <!-- connection -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center gap-3">
        <Button v-if="!connected && !busy" size="lg" @click="connect">
          <Bluetooth class="size-4" aria-hidden="true" />
          Connect a sensor
        </Button>
        <Button v-else-if="busy" size="lg" disabled>
          {{ stateLabel }}
        </Button>
        <Button v-else size="lg" variant="secondary" @click="disconnect"> Disconnect </Button>

        <div
          v-if="state !== 'idle'"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
        >
          <span class="font-medium text-foreground">{{ deviceName }}</span>
          <span class="inline-flex items-center gap-1.5" :class="connected ? 'text-positive' : ''">
            <span
              class="size-2 rounded-full"
              :class="connected ? 'bg-positive' : 'bg-muted-foreground'"
              aria-hidden="true"
            />
            {{ stateLabel }}
          </span>
          <span v-if="rssi !== null" class="tabular-nums">{{ rssi }} dBm</span>
          <span v-if="batteryLevel !== null" class="tabular-nums">Battery {{ batteryLevel }}%</span>
        </div>
      </div>

      <div class="flex flex-wrap items-end gap-4">
        <div class="flex w-40 flex-col gap-1.5">
          <Label for="ble-window" class="text-xs text-muted-foreground">Chart window</Label>
          <Select v-model="windowMs">
            <SelectTrigger id="ble-window" size="sm" class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="choice in WINDOW_CHOICES"
                :key="choice.value"
                :value="choice.value"
              >
                {{ choice.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex w-40 flex-col gap-1.5">
          <Label for="ble-poll" class="text-xs text-muted-foreground">Poll interval</Label>
          <Select v-model="pollMs">
            <SelectTrigger id="ble-poll" size="sm" class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="choice in POLL_CHOICES" :key="choice.value" :value="choice.value">
                {{ choice.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex items-center gap-2 pb-2">
          <Switch id="ble-reconnect" v-model="autoReconnect" />
          <Label for="ble-reconnect" class="cursor-pointer text-xs text-muted-foreground"
            >Auto reconnect</Label
          >
        </div>

        <div class="ml-auto flex items-center gap-2 pb-1">
          <Button variant="ghost" size="sm" :disabled="!readingCount" @click="clearCharts">
            <Trash2 class="size-3.5" aria-hidden="true" />
            Clear
          </Button>
          <Button variant="outline" size="sm" :disabled="!readingCount" @click="exportCsv">
            <Download class="size-3.5" aria-hidden="true" />
            Export CSV
          </Button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        Everything runs in this tab: your files and inputs never leave your device. Web Bluetooth is
        a Chromium feature, so this works in Chrome, Edge and Opera on desktop and Android, and not
        in Firefox, Safari or any browser on iOS. This version connects one device at a time.
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

    <!-- empty state -->
    <div
      v-if="state === 'idle'"
      class="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-[18px] border bg-card p-8 text-center shadow-[var(--sh-inset)]"
    >
      <Plug class="size-6 text-muted-foreground" aria-hidden="true" />
      <p class="text-muted-foreground">
        Click Connect a sensor and pick your Bluetooth device. Each numeric reading gets a live tile
        and chart, and the whole session exports as CSV.
      </p>
    </div>

    <!-- numeric field charts -->
    <div v-if="numericSeries.length" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div
        v-for="series in numericSeries"
        :key="series.key"
        class="flex flex-col gap-2 rounded-[14px] border bg-card p-4 shadow-[var(--sh-sm)]"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span
            class="truncate text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            {{ series.fieldName }}
          </span>
          <span class="truncate text-xs text-muted-foreground">{{ series.charName }}</span>
        </div>
        <div class="flex items-baseline gap-1.5">
          <span class="font-mono text-3xl leading-none font-semibold tabular-nums">
            {{ displayValue(series) }}
          </span>
          <span v-if="series.unit" class="text-sm text-muted-foreground">{{ series.unit }}</span>
        </div>
        <canvas
          :ref="bindCanvas(series.key)"
          class="w-full rounded-[8px] shadow-[var(--sh-inset)]"
          :style="{ height: `${CHART_HEIGHT}px` }"
        />
      </div>
    </div>

    <!-- text and hex fields -->
    <div
      v-if="textSeries.length"
      class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Other readings
      </span>
      <div class="flex flex-col gap-2">
        <div
          v-for="series in textSeries"
          :key="series.key"
          class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0"
        >
          <span class="text-sm">
            {{ series.charName }}
            <span class="text-muted-foreground">/ {{ series.fieldName }}</span>
          </span>
          <span class="font-mono text-sm break-all">{{ displayValue(series) }}</span>
        </div>
      </div>
    </div>

    <!-- discovered characteristics -->
    <div
      v-if="discovered.length"
      class="flex flex-col gap-2 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Characteristics found
      </span>
      <div class="flex flex-wrap gap-2">
        <span
          v-for="(item, i) in discovered"
          :key="i"
          class="inline-flex items-center gap-1.5 rounded-full border bg-secondary px-3 py-1 text-xs"
        >
          {{ item.name }}
          <span class="text-muted-foreground">{{ item.mode }}</span>
        </span>
      </div>
      <p class="text-xs text-muted-foreground">
        Live characteristics push readings as they change. Polled ones are read on the interval
        above. A reading shown as raw hex is a non-standard characteristic with no public
        definition.
      </p>
    </div>
  </div>
</template>
