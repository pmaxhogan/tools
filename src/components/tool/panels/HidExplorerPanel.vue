<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { Pause, Play, Plug, Trash2, Usb } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useStickToBottom } from "@/lib/stick-to-bottom";
import OutputView from "../OutputView.vue";
import {
  decodeInputReport,
  describeCollectionTree,
  formatLayoutHeader,
  layoutsFromCollections,
  run,
  usageName,
  usagePageName,
  type DecodedField,
  type HidCollectionInfo,
  type ReportLayout,
} from "@/tools/hid-report-explorer/index";

/**
 * Bespoke panel for the HID report explorer. Two surfaces over one pure
 * logic layer:
 *
 *  - a live WebHID capture, because reports only exist while a device is
 *    plugged in and talking, and
 *  - a paste box for a raw report descriptor dump, because WebHID never
 *    exposes the descriptor bytes themselves.
 *
 * Everything the panel shows is computed by `src/tools/hid-report-explorer`:
 * the field layout, the decode, the hex view and the collection tree all
 * come from there, so the live path and the paste path can never disagree.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* WebHID shapes (not in lib.dom, so declared narrowly here)          */
/* ---------------------------------------------------------------- */

interface HidDeviceLike extends EventTarget {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections: HidCollectionInfo[];
  open(): Promise<void>;
  close(): Promise<void>;
}

interface HidApiLike extends EventTarget {
  requestDevice(options: { filters: unknown[] }): Promise<HidDeviceLike[]>;
  getDevices(): Promise<HidDeviceLike[]>;
}

interface HidInputReportEventLike extends Event {
  device: HidDeviceLike;
  reportId: number;
  data: DataView;
}

interface HidConnectionEventLike extends Event {
  device: HidDeviceLike;
}

function hidApi(): HidApiLike | undefined {
  return (navigator as Navigator & { hid?: HidApiLike }).hid;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

/** How many reports the rolling log keeps. */
const LOG_LIMIT = 50;

interface LogEntry {
  key: number;
  time: string;
  reportId: number;
  bytes: number[];
  /** Per byte: did it differ from the previous report with the same ID. */
  changed: boolean[];
  hex: string;
  fields: DecodedField[];
  /** True when no layout matched this report ID. */
  unknownLayout: boolean;
}

const device = shallowRef<HidDeviceLike | null>(null);
const knownDevices = shallowRef<HidDeviceLike[]>([]);
const layouts = shallowRef<ReportLayout[]>([]);
const collectionTree = ref("");
const connecting = ref(false);
const errorTitle = ref<string | null>(null);
const errorDetail = ref<string | null>(null);

const log = ref<LogEntry[]>([]);
const paused = ref(false);
const reportFilter = ref("all");
const reportCount = ref(0);

const dump = ref("");

let sequence = 0;
const previousBytes = new Map<number, number[]>();

/* ---------------------------------------------------------------- */
/* device identity                                                   */
/* ---------------------------------------------------------------- */

function hex4(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
}

function deviceLabel(d: HidDeviceLike): string {
  const name = d.productName?.trim() || "Unnamed HID device";
  return `${name} (vendor ${hex4(d.vendorId)}, product ${hex4(d.productId)})`;
}

const deviceRows = computed<Record<string, string> | null>(() => {
  const d = device.value;
  if (!d) return null;
  const collections = d.collections ?? [];
  const named = collections
    .map((c) => `${usagePageName(c.usagePage ?? 0)} / ${usageName(c.usagePage ?? 0, c.usage ?? 0)}`)
    .join(", ");
  return {
    Device: d.productName?.trim() || "Unnamed HID device",
    "Vendor ID": hex4(d.vendorId),
    "Product ID": hex4(d.productId),
    Collections: named || "none reported",
    "Report layouts": layouts.value.length
      ? layouts.value.map(formatLayoutHeader).join("\n")
      : "none computed",
  };
});

const inputReportIds = computed(() =>
  Array.from(new Set(layouts.value.filter((l) => l.kind === "input").map((l) => l.reportId))).sort(
    (a, b) => a - b,
  ),
);

const visibleLog = computed(() =>
  reportFilter.value === "all"
    ? log.value
    : log.value.filter((e) => String(e.reportId) === reportFilter.value),
);

// The report log stays pinned to the newest entry unless the reader scrolls up.
const { el: logEl, onScroll: onLogScroll } = useStickToBottom(() => visibleLog.value.length);

/** The report-ID filter choices, rebuilt as the device's report layouts change. */
const reportFilterSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "hid-report-filter",
  label: "Report ID",
  default: "all",
  options: [
    { value: "all", label: "All", synonyms: ["every", "any", "everything"] },
    ...inputReportIds.value.map((id) => ({
      value: String(id),
      label: id === 0 ? "No ID" : `ID ${id}`,
      synonyms:
        id === 0 ? ["no id", "unnumbered", "zero"] : [`id ${id}`, `report ${id}`, String(id)],
    })),
  ],
}));

