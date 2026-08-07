<script setup lang="ts">
/**
 * MediaShell: the generic island every Phase 3 media tool renders inside.
 *
 * It owns everything that is the same for every ffmpeg tool, so a tool panel
 * only has to describe its options and turn them into an ffmpeg command:
 *
 *   - input: drop zone, file picker, file chips with sizes
 *   - the media engine: a one time ~31 MB download that never starts on page
 *     load. The visitor presses "Load media engine" and watches a byte counter.
 *   - the run: progress from ffmpeg, a collapsible log tail, and a cancel that
 *     terminates the worker and restarts it from the browser cache
 *   - output: produced files with sizes, download buttons, and a preview for
 *     video, audio, and images
 *   - errors in the same box style the rest of the site uses
 *
 * Contract for a tool panel:
 *
 *   <MediaShell
 *     :meta="meta"
 *     accept="video/*"
 *     :opts="opts"
 *     :build-args="buildArgs"
 *     run-label="Convert"
 *     @complete="onComplete"
 *   >
 *     <template #options> ...your controls, bound to `opts`... </template>
 *   </MediaShell>
 *
 * `buildArgs` is a pure function of the sanitized input names plus the panel's
 * own option values. It returns `{ args, outputs }` to run, or
 * `{ error, fix? }` to refuse with a message instead of a broken command.
 * The panel owns option state; MediaShell never mutates `opts`.
 *
 * Props
 *   meta       ToolMeta       the tool's metadata, used for copy
 *   accept     string         accept attribute for the picker, e.g. "video/*"
 *   buildArgs  MediaBuildArgs args builder, described above
 *   opts       object         option values passed through to buildArgs (default {})
 *   multiple   boolean        accept more than one input file (default false)
 *   runLabel   string         run button text (default "Run")
 *   inputLabel string         label above the drop zone (default "File")
 *   hint       string         replaces the default drop zone helper text
 *
 * Slots
 *   options    controls rendered above the run button
 *   notes      extra explanation rendered under the run controls
 *
 * Events
 *   complete   MediaFile[]                       a run finished, with its outputs
 *   files      { name: string; size: number }[]  the selected input files changed
 *
 * Rendering is inert on the server: no engine work happens until the component
 * is mounted in a browser.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, useSlots } from 'vue';
import { Check, X } from 'lucide-vue-next';
import type { ToolMeta } from '@/tools/types';
import { ToolError } from '@/tools/types';
import {
  MediaJobError,
  isEngineReady,
  isMediaSupported,
  getFFmpeg,
  runJob,
  terminateEngine,
  type MediaBuildArgs,
  type MediaFile,
} from '@/lib/ffmpeg';
import { Button } from '@/components/ui/button';

const props = withDefaults(
  defineProps<{
    meta: ToolMeta;
    accept: string;
    buildArgs: MediaBuildArgs;
    opts?: Record<string, unknown>;
    multiple?: boolean;
    runLabel?: string;
    inputLabel?: string;
    hint?: string;
  }>(),
  {
    opts: () => ({}),
    multiple: false,
    runLabel: 'Run',
    inputLabel: 'File',
    hint: undefined,
  }
);

const emit = defineEmits<{
  complete: [files: MediaFile[]];
  files: [files: { name: string; size: number; file: File }[]];
}>();

const slots = useSlots();

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

/** False until mounted, which keeps every capability check off the server. */
const supported = ref(false);

type EngineState = 'idle' | 'loading' | 'ready';
const engineState = ref<EngineState>('idle');
/** Sticky once the bytes have been fetched, so the copy can say "restart". */
const engineDownloaded = ref(false);
const downloadedBytes = ref(0);
const downloadTotal = ref(0);

interface PickedFile {
  file: File;
  /** Name used inside the ffmpeg filesystem. */
  safeName: string;
}
const picked = ref<PickedFile[]>([]);
const inputEl = ref<HTMLInputElement>();
const dragging = ref(false);

const running = ref(false);
const cancelling = ref(false);
const ratio = ref<number | null>(null);
const timeMs = ref<number | null>(null);
const logLines = ref<string[]>([]);
const showLog = ref(false);

interface OutputFile {
  name: string;
  size: number;
  url: string;
  kind: 'video' | 'audio' | 'image' | 'other';
}
const outputs = shallowRef<OutputFile[]>([]);

const error = ref<{ message: string; fix?: string; log: string[] } | null>(null);

/* ---------------------------------------------------------------- */
/* formatting                                                        */
/* ---------------------------------------------------------------- */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const downloadLabel = computed(() => {
  if (!downloadTotal.value) return 'Downloading media engine';
  return `Downloading media engine (${megabytes(downloadedBytes.value)} of ${megabytes(downloadTotal.value)} MB)`;
});

const downloadPercent = computed(() =>
  downloadTotal.value ? Math.min(100, (downloadedBytes.value / downloadTotal.value) * 100) : 0
);

const engineButtonLabel = computed(() =>
  engineDownloaded.value ? 'Restart media engine' : 'Load media engine'
);

const canRun = computed(
  () => supported.value && picked.value.length > 0 && !running.value && !cancelling.value
);

