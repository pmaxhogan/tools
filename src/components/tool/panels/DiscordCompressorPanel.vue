<script setup lang="ts">
/**
 * Bespoke panel for the Discord Compressor.
 *
 * Every other media tool is one ffmpeg command, which is exactly what
 * `MediaShell` runs. This one is two: a hard size target needs two pass rate
 * control, so pass 1 writes ffmpeg2pass-0.log and pass 2 reads it. MediaShell
 * calls its `buildArgs` once and runs one job, with no way to sequence a second
 * one behind it, so this panel drives `runJob` directly and mirrors the shell's
 * chrome instead: the same drop zone, the same opt in engine download, the same
 * progress, log tail, error box, and output card.
 *
 * The two jobs are safe to chain because `runJob` only deletes the files it was
 * told about, so the pass log survives from one call to the next. The input is
 * handed to both jobs because the first job cleans it up on the way out.
 *
 * All the arithmetic lives in the logic layer. This file reads a duration,
 * renders a plan, runs two commands, and checks the result against the cap.
 * Nothing touches the DOM until the component is mounted in a browser.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { Check, X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  MediaJobError,
  getFFmpeg,
  isEngineReady,
  isMediaSupported,
  runJob,
  terminateEngine,
} from "@/lib/ffmpeg";
import { formatBytes } from "@/lib/format";
import { downloadUrl } from "@/lib/download";
import { useStickToBottom } from "@/lib/stick-to-bottom";
import {
  MAX_CAP_MB,
  OVERHEAD_FLOOR_BYTES,
  OVERHEAD_FRACTION,
  buildPassArgs,
  formatClock,
  formatMegabytes,
  megabytesToBytes,
  normalizeDuration,
  outputNameFor,
  planCompression,
  resolveCapMB,
  resolveFps,
  resolveMaxHeight,
  type CompressionPlan,
} from "@/tools/discord-video-compressor/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

/** False until mounted, which keeps every capability check off the server. */
const supported = ref(false);

const file = shallowRef<File | null>(null);
const safeName = ref("");
const fileInput = ref<HTMLInputElement>();
const dragging = ref(false);

const probing = ref(false);
const durationSec = ref<number | null>(null);
const sourceWidth = ref(0);
const sourceHeight = ref(0);

const cap = ref("10");
const customMB = ref("");
const maxHeight = ref("0");
const keepFps = ref(true);
const keepAudio = ref(true);

const capSpec: SelectOptionSpec = {
  kind: "select",
  id: "dc-cap",
  label: "Size cap",
  default: "10",
  options: [
    { value: "10", label: "10 MB (free tier)", synonyms: ["free", "default", "no nitro"] },
    { value: "50", label: "50 MB (Nitro Basic)", synonyms: ["nitro basic", "basic"] },
    { value: "500", label: "500 MB (Nitro)", synonyms: ["nitro", "full nitro"] },
  ],
};

const heightSpec: SelectOptionSpec = {
  kind: "select",
  id: "dc-height",
  label: "Resolution",
  default: "0",
  options: [
    {
      value: "0",
      label: "Keep the source height",
      synonyms: ["original", "no change", "native", "source resolution", "full"],
    },
    { value: "1080", label: "Cap at 1080p", synonyms: ["full hd", "fhd", "1920x1080"] },
    { value: "720", label: "Cap at 720p", synonyms: ["hd", "1280x720"] },
    { value: "480", label: "Cap at 480p", synonyms: ["sd", "standard definition", "854x480"] },
  ],
};

type EngineState = "idle" | "loading" | "ready";
const engineState = ref<EngineState>("idle");
const engineDownloaded = ref(false);
const downloadedBytes = ref(0);
const downloadTotal = ref(0);

const running = ref(false);
const cancelling = ref(false);
/** 0 when idle, otherwise which of the two passes is on screen. */
const activePass = ref<0 | 1 | 2>(0);
const jobRatio = ref<number | null>(null);
const jobTimeMs = ref<number | null>(null);
const logLines = ref<string[]>([]);
const showLog = ref(false);

// The log tail stays pinned to the newest line unless the reader scrolls up.
const { el: logEl, onScroll: onLogScroll } = useStickToBottom(() => logLines.value.length);

