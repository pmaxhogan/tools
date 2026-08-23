<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Bell, BellOff, Flag, Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  decodeTimerState,
  encodeTimerState,
  formatRemaining,
  formatStopwatch,
  lapStats,
  parseDuration,
  parseTarget,
  renderChimeSamples,
  timerProgress,
  type TimerState,
} from "@/tools/countdown-timer/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import CopyButton from "../CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the Countdown Timer and Stopwatch.
 *
 * The generic ToolShell can only describe a timer in text. A timer has to
 * actually run, so this panel owns the clock, the transport controls, the
 * alarm chime, and the document title, while every number it shows still
 * comes from the pure logic layer (PROJECT.md rule 27): parseDuration,
 * parseTarget, formatRemaining, formatStopwatch, timerProgress, lapStats,
 * renderChimeSamples, and encodeTimerState/decodeTimerState.
 *
 * Timekeeping is absolute, never accumulated. A running countdown stores the
 * epoch millisecond it ends at and a running stopwatch stores the epoch
 * millisecond it started, so every frame recomputes from Date.now() and a
 * throttled or suspended tab cannot make the clock drift. A visibilitychange
 * listener recomputes the moment the tab comes back.
 *
 * Audio never starts on its own. The AudioContext is created inside a click
 * (Start, or the sound toggle), and a countdown restored from a link that has
 * already run out stays silent rather than fighting the autoplay policy.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Background tick. Browsers throttle this to about 1 Hz in a hidden tab,
 * which is harmless because every reading is recomputed from absolute time. */
const TICK_MS = 250;
/** How long the digits flash once a countdown reaches zero. */
const FLASH_MS = 2600;
/** Output level for the chime, well below full scale. */
const CHIME_GAIN = 0.6;
/** Quick presets, in minutes. */
const PRESET_MINUTES = [1, 5, 10, 15, 25];

const STYLE_VALUES = new Set<string>(["clock", "words", "compact"]);

const STYLE_FALLBACK: SelectOptionSpec = {
  kind: "select",
  id: "style",
  label: "Remaining time style",
  default: "clock",
  options: [
    {
      value: "clock",
      label: "Clock (01:02:03)",
      synonyms: ["digits", "numeric", "hh:mm:ss", "clock format"],
    },
    {
      value: "words",
      label: "Words (1 hour 2 minutes 3 seconds)",
      synonyms: ["long", "full", "verbose", "spelled out"],
    },
    {
      value: "compact",
      label: "Compact (1h 2m 3s)",
      synonyms: ["short", "abbreviated", "abbr"],
    },
  ],
};

const styleSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find((o) => o.id === "style");
  return found && found.kind === "select" ? found : STYLE_FALLBACK;
});

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

type Mode = "countdown" | "stopwatch";
type Source = "duration" | "target";

interface FieldError {
  message: string;
  fix?: string;
}

function toFieldError(err: unknown, fallback: string): FieldError {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : fallback };
}

const mode = ref<Mode>("countdown");
const source = ref<Source>("duration");
const durationText = ref("5m");
const targetText = ref("");
const timerLabel = ref("");
const styleId = ref("clock");

/** Wall clock, resampled on every tick. Zero until mounted, so the server
 * render and the first client render agree. */
const nowMs = ref(0);

/* countdown runtime */
const cdRunning = ref(false);
const cdFinished = ref(false);
/** Epoch ms the running countdown ends at, or null when it is not running. */
const cdEndAtMs = ref<number | null>(null);
/** Milliseconds held while paused (0 once it has finished), else null. */
const cdHeldMs = ref<number | null>(null);
/** Full length of the current run, for the progress bar. */
const cdTotalMs = ref(0);

/* stopwatch runtime */
const swRunning = ref(false);
const swStartedAtMs = ref(0);
const swAccumulatedMs = ref(0);
/** Per-lap durations in milliseconds, which is what lapStats expects. */
const laps = ref<number[]>([]);

/* alarm */
const soundOn = ref(true);
const notifyOn = ref(false);
const notifySupported = ref(false);
const flashing = ref(false);

