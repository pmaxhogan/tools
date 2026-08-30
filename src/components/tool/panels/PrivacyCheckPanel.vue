<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import { PROBES, run } from "@/tools/browser-privacy-check/index";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2, ShieldCheck, TriangleAlert, X } from "lucide-vue-next";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import OutputView from "../OutputView.vue";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for Browser Privacy Check: the pure layer only knows how to
 * describe a probe report, so this panel owns every probe collector. Nothing
 * runs until the button is pressed (an explicit trigger, not onMounted),
 * every collector is individually try/caught so one blocked or unsupported
 * API never breaks the rest, and every navigator/window/canvas/RTCPeerConnection
 * read happens inside that click handler, never at setup time, so the
 * server-rendered shell never touches a browser API.
 */
defineProps<{ meta: ToolMeta }>();

/**
 * A handful of navigator and window members are missing from the standard DOM
 * lib (Client Hints, deviceMemory, Global Privacy Control, the Battery API,
 * and the two legacy doNotTrack spellings). Declared narrowly here, following
 * DisplayInfoPanel and GpuInspectorPanel's pattern for browser APIs
 * TypeScript does not know about yet.
 */
interface NavigatorUAData {
  brands?: { brand: string; version: string }[];
  platform?: string;
  mobile?: boolean;
}
interface NavigatorPrivacyExtras extends Navigator {
  userAgentData?: NavigatorUAData;
  deviceMemory?: number;
  globalPrivacyControl?: boolean;
  getBattery?: () => Promise<unknown>;
  msDoNotTrack?: string;
}
interface WindowWithDNT extends Window {
  doNotTrack?: string;
}
interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

type ProbeStatus = "pending" | "running" | "collected" | "skipped";
type Collector = () => unknown | Promise<unknown>;

/* ------------------------------------------------------------------ *
 * small standalone helpers, only ever called from inside a collector
 * ------------------------------------------------------------------ */

/** A minimal inline FNV-1a, run twice with a perturbed second pass so the
 * combined digest is 16 hex characters instead of 8. Good enough to spot a
 * changed canvas render without pulling in a hashing library. */
function fnv1aHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + 1;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

function collectCanvasHash(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 60;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.textBaseline = "top";
  ctx.font = "16px Arial";
  ctx.fillStyle = "#f60";
  ctx.fillRect(0, 0, 80, 20);
  ctx.fillStyle = "#069";
  ctx.fillText("Browser fingerprint, hello", 2, 15);
  ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
  ctx.fillText("Browser fingerprint, hello", 4, 17);
  ctx.strokeStyle = "rgba(120, 40, 200, 0.8)";
  ctx.beginPath();
  ctx.arc(60, 40, 15, 0, Math.PI * 2);
  ctx.stroke();
  return fnv1aHash(canvas.toDataURL());
}

function collectWebglRenderer(): { vendor?: string; renderer?: string } {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl");
  if (!gl) throw new Error("WebGL unavailable");
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  if (!ext) throw new Error("WEBGL_debug_renderer_info blocked");
  const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string;
  const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
  return { vendor, renderer };
}

async function collectAudioSampleRate(): Promise<number> {
  const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext unavailable");
  const ctx = new Ctor();
  const rate = ctx.sampleRate;
  await ctx.close();
  return rate;
}

/** Reference list of common font names, checked with a canvas measureText
 * width delta against three generic baseline families: a font is "detected"
 * when it renders a different width than the baseline in at least one of
 * them. Thirty names, the standard technique behind most font probes. */
const FONT_CANDIDATES = [
  "Arial",
  "Arial Black",
  "Arial Narrow",
  "Book Antiqua",
  "Bookman Old Style",
  "Calibri",
  "Cambria",
  "Cambria Math",
  "Century",
  "Century Gothic",
  "Comic Sans MS",
  "Consolas",
  "Courier",
  "Courier New",
  "Georgia",
  "Helvetica",
  "Impact",
  "Lucida Console",
  "Lucida Sans Unicode",
  "Microsoft Sans Serif",
  "Palatino Linotype",
  "Segoe Print",
  "Segoe Script",
  "Segoe UI",
  "Segoe UI Light",
  "Tahoma",
  "Times",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
  "Wingdings",
];

function detectFontsCount(): number {
  const baseFonts = ["monospace", "serif", "sans-serif"];
  const testString = "mmmmmmmmmmlli";
  const testSize = "72px";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  const baseWidths: Record<string, number> = {};
  for (const base of baseFonts) {
    ctx.font = `${testSize} ${base}`;
    baseWidths[base] = ctx.measureText(testString).width;
  }

  let detected = 0;
  for (const font of FONT_CANDIDATES) {
    const isDetected = baseFonts.some((base) => {
      ctx.font = `${testSize} "${font}", ${base}`;
      return ctx.measureText(testString).width !== baseWidths[base];
    });
    if (isDetected) detected += 1;
  }
  return detected;
}