/* ---------------------------------------------------------------- */
/* connect / disconnect                                              */
/* ---------------------------------------------------------------- */

function resetCapture() {
  log.value = [];
  previousBytes.clear();
  reportCount.value = 0;
  reportFilter.value = "all";
}

function describeError(err: unknown): { title: string; detail: string } {
  const name = err instanceof DOMException ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "NotAllowedError") {
    return {
      title: "The browser blocked access to that device.",
      detail:
        "HID access needs a user gesture and a device the browser is willing to share. Keyboards, mice and other protected usage pages are never offered. Try again and pick a different device.",
    };
  }
  if (name === "SecurityError") {
    return {
      title: "This page is not allowed to use WebHID.",
      detail:
        "WebHID only works on a secure connection and outside a restricted frame. Open the page directly over HTTPS and try again.",
    };
  }
  return {
    title: "Could not open that device.",
    detail:
      message ||
      "The device was picked but would not open. Another program may already hold it open. Close that program and try again.",
  };
}

async function attach(target: HidDeviceLike) {
  if (!target.opened) await target.open();
  target.addEventListener("inputreport", handleInputReport);
  device.value = target;
  layouts.value = layoutsFromCollections(target.collections ?? []);
  collectionTree.value = describeCollectionTree(target.collections ?? []);
  resetCapture();
}

async function detach() {
  const current = device.value;
  if (!current) return;
  current.removeEventListener("inputreport", handleInputReport);
  try {
    if (current.opened) await current.close();
  } catch {
    // The device may already be gone; nothing useful to do about it.
  }
  device.value = null;
  layouts.value = [];
  collectionTree.value = "";
}

async function connect() {
  errorTitle.value = null;
  errorDetail.value = null;
  const hid = hidApi();
  if (!hid) return;

  connecting.value = true;
  try {
    const picked = await hid.requestDevice({ filters: [] });
    const target = picked[0];
    if (!target) return;
    await detach();
    await attach(target);
    await refreshKnownDevices();
  } catch (err) {
    const described = describeError(err);
    errorTitle.value = described.title;
    errorDetail.value = described.detail;
  } finally {
    connecting.value = false;
  }
}

async function reconnect(target: HidDeviceLike) {
  errorTitle.value = null;
  errorDetail.value = null;
  connecting.value = true;
  try {
    await detach();
    await attach(target);
  } catch (err) {
    const described = describeError(err);
    errorTitle.value = described.title;
    errorDetail.value = described.detail;
  } finally {
    connecting.value = false;
  }
}

async function refreshKnownDevices() {
  const hid = hidApi();
  if (!hid) return;
  try {
    knownDevices.value = await hid.getDevices();
  } catch {
    knownDevices.value = [];
  }
}

function handleDisconnect(event: Event) {
  const e = event as HidConnectionEventLike;
  if (device.value && e.device === device.value) {
    device.value = null;
    layouts.value = [];
    collectionTree.value = "";
    errorTitle.value = "The device was unplugged.";
    errorDetail.value = "Plug it back in and click Connect a device again. The log above is kept.";
  }
  void refreshKnownDevices();
}

/* ---------------------------------------------------------------- */
/* live reports                                                      */
/* ---------------------------------------------------------------- */