interface Result {
  name: string;
  size: number;
  url: string;
  /** The cap this file was actually encoded for, so changing the option later
   *  never re-labels a finished result against a target it never had. */
  capBytes: number;
}
const result = shallowRef<Result | null>(null);

const error = ref<{ message: string; fix?: string; log: string[] } | null>(null);

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const downloadLabel = computed(() => {
  if (!downloadTotal.value) return "Downloading media engine";
  return `Downloading media engine (${megabytes(downloadedBytes.value)} of ${megabytes(downloadTotal.value)} MB)`;
});

const downloadPercent = computed(() =>
  downloadTotal.value ? Math.min(100, (downloadedBytes.value / downloadTotal.value) * 100) : 0,
);

const engineButtonLabel = computed(() =>
  engineDownloaded.value ? "Restart media engine" : "Load media engine",
);

/* ---------------------------------------------------------------- */
/* the plan                                                          */
/* ---------------------------------------------------------------- */

interface CapState {
  mb: number | null;
  issue: { message: string; fix?: string } | null;
}

/** The cap is resolved through the logic layer so the panel and the text
 *  interface agree about what a custom entry means. */
const capState = computed<CapState>(() => {
  try {
    return { mb: resolveCapMB({ cap: cap.value, customMB: customMB.value }), issue: null };
  } catch (e) {
    return {
      mb: null,
      issue:
        e instanceof ToolError
          ? { message: e.message, fix: e.fix }
          : { message: e instanceof Error ? e.message : String(e) },
    };
  }
});

const targetBytes = computed(() =>
  capState.value.mb === null ? 0 : megabytesToBytes(capState.value.mb),
);

const plan = computed<CompressionPlan | null>(() => {
  if (!file.value || durationSec.value === null || capState.value.mb === null) return null;
  return planCompression({
    targetBytes: targetBytes.value,
    durationSec: durationSec.value,
    hasAudio: keepAudio.value,
  });
});

/**
 * The same usable budget `planCompression` divides between the streams: the
 * cap minus the container overhead it has to reserve. A source already at or
 * under that budget does not need a re-encode to clear the cap, so the plan
 * card says so and the primary action turns into an opt in "anyway" rather
 * than silently spending two passes on a file that already fits.
 */
const usableBytes = computed(() => {
  if (capState.value.mb === null) return null;
  const bytes = targetBytes.value * (1 - OVERHEAD_FRACTION) - OVERHEAD_FLOOR_BYTES;
  return bytes > 0 ? bytes : null;
});

const alreadyUnderCap = computed(
  () => file.value !== null && usableBytes.value !== null && file.value.size <= usableBytes.value,
);

const compressButtonLabel = computed(() =>
  alreadyUnderCap.value ? "Compress anyway" : "Compress",
);

const heightCap = computed(() => resolveMaxHeight({ maxHeight: maxHeight.value }));
const fpsCap = computed(() => resolveFps({ keepFps: keepFps.value }));

const outputName = computed(() =>
  outputNameFor(file.value?.name ?? "video.mp4", capState.value.mb ?? 10),
);

const canRun = computed(
  () =>
    supported.value &&
    file.value !== null &&
    plan.value !== null &&
    plan.value.feasible &&
    !running.value &&
    !cancelling.value,
);

/** Pass 1 is the cheaper half, so it takes the smaller share of the bar. */
const overallPercent = computed(() => {
  if (!running.value || jobRatio.value === null) return null;
  const share = activePass.value === 1 ? jobRatio.value * 0.4 : 0.4 + jobRatio.value * 0.6;
  return Math.round(Math.min(1, Math.max(0, share)) * 100);
});

const verdict = computed(() => {
  const out = result.value;
  if (!out) return null;
  const headroom = out.capBytes - out.size;
  if (headroom >= 0) {
    return {
      fits: true,
      text: `${formatMegabytes(headroom)} under the ${formatMegabytes(out.capBytes)} cap.`,
    };
  }
  return {
    fits: false,
    text: `${formatMegabytes(-headroom)} over the ${formatMegabytes(out.capBytes)} cap. Complex footage can overshoot its target bitrate. Set a custom cap a few MB lower, or cap the resolution, and run it again.`,
  };
});

/* ---------------------------------------------------------------- */
/* files                                                             */
/* ---------------------------------------------------------------- */

/**
 * ffmpeg picks a demuxer from the extension, so the extension is preserved
 * while everything else collapses to a safe ASCII name.
 */
function safeNameFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const stem =
    (dot > 0 ? name.slice(0, dot) : name)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "input";
  return ext ? `${stem}.${ext.replace(/[^A-Za-z0-9]/g, "")}` : stem;
}

/**
 * Reads the length of the clip from a video element rather than from ffmpeg, so
 * the plan appears immediately and the 31 MB engine is only fetched when the
 * visitor actually asks for an encode.
 */
function probe(picked: File) {
  probing.value = true;
  durationSec.value = null;
  sourceWidth.value = 0;
  sourceHeight.value = 0;

  const url = URL.createObjectURL(picked);
  const el = document.createElement("video");
  el.preload = "metadata";
  el.muted = true;

  const finish = () => {
    URL.revokeObjectURL(url);
    probing.value = false;
  };

  el.onloadedmetadata = () => {
    durationSec.value = normalizeDuration(el.duration);
    sourceWidth.value = el.videoWidth;
    sourceHeight.value = el.videoHeight;

    // Best effort only: no browser exposes audio tracks the same way, and none
    // of them promise an answer before playback. A file that definitely has no
    // audio turns the toggle off; anything unknown keeps the budget reserved.
    const probed = el as HTMLVideoElement & {
      mozHasAudio?: boolean;
      audioTracks?: { length: number };
    };
    if (probed.mozHasAudio === false || probed.audioTracks?.length === 0) {
      keepAudio.value = false;
    }

    if (durationSec.value === null) {
      error.value = {
        message: "This browser could not read the length of that video.",
        fix: "Some streamed WebM files carry no duration. Remux it to MP4 first, or use a different copy of the clip.",
        log: [],
      };
    }
    finish();
  };

  el.onerror = () => {
    error.value = {
      message: "This browser cannot read that file as a video.",
      fix: "Pick an MP4, MOV, WebM, or MKV file. The encoder still handles formats the preview cannot.",
      log: [],
    };
    finish();
  };

  el.src = url;
}

function setFile(picked: File) {
  clearResult();
  error.value = null;
  logLines.value = [];
  file.value = picked;
  safeName.value = safeNameFor(picked.name);
  keepAudio.value = true;
  probe(picked);
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const picked = e.dataTransfer?.files[0];
  if (picked) setFile(picked);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const picked = picker.files?.[0];
  if (picked) setFile(picked);
  // Reset so picking the same file again still fires a change event.
  picker.value = "";
}

function clearFile() {
  clearResult();
  file.value = null;
  safeName.value = "";
  durationSec.value = null;
  sourceWidth.value = 0;
  sourceHeight.value = 0;
  error.value = null;
  logLines.value = [];
}

/* ---------------------------------------------------------------- */
/* engine                                                            */
/* ---------------------------------------------------------------- */

function onDownload(loaded: number, total: number) {
  downloadedBytes.value = loaded;
  downloadTotal.value = total;
  if (loaded >= total && total > 0) engineDownloaded.value = true;
}

async function loadEngine() {
  if (engineState.value === "loading") return;
  engineState.value = "loading";
  error.value = null;
  try {
    await getFFmpeg(undefined, onDownload);
    engineState.value = "ready";
    engineDownloaded.value = true;
  } catch (e) {
    engineState.value = "idle";
    setError(e);
  }
}

/* ---------------------------------------------------------------- */
/* run                                                               */
/* ---------------------------------------------------------------- */

function setError(e: unknown) {
  if (e instanceof MediaJobError) {
    error.value = { message: e.message, fix: e.fix, log: e.log };
  } else if (e instanceof ToolError) {
    error.value = { message: e.message, fix: e.fix, log: [] };
  } else {
    error.value = { message: e instanceof Error ? e.message : String(e), log: [] };
  }
}

function clearResult() {
  if (result.value) URL.revokeObjectURL(result.value.url);
  result.value = null;
}

function onProgress(p: { ratio: number | null; timeMs: number | null; logLine: string }) {
  jobRatio.value = p.ratio;
  jobTimeMs.value = p.timeMs;
  if (p.logLine) logLines.value.push(p.logLine);
}

/**
 * x264 leaves its statistics behind after pass 2. They are only valid for the
 * settings that produced them, so they are cleared rather than left to be read
 * by whatever runs next in this tab.
 */
