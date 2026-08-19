<script setup lang="ts">
/**
 * Bespoke panel for Media Key Tester.
 *
 * The pure layer (`src/tools/media-key-tester/index.ts`, rule 27) only knows
 * the shape of a { caps, events } report; this panel owns everything it
 * cannot touch: creating the silent audio element that makes the browser
 * grant this page a media session, registering navigator.mediaSession action
 * handlers, and listening for raw keyboard media-key events. Start test is a
 * click-to-start action (never automatic) so the server rendered shell never
 * touches window, navigator, or Audio.
 *
 * The silent clip is a 1 second WAV built at runtime from a 44 byte RIFF
 * header plus zeroed 16 bit PCM samples (silence), turned into a Blob URL.
 * Nothing is fetched, nothing leaves the tab.
 */
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import {
  MEDIA_ACTIONS,
  KEYBOARD_MEDIA_KEYS,
  KEYBOARD_KEYS_NOTE,
  describeEvent,
  describeSupport,
  run,
  type MediaKeyEvent,
  type MediaSessionCaps,
} from "@/tools/media-key-tester/index";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import OutputView from "@/components/tool/OutputView.vue";
import CopyButton from "@/components/tool/CopyButton.vue";
import { Check, CircleAlert, Play, Square, Trash2 } from "lucide-vue-next";

defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * the silent clip: 1 second of 16 bit PCM silence, built at runtime
 * ------------------------------------------------------------------ */

const WAV_SAMPLE_RATE = 8000;
const WAV_DURATION_SECONDS = 1;