const visibleLog = computed(() => logLines.value.slice(-30));

/* ---------------------------------------------------------------- */
/* files                                                             */
/* ---------------------------------------------------------------- */

const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'];

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gz: 'application/gzip',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function kindOf(name: string): OutputFile['kind'] {
  const ext = extensionOf(name);
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return 'other';
}

/**
 * ffmpeg picks a demuxer from the extension, so the extension is preserved
 * while everything else collapses to a safe ASCII name. Spaces and unicode in
 * a filename are legal in the ffmpeg filesystem but make log lines unreadable.
 */
function safeNameFor(file: File, index: number): string {
  const ext = extensionOf(file.name);
  const base = file.name
    .slice(0, ext ? file.name.length - ext.length - 1 : undefined)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stem = base || `input${index === 0 ? '' : index}`;
  return ext ? `${stem}.${ext.replace(/[^A-Za-z0-9]/g, '')}` : stem;
}

function setFiles(list: File[]) {
  const files = props.multiple ? list : list.slice(0, 1);
  if (!files.length) return;
  // Two files with the same name would collide in one flat filesystem.
  const used = new Set<string>();
  picked.value = files.map((file, i) => {
    let safeName = safeNameFor(file, i);
    while (used.has(safeName)) safeName = `${i}-${safeName}`;
    used.add(safeName);
    return { file, safeName };
  });
  clearOutputs();
  error.value = null;
  emit(
    'files',
    picked.value.map(({ file }) => ({ name: file.name, size: file.size, file }))
  );
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) setFiles(files);
}

function onPickFile(e: Event) {
  const el = e.target as HTMLInputElement;
  const files = Array.from(el.files ?? []);
  if (files.length) setFiles(files);
  // Reset so picking the same file again still fires a change event.
  el.value = '';
}