async function clearPassLog() {
  if (!isEngineReady()) return;
  try {
    const ffmpeg = await getFFmpeg();
    for (const name of ["ffmpeg2pass-0.log", "ffmpeg2pass-0.log.mbtree"]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        // The file is only written by some x264 configurations.
      }
    }
  } catch {
    // A missing engine means there is nothing left to clean up.
  }
}

async function compress() {
  const source = file.value;
  const current = plan.value;
  if (!canRun.value || !source || !current) return;

  running.value = true;
  cancelling.value = false;
  error.value = null;
  jobRatio.value = null;
  jobTimeMs.value = null;
  logLines.value = [];
  clearResult();

  const passOpts = {
    inputName: safeName.value,
    videoKbps: current.videoKbps,
    audioKbps: current.audioKbps,
    maxHeight: heightCap.value,
    fps: fpsCap.value,
    outputName: outputName.value,
  };

  try {
    if (!isEngineReady()) engineState.value = "loading";

    // Both jobs get the same bytes: runJob copies them in and deletes the file
    // it wrote once the job is done, so pass 2 needs its own copy of the input.
    const data = new Uint8Array(await source.arrayBuffer());
    const inputs = [{ name: safeName.value, data }];

    activePass.value = 1;
    await runJob({
      inputs,
      args: buildPassArgs(1, passOpts),
      outputs: [],
      onDownload,
      onProgress,
    });

    if (cancelling.value) return;

    activePass.value = 2;
    jobRatio.value = null;
    const produced = await runJob({
      inputs,
      args: buildPassArgs(2, passOpts),
      outputs: [passOpts.outputName],
      onDownload,
      onProgress,
    });

    engineState.value = "ready";
    engineDownloaded.value = true;

    const out = produced[0]!;
    result.value = {
      name: out.name,
      size: out.data.byteLength,
      capBytes: targetBytes.value,
      url: URL.createObjectURL(
        new Blob([out.data.slice().buffer as ArrayBuffer], { type: "video/mp4" }),
      ),
    };
    await clearPassLog();
  } catch (e) {
    if (cancelling.value) {
      error.value = null;
    } else {
      engineState.value = isEngineReady() ? "ready" : "idle";
      setError(e);
      if (logLines.value.length) showLog.value = true;
    }
  } finally {
    running.value = false;
    activePass.value = 0;
    jobRatio.value = null;
  }
}

/**
 * Killing the worker is the only way to stop ffmpeg mid run. The engine is
 * restarted straight away so the panel returns to a usable state, and the wasm
 * comes back from the browser cache rather than from the network.
 */
async function cancel() {
  if (!running.value) return;
  cancelling.value = true;
  terminateEngine();
  engineState.value = "idle";
  await loadEngine();
  cancelling.value = false;
}

function download() {
  const out = result.value;
  if (!out) return;
  // out.url is an object URL owned by `result`, revoked in clearResult/unmount.
  downloadUrl(out.url, out.name);
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  supported.value = isMediaSupported();
  if (isEngineReady()) {
    engineState.value = "ready";
    engineDownloaded.value = true;
  }
});