function timestamp(): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function handleInputReport(event: Event) {
  const e = event as HidInputReportEventLike;
  reportCount.value += 1;
  if (paused.value) return;

  const view = e.data;
  const bytes: number[] = [];
  for (let i = 0; i < view.byteLength; i++) bytes.push(view.getUint8(i));

  const previous = previousBytes.get(e.reportId);
  const changed = bytes.map((b, i) => (previous ? previous[i] !== b : false));
  previousBytes.set(e.reportId, bytes);

  const layout = layouts.value.find((l) => l.kind === "input" && l.reportId === e.reportId);
  const data = Uint8Array.from(bytes);

  sequence += 1;
  const entry: LogEntry = {
    key: sequence,
    time: timestamp(),
    reportId: e.reportId,
    bytes,
    changed,
    hex: bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
    fields: layout ? decodeInputReport(layout, data) : [],
    unknownLayout: !layout,
  };

  log.value = [entry, ...log.value].slice(0, LOG_LIMIT);
}

function togglePause() {
  paused.value = !paused.value;
}

function clearLog() {
  log.value = [];
  previousBytes.clear();
  reportCount.value = 0;
}

/* ---------------------------------------------------------------- */
/* pasted descriptor                                                 */
/* ---------------------------------------------------------------- */

const dumpResult = computed<{ output: Record<string, string> | null; error: ToolError | null }>(
  () => {
    if (!dump.value.trim()) return { output: null, error: null };
    try {
      return { output: run(dump.value, { view: "both", showBytes: true }), error: null };
    } catch (err) {
      if (err instanceof ToolError) return { output: null, error: err };
      return {
        output: null,
        error: new ToolError("parse-failed", "That descriptor could not be parsed."),
      };
    }
  },
);

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  const hid = hidApi();
  if (!hid) return;
  hid.addEventListener("disconnect", handleDisconnect);
  void refreshKnownDevices();
});