const actionError = ref<FieldError | null>(null);

/* ------------------------------------------------------------------ *
 * parsing, straight from the logic layer
 * ------------------------------------------------------------------ */

interface Parsed {
  ms: number | null;
  error: FieldError | null;
}

const durationParse = computed<Parsed>(() => {
  if (!durationText.value.trim()) return { ms: null, error: null };
  try {
    return { ms: parseDuration(durationText.value) * 1000, error: null };
  } catch (err) {
    return { ms: null, error: toFieldError(err, "That is not a duration this tool can use.") };
  }
});

/**
 * The local IANA zone, resolved after mount. parseTarget reads zone-less text
 * as UTC, which is not what someone typing a wall-clock time in a countdown
 * expects, so the panel supplies the reader's own zone.
 */
const localZone = ref("");

/**
 * Target parsing with a local-zone default. Text that already names a zone
 * ("2026-12-31 15:00 America/Chicago") makes the zone argument disagree with
 * the text and parseTarget throws, so that case falls back to letting the
 * text speak for itself.
 */
function parseTargetHere(text: string): number {
  if (!localZone.value) return parseTarget(text);
  try {
    return parseTarget(text, localZone.value);
  } catch {
    return parseTarget(text);
  }
}

/**
 * The instant a shared link named, held apart from the text field.
 *
 * A link carries an absolute epoch millisecond, but the readable text beside
 * it ("2026-12-31T23:59") is zone-less, so re-parsing that text in the
 * recipient's zone would move the target. The pin wins until the reader edits
 * the field, at which point their own typing is what they mean.
 */
const pinnedTargetMs = ref<number | null>(null);
/** The exact field text the pin was restored with, so an edit can drop it. */
let pinnedText = "";

watch(targetText, (text) => {
  if (text !== pinnedText) pinnedTargetMs.value = null;
});

const targetParse = computed<Parsed>(() => {
  if (pinnedTargetMs.value !== null) return { ms: pinnedTargetMs.value, error: null };
  if (!targetText.value.trim()) return { ms: null, error: null };
  try {
    return { ms: parseTargetHere(targetText.value), error: null };
  } catch (err) {
    return { ms: null, error: toFieldError(err, "That is not a date and time this tool can use.") };
  }
});

const fieldError = computed<FieldError | null>(() => {
  if (mode.value !== "countdown") return null;
  return source.value === "duration" ? durationParse.value.error : targetParse.value.error;
});

/** Milliseconds a fresh run would last, or null when the field does not parse. */
const plannedMs = computed<number | null>(() => {
  if (source.value === "duration") return durationParse.value.ms;
  const target = targetParse.value.ms;
  return target === null ? null : target - nowMs.value;
});

/* ------------------------------------------------------------------ *
 * derived display values
 * ------------------------------------------------------------------ */

const cdRemainingMs = computed<number>(() => {
  if (cdRunning.value && cdEndAtMs.value !== null) {
    return Math.max(0, cdEndAtMs.value - nowMs.value);
  }
  if (cdHeldMs.value !== null) return cdHeldMs.value;
  return plannedMs.value ?? 0;
});

const swElapsedMs = computed<number>(
  () =>
    swAccumulatedMs.value + (swRunning.value ? Math.max(0, nowMs.value - swStartedAtMs.value) : 0),
);

const countdownText = computed(() =>
  formatRemaining(cdRemainingMs.value, { style: styleId.value }),
);
const stopwatchText = computed(() => formatStopwatch(swElapsedMs.value));
const displayText = computed(() =>
  mode.value === "stopwatch" ? stopwatchText.value : countdownText.value,
);

/** Three size steps so long readings ("2d 01:02:03", the words style) stay
 * inside a narrow pop out window instead of running off the edge. */
const displaySize = computed(() => {
  const length = displayText.value.length;
  if (length <= 9) return "lg";
  if (length <= 16) return "md";
  return "sm";
});