function removeFile(index: number) {
  picked.value = picked.value.filter((_, i) => i !== index);
  clearOutputs();
  emit(
    'files',
    picked.value.map(({ file }) => ({ name: file.name, size: file.size, file }))
  );
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
  if (engineState.value === 'loading') return;
  engineState.value = 'loading';
  error.value = null;
  try {
    await getFFmpeg(undefined, onDownload);
    engineState.value = 'ready';
    engineDownloaded.value = true;
  } catch (e) {
    engineState.value = 'idle';
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

function clearOutputs() {
  for (const out of outputs.value) URL.revokeObjectURL(out.url);
  outputs.value = [];
}

async function run() {
  if (!canRun.value) return;

  const built = props.buildArgs({
    inputName: picked.value[0]?.safeName ?? '',
    inputNames: picked.value.map((p) => p.safeName),
    files: picked.value.map(({ file }) => ({ name: file.name, size: file.size })),
    opts: props.opts,
  });

  if ('error' in built) {
    error.value = { message: built.error, fix: built.fix, log: [] };
    return;
  }

  running.value = true;
  cancelling.value = false;
  error.value = null;
  ratio.value = null;
  timeMs.value = null;
  logLines.value = [];
  clearOutputs();

  try {
    // Loading the engine inside the run is deliberate: pressing run after a
    // cancel, or on a page where the engine was never started, still works.
    if (!isEngineReady()) engineState.value = 'loading';

    const inputs = await Promise.all(
      picked.value.map(async ({ file, safeName }) => ({
        name: safeName,
        data: new Uint8Array(await file.arrayBuffer()),
      }))
    );

    const produced = await runJob({
      inputs,
      args: built.args,
      outputs: built.outputs,
      onDownload,
      onProgress: (p) => {
        ratio.value = p.ratio;
        timeMs.value = p.timeMs;
        if (p.logLine) logLines.value.push(p.logLine);
      },
    });

    engineState.value = 'ready';
    engineDownloaded.value = true;
    outputs.value = produced.map(({ name, data }) => ({
      name,
      size: data.byteLength,
      kind: kindOf(name),
      url: URL.createObjectURL(
        new Blob([data.slice().buffer as ArrayBuffer], {
          type: MIME[extensionOf(name)] ?? 'application/octet-stream',
        })
      ),
    }));
    emit('complete', produced);
  } catch (e) {
    if (cancelling.value) {
      error.value = null;
    } else {
      engineState.value = isEngineReady() ? 'ready' : 'idle';
      setError(e);
      // A failure usually explains itself in the log, so open it.
      if (logLines.value.length) showLog.value = true;
    }
  } finally {
    running.value = false;
    ratio.value = null;
  }
}

/**
 * Cancel kills the worker, which is the only way to stop ffmpeg mid run. The
 * engine is restarted straight away so the panel returns to a usable state; the
 * wasm comes back from the browser cache rather than from the network.
 */
async function cancel() {
  if (!running.value) return;
  cancelling.value = true;
  terminateEngine();
  engineState.value = 'idle';
  await loadEngine();
  cancelling.value = false;
}

function download(out: OutputFile) {
  const a = document.createElement('a');
  a.href = out.url;
  a.download = out.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                         */
/* ---------------------------------------------------------------- */

onMounted(() => {
  supported.value = isMediaSupported();
  if (isEngineReady()) {
    engineState.value = 'ready';
    engineDownloaded.value = true;
  }
});

onUnmounted(clearOutputs);
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Capability gate -->
    <div
      v-if="!supported"
      role="status"
      class="rounded-lg border bg-secondary/60 px-3 py-2 text-sm"
    >
      <p class="font-medium text-muted-foreground">
        Starting the media engine.
      </p>
      <p class="mt-1 text-muted-foreground">
        {{ meta.name }} runs ffmpeg inside this tab, which needs WebAssembly. If this message
        stays, your browser has WebAssembly turned off or is too old to run it.
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
            {{ inputLabel }}
          </span>
          <Button
            variant="ghost"
            size="sm"
            @click="inputEl?.click()"
          >
            Open file…
          </Button>
          <input
            ref="inputEl"
            type="file"
            class="hidden"
            :accept="accept"
            :multiple="multiple"
            @change="onPickFile"
          >
        </div>

        <div
          v-if="picked.length"
          class="flex flex-wrap gap-2 px-3 pt-2 pb-3"
        >
          <span
            v-for="(item, index) in picked"
            :key="item.safeName"
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ item.file.name }}</span>
            <span class="shrink-0 text-muted-foreground tabular-nums">
              {{ humanSize(item.file.size) }}
            </span>
            <button
              type="button"
              aria-label="Remove file"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="removeFile(index)"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>

        <p
          v-else
          class="px-3 pt-1 pb-4 text-sm text-muted-foreground"
        >
          {{
            hint ??
              `Drop a file here or pick one to get started. Everything runs in this tab: your files and inputs never leave your device.`
          }}
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
          This tool runs ffmpeg inside your browser. The engine is a one time download of about
          31 MB, and your browser keeps it afterwards, so later visits start it straight from the
          cache and work offline. Nothing is uploaded: your files and inputs never leave your
          device.
        </p>

        <div
          v-if="engineState === 'loading'"
          class="flex flex-col gap-2"
        >
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

        <Button
          v-else
          class="self-start"
          size="sm"
          @click="loadEngine"
        >
          {{ engineButtonLabel }}
        </Button>
      </div>

      <p
        v-else
        class="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Check class="size-3.5 text-[var(--positive)]" />
        Engine ready. It stays loaded for as long as this page is open.
      </p>

      <!-- Per tool options -->
      <div v-if="slots.options">
        <slot name="options" />
      </div>

      <!-- Run controls -->
      <div class="flex flex-wrap items-center gap-2">
        <Button
          :disabled="!canRun"
          @click="run"
        >
          {{ running ? 'Working…' : runLabel }}
        </Button>
        <Button
          v-if="running"
          variant="outline"
          :disabled="cancelling"
          @click="cancel"
        >
          {{ cancelling ? 'Stopping…' : 'Cancel' }}
        </Button>
        <span
          v-if="running && (ratio !== null || timeMs !== null)"
          class="font-mono text-xs text-muted-foreground tabular-nums"
        >
          <template v-if="ratio !== null">{{ Math.round(ratio * 100) }}%</template>
          <template v-if="ratio !== null && timeMs !== null"> · </template>
          <template v-if="timeMs !== null">{{ formatTime(timeMs) }}</template>
        </span>
      </div>

      <div
        v-if="running && ratio !== null"
        class="h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        :aria-valuenow="Math.round(ratio * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label="Job progress"
      >
        <div
          class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          :style="{ width: `${Math.round(ratio * 100)}%` }"
        />
      </div>

      <slot name="notes" />

      <!-- Log tail -->
      <details
        v-if="visibleLog.length"
        :open="showLog"
        class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
      >
        <summary
          class="cursor-pointer text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          ffmpeg log
        </summary>
        <pre
          class="mt-2 max-h-56 overflow-auto font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground"
        >{{ visibleLog.join('\n') }}</pre>
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
        <p
          v-if="error.fix"
          class="mt-1 text-muted-foreground"
        >
          {{ error.fix }}
        </p>
        <pre
          v-if="error.log.length"
          class="mt-2 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground"
        >{{ error.log.join('\n') }}</pre>
      </div>

      <!-- Output -->
      <div
        v-if="outputs.length"
        class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      >
        <div class="px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Output
          </span>
        </div>
        <div class="divide-y divide-border/60">
          <div
            v-for="out in outputs"
            :key="out.name"
            class="flex flex-col gap-3 px-3 py-3"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="truncate font-mono text-sm">
                  {{ out.name }}
                </div>
                <div class="text-xs text-muted-foreground tabular-nums">
                  {{ humanSize(out.size) }}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                @click="download(out)"
              >
                Download
              </Button>
            </div>

            <video
              v-if="out.kind === 'video'"
              :src="out.url"
              controls
              playsinline
              class="max-h-[360px] w-full rounded-[8px] bg-background"
            />
            <audio
              v-else-if="out.kind === 'audio'"
              :src="out.url"
              controls
              class="w-full"
            />
            <img
              v-else-if="out.kind === 'image'"
              :src="out.url"
              :alt="`Result: ${out.name}`"
              class="max-h-[360px] w-auto max-w-full self-start rounded-[8px]"
            >
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