async function collectStorageEstimate(): Promise<{ usage?: number; quota?: number }> {
  if (!navigator.storage?.estimate) throw new Error("Storage estimate unavailable");
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage, quota: estimate.quota };
}

/** RFC 1918 private ranges plus link local; an address ending in ".local"
 * is mDNS obfuscation, handled by the caller, not a leak by itself. */
function isPrivateIPv4(ip: string): boolean {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

function extractAddressFromCandidateString(candidate: string): string | null {
  const match = candidate.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  return match ? match[1]! : null;
}

const WEBRTC_GATHER_TIMEOUT_MS = 2000;

/** Opens an RTCPeerConnection with no STUN server at all (iceServers: []),
 * so gathering ICE candidates makes no network request: only the OS network
 * stack is asked for local interface addresses. Any host candidate whose
 * address is a private IPv4 (and not mDNS-obfuscated) counts as a leak. */
function collectWebrtcLeak(): Promise<boolean> {
  if (typeof RTCPeerConnection === "undefined") {
    return Promise.reject(new Error("RTCPeerConnection unavailable"));
  }
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let leak = false;
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error("RTCPeerConnection failed"));
      return;
    }
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        // already closed, nothing to do
      }
      resolve(leak);
    };
    const timer = setTimeout(finish, WEBRTC_GATHER_TIMEOUT_MS);
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        finish();
        return;
      }
      const address =
        event.candidate.address ?? extractAddressFromCandidateString(event.candidate.candidate);
      if (address && !address.endsWith(".local") && isPrivateIPv4(address)) {
        leak = true;
      }
    };
    try {
      pc.createDataChannel("privacy-probe");
    } catch {
      // some browsers still gather host candidates without a data channel
    }
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => finish());
  });
}

async function queryPermissionState(name: "notifications" | "geolocation"): Promise<string> {
  if (!navigator.permissions?.query) throw new Error("Permissions API unavailable");
  const status = await navigator.permissions.query({ name });
  return status.state;
}

/* ------------------------------------------------------------------ *
 * one collector per PROBES id; every value is read fresh on each run
 * ------------------------------------------------------------------ */