const progress = computed<number>(() => {
  const total = cdTotalMs.value;
  if (total <= 0) return cdFinished.value ? 1 : 0;
  const startedAt =
    cdRunning.value && cdEndAtMs.value !== null
      ? cdEndAtMs.value - total
      : nowMs.value - (total - cdRemainingMs.value);
  return timerProgress(startedAt, total / 1000, nowMs.value);
});

/**
 * When this run ends. `exact` marks an instant that is already pinned (a
 * running countdown, a finished one, a target date), so it can be shown to
 * the second. Anything else is a preview measured from right now, which would
 * visibly creep if it carried seconds, so it drops them.
 */
const endsAt = computed<{ ms: number; exact: boolean } | null>(() => {
  if (mode.value === "stopwatch" || nowMs.value === 0) return null;
  if (cdEndAtMs.value !== null && (cdRunning.value || cdFinished.value)) {
    return { ms: cdEndAtMs.value, exact: true };
  }
  if (source.value === "target" && targetParse.value.ms !== null && cdHeldMs.value === null) {
    return { ms: targetParse.value.ms, exact: true };
  }
  const held = cdHeldMs.value;
  if (held !== null) return { ms: nowMs.value + held, exact: false };
  const planned = plannedMs.value;
  if (planned === null) return null;
  return { ms: nowMs.value + planned, exact: false };
});

const endsAtText = computed(() => {
  const at = endsAt.value;
  if (at === null) return null;
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: at.exact ? "medium" : "short",
    });
    return fmt.format(new Date(at.ms));
  } catch {
    return new Date(at.ms).toISOString();
  }
});

const stats = computed(() => lapStats(laps.value));

const lapRows = computed(() => {
  let total = 0;
  return laps.value.map((split, index) => {
    total += split;
    return { index: index + 1, split, total };
  });
});

const lapsText = computed(() =>
  [
    "Lap\tSplit\tTotal",
    ...lapRows.value.map(
      (r) => `${r.index}\t${formatStopwatch(r.split)}\t${formatStopwatch(r.total)}`,
    ),
  ].join("\n"),
);

const titleLabel = computed(() => timerLabel.value.trim() || props.meta.name);

const canStartCountdown = computed(() => {
  if (cdHeldMs.value !== null && cdHeldMs.value > 0) return true;
  return plannedMs.value !== null && plannedMs.value > 0;
});

/* ------------------------------------------------------------------ *
 * the tick
 * ------------------------------------------------------------------ */

let interval: ReturnType<typeof setInterval> | null = null;
let frame: number | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function tick(): void {
  const now = Date.now();
  nowMs.value = now;
  if (cdRunning.value && cdEndAtMs.value !== null && now >= cdEndAtMs.value) finish();
  syncTitle();
}

function frameLoop(): void {
  frame = requestAnimationFrame(frameLoop);
  tick();
}

/** Smooth ticking only while something is actually counting. */
const ticking = computed(() => cdRunning.value || swRunning.value);

watch(ticking, (on) => {
  if (on) {
    if (frame === null) frame = requestAnimationFrame(frameLoop);
    return;
  }
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
});

function onVisibilityChange(): void {
  if (!document.hidden) tick();
}

/* ------------------------------------------------------------------ *
 * document title
 * ------------------------------------------------------------------ */

let baseTitle = "";
let appliedTitle = "";

function syncTitle(): void {
  if (!baseTitle) return;
  const next =
    mode.value === "countdown" && cdRunning.value
      ? `${countdownText.value} ${titleLabel.value}`
      : baseTitle;
  if (next === appliedTitle) return;
  document.title = next;
  appliedTitle = next;
}

/* ------------------------------------------------------------------ *
 * alarm: chime, flash, notification
 * ------------------------------------------------------------------ */

let audioCtx: AudioContext | null = null;
let chimeBuffer: AudioBuffer | null = null;

/** Called from a click only, so the context comes up running. */
function primeAudio(): void {
  if (typeof AudioContext === "undefined") return;
  try {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
      chimeBuffer = null;
    }
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    // A browser that refuses to open an AudioContext just stays silent.
    audioCtx = null;
  }
}

