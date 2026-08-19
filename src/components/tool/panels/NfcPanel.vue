<script setup lang="ts">
/**
 * Bespoke panel for the NFC Tag Reader and Writer.
 *
 * Web NFC only exists in a real browser session (Chrome on Android), so the
 * radio half lives here: requestPermission happens implicitly on the first
 * scan() or write() call, and this panel owns that call, the reading events,
 * and makeReadOnly(). Everything that turns a record's meaning into NDEF
 * bytes, and back, lives in the pure layer at src/tools/nfc-tag-tool (rule
 * 27): buildRecord and run() compose a record from typed fields, and
 * encodeMessage/decodeMessage/describeRecords turn a scanned tag's records
 * back into the same readable rows a pasted hex dump would produce, so a live
 * reading and a hand-typed one can never disagree about what the bytes mean.
 *
 * CapabilityGate (PROJECT.md rule 15) already keeps this panel from rendering
 * its "no NFC" state: it is only mounted once "NDEFReader" in window is true.
 * This file still guards every radio call defensively, and never reads
 * window or navigator outside a click handler, since the gate's own check
 * only runs after mount and this component's markup is still server rendered
 * first.
 *
 * Nothing here is persisted. Composed fields, the scan log, and any reading
 * live in this component's memory only: tag contents are read and written by
 * the phone directly, and nothing about them is sent to this site.
 */
import { computed, onUnmounted, ref, watch } from "vue";
import { Lock, Radio, Send, Square } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  TAG_CAPACITIES,
  buildRecord,
  decodeMessage,
  describeRecords,
  encodeMessage,
  run,
  tagCapacityFit,
  toWebNfcMessage,
  type NdefRecordObj,
  type WebNfcMessageInit,
} from "@/tools/nfc-tag-tool/index";
import { formatByteCount } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "@/components/tool/CopyButton.vue";
import OutputView from "@/components/tool/OutputView.vue";

const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * Web NFC shapes (not in lib.dom, so declared narrowly here)
 * ------------------------------------------------------------------ */

interface NDEFRecordLike {
  recordType: string;
  mediaType?: string;
  id?: string;
  data?: DataView;
  encoding?: string;
  lang?: string;
}

interface NDEFMessageLike {
  records: NDEFRecordLike[];
}

interface NDEFReadingEventLike extends Event {
  serialNumber: string;
  message: NDEFMessageLike;
}

interface NDEFReaderLike extends EventTarget {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(
    message: WebNfcMessageInit,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<void>;
  makeReadOnly(options?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((event: NDEFReadingEventLike) => void) | null;
  onreadingerror: ((event: Event) => void) | null;
}

function nfcReaderCtor(): (new () => NDEFReaderLike) | undefined {
  return (window as Window & { NDEFReader?: new () => NDEFReaderLike }).NDEFReader;
}

/* ------------------------------------------------------------------ *
 * shared error shape
 * ------------------------------------------------------------------ */

interface PanelError {
  message: string;
  fix?: string;
}

function toPanelError(err: unknown): PanelError {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : String(err) };
}

function describeNfcError(err: unknown): PanelError {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") {
    return {
      message: "NFC permission was not granted.",
      fix: "Allow NFC access when the browser asks, and check that NFC is turned on in the phone's system settings.",
    };
  }
  if (name === "NotSupportedError") {
    return {
      message: "This device has no usable NFC hardware.",
      fix: "NFC needs to be present and turned on. Check the phone's settings, and confirm this is Chrome on Android.",
    };
  }
  if (name === "AbortError") {
    return {
      message: "The operation timed out.",
      fix: "No tag was seen in time. Try again and hold the tag steady against the back of the phone as soon as you start.",
    };
  }
  if (name === "NetworkError") {
    return {
      message: "The tag moved out of range before the operation finished.",
      fix: "Hold the tag steady against the back of the phone for the whole operation, then try again.",
    };
  }
  if (name === "InvalidStateError") {
    return {
      message: "Another NFC operation is already running.",
      fix: "Stop the current scan, or wait for the current write to finish, before starting another one.",
    };
  }
  return {
    message: name
      ? `${name}: ${err instanceof Error ? err.message : String(err)}`
      : err instanceof Error
        ? err.message
        : String(err),
  };
}

/* ------------------------------------------------------------------ *
 * Compose
 * ------------------------------------------------------------------ */