onUnmounted(clearResult);
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Capability gate -->
    <div
      v-if="!supported"
      role="status"
      class="rounded-lg border bg-secondary/60 px-3 py-2 text-sm"
    >
      <p class="font-medium text-muted-foreground">Starting the media engine.</p>
      <p class="mt-1 text-muted-foreground">
        {{ meta.name }} runs ffmpeg inside this tab, which needs WebAssembly. If this message stays,
        your browser has WebAssembly turned off or is too old to run it.
      </p>
    </div>

    <template v-else>
      <!-- Input -->
      <div
        class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        :class="dragging ? 'ring-2 ring-ring' : ''"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Video
          </span>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
          <input ref="fileInput" type="file" class="hidden" accept="video/*" @change="onPickFile" />
        </div>

        <div v-if="file" class="flex flex-wrap items-center gap-2 px-3 pt-2 pb-3">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ file.name }}</span>
            <span class="shrink-0 text-muted-foreground tabular-nums">
              {{ formatBytes(file.size) }}
            </span>
            <button
              type="button"
              aria-label="Remove video"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
          <span class="text-xs text-muted-foreground tabular-nums">
            <template v-if="probing">Reading the clip…</template>
            <template v-else-if="durationSec !== null">
              {{ formatClock(durationSec) }}
              <template v-if="sourceWidth">· {{ sourceWidth }} x {{ sourceHeight }}</template>
            </template>
          </span>
        </div>

        <p v-else class="px-3 pt-1 pb-4 text-sm text-muted-foreground">
          Drop a video here or pick one to get started. Everything runs in this tab: your files and
          inputs never leave your device.
        </p>
      </div>

      <!-- Media engine -->
      <div
        v-if="engineState !== 'ready'"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Media engine
        </span>
        <p class="text-sm text-muted-foreground">
          This tool runs ffmpeg inside your browser. The engine is a one time download of about 31
          MB, and your browser keeps it afterwards, so later visits start it straight from the cache
          and work offline. Nothing is uploaded: your files and inputs never leave your device.
        </p>

        <div v-if="engineState === 'loading'" class="flex flex-col gap-2">
          <div
            class="h-2 overflow-hidden rounded-full bg-background"
            role="progressbar"
            :aria-valuenow="Math.round(downloadPercent)"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="downloadLabel"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              :style="{ width: `${downloadPercent}%` }"
            />
          </div>
          <p class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ downloadLabel }}
          </p>
        </div>

        <!-- This branch only ever renders while engineState is 'idle' (the
             sibling v-if already covers 'loading', the wrapper covers
             'ready'), and loadEngine itself guards re-entrancy, so there is
             nothing left here worth disabling on. -->
        <Button v-else class="self-start" size="sm" @click="loadEngine">
          {{ engineButtonLabel }}
        </Button>
      </div>

      <p v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check class="size-3.5 text-[var(--positive)]" />
        Engine ready. It stays loaded for as long as this page is open.
      </p>

      <!-- Options -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Target
        </span>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex w-48 flex-col gap-1.5">
            <Label for="dc-cap" class="text-xs text-muted-foreground">Size cap</Label>
            <SearchableSelect
              id="dc-cap"
              :spec="capSpec"
              :model-value="cap"
              @update:model-value="(v) => (cap = String(v))"
            />
          </div>

          <div class="flex w-40 flex-col gap-1.5">
            <Label for="dc-custom" class="text-xs text-muted-foreground">Custom cap in MB</Label>
            <Input
              id="dc-custom"
              :model-value="customMB"
              inputmode="decimal"
              placeholder="e.g. 25"
              class="h-9 bg-card"
              @update:model-value="(v) => (customMB = String(v ?? ''))"
            />
          </div>

          <div class="flex w-40 flex-col gap-1.5">
            <Label for="dc-height" class="text-xs text-muted-foreground">Resolution</Label>
            <SearchableSelect
              id="dc-height"
              :spec="heightSpec"
              :model-value="maxHeight"
              @update:model-value="(v) => (maxHeight = String(v))"
            />
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-5">
          <div class="flex items-center gap-2">
            <Switch
              id="dc-fps"
              :model-value="keepFps"
              @update:model-value="(v) => (keepFps = Boolean(v))"
            />
            <Label for="dc-fps" class="text-xs text-muted-foreground"
              >Keep the source frame rate</Label
            >
          </div>
          <div class="flex items-center gap-2">
            <Switch
              id="dc-audio"
              :model-value="keepAudio"
              @update:model-value="(v) => (keepAudio = Boolean(v))"
            />
            <Label for="dc-audio" class="text-xs text-muted-foreground">Keep the audio track</Label>
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          Capping the height or the frame rate does not change the size of the result. It gives the
          same bit budget fewer pixels to spend on, which is how a tight cap stays sharp.
        </p>

        <div
          v-if="capState.issue"
          role="alert"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">
            {{ capState.issue.message }}
          </p>
          <p v-if="capState.issue.fix" class="mt-1 text-muted-foreground">
            {{ capState.issue.fix }}
          </p>
        </div>
      </div>

      <!-- The plan -->
      <div v-if="plan" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Plan
          </span>
        </div>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 px-3 pt-2 pb-3 sm:grid-cols-4">
          <div>
            <dt class="text-xs text-muted-foreground">Size cap</dt>
            <dd class="font-mono text-sm tabular-nums">
              {{ formatMegabytes(targetBytes) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Video bitrate</dt>
            <dd class="font-mono text-sm tabular-nums">{{ plan.videoKbps }} kbps</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Audio bitrate</dt>
            <dd class="font-mono text-sm tabular-nums">
              {{ plan.audioKbps > 0 ? `${plan.audioKbps} kbps` : "silent" }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">Estimated result</dt>
            <dd class="font-mono text-sm tabular-nums">
              {{ formatMegabytes(plan.estimatedBytes) }}
            </dd>
          </div>
        </dl>
        <p
          v-if="alreadyUnderCap"
          class="flex items-center gap-1.5 border-t border-border/60 px-3 py-2 text-sm text-muted-foreground"
        >
          <Check class="size-3.5 shrink-0 text-[var(--positive)]" />
          Already {{ formatMegabytes(targetBytes - file!.size) }} under the
          {{ formatMegabytes(targetBytes) }} cap. No compression needed.
        </p>
        <p
          v-if="!plan.feasible"
          role="alert"
          class="border-t border-border/60 px-3 py-2 text-sm text-destructive"
        >
          {{ plan.reason }}
        </p>
      </div>

      <p v-else-if="file && !probing && durationSec === null" class="text-sm text-muted-foreground">
        The plan needs the length of the clip, which could not be read from this file.
      </p>

      <!-- Run controls -->
      <div class="flex flex-wrap items-center gap-2">
        <Button :disabled="!canRun" @click="compress">
          {{ running ? `Pass ${activePass} of 2…` : compressButtonLabel }}
        </Button>
        <Button v-if="running" variant="outline" :disabled="cancelling" @click="cancel">
          {{ cancelling ? "Stopping…" : "Cancel" }}
        </Button>
        <span
          v-if="running && (overallPercent !== null || jobTimeMs !== null)"
          class="font-mono text-xs text-muted-foreground tabular-nums"
        >
          <template v-if="overallPercent !== null">{{ overallPercent }}%</template>
          <template v-if="overallPercent !== null && jobTimeMs !== null"> · </template>
          <template v-if="jobTimeMs !== null">{{ formatTime(jobTimeMs) }}</template>
        </span>
      </div>

      <div
        v-if="running && overallPercent !== null"
        class="h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        :aria-valuenow="overallPercent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="`Pass ${activePass} of 2`"
      >
        <div
          class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          :style="{ width: `${overallPercent}%` }"
        />
      </div>

      <p class="text-xs text-muted-foreground">
        Pass 1 measures where the motion and detail are, pass 2 spends the bit budget against that
        map. Both passes run here, so a long clip takes a while and a very large source is limited
        by how much memory this browser tab can hold. Custom caps go up to {{ MAX_CAP_MB }} MB.
      </p>

      <!-- Log tail -->
      <details
        v-if="logLines.length"
        :open="showLog"
        class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
      >
        <summary
          class="cursor-pointer text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          ffmpeg log
        </summary>
        <pre
          ref="logEl"
          class="mt-2 max-h-56 overflow-auto font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground"
          @scroll.passive="onLogScroll"
          >{{ logLines.slice(-30).join("\n") }}</pre>
      </details>

      <!-- Errors -->
      <div
        v-if="error"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">
          {{ error.message }}
        </p>
        <p v-if="error.fix" class="mt-1 text-muted-foreground">
          {{ error.fix }}
        </p>
        <pre
          v-if="error.log.length"
          class="mt-2 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground"
          >{{ error.log.join("\n") }}</pre>
      </div>

      <!-- Output -->
      <div v-if="result" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
        <div class="px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Result
          </span>
        </div>
        <div class="flex flex-col gap-3 px-3 py-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate font-mono text-sm">
                {{ result.name }}
              </div>
              <div class="text-xs text-muted-foreground tabular-nums">
                {{ formatMegabytes(result.size) }}
              </div>
            </div>
            <Button size="sm" variant="outline" @click="download"> Download </Button>
          </div>

          <p
            v-if="verdict"
            class="text-sm"
            :class="verdict.fits ? 'text-muted-foreground' : 'text-destructive'"
          >
            <Check v-if="verdict.fits" class="mr-1 inline size-3.5 text-[var(--positive)]" />{{
              verdict.text
            }}
          </p>

          <video
            :src="result.url"
            controls
            playsinline
            class="max-h-[360px] w-full rounded-[8px] bg-background"
          />
        </div>
      </div>
    </template>
  </div>
</template>