function playChime(): void {
  const ctx = audioCtx;
  if (!soundOn.value || !ctx || ctx.state === "closed") return;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    if (!chimeBuffer) {
      const samples = renderChimeSamples(ctx.sampleRate);
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.getChannelData(0).set(samples);
      chimeBuffer = buffer;
    }
    const gain = ctx.createGain();
    gain.gain.value = CHIME_GAIN;
    gain.connect(ctx.destination);
    const node = ctx.createBufferSource();
    node.buffer = chimeBuffer;
    node.connect(gain);
    node.start();
  } catch {
    // Playback failed, which is not worth interrupting the countdown for.
  }
}

function toggleSound(): void {
  soundOn.value = !soundOn.value;
  if (!soundOn.value) return;
  primeAudio();
  // Preview the alarm, but never while a countdown is running: that would
  // sound exactly like the timer going off.
  if (!cdRunning.value) playChime();
}

function toggleNotify(): void {
  if (notifyOn.value) {
    notifyOn.value = false;
    return;
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    notifyOn.value = true;
    return;
  }
  Notification.requestPermission()
    .then((permission) => {
      notifyOn.value = permission === "granted";
    })
    .catch(() => {
      notifyOn.value = false;
    });
}

function showNotification(): void {
  if (!notifyOn.value || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(titleLabel.value, { body: "The countdown reached zero." });
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}

function startFlash(): void {
  flashing.value = true;
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashing.value = false;
    flashTimer = null;
  }, FLASH_MS);
}

/* ------------------------------------------------------------------ *
 * countdown transport
 * ------------------------------------------------------------------ */

function startCountdown(): void {
  primeAudio();
  actionError.value = null;

  const held = cdHeldMs.value;
  const resume = !cdFinished.value && held !== null && held > 0 ? held : null;
  const ms = resume ?? plannedMs.value;
  if (ms === null) return;
  if (ms <= 0) {
    actionError.value = {
      message: "That target has already passed.",
      fix: "Pick a date and time in the future, or switch to a duration.",
    };
    return;
  }

  const now = Date.now();
  nowMs.value = now;
  cdEndAtMs.value = now + ms;
  if (resume === null) cdTotalMs.value = ms;
  cdHeldMs.value = null;
  cdFinished.value = false;
  flashing.value = false;
  cdRunning.value = true;
  writeState();
  syncTitle();
}

function pauseCountdown(): void {
  if (!cdRunning.value || cdEndAtMs.value === null) return;
  const now = Date.now();
  nowMs.value = now;
  cdHeldMs.value = Math.max(0, cdEndAtMs.value - now);
  cdEndAtMs.value = null;
  cdRunning.value = false;
  writeState();
  syncTitle();
}

function resetCountdown(): void {
  cdRunning.value = false;
  cdFinished.value = false;
  cdEndAtMs.value = null;
  cdHeldMs.value = null;
  cdTotalMs.value = 0;
  flashing.value = false;
  actionError.value = null;
  writeState();
  syncTitle();
}

function finish(): void {
  cdRunning.value = false;
  cdFinished.value = true;
  // cdEndAtMs is deliberately kept: it is the instant this run ended, and the
  // "Ended at" line reads it. cdRunning is what gates the live countdown.
  cdHeldMs.value = 0;
  startFlash();
  playChime();
  showNotification();
  writeState();
  syncTitle();
}

function usePreset(minutes: number): void {
  source.value = "duration";
  durationText.value = `${minutes}m`;
  resetCountdown();
}

/* ------------------------------------------------------------------ *
 * stopwatch transport
 * ------------------------------------------------------------------ */

function startStopwatch(): void {
  if (swRunning.value) return;
  const now = Date.now();
  nowMs.value = now;
  swStartedAtMs.value = now;
  swRunning.value = true;
  writeState();
}

function stopStopwatch(): void {
  if (!swRunning.value) return;
  const now = Date.now();
  nowMs.value = now;
  swAccumulatedMs.value += Math.max(0, now - swStartedAtMs.value);
  swRunning.value = false;
  writeState();
}