const collectors: Record<string, Collector> = {
  userAgent: () => navigator.userAgent,
  uaData: () => {
    const data = (navigator as NavigatorPrivacyExtras).userAgentData;
    if (!data) throw new Error("Client Hints unavailable");
    return { brands: data.brands, platform: data.platform, mobile: data.mobile };
  },
  language: () => ({ language: navigator.language, languages: [...navigator.languages] }),
  timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  screen: () => ({
    width: window.screen.width,
    height: window.screen.height,
    colorDepth: window.screen.colorDepth,
    pixelRatio: window.devicePixelRatio,
  }),
  hardwareConcurrency: () => navigator.hardwareConcurrency,
  deviceMemory: () => {
    const value = (navigator as NavigatorPrivacyExtras).deviceMemory;
    if (value == null) throw new Error("Device memory unavailable");
    return value;
  },
  maxTouchPoints: () => navigator.maxTouchPoints,
  cookieEnabled: () => navigator.cookieEnabled,
  doNotTrack: () => {
    const nav = navigator as NavigatorPrivacyExtras;
    const win = window as WindowWithDNT;
    return navigator.doNotTrack ?? win.doNotTrack ?? nav.msDoNotTrack ?? null;
  },
  globalPrivacyControl: () => {
    const nav = navigator as NavigatorPrivacyExtras;
    if (!("globalPrivacyControl" in nav)) throw new Error("Global Privacy Control unavailable");
    return nav.globalPrivacyControl ?? false;
  },
  storageEstimate: () => collectStorageEstimate(),
  webdriver: () => navigator.webdriver,
  plugins: () => ({ plugins: navigator.plugins.length, mimeTypes: navigator.mimeTypes.length }),
  canvasHash: () => collectCanvasHash(),
  webglRenderer: () => collectWebglRenderer(),
  audioSampleRate: () => collectAudioSampleRate(),
  fontsCount: () => detectFontsCount(),
  batteryApi: () => typeof (navigator as NavigatorPrivacyExtras).getBattery === "function",
  webrtcLeak: () => collectWebrtcLeak(),
  permissionNotifications: () => queryPermissionState("notifications"),
  permissionGeolocation: () => queryPermissionState("geolocation"),
  prefersColorScheme: () => {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    return "no-preference";
  },
  prefersReducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

/* ------------------------------------------------------------------ *
 * run state
 * ------------------------------------------------------------------ */

const running = ref(false);
const hasRun = ref(false);
const errorMessage = ref<string | null>(null);
const report = ref<Record<string, unknown>>({});
const output = ref<Record<string, string> | null>(null);
const probeStatus = ref<Record<string, ProbeStatus>>(
  Object.fromEntries(PROBES.map((p) => [p.id, "pending" as ProbeStatus])),
);

function setStatus(id: string, status: ProbeStatus) {
  probeStatus.value = { ...probeStatus.value, [id]: status };
}

async function runCheck() {
  running.value = true;
  hasRun.value = true;
  errorMessage.value = null;

  const nextStatus: Record<string, ProbeStatus> = {};
  for (const probe of PROBES) nextStatus[probe.id] = "pending";
  probeStatus.value = nextStatus;

  const nextReport: Record<string, unknown> = {};

  for (const probe of PROBES) {
    setStatus(probe.id, "running");
    const collect = collectors[probe.id];
    if (!collect) {
      setStatus(probe.id, "skipped");
      continue;
    }
    try {
      const value = await collect();
      if (value === undefined) {
        setStatus(probe.id, "skipped");
      } else {
        nextReport[probe.id] = value;
        setStatus(probe.id, "collected");
      }
    } catch {
      setStatus(probe.id, "skipped");
    }
  }

  report.value = nextReport;

  try {
    output.value = run(JSON.stringify(nextReport), {});
  } catch (err) {
    output.value = null;
    errorMessage.value =
      err instanceof Error ? err.message : "Could not analyze the collected probe report.";
  }

  running.value = false;
}

const rawJson = computed(() => JSON.stringify(report.value, null, 2));

/* ------------------------------------------------------------------ *
 * group the flat run() output by its category prefix (split on ": ")
 * ------------------------------------------------------------------ */

interface OutputGroup {
  title: string;
  rows: Record<string, string>;
}

const groupedOutput = computed<OutputGroup[]>(() => {
  const out = output.value;
  if (!out) return [];
  const order: string[] = [];
  const byTitle = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(out)) {
    const idx = key.indexOf(": ");
    const title = idx >= 0 ? key.slice(0, idx) : key;
    const label = idx >= 0 ? key.slice(idx + 2) : key;
    if (!byTitle.has(title)) {
      byTitle.set(title, {});
      order.push(title);
    }
    byTitle.get(title)![label] = value;
  }
  return order.map((title) => ({ title, rows: byTitle.get(title)! }));
});

const surfaceGroup = computed(
  () => groupedOutput.value.find((g) => g.title === "Fingerprint surface") ?? null,
);
const flagEntries = computed(() => {
  const group = groupedOutput.value.find((g) => g.title === "Flag");
  return group ? Object.entries(group.rows) : [];
});
const categoryGroups = computed(() =>
  groupedOutput.value.filter((g) => g.title !== "Fingerprint surface" && g.title !== "Flag"),
);

type Severity = "low" | "moderate" | "high";

const surfaceSeverity = computed<Severity | null>(() => {
  const assessment = surfaceGroup.value?.rows["assessment"];
  if (!assessment) return null;
  if (assessment.startsWith("Low")) return "low";
  if (assessment.startsWith("Moderate")) return "moderate";
  if (assessment.startsWith("High")) return "high";
  return null;
});

const SEVERITY_LABEL: Record<Severity, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

const SURFACE_CONTAINER_CLASS: Record<Severity, string> = {
  low: "border-[var(--positive)]/30 bg-[var(--positive-soft)]/40",
  moderate: "border-[var(--brand-hairline)] bg-[var(--accent-soft)]/50",
  high: "border-destructive/30 bg-destructive/5",
};

const SURFACE_BADGE_CLASS: Record<Severity, string> = {
  low: "bg-[var(--positive-soft)] text-[var(--positive)]",
  moderate: "bg-[var(--accent-soft)] text-primary",
  high: "bg-destructive/10 text-destructive dark:bg-destructive/20",
};

/** Automation detection and the WebRTC leak are the two flags this tool can
 * raise that reflect an actual exposure; the privacy-signal-irony flag is
 * informational, not a leak, so it renders a step softer. */
const FLAG_SEVERITY: Record<string, Severity> = {
  "automation detected": "high",
  "WebRTC IP leak": "high",
  "privacy signal irony": "moderate",
};