const kindSpec = computed<SelectOptionSpec | undefined>(
  () =>
    props.meta.options?.find(
      (o): o is SelectOptionSpec => o.kind === "select" && o.id === "kind",
    ),
);

const composeKind = ref("text");

const textValue = ref("");
const urlValue = ref("");
const wifiSsid = ref("");
const wifiPassword = ref("");
const wifiAuth = ref("WPA2");
const vcardName = ref("");
const vcardTel = ref("");
const vcardEmail = ref("");
const vcardUrl = ref("");
const geoLat = ref("");
const geoLon = ref("");
const telValue = ref("");
const mailtoValue = ref("");
const smsNumber = ref("");
const smsBody = ref("");
const appPackage = ref("");
const hexDecodeInput = ref("");

const wifiAuthSpec: SelectOptionSpec = {
  kind: "select",
  id: "nfc-wifi-auth",
  label: "Security",
  default: "WPA2",
  options: [
    { value: "Open", label: "Open", synonyms: ["no password", "none"] },
    { value: "WEP", label: "WEP", synonyms: [] },
    { value: "WPA", label: "WPA", synonyms: [] },
    { value: "WPA2", label: "WPA2", synonyms: ["default"] },
    { value: "WPA/WPA2", label: "WPA and WPA2", synonyms: ["mixed mode"] },
  ],
};

/** Whether the current kind's fields have anything worth building a preview from. */
const hasComposeInput = computed(() => {
  switch (composeKind.value) {
    case "empty":
      return true;
    case "wifi":
      return Boolean(wifiSsid.value.trim() || wifiPassword.value.trim());
    case "vcard":
      return Boolean(
        vcardName.value.trim() ||
          vcardTel.value.trim() ||
          vcardEmail.value.trim() ||
          vcardUrl.value.trim(),
      );
    case "geo":
      return Boolean(geoLat.value.trim() || geoLon.value.trim());
    case "sms":
      return Boolean(smsNumber.value.trim() || smsBody.value.trim());
    default:
      return Boolean(composedValue.value.trim());
  }
});

/** The single string value `buildRecord` and `run` expect for the current kind. */
const composedValue = computed(() => {
  switch (composeKind.value) {
    case "text":
      return textValue.value;
    case "url":
      return urlValue.value;
    case "wifi":
      return `${wifiSsid.value};${wifiPassword.value};${wifiAuth.value}`;
    case "vcard":
      return `${vcardName.value};${vcardTel.value};${vcardEmail.value};${vcardUrl.value}`;
    case "geo":
      return `${geoLat.value},${geoLon.value}`;
    case "tel":
      return telValue.value;
    case "mailto":
      return mailtoValue.value;
    case "sms":
      return smsBody.value.trim() ? `${smsNumber.value};${smsBody.value}` : smsNumber.value;
    case "app":
      return appPackage.value;
    default:
      return "";
  }
});

const composePreview = computed<{ rows: Record<string, string> | null; error: PanelError | null }>(
  () => {
    if (composeKind.value === "raw-hex-decode") {
      if (!hexDecodeInput.value.trim()) return { rows: null, error: null };
      try {
        return { rows: run(hexDecodeInput.value, { kind: "raw-hex-decode" }), error: null };
      } catch (err) {
        return { rows: null, error: toPanelError(err) };
      }
    }
    if (!hasComposeInput.value) return { rows: null, error: null };
    try {
      return { rows: run(composedValue.value, { kind: composeKind.value }), error: null };
    } catch (err) {
      return { rows: null, error: toPanelError(err) };
    }
  },
);

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

interface LogEntry {
  time: string;
  text: string;
}

interface ReadingResult {
  serialNumber: string;
  rows: Record<string, string>;
  hex: string;
  size: string;
  fitsOn: string;
}

const MAX_LOG_ENTRIES = 200;

const scanning = ref(false);
const scanStarting = ref(false);
const scanLog = ref<LogEntry[]>([]);
const scanError = ref<PanelError | null>(null);
const currentReading = ref<ReadingResult | null>(null);

let scanSeq = 0;
let scanController: AbortController | null = null;