function createSilentWavBlob(): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (WAV_SAMPLE_RATE * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = WAV_SAMPLE_RATE * WAV_DURATION_SECONDS * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeAscii(offset: number, value: string) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // PCM format tag
  view.setUint16(22, numChannels, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  // Sample bytes are already zero-initialized: 0 is silence for signed PCM.

  return new Blob([buffer], { type: "audio/wav" });
}

/** A small inline play-triangle mark, so the OS media overlay has artwork
 * without this page ever requesting an image over the network. */
const ARTWORK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
  '<rect width="256" height="256" rx="40" fill="#5B4BD6"/>' +
  '<path d="M100 76l100 52-100 52V76z" fill="#F6F4F1"/>' +
  "</svg>";
const ARTWORK_DATA_URL = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(ARTWORK_SVG)}`;

/* ------------------------------------------------------------------ *
 * capability detection and test state
 * ------------------------------------------------------------------ */

// Starts false so the server render and the first client render agree (no
// hydration mismatch); the real capability is read after mount, client only.
const mediaSessionSupported = ref(false);

const started = ref(false);
const playing = ref(false);
const testError = ref<string | null>(null);
const supportedActions = ref<string[]>([]);
const unsupportedActions = ref<string[]>([]);

let audioEl: HTMLAudioElement | null = null;
let audioObjectUrl: string | null = null;

const caps = computed<MediaSessionCaps>(() => ({
  mediaSession: mediaSessionSupported.value,
  supportedActions: supportedActions.value,
  unsupportedActions: unsupportedActions.value,
}));

const supportRows = computed(() => describeSupport(caps.value));

/* ------------------------------------------------------------------ *
 * event log
 * ------------------------------------------------------------------ */

const MAX_EVENTS = 500;

interface LoggedEvent extends MediaKeyEvent {
  id: number;
}

const events = ref<LoggedEvent[]>([]);
let nextEventId = 0;

/** Newest first, capped so a busy session cannot grow without bound. */
function logEvent(e: MediaKeyEvent) {
  nextEventId += 1;
  events.value = [{ ...e, id: nextEventId }, ...events.value].slice(0, MAX_EVENTS);
}

function clearLog() {
  events.value = [];
}

function logLineClass(e: MediaKeyEvent): string {
  if (e.source === "mediasession") return "text-foreground";
  return isKeyboardMediaKey(e.key ?? "") ? "text-primary font-medium" : "text-muted-foreground";
}

/** The exact { caps, events } shape the tool's run() and paste-JSON input
 * expect, with the panel's own bookkeeping id stripped back out. */
const reportEvents = computed<MediaKeyEvent[]>(() =>
  events.value.map(({ id: _id, ...rest }) => rest),
);

const reportJson = computed(() =>
  JSON.stringify({ caps: caps.value, events: reportEvents.value }, null, 2),
);

/* ------------------------------------------------------------------ *
 * fired / flash state for the action grid
 * ------------------------------------------------------------------ */

const firedActions = reactive<Record<string, boolean>>({});
const flashingActions = reactive<Record<string, boolean>>({});
const flashTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function markFired(action: string) {
  firedActions[action] = true;
  flashingActions[action] = true;
  if (flashTimers[action]) clearTimeout(flashTimers[action]);
  flashTimers[action] = setTimeout(() => {
    flashingActions[action] = false;
  }, 700);
}

function clearFlashTimers() {
  for (const key of Object.keys(flashTimers)) clearTimeout(flashTimers[key]);
}

type ActionStatus = "no-api" | "not-started" | "unsupported" | "registered";

function actionStatus(action: string): ActionStatus {
  if (!mediaSessionSupported.value) return "no-api";
  if (!started.value) return "not-started";
  if (unsupportedActions.value.includes(action)) return "unsupported";
  return "registered";
}

const STATUS_LABEL: Record<ActionStatus, string> = {
  "no-api": "No Media Session API",
  "not-started": "Not started",
  unsupported: "Not supported",
  registered: "Registered",
};

function statusBadgeClass(status: ActionStatus): string {
  return status === "registered"
    ? "border-[var(--positive)]/40 text-[var(--positive)]"
    : "border-border text-muted-foreground";
}

/* ------------------------------------------------------------------ *
 * media session playback state, kept truthful for play/pause
 * ------------------------------------------------------------------ */

async function resumePlayback() {
  if (audioEl) {
    try {
      await audioEl.play();
      playing.value = true;
    } catch {
      // A programmatic resume without a fresh user gesture can be blocked by
      // autoplay policy in some browsers; the fired event is already logged.
    }
  }
  if (mediaSessionSupported.value) {
    navigator.mediaSession.playbackState = playing.value ? "playing" : "none";
  }
}

function pausePlayback() {
  audioEl?.pause();
  playing.value = false;
  if (mediaSessionSupported.value) navigator.mediaSession.playbackState = "paused";
}

// Derived from the navigator type so eslint's no-undef (which does not read
// the DOM lib globals in .vue files) stays quiet without losing type safety.
type SessionAction = Parameters<MediaSession["setActionHandler"]>[0];
type SessionActionDetails = Parameters<NonNullable<Parameters<MediaSession["setActionHandler"]>[1]>>[0];

function actionDetails(details: SessionActionDetails): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (typeof details.seekOffset === "number") out.seekOffset = details.seekOffset;
  if (typeof details.seekTime === "number") out.seekTime = details.seekTime;
  if (typeof details.fastSeek === "boolean") out.fastSeek = details.fastSeek;
  return Object.keys(out).length > 0 ? out : undefined;
}

function makeActionHandler(action: string) {
  return (details: SessionActionDetails) => {
    logEvent({
      source: "mediasession",
      action,
      timestamp: Date.now(),
      details: actionDetails(details),
    });
    markFired(action);

    if (action === "play") void resumePlayback();
    else if (action === "pause") pausePlayback();
  };
}

/* ------------------------------------------------------------------ *
 * start / stop
 * ------------------------------------------------------------------ */

async function startTest() {
  if (started.value) return;
  testError.value = null;

  const blob = createSilentWavBlob();
  audioObjectUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioObjectUrl);
  audio.loop = true;
  audio.preload = "auto";
  audioEl = audio;

  try {
    await audio.play();
    playing.value = true;
  } catch (e) {
    testError.value =
      "The silent clip could not start playing " +
      `(${e instanceof Error ? e.message : String(e)}). ` +
      "Browsers only grant a page control of hardware media keys while it has " +
      "an active audio or video element, so key routing may not work, but " +
      "keyboard testing still will.";
  }

  if (mediaSessionSupported.value) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Media Key Tester",
        artist: "tools.maxhogan.dev",
        artwork: [{ src: ARTWORK_DATA_URL, sizes: "256x256", type: "image/svg+xml" }],
      });
    } catch {
      // Metadata is a nicety for the OS overlay; the test still works without it.
    }
    navigator.mediaSession.playbackState = playing.value ? "playing" : "none";

    const supported: string[] = [];
    const unsupported: string[] = [];
    for (const spec of MEDIA_ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(
          spec.action as SessionAction,
          makeActionHandler(spec.action),
        );
        supported.push(spec.action);
      } catch {
        unsupported.push(spec.action);
      }
    }
    supportedActions.value = supported;
    unsupportedActions.value = unsupported;
  }

  started.value = true;
}

function clearActionHandlers() {
  if (!mediaSessionSupported.value) return;
  for (const spec of MEDIA_ACTIONS) {
    try {
      navigator.mediaSession.setActionHandler(spec.action as SessionAction, null);
    } catch {
      // Nothing to clear if this browser never accepted this action.
    }
  }
}

function teardownAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = "";
    audioEl = null;
  }
  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
  }
}

function stopTest() {
  clearActionHandlers();
  teardownAudio();
  clearFlashTimers();
  if (mediaSessionSupported.value) {
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    } catch {
      // Nothing to reset if the browser never accepted metadata.
    }
  }
  supportedActions.value = [];
  unsupportedActions.value = [];
  playing.value = false;
  started.value = false;
}

/* ------------------------------------------------------------------ *
 * keyboard fallback: active from mount, independent of Start test, so
 * keyboard-only mode works even without navigator.mediaSession
 * ------------------------------------------------------------------ */

const logAllKeys = ref(false);

function isKeyboardMediaKey(key: string): boolean {
  return KEYBOARD_MEDIA_KEYS.some((k) => k.key === key);
}

function handleKeyDown(e: KeyboardEvent) {
  if (!isKeyboardMediaKey(e.key) && !logAllKeys.value) return;
  logEvent({ source: "keyboard", key: e.key, code: e.code, timestamp: Date.now() });
}

onMounted(() => {
  mediaSessionSupported.value = typeof navigator !== "undefined" && "mediaSession" in navigator;
  window.addEventListener("keydown", handleKeyDown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeyDown);
  if (started.value) stopTest();
});

/* ------------------------------------------------------------------ *
 * summary: run() over { events } only, describeSupport already covers caps
 * ------------------------------------------------------------------ */

const summaryShown = ref(false);
const summaryRows = ref<Record<string, string> | null>(null);

async function refreshSummary() {
  if (!summaryShown.value) return;
  summaryRows.value = await run(JSON.stringify({ events: reportEvents.value }), {});
}

function onSummarizeClick() {
  summaryShown.value = true;
  void refreshSummary();
}
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Honest fallback for browsers without the Media Session API -->
    <div
      v-if="!mediaSessionSupported"
      class="flex items-start gap-3 rounded-[10px] bg-secondary px-4 py-3 shadow-[var(--sh-inset)]"
    >
      <CircleAlert class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="text-sm">
        <p class="font-medium">This browser does not expose the Media Session API.</p>
        <p class="mt-1 text-muted-foreground">
          Hardware key routing through navigator.mediaSession is not available here, so the action
          grid below cannot register handlers. Keyboard-only mode still works: press a media key
          and watch the event log below.
        </p>
      </div>
    </div>

    <!-- Controls -->
    <div class="flex flex-wrap items-center gap-3">
      <Button v-if="!started" @click="startTest">
        <Play class="size-4" aria-hidden="true" />
        Start test
      </Button>
      <Button v-else variant="outline" @click="stopTest">
        <Square class="size-4" aria-hidden="true" />
        Stop test
      </Button>

      <span v-if="started" class="text-sm text-muted-foreground" role="status">
        Now press your media keys or headset button.
      </span>

      <label class="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Switch v-model="logAllKeys" size="sm" />
        Log all keys (media keys highlighted)
      </label>
    </div>

    <div
      v-if="testError"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <span class="font-semibold text-destructive">Playback could not start</span>
      <span class="text-muted-foreground">{{ testError }}</span>
    </div>

    <!-- Action grid -->
    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Media Session actions
      </span>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="spec in MEDIA_ACTIONS"
          :key="spec.action"
          class="flex flex-col gap-1.5 rounded-[14px] border bg-card p-3 shadow-[var(--sh-sm)] transition-colors duration-150"
          :class="
            flashingActions[spec.action]
              ? 'border-primary bg-[var(--accent-soft)] ring-1 ring-primary/40'
              : ''
          "
        >
          <div class="flex items-start justify-between gap-2">
            <span class="text-sm font-semibold">{{ spec.label }}</span>
            <Badge
              variant="outline"
              class="shrink-0"
              :class="statusBadgeClass(actionStatus(spec.action))"
            >
              {{ STATUS_LABEL[actionStatus(spec.action)] }}
            </Badge>
          </div>
          <span class="text-xs text-muted-foreground">{{ spec.keyHint }}</span>
          <span
            v-if="firedActions[spec.action]"
            class="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary"
          >
            <Check class="size-3" aria-hidden="true" />
            Fired
          </span>
        </div>
      </div>
    </div>

    <!-- Support -->
    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Support
      </span>
      <OutputView :output="supportRows" />
    </div>

    <!-- Event log -->
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Event log
        </span>
        <Button v-if="events.length" variant="ghost" size="sm" @click="clearLog">
          <Trash2 class="size-3.5" aria-hidden="true" />
          Clear
        </Button>
      </div>
      <div
        class="max-h-72 overflow-auto rounded-[10px] bg-secondary p-3 font-mono text-xs shadow-[var(--sh-inset)]"
      >
        <p v-if="events.length === 0" class="text-muted-foreground">
          No events yet. Click Start test, then press play/pause, stop, track skip, volume, or your
          headset buttons.
        </p>
        <div
          v-for="e in events"
          :key="e.id"
          class="py-0.5 break-words whitespace-pre-wrap"
          :class="logLineClass(e)"
        >
          {{ describeEvent(e) }}
        </div>
      </div>
      <p class="text-xs text-muted-foreground">{{ KEYBOARD_KEYS_NOTE }}</p>
    </div>

    <!-- Summary -->
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Summary
        </span>
        <Button v-if="!summaryShown" variant="outline" size="sm" @click="onSummarizeClick">
          Summarize
        </Button>
      </div>
      <template v-if="summaryShown && summaryRows">
        <div
          class="rounded-[10px] border border-primary/30 bg-[var(--accent-soft)]/40 p-3"
          role="status"
        >
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Verdict
          </span>
          <p class="mt-1 text-sm font-semibold">{{ summaryRows["Verdict"] }}</p>
        </div>
        <OutputView :output="summaryRows" />
      </template>
      <p v-else class="text-xs text-muted-foreground">
        Press Summarize, or press any tested key, to see which handlers fired and how hardware keys
        are reaching this page.
      </p>
    </div>

    <!-- Copy report -->
    <div class="flex flex-wrap items-center gap-3 border-t pt-4">
      <CopyButton :text="reportJson" label="Copy report" />
      <p class="text-xs text-muted-foreground">
        Copies the full report as JSON (caps and events). Everything above runs in this tab: your
        files and inputs never leave your device.
      </p>
    </div>
  </div>
</template>