function resetStopwatch(): void {
  swRunning.value = false;
  swStartedAtMs.value = 0;
  swAccumulatedMs.value = 0;
  laps.value = [];
  writeState();
}

function recordLap(): void {
  const elapsed = swElapsedMs.value;
  const already = lapStats(laps.value).total;
  laps.value = [...laps.value, Math.max(0, elapsed - already)];
}

/* ------------------------------------------------------------------ *
 * fragment state, encoded by the logic layer
 * ------------------------------------------------------------------ */

let ready = false;

function currentState(): TimerState {
  const state: TimerState = { kind: "countdown" };

  if (mode.value === "stopwatch") {
    state.kind = "stopwatch";
    // The effective origin, so a resumed stopwatch still restores exactly.
    if (swRunning.value) state.startedAtMs = Date.now() - swElapsedMs.value;
  } else if (source.value === "target") {
    state.kind = "until";
    const target =
      cdRunning.value && cdEndAtMs.value !== null ? cdEndAtMs.value : targetParse.value.ms;
    if (target !== null) state.targetMs = target;
  } else {
    const total = cdTotalMs.value > 0 ? cdTotalMs.value : durationParse.value.ms;
    if (total !== null && total > 0) state.seconds = Math.round(total / 1000);
    if (cdRunning.value && cdEndAtMs.value !== null && cdTotalMs.value > 0) {
      state.startedAtMs = cdEndAtMs.value - cdTotalMs.value;
    }
  }

  const trimmed = timerLabel.value.trim();
  if (trimmed) state.label = trimmed;
  return state;
}

function writeState(): void {
  if (!ready) return;
  const input =
    mode.value === "stopwatch"
      ? ""
      : source.value === "duration"
        ? durationText.value.trim()
        : targetText.value.trim();
  writeFragment({ input, opts: { t: encodeTimerState(currentState()), style: styleId.value } });
}

watch([mode, source, durationText, targetText, timerLabel, styleId], () => writeState());

function restore(): void {
  const fragment = readFragment();

  const styleFromHash = fragment.opts["style"];
  if (styleFromHash && STYLE_VALUES.has(styleFromHash)) styleId.value = styleFromHash;

  const encoded = fragment.opts["t"];
  if (!encoded) {
    if (fragment.input) durationText.value = fragment.input;
    return;
  }

  const state = decodeTimerState(encoded);
  if (state.label) timerLabel.value = state.label;
  const now = Date.now();

  if (state.kind === "stopwatch") {
    mode.value = "stopwatch";
    if (state.startedAtMs !== undefined && state.startedAtMs <= now) {
      swStartedAtMs.value = state.startedAtMs;
      swAccumulatedMs.value = 0;
      swRunning.value = true;
    }
    return;
  }

  if (state.kind === "until") {
    source.value = "target";
    if (fragment.input) targetText.value = fragment.input;
    else if (state.targetMs !== undefined) {
      targetText.value = `${new Date(state.targetMs).toISOString().slice(0, 16)}Z`;
    }
    // The link's instant is the truth; the text beside it is only a label
    // until the reader changes it.
    pinnedText = targetText.value;
    if (state.targetMs !== undefined) pinnedTargetMs.value = state.targetMs;
    if (state.targetMs !== undefined && state.targetMs > now) {
      cdEndAtMs.value = state.targetMs;
      cdTotalMs.value = state.targetMs - now;
      cdRunning.value = true;
    }
    return;
  }

  source.value = "duration";
  if (fragment.input) durationText.value = fragment.input;
  else if (state.seconds !== undefined) durationText.value = `${state.seconds}s`;

  if (state.seconds !== undefined && state.startedAtMs !== undefined) {
    const endAt = state.startedAtMs + state.seconds * 1000;
    cdTotalMs.value = state.seconds * 1000;
    if (endAt > now) {
      cdEndAtMs.value = endAt;
      cdRunning.value = true;
    } else {
      // It ran out while the tab was closed. Show zero, stay silent.
      cdEndAtMs.value = endAt;
      cdHeldMs.value = 0;
      cdFinished.value = true;
    }
  }
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  baseTitle = document.title;
  appliedTitle = baseTitle;
  try {
    localZone.value = new Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    localZone.value = "";
  }
  notifySupported.value = typeof Notification !== "undefined";
  notifyOn.value = notifySupported.value && Notification.permission === "granted";

  restore();
  nowMs.value = Date.now();
  ready = true;

  interval = setInterval(tick, TICK_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (interval !== null) clearInterval(interval);
  interval = null;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = null;
  if (baseTitle) document.title = baseTitle;
  if (audioCtx) void audioCtx.close();
  audioCtx = null;
  chimeBuffer = null;
});
</script>