function flagSeverity(label: string): Severity {
  return FLAG_SEVERITY[label] ?? "moderate";
}

const FLAG_CONTAINER_CLASS: Record<Severity, string> = {
  low: "border-[var(--positive)]/30 bg-[var(--positive-soft)]/40",
  moderate: "border-[var(--brand-hairline)] bg-[var(--accent-soft)]/50",
  high: "border-destructive/30 bg-destructive/5",
};

const FLAG_ICON_CLASS: Record<Severity, string> = {
  low: "text-[var(--positive)]",
  moderate: "text-primary",
  high: "text-destructive",
};

const buttonLabel = computed(() => {
  if (running.value) return "Running privacy check...";
  return hasRun.value ? "Run again" : "Run privacy check";
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground">
        Nothing runs until you press the button. Every probe below is collected and analyzed on this
        device: your files and inputs never leave your device.
      </p>

      <Button :disabled="running" @click="runCheck">
        <Loader2 v-if="running" class="size-3.5 animate-spin" aria-hidden="true" />
        <ShieldCheck v-else class="size-3.5" aria-hidden="true" />
        {{ buttonLabel }}
      </Button>
    </div>

    <div
      v-if="running"
      class="grid grid-cols-1 gap-x-4 gap-y-1 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)] sm:grid-cols-2"
      aria-live="polite"
    >
      <div
        v-for="probe in PROBES"
        :key="probe.id"
        class="flex items-center justify-between gap-3 py-0.5 text-xs"
      >
        <span class="text-muted-foreground">{{ probe.label }}</span>
        <Loader2
          v-if="probeStatus[probe.id] === 'running'"
          class="size-3 shrink-0 animate-spin text-primary"
          aria-hidden="true"
        />
        <Check
          v-else-if="probeStatus[probe.id] === 'collected'"
          class="size-3 shrink-0 text-[var(--positive)]"
          aria-hidden="true"
        />
        <X
          v-else-if="probeStatus[probe.id] === 'skipped'"
          class="size-3 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span
          v-else
          class="size-2.5 shrink-0 rounded-full border border-input"
          aria-hidden="true"
        />
      </div>
    </div>

    <EmptyState
      v-if="!hasRun && !running"
      title="Nothing has run yet"
      hint='Press "Run privacy check" to collect every probe below from this browser and see what it reveals.'
      icon="ShieldCheck"
    />

    <ErrorBanner v-if="errorMessage" :message="errorMessage" />

    <template v-if="hasRun && !running && output">
      <div
        v-if="surfaceGroup && surfaceSeverity"
        class="flex flex-col gap-3 rounded-[14px] border p-4 shadow-[var(--sh-sm)]"
        :class="SURFACE_CONTAINER_CLASS[surfaceSeverity]"
      >
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >Fingerprint surface</span
          >
          <Badge variant="outline" :class="SURFACE_BADGE_CLASS[surfaceSeverity]">
            {{ SEVERITY_LABEL[surfaceSeverity] }}
          </Badge>
        </div>
        <OutputView :output="surfaceGroup.rows" />
      </div>

      <div
        v-for="[label, value] in flagEntries"
        :key="label"
        role="alert"
        class="flex flex-col gap-1 rounded-[14px] border p-4 shadow-[var(--sh-sm)]"
        :class="FLAG_CONTAINER_CLASS[flagSeverity(label)]"
      >
        <span class="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <TriangleAlert
            class="size-4 shrink-0"
            :class="FLAG_ICON_CLASS[flagSeverity(label)]"
            aria-hidden="true"
          />
          {{ label }}
        </span>
        <span class="text-xs text-muted-foreground">{{ value }}</span>
      </div>

      <div v-for="group in categoryGroups" :key="group.title" class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">{{
          group.title
        }}</span>
        <OutputView :output="group.rows" />
      </div>

      <p class="text-xs text-muted-foreground">
        The WebRTC probe opens a connection with no STUN server, so gathering candidates makes no
        network request of its own. Every probe result stays in this page; nothing is sent anywhere.
      </p>

      <details class="rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
        <summary class="cursor-pointer text-sm font-medium">Raw probe data</summary>
        <div class="mt-3 flex flex-col gap-2">
          <div class="flex justify-end">
            <CopyButton :text="rawJson" label="Copy JSON" />
          </div>
          <pre
            class="max-h-96 overflow-auto rounded-[10px] bg-card px-3 py-3 font-mono text-xs whitespace-pre-wrap shadow-[var(--sh-inset)]"
            >{{ rawJson }}</pre>
        </div>
      </details>
    </template>
  </div>
</template>