function logLine(text: string) {
  scanLog.value.push({ time: new Date().toLocaleTimeString(), text });
  if (scanLog.value.length > MAX_LOG_ENTRIES) {
    scanLog.value.splice(0, scanLog.value.length - MAX_LOG_ENTRIES);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function fitsOnLabel(byteLength: number): string {
  const fitting = Object.keys(TAG_CAPACITIES).filter(
    (tagType) => tagCapacityFit(byteLength, tagType).fits,
  );
  return fitting.length ? fitting.join(", ") : "none of the common tags";
}

function recordBytes(record: NDEFRecordLike): Uint8Array {
  if (!record.data) return new Uint8Array(0);
  return new Uint8Array(record.data.buffer, record.data.byteOffset, record.data.byteLength);
}

/**
 * Turns one Web NFC record, which the browser has already decoded into a
 * semantic recordType, encoding, and language, back into the raw NDEF record
 * shape `encodeMessage`/`decodeMessage` understand. That lets a scanned tag
 * run through the exact same decoder as a hand pasted hex dump, instead of
 * this panel reimplementing any of that interpretation itself.
 */
function webNfcRecordToRaw(record: NDEFRecordLike): NdefRecordObj {
  const bytes = recordBytes(record);
  switch (record.recordType) {
    case "empty":
      return { tnf: 0x00, type: "", payload: new Uint8Array(0) };
    case "text": {
      const lang = record.lang || "en";
      const langBytes = new TextEncoder().encode(lang);
      const isUtf16 = record.encoding === "utf-16";
      const status = (isUtf16 ? 0x80 : 0x00) | (langBytes.length & 0x3f);
      const payload = new Uint8Array(1 + langBytes.length + bytes.length);
      payload[0] = status;
      payload.set(langBytes, 1);
      payload.set(bytes, 1 + langBytes.length);
      return { tnf: 0x01, type: "T", payload };
    }
    case "url": {
      // Prefix code 0 means "no abbreviation": the payload carries the whole
      // URI, which decodes back to the exact same string either way.
      const payload = new Uint8Array(1 + bytes.length);
      payload.set(bytes, 1);
      return { tnf: 0x01, type: "U", payload };
    }
    case "mime":
      return { tnf: 0x02, type: record.mediaType || "application/octet-stream", payload: bytes };
    case "absolute-url":
      return { tnf: 0x03, type: "", payload: bytes };
    case "unknown":
      return { tnf: 0x05, type: "", payload: bytes };
    default:
      // A custom external type, such as an Android Application Record.
      return { tnf: 0x04, type: record.recordType, payload: bytes };
  }
}

function handleReading(runId: number, event: NDEFReadingEventLike) {
  if (runId !== scanSeq) return;
  const raw = event.message.records.map(webNfcRecordToRaw);
  const bytes = encodeMessage(raw);
  const serialNumber = event.serialNumber || "(not available)";
  logLine(
    `Tag read: serial number ${serialNumber}, ${raw.length} record${raw.length === 1 ? "" : "s"}.`,
  );
  try {
    const decoded = decodeMessage(bytes);
    currentReading.value = {
      serialNumber,
      rows: describeRecords(decoded),
      hex: toHex(bytes),
      size: formatByteCount(bytes.length),
      fitsOn: fitsOnLabel(bytes.length),
    };
    scanError.value = null;
  } catch (err) {
    currentReading.value = null;
    const described = toPanelError(err);
    scanError.value = described;
    logLine(`Could not decode the tag's NDEF message: ${described.message}`);
  }
}

async function startScan() {
  if (scanning.value || scanStarting.value) return;
  scanError.value = null;
  const Ctor = nfcReaderCtor();
  if (!Ctor) {
    scanError.value = {
      message: "Web NFC is not available in this browser.",
      fix: "Open this page in Chrome on an Android phone with NFC turned on.",
    };
    return;
  }

  // Set before the await: scan() can sit on the permission prompt for a
  // while, and a second click in that window must not start a second scan.
  scanStarting.value = true;
  const runId = ++scanSeq;
  const controller = new AbortController();
  scanController = controller;
  const readerInstance = new Ctor();
  readerInstance.onreading = (event) => handleReading(runId, event);
  readerInstance.onreadingerror = () => {
    if (runId !== scanSeq) return;
    logLine(
      "A tag was seen but its contents could not be read. Hold it steady against the back of the phone.",
    );
  };

  try {
    await readerInstance.scan({ signal: controller.signal });
  } catch (err) {
    if (runId !== scanSeq) return;
    scanStarting.value = false;
    scanController = null;
    scanError.value = describeNfcError(err);
    return;
  }

  if (runId !== scanSeq) return;
  scanStarting.value = false;
  scanning.value = true;
  logLine("Scanning started. Hold a tag to the back of the phone.");
}

function stopScan() {
  scanSeq++;
  scanController?.abort();
  scanController = null;
  scanning.value = false;
  scanStarting.value = false;
  logLine("Scanning stopped.");
}

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

const WRITE_TIMEOUT_MS = 20000;

const writing = ref(false);
const writeStatus = ref<string | null>(null);
const writeError = ref<PanelError | null>(null);
const makeReadOnlyChecked = ref(false);
const confirmIrreversible = ref(false);

let writeController: AbortController | null = null;

const canWrite = computed(
  () => composeKind.value !== "raw-hex-decode" && composePreview.value.rows !== null,
);

// Unchecking "Make read only" also clears the confirmation, so re-checking it
// later always needs both boxes ticked again rather than finding the second
// step already satisfied from an earlier session.
watch(makeReadOnlyChecked, (checked) => {
  if (!checked) confirmIrreversible.value = false;
});

async function writeToTag() {
  if (writing.value || !canWrite.value) return;

  const Ctor = nfcReaderCtor();
  if (!Ctor) {
    writeError.value = {
      message: "Web NFC is not available in this browser.",
      fix: "Open this page in Chrome on an Android phone with NFC turned on.",
    };
    return;
  }

  let built;
  try {
    built = buildRecord(composeKind.value, composedValue.value.trim());
  } catch (err) {
    writeError.value = toPanelError(err);
    return;
  }

  writeError.value = null;
  writing.value = true;
  writeStatus.value = "Hold the tag to the back of the phone.";

  // The write and the (optional) makeReadOnly step each get their own tag
  // tap, so each gets its own timeout instead of sharing one budget: a slow
  // write should not leave no time left over for making the tag read only,
  // and a timeout there must not be reported as the write itself failing.
  let wroteOk = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const writer = new Ctor();
    const writeAbort = new AbortController();
    writeController = writeAbort;
    timer = setTimeout(() => writeAbort.abort(), WRITE_TIMEOUT_MS);

    await writer.write(toWebNfcMessage([built.record]), {
      overwrite: true,
      signal: writeAbort.signal,
    });
    clearTimeout(timer);
    wroteOk = true;
    writeStatus.value = "Written.";

    if (makeReadOnlyChecked.value && confirmIrreversible.value) {
      writeStatus.value = "Written. Hold the tag to the phone again to make it read only.";
      const readOnlyAbort = new AbortController();
      writeController = readOnlyAbort;
      timer = setTimeout(() => readOnlyAbort.abort(), WRITE_TIMEOUT_MS);

      await writer.makeReadOnly({ signal: readOnlyAbort.signal });
      clearTimeout(timer);
      writeStatus.value = "Written and made read only. This cannot be undone.";
    }
  } catch (err) {
    writeStatus.value = wroteOk ? "Written, but could not make the tag read only." : "Failed.";
    writeError.value = describeNfcError(err);
  } finally {
    clearTimeout(timer);
    writeController = null;
    writing.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onUnmounted(() => {
  scanSeq++;
  scanController?.abort();
  scanController = null;
  writeController?.abort();
  writeController = null;
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Compose -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Compose
      </span>

      <div class="flex flex-col gap-1.5 sm:max-w-xs">
        <Label :for="kindSpec?.id ?? 'nfc-kind'" class="text-xs text-muted-foreground"
          >Record kind</Label
        >
        <SearchableSelect
          v-if="kindSpec"
          :id="kindSpec.id"
          v-model="composeKind"
          :spec="kindSpec"
        />
      </div>

      <div v-if="composeKind === 'text'" class="flex flex-col gap-1.5">
        <Label for="nfc-text" class="text-xs text-muted-foreground">Text</Label>
        <Input id="nfc-text" v-model="textValue" placeholder="Note text" class="h-9" />
      </div>

      <div v-else-if="composeKind === 'url'" class="flex flex-col gap-1.5">
        <Label for="nfc-url" class="text-xs text-muted-foreground">URL</Label>
        <Input id="nfc-url" v-model="urlValue" placeholder="https://example.com" class="h-9" />
      </div>

      <div v-else-if="composeKind === 'wifi'" class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-wifi-ssid" class="text-xs text-muted-foreground">Network name</Label>
          <Input id="nfc-wifi-ssid" v-model="wifiSsid" placeholder="Home network" class="h-9" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-wifi-password" class="text-xs text-muted-foreground">Password</Label>
          <Input id="nfc-wifi-password" v-model="wifiPassword" placeholder="Password" class="h-9" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-wifi-auth" class="text-xs text-muted-foreground">Security</Label>
          <SearchableSelect id="nfc-wifi-auth" v-model="wifiAuth" :spec="wifiAuthSpec" />
        </div>
      </div>

      <div v-else-if="composeKind === 'vcard'" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-vcard-name" class="text-xs text-muted-foreground">Name</Label>
          <Input id="nfc-vcard-name" v-model="vcardName" placeholder="Jane Doe" class="h-9" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-vcard-tel" class="text-xs text-muted-foreground">Phone</Label>
          <Input id="nfc-vcard-tel" v-model="vcardTel" placeholder="+1 555 0100" class="h-9" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-vcard-email" class="text-xs text-muted-foreground">Email</Label>
          <Input
            id="nfc-vcard-email"
            v-model="vcardEmail"
            placeholder="jane@example.com"
            class="h-9"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-vcard-url" class="text-xs text-muted-foreground">Website</Label>
          <Input
            id="nfc-vcard-url"
            v-model="vcardUrl"
            placeholder="https://example.com"
            class="h-9"
          />
        </div>
      </div>

      <div v-else-if="composeKind === 'geo'" class="grid grid-cols-2 gap-3 sm:max-w-xs">
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-geo-lat" class="text-xs text-muted-foreground">Latitude</Label>
          <Input id="nfc-geo-lat" v-model="geoLat" placeholder="37.7749" class="h-9" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-geo-lon" class="text-xs text-muted-foreground">Longitude</Label>
          <Input id="nfc-geo-lon" v-model="geoLon" placeholder="-122.4194" class="h-9" />
        </div>
      </div>

      <div v-else-if="composeKind === 'tel'" class="flex flex-col gap-1.5 sm:max-w-xs">
        <Label for="nfc-tel" class="text-xs text-muted-foreground">Phone number</Label>
        <Input id="nfc-tel" v-model="telValue" placeholder="+1 555 0100" class="h-9" />
      </div>

      <div v-else-if="composeKind === 'mailto'" class="flex flex-col gap-1.5 sm:max-w-xs">
        <Label for="nfc-mailto" class="text-xs text-muted-foreground">Email address</Label>
        <Input id="nfc-mailto" v-model="mailtoValue" placeholder="jane@example.com" class="h-9" />
      </div>

      <div v-else-if="composeKind === 'sms'" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-sms-number" class="text-xs text-muted-foreground">Phone number</Label>
          <Input id="nfc-sms-number" v-model="smsNumber" placeholder="+1 555 0100" class="h-9" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="nfc-sms-body" class="text-xs text-muted-foreground"
            >Message (optional)</Label
          >
          <Input id="nfc-sms-body" v-model="smsBody" placeholder="Message body" class="h-9" />
        </div>
      </div>

      <div v-else-if="composeKind === 'app'" class="flex flex-col gap-1.5 sm:max-w-xs">
        <Label for="nfc-app" class="text-xs text-muted-foreground">Android package name</Label>
        <Input id="nfc-app" v-model="appPackage" placeholder="com.example.app" class="h-9" />
      </div>

      <p v-else-if="composeKind === 'empty'" class="text-xs text-muted-foreground">
        No value needed. An empty record clears a tag's content, which is useful before making a
        tag read only.
      </p>

      <div v-else-if="composeKind === 'raw-hex-decode'" class="flex flex-col gap-1.5">
        <Label for="nfc-hex-decode" class="text-xs text-muted-foreground"
          >NDEF bytes to decode, as hex</Label
        >
        <Textarea
          id="nfc-hex-decode"
          v-model="hexDecodeInput"
          rows="4"
          spellcheck="false"
          autocomplete="off"
          class="font-mono text-sm"
          placeholder="D1 01 08 54 02 65 6E 68 65 6C 6C 6F"
        />
        <p class="text-xs text-muted-foreground">
          Pairs of hex digits. Spaces, commas, and 0x prefixes are all fine.
        </p>
      </div>

      <div
        v-if="composePreview.error"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">{{ composePreview.error.message }}</p>
        <p v-if="composePreview.error.fix" class="mt-1 text-muted-foreground">
          {{ composePreview.error.fix }}
        </p>
      </div>

      <OutputView v-if="composePreview.rows" :output="composePreview.rows" />
      <p v-else-if="!composePreview.error" class="text-xs text-muted-foreground">
        Fill in the fields above to see the record type, its NDEF bytes, and which common tags it
        fits on.
      </p>
    </div>

    <!-- Read -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Read
      </span>

      <div class="flex flex-wrap items-center gap-3">
        <Button v-if="!scanning" :disabled="scanStarting" @click="startScan">
          <Radio class="size-4" aria-hidden="true" />
          {{ scanStarting ? "Waiting for the browser…" : "Scan for tags" }}
        </Button>
        <Button v-else variant="secondary" @click="stopScan">
          <Square class="size-4" aria-hidden="true" />
          Stop scanning
        </Button>
        <span v-if="scanning" class="text-sm text-muted-foreground"
          >Hold a tag to the back of the phone.</span
        >
      </div>

      <div
        v-if="scanError"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">{{ scanError.message }}</p>
        <p v-if="scanError.fix" class="mt-1 text-muted-foreground">{{ scanError.fix }}</p>
      </div>

      <div v-if="currentReading" class="flex flex-col gap-3">
        <p class="text-sm">
          Serial number
          <span class="font-mono">{{ currentReading.serialNumber }}</span>
        </p>
        <OutputView :output="currentReading.rows" />
        <p class="text-xs text-muted-foreground">
          Size: {{ currentReading.size }}. Fits on: {{ currentReading.fitsOn }}.
        </p>
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted-foreground">Raw NDEF bytes (hex)</span>
            <CopyButton :text="currentReading.hex" label="Copy" />
          </div>
          <p
            class="rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs break-all shadow-[var(--sh-inset)]"
          >
            {{ currentReading.hex }}
          </p>
        </div>
      </div>

      <div
        v-if="scanLog.length"
        class="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]"
      >
        <div v-for="(entry, i) in scanLog" :key="i" class="font-mono text-xs text-muted-foreground">
          {{ entry.time }} {{ entry.text }}
        </div>
      </div>

      <p v-if="!scanning && !currentReading && !scanLog.length" class="text-xs text-muted-foreground">
        Click Scan for tags, then hold an NFC tag to the back of the phone. Each reading is
        decoded with the same rules as the Compose and Decode sections above.
      </p>
    </div>

    <!-- Write -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Write
      </span>

      <p class="text-xs text-muted-foreground">
        Writes the record composed above to a tag. Hold the tag to the back of the phone when
        prompted.
      </p>
      <p v-if="composeKind === 'raw-hex-decode'" class="text-xs text-muted-foreground">
        Decode hex bytes is read only. Pick a different record kind above to compose something to
        write.
      </p>

      <div class="flex flex-wrap items-center gap-3">
        <Button :disabled="writing || !canWrite" @click="writeToTag">
          <Send class="size-4" aria-hidden="true" />
          {{ writing ? "Waiting for the tag…" : "Write to tag" }}
        </Button>
        <span v-if="writeStatus" class="text-sm text-muted-foreground">{{ writeStatus }}</span>
      </div>

      <div class="flex flex-col gap-2 rounded-[10px] border border-destructive/50 bg-destructive/5 p-3">
        <div class="flex items-center gap-2">
          <Checkbox id="nfc-readonly" v-model="makeReadOnlyChecked" :disabled="writing" />
          <Label for="nfc-readonly" class="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <Lock class="size-3.5" aria-hidden="true" />
            Make read only after writing
          </Label>
        </div>
        <p class="text-xs text-muted-foreground">
          Making a tag read only is permanent. Once set, no device, including this one, can ever
          write to that tag again.
        </p>
        <div v-if="makeReadOnlyChecked" class="flex items-center gap-2">
          <Checkbox id="nfc-readonly-confirm" v-model="confirmIrreversible" :disabled="writing" />
          <Label for="nfc-readonly-confirm" class="text-sm">
            I understand this cannot be undone
          </Label>
        </div>
      </div>

      <div
        v-if="writeError"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">{{ writeError.message }}</p>
        <p v-if="writeError.fix" class="mt-1 text-muted-foreground">{{ writeError.fix }}</p>
      </div>
    </div>
  </div>
</template>