<template>
  <div
    class="timer-shell flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
  >
    <!-- mode -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Mode
      </span>
      <div class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
        <Button
          variant="ghost"
          size="sm"
          :aria-pressed="mode === 'countdown'"
          :class="mode === 'countdown' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
          @click="mode = 'countdown'"
        >
          Countdown
        </Button>
        <Button
          variant="ghost"
          size="sm"
          :aria-pressed="mode === 'stopwatch'"
          :class="mode === 'stopwatch' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
          @click="mode = 'stopwatch'"
        >
          Stopwatch
        </Button>
      </div>
    </div>

    <!-- the clock -->
    <div
      class="flex flex-col items-center gap-3 rounded-[10px] bg-secondary p-5 shadow-[var(--sh-inset)]"
    >
      <p v-if="timerLabel.trim()" class="text-sm text-muted-foreground">
        {{ timerLabel.trim() }}
      </p>

      <output
        class="timer-digits block w-full text-center font-mono font-semibold tracking-[-0.02em] break-words tabular-nums"
        :data-size="displaySize"
        :class="flashing ? 'timer-flash text-primary' : ''"
        aria-live="off"
      >
        {{ displayText }}
      </output>

      <!-- The digits change every frame, so the spoken update is this line,
           refreshed only when the run state changes. -->
      <p class="sr-only" role="status" aria-live="polite">
        {{
          mode === "stopwatch"
            ? swRunning
              ? "Stopwatch running"
              : "Stopwatch stopped"
            : cdFinished
              ? "Countdown finished"
              : cdRunning
                ? "Countdown running"
                : "Countdown ready"
        }}
      </p>

      <div
        v-if="mode === 'countdown'"
        class="h-1.5 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        :aria-valuemin="0"
        :aria-valuemax="100"
        :aria-valuenow="Math.round(progress * 100)"
        aria-label="Countdown progress"
      >
        <div
          class="h-full rounded-full bg-[image:var(--grad-brand)] transition-[width] duration-150 ease-out"
          :style="{ width: `${progress * 100}%` }"
        ></div>
      </div>

      <p v-if="mode === 'countdown' && endsAtText" class="text-xs text-muted-foreground">
        {{ cdFinished ? "Ended at" : "Ends at" }} {{ endsAtText }}
      </p>
    </div>

    <!-- countdown -->
    <template v-if="mode === 'countdown'">
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Count down
          </span>
          <div class="inline-flex gap-1 rounded-[10px] bg-card p-1">
            <Button
              variant="ghost"
              size="sm"
              :aria-pressed="source === 'duration'"
              :class="source === 'duration' ? 'bg-secondary' : ''"
              @click="source = 'duration'"
            >
              From a duration
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :aria-pressed="source === 'target'"
              :class="source === 'target' ? 'bg-secondary' : ''"
              @click="source = 'target'"
            >
              To a date and time
            </Button>
          </div>
        </div>

        <div v-if="source === 'duration'" class="flex flex-col gap-3">
          <div class="flex flex-col gap-1.5">
            <Label for="timer-duration" class="text-xs text-muted-foreground">Duration</Label>
            <Input
              id="timer-duration"
              v-model="durationText"
              type="text"
              inputmode="text"
              spellcheck="false"
              autocomplete="off"
              autocapitalize="off"
              placeholder="5m, 1h 30m, 90, 2:30, 01:30:00"
              class="bg-card font-mono tabular-nums"
              :aria-invalid="durationParse.error ? 'true' : undefined"
            />
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="minutes in PRESET_MINUTES"
              :key="minutes"
              type="button"
              class="rounded-[8px] border bg-card px-2.5 py-1 text-xs tabular-nums transition-colors duration-[120ms] hover:bg-accent"
              :class="
                durationText.trim() === `${minutes}m`
                  ? 'border-primary text-primary'
                  : 'border-border text-muted-foreground'
              "
              @click="usePreset(minutes)"
            >
              {{ minutes }} min
            </button>
          </div>
        </div>

        <div v-else class="flex flex-col gap-1.5">
          <Label for="timer-target" class="text-xs text-muted-foreground">Date and time</Label>
          <Input
            id="timer-target"
            v-model="targetText"
            type="text"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            placeholder="2026-12-31T23:59"
            class="bg-card font-mono tabular-nums"
            :aria-invalid="targetParse.error ? 'true' : undefined"
          />
          <p class="text-xs text-muted-foreground">
            Read in your own time zone{{ localZone ? ` (${localZone})` : "" }}. Add an IANA zone
            name such as 2026-12-31 15:00 America/Chicago, or an offset such as
            2026-12-31T15:00-06:00, to pin it somewhere else.
          </p>
        </div>

        <div class="flex flex-wrap items-end gap-3">
          <div class="flex min-w-40 flex-1 flex-col gap-1.5">
            <Label for="timer-label" class="text-xs text-muted-foreground">Label (optional)</Label>
            <Input
              id="timer-label"
              v-model="timerLabel"
              type="text"
              autocomplete="off"
              placeholder="Tea timer"
              class="bg-card"
            />
          </div>
          <div class="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label for="timer-style" class="text-xs text-muted-foreground">
              Remaining time style
            </Label>
            <SearchableSelect
              id="timer-style"
              :spec="styleSpec"
              :model-value="styleId"
              @update:model-value="(v: string) => (styleId = v)"
            />
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button v-if="cdRunning" type="button" @click="pauseCountdown">
          <Pause class="size-3.5" aria-hidden="true" />
          Pause
        </Button>
        <Button v-else type="button" :disabled="!canStartCountdown" @click="startCountdown">
          <Play class="size-3.5" aria-hidden="true" />
          {{ cdHeldMs !== null && cdHeldMs > 0 ? "Resume" : "Start" }}
        </Button>

        <Button type="button" variant="outline" @click="resetCountdown">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset
        </Button>

        <div class="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :aria-pressed="soundOn"
            @click="toggleSound"
          >
            <Volume2 v-if="soundOn" class="size-3.5" aria-hidden="true" />
            <VolumeX v-else class="size-3.5" aria-hidden="true" />
            {{ soundOn ? "Chime on" : "Chime off" }}
          </Button>
          <Button
            v-if="notifySupported"
            type="button"
            variant="ghost"
            size="sm"
            :aria-pressed="notifyOn"
            @click="toggleNotify"
          >
            <Bell v-if="notifyOn" class="size-3.5" aria-hidden="true" />
            <BellOff v-else class="size-3.5" aria-hidden="true" />
            {{ notifyOn ? "Notify on" : "Notify off" }}
          </Button>
        </div>
      </div>
    </template>

    <!-- stopwatch -->
    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <Button v-if="swRunning" type="button" @click="stopStopwatch">
          <Pause class="size-3.5" aria-hidden="true" />
          Stop
        </Button>
        <Button v-else type="button" @click="startStopwatch">
          <Play class="size-3.5" aria-hidden="true" />
          {{ swElapsedMs > 0 ? "Resume" : "Start" }}
        </Button>

        <Button type="button" variant="outline" :disabled="!swRunning" @click="recordLap">
          <Flag class="size-3.5" aria-hidden="true" />
          Lap
        </Button>

        <Button
          type="button"
          variant="outline"
          :disabled="swElapsedMs === 0 && laps.length === 0"
          @click="resetStopwatch"
        >
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset
        </Button>
      </div>

      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Laps
          </span>
          <CopyButton v-if="laps.length > 0" :text="lapsText" label="Copy laps" />
        </div>

        <p v-if="laps.length === 0" class="text-sm text-muted-foreground">
          Press Lap while the stopwatch runs to record a split. Splits stay in this tab: your files
          and inputs never leave your device.
        </p>

        <template v-else>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-xs text-muted-foreground">
                  <th scope="col" class="py-1 pr-3 text-left font-normal">Lap</th>
                  <th scope="col" class="py-1 pr-3 text-left font-normal">Split</th>
                  <th scope="col" class="py-1 text-left font-normal">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in lapRows" :key="row.index" class="border-t border-border">
                  <td class="py-1 pr-3 font-mono tabular-nums">{{ row.index }}</td>
                  <td
                    class="py-1 pr-3 font-mono tabular-nums"
                    :class="
                      laps.length > 1 && row.split === stats.fastest
                        ? 'text-[color:var(--positive)]'
                        : laps.length > 1 && row.split === stats.slowest
                          ? 'text-destructive'
                          : ''
                    "
                  >
                    {{ formatStopwatch(row.split) }}
                  </td>
                  <td class="py-1 font-mono text-muted-foreground tabular-nums">
                    {{ formatStopwatch(row.total) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <dl class="flex flex-wrap gap-x-6 gap-y-2">
            <div class="flex flex-col gap-0.5">
              <dt class="text-xs text-muted-foreground">Fastest</dt>
              <dd class="font-mono text-sm tabular-nums">{{ formatStopwatch(stats.fastest) }}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt class="text-xs text-muted-foreground">Slowest</dt>
              <dd class="font-mono text-sm tabular-nums">{{ formatStopwatch(stats.slowest) }}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt class="text-xs text-muted-foreground">Average</dt>
              <dd class="font-mono text-sm tabular-nums">{{ formatStopwatch(stats.average) }}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt class="text-xs text-muted-foreground">Total</dt>
              <dd class="font-mono text-sm tabular-nums">{{ formatStopwatch(stats.total) }}</dd>
            </div>
          </dl>
        </template>
      </div>
    </template>

    <!-- errors -->
    <div
      v-if="fieldError || actionError"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <template v-for="err in [fieldError, actionError]" :key="err?.message">
        <template v-if="err">
          <span class="font-semibold text-destructive">{{ err.message }}</span>
          <span v-if="err.fix" class="text-muted-foreground">{{ err.fix }}</span>
        </template>
      </template>
    </div>

    <p class="text-xs text-muted-foreground">
      The countdown travels in the link's fragment, so sharing or reopening the page picks the same
      timer back up. Laps are held in this tab only and are not written to the link. Everything runs
      here: your files and inputs never leave your device.
    </p>
  </div>
</template>

<style scoped>
.timer-shell {
  container-type: inline-size;
}

/* The vw pair is the fallback for engines without container query units;
   the cqi pair wins wherever it parses, so the digits track the panel's own
   width rather than the viewport's, which is what a pop out window needs. */
.timer-digits {
  line-height: 1.05;
  font-size: clamp(2rem, 13vw, 5.5rem);
  font-size: clamp(2rem, 17cqi, 5.5rem);
}

.timer-digits[data-size="md"] {
  font-size: clamp(1.5rem, 9vw, 3.25rem);
  font-size: clamp(1.5rem, 11cqi, 3.25rem);
}

.timer-digits[data-size="sm"] {
  font-size: clamp(1.125rem, 5.5vw, 2rem);
  font-size: clamp(1.125rem, 7cqi, 2rem);
}

.timer-flash {
  animation: timer-flash 600ms steps(1, end) 4;
}

@keyframes timer-flash {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

/* Reduced motion keeps the violet color change and drops the blink. */
@media (prefers-reduced-motion: reduce) {
  .timer-flash {
    animation: none;
  }
}
</style>