onUnmounted(() => {
  hidApi()?.removeEventListener("disconnect", handleDisconnect);
  void detach();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- connect -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center gap-3">
        <Button size="lg" :disabled="connecting" @click="connect">
          <Usb class="size-4" aria-hidden="true" />
          {{ connecting ? "Waiting for the browser…" : "Connect a device" }}
        </Button>
        <Button v-if="device" variant="ghost" @click="detach"> Disconnect </Button>
        <span v-if="device" class="text-sm text-muted-foreground">{{ deviceLabel(device) }}</span>
      </div>

      <div v-if="!device && knownDevices.length" class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Already allowed</span
        >
        <Button
          v-for="d in knownDevices"
          :key="`${d.vendorId}-${d.productId}-${d.productName}`"
          variant="secondary"
          size="sm"
          :disabled="connecting"
          @click="reconnect(d)"
        >
          <Plug class="size-3.5" aria-hidden="true" />
          {{ d.productName?.trim() || "Unnamed HID device" }}
        </Button>
      </div>

      <p class="text-xs text-muted-foreground">
        Everything runs in this tab: your files and inputs never leave your device. Keyboards, mice
        and other protected usage pages are hidden from the chooser by the browser itself, so they
        cannot be captured here.
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

    <!-- device description -->
    <div
      v-if="device"
      class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <OutputView v-if="deviceRows" :output="deviceRows" />

      <div class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Collection tree</span
        >
        <pre
          class="max-h-96 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs shadow-[var(--sh-inset)]"
          >{{ collectionTree }}</pre>
      </div>

      <p class="text-xs text-muted-foreground">
        WebHID hands the page the collections the browser already parsed, never the raw report
        descriptor bytes, so this tree is rebuilt from those collections rather than decoded from
        the descriptor itself. To read the real item stream, dump the descriptor with a tool that
        can see it and paste the bytes below.
      </p>
    </div>

    <!-- live log -->
    <div
      v-if="device"
      class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" @click="togglePause">
          <component :is="paused ? Play : Pause" class="size-3.5" aria-hidden="true" />
          {{ paused ? "Resume" : "Pause" }}
        </Button>
        <Button variant="ghost" size="sm" @click="clearLog">
          <Trash2 class="size-3.5" aria-hidden="true" />
          Clear
        </Button>

        <div v-if="inputReportIds.length > 1" class="flex items-center gap-2">
          <Label for="hid-report-filter" class="text-xs text-muted-foreground">Report ID</Label>
          <SearchableSelect
            id="hid-report-filter"
            v-model="reportFilter"
            :spec="reportFilterSpec"
            class="w-32 bg-card"
          />
        </div>

        <span class="text-xs text-muted-foreground">
          {{ reportCount }} report{{ reportCount === 1 ? "" : "s" }} seen, showing the last
          {{ LOG_LIMIT }}{{ paused ? ", paused" : "" }}
        </span>
      </div>

      <p
        v-if="!visibleLog.length"
        class="rounded-[10px] bg-secondary px-3 py-6 text-center text-sm text-muted-foreground shadow-[var(--sh-inset)]"
      >
        Waiting for input reports. Move the device or press one of its controls.
      </p>

      <ol
        v-else
        ref="logEl"
        class="flex max-h-[520px] flex-col gap-2 overflow-y-auto"
        @scroll.passive="onLogScroll"
      >
        <li
          v-for="entry in visibleLog"
          :key="entry.key"
          class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="font-mono text-xs text-muted-foreground">{{ entry.time }}</span>
            <span class="text-xs text-muted-foreground">
              {{ entry.reportId === 0 ? "no report ID" : `report ID ${entry.reportId}` }},
              {{ entry.bytes.length }} bytes
            </span>
          </div>

          <div class="mt-1 flex flex-wrap gap-1 font-mono text-sm">
            <span
              v-for="(byte, i) in entry.bytes"
              :key="i"
              class="rounded-[4px] px-1 py-0.5"
              :class="entry.changed[i] ? 'byte-changed' : 'text-muted-foreground'"
              >{{ byte.toString(16).toUpperCase().padStart(2, "0") }}</span
            >
          </div>

          <p v-if="entry.unknownLayout" class="mt-2 text-xs text-muted-foreground">
            No layout was declared for this report ID, so only the raw bytes are shown.
          </p>

          <dl v-else class="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-xs">
            <template v-for="(field, i) in entry.fields" :key="i">
              <dt class="truncate text-muted-foreground">
                {{ field.name }}
                <span class="opacity-60">bit {{ field.bitOffset }}, {{ field.bitSize }} b</span>
              </dt>
              <dd class="text-right font-mono">
                {{ field.display }}
              </dd>
            </template>
          </dl>
        </li>
      </ol>
    </div>

    <!-- pasted descriptor -->
    <div class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <Label for="hid-descriptor-dump" class="text-sm font-medium"
        >Paste a report descriptor hex dump</Label
      >
      <p class="text-xs text-muted-foreground">
        Spaced bytes, a C array with 0x prefixes and comments, a hexdump with offset columns, or one
        unbroken hex string. The item tree and the computed report layout come back below.
      </p>
      <Textarea
        id="hid-descriptor-dump"
        v-model="dump"
        rows="5"
        spellcheck="false"
        class="font-mono text-sm"
        placeholder="05 01 09 02 A1 01 09 01 A1 00 ..."
      />

      <div
        v-if="dumpResult.error"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">
          {{ dumpResult.error.message }}
        </p>
        <p v-if="dumpResult.error.fix" class="mt-1 text-muted-foreground">
          {{ dumpResult.error.fix }}
        </p>
      </div>

      <OutputView v-if="dumpResult.output" :output="dumpResult.output" />
    </div>
  </div>
</template>

<style scoped>
/* Bytes that differ from the previous report of the same ID stay tinted so
   the change is still readable after scrolling, and fade in once on arrival. */
.byte-changed {
  background-color: color-mix(in oklab, var(--ring) 24%, transparent);
  color: var(--foreground);
  animation: byte-flash 160ms cubic-bezier(0.2, 0.7, 0.3, 1);
}

@keyframes byte-flash {
  from {
    background-color: color-mix(in oklab, var(--ring) 70%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .byte-changed {
    animation: none;
  }
}
</style>
