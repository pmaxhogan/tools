<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Bell, BellOff, Pause, Play, RotateCcw, SkipForward } from "lucide-vue-next";
import { ToolError, type OptionSpec, type ToolMeta } from "@/tools/types";
import {
  buildSchedule,
  chimeSamples,
  decodeState,
  encodeState,
  formatClock,
  nextTransition,
  phaseAt,
  run,
  summarizeDay,
  totalDuration,
  type ChimeKind,
  type Phase,
  type PhaseKind,
  type TimerConfig,
  type TimerState,
} from "@/tools/pomodoro-timer/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import ErrorBanner from "../ErrorBanner.vue";
import OptionControl from "../OptionControl.vue";
import { Button } from "@/components/ui/button";

/**
 * Bespoke panel for the Pomodoro Timer.
 *
 * The generic ToolShell can only print the schedule as text. A timer has to
 * run, so this panel owns the live parts and nothing else: the interval that
 * samples the wall clock, the WebAudio chime, the page title, and the URL
 * fragment. Every number it shows still comes from the pure layer at
 * `src/tools/pomodoro-timer/` (PROJECT.md rule 27): buildSchedule, phaseAt,
 * totalDuration, nextTransition, summarizeDay, formatClock, chimeSamples,
 * encodeState, decodeState, and run.
 *
 * Three choices worth knowing about:
 *
 * - Time is never accumulated. The single source of truth is total elapsed
 *   milliseconds since the start of the whole schedule, derived from
 *   `startedAtMs` plus the banked `elapsedBeforePauseMs`. The interval only
 *   samples `Date.now()`, so a throttled or skipped tick cannot make the
 *   countdown drift, and returning to a backgrounded tab resyncs on
 *   visibilitychange.
 * - The current phase is derived, never stored. `phaseAt` locates it from the
 *   elapsed total, so skipping banks elapsed forward to the next boundary
 *   rather than nudging an index that the schedule math would then disagree
 *   with. The `pi` field in the shared link mirrors that derived value.
 * - Audio is created inside a click, never on mount, so the server rendered
 *   shell is silent and the browser autoplay policy never suspends the
 *   context. Crossing several boundaries at once, after a sleep or a long
 *   spell in the background, plays exactly one chime, never a burst.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** How often the wall clock is sampled. Fine enough for a smooth ring. */
const TICK_MS = 250;
/** Extra delay on the boundary timeout, so it always lands past the edge. */
const BOUNDARY_GRACE_MS = 20;
/** Chime output level. Well below full scale: this fires without warning. */
const CHIME_GAIN = 0.35;

/** Ring geometry, in the SVG's own user units. */
const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Sentinel for "the whole schedule is finished" in the boundary tracker. */
const FINISHED_INDEX = -1;

/** Panel copy for each phase. The logic layer calls the working phase "work"; a
 * timer people stare at reads better as "Focus". */
const PHASE_LABEL: Record<PhaseKind, string> = {
  work: "Focus",
  short: "Short break",
  long: "Long break",
};

/** One accent per phase, taken from the design tokens so both themes work. It
 * paints the ring, the phase dot, and the session dots, never body text, so
 * contrast stays comfortable in light and dark. */
const PHASE_ACCENT: Record<PhaseKind, string> = {
  work: "var(--primary)",
  short: "var(--positive)",
  long: "var(--chart-2)",
};

/** Fallback used while the options describe a schedule that cannot be built. */
const FALLBACK_SCHEDULE: Phase[] = buildSchedule();

/* ------------------------------------------------------------------ *
 * options, driven by the tool's own meta
 * ------------------------------------------------------------------ */

interface FieldError {
  message: string;
  fix?: string;
}

function toFieldError(err: unknown, fallback: string): FieldError {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : fallback };
}

function defaultOpts(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of props.meta.options ?? []) out[spec.id] = spec.default;
  return out;
}

const opts = ref<Record<string, unknown>>(defaultOpts());

/** The five schedule numbers. Locked while a run is in flight, so the playhead
 * can never be moved out from under itself. */
const numberSpecs = computed<OptionSpec[]>(() =>
  (props.meta.options ?? []).filter((o) => o.kind === "number"),
);

/** The auto advance toggle is the tool's own `autoStartBreaks` option. */
const autoSpec = computed<OptionSpec | undefined>(() =>
  props.meta.options?.find((o) => o.id === "autoStartBreaks"),
);

function numberOpt(id: string, fallback: number): number {
  const raw = opts.value[id];
  return raw === undefined || raw === null ? fallback : Number(raw);
}

const config = computed<TimerConfig>(() => ({
  work: numberOpt("work", 25),
  shortBreak: numberOpt("shortBreak", 5),
  longBreak: numberOpt("longBreak", 15),
  cyclesBeforeLong: numberOpt("cyclesBeforeLong", 4),
  sessions: numberOpt("sessions", 8),
  autoStartBreaks: Boolean(opts.value["autoStartBreaks"]),
}));

/* ------------------------------------------------------------------ *
 * timer state
 *
 * `nowMs` starts at 0 rather than Date.now() so the server render and the
 * first client render agree; onMounted samples the real clock.
 * ------------------------------------------------------------------ */

const nowMs = ref(0);
const startedAtMs = ref<number | undefined>(undefined);
const pausedAtMs = ref<number | undefined>(undefined);
const elapsedBeforePauseMs = ref(0);

const chimeOn = ref(true);
const stateError = ref<FieldError | null>(null);

/** Guards the fragment write and the title until the panel is really mounted. */
let ready = false;
/** The phase the panel last announced, so a boundary is only handled once. */
let lastPhaseIndex = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
let originalTitle: string | null = null;
let audioCtx: AudioContext | null = null;

const isRunning = computed(() => startedAtMs.value !== undefined && pausedAtMs.value === undefined);
const hasStarted = computed(() => startedAtMs.value !== undefined);

/* ------------------------------------------------------------------ *
 * derived schedule and playhead
 * ------------------------------------------------------------------ */

interface ScheduleInfo {
  schedule: Phase[];
  error: FieldError | null;
}

const scheduleInfo = computed<ScheduleInfo>(() => {
  try {
    const c = config.value;
    return {
      schedule: buildSchedule({
        work: c.work,
        shortBreak: c.shortBreak,
        longBreak: c.longBreak,
        cyclesBeforeLong: c.cyclesBeforeLong,
        sessions: c.sessions,
      }),
      error: null,
    };
  } catch (err) {
    return {
      schedule: FALLBACK_SCHEDULE,
      error: toFieldError(err, "That schedule cannot be built."),
    };
  }
});

const schedule = computed<Phase[]>(() => scheduleInfo.value.schedule);
const totalMs = computed(() => totalDuration(schedule.value));

const elapsedMs = computed(() => {
  if (startedAtMs.value === undefined || pausedAtMs.value !== undefined) {
    return elapsedBeforePauseMs.value;
  }
  return elapsedBeforePauseMs.value + Math.max(0, nowMs.value - startedAtMs.value);
});

const playhead = computed(() => phaseAt(schedule.value, elapsedMs.value));
const isFinished = computed(() => elapsedMs.value >= totalMs.value);

const currentPhase = computed<Phase>(() => playhead.value.phase);
const phaseLabel = computed(() => PHASE_LABEL[currentPhase.value.kind]);
const accent = computed(() => PHASE_ACCENT[currentPhase.value.kind]);
const clockLabel = computed(() => formatClock(playhead.value.remainingMs));
const ringOffset = computed(
  () => RING_CIRCUMFERENCE * Math.min(1, Math.max(0, playhead.value.progress)),
);

/** Total schedule length, formatted by the logic layer rather than here. */
const totalLabel = computed<string | null>(() => {
  const c = config.value;
  try {
    const summary = run("", {
      work: c.work,
      shortBreak: c.shortBreak,
      longBreak: c.longBreak,
      cyclesBeforeLong: c.cyclesBeforeLong,
      sessions: c.sessions,
      autoStartBreaks: c.autoStartBreaks,
    });
    return summary["Total duration"] ?? null;
  } catch {
    return null;
  }
});

const workPhases = computed<Phase[]>(() => schedule.value.filter((p) => p.kind === "work"));

/** Completed work phases, counted by the logic layer. */
const sessionsDone = computed(() =>
  isFinished.value ? workPhases.value.length : playhead.value.sessionsDone,
);

/** The dot that is lit right now, or -1 during a break and after the last phase. */
const currentSessionIndex = computed(() =>
  !isFinished.value && currentPhase.value.kind === "work" ? playhead.value.sessionsDone : -1,
);

const focused = computed(() => summarizeDay(workPhases.value.slice(0, sessionsDone.value)));

const focusedLabel = computed(() => {
  const done = focused.value;
  return `${done.focusedMinutes} min, ${done.sessions} ${done.sessions === 1 ? "session" : "sessions"}`;
});

/* ------------------------------------------------------------------ *
 * schedule overview
 * ------------------------------------------------------------------ */

/** Milliseconds from the start of the schedule to the start of phase `index`. */
function offsetOf(list: Phase[], index: number): number {
  let sum = 0;
  for (let i = 0; i < index && i < list.length; i++) sum += list[i]!.minutes * 60_000;
  return sum;
}

/**
 * The instant the schedule started, or would start if you pressed Start now.
 * Rounded to the second: while a run is live this value is constant (the
 * sampled clock cancels out), and while it is idle the rounding keeps the
 * projected times from being rebuilt four times a second.
 */
const anchorMs = computed<number | null>(() => {
  if (nowMs.value === 0) return null;
  return Math.round((nowMs.value - elapsedMs.value) / 1000) * 1000;
});

/** Built on first use, so the reader's locale is read in the browser. */
let timeFormat: Intl.DateTimeFormat | null = null;

function formatTimeOfDay(ms: number): string {
  timeFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return timeFormat.format(ms);
}

interface ScheduleRow {
  key: number;
  label: string;
  minutes: number;
  accent: string;
  endsAt: string | null;
  state: "done" | "current" | "upcoming";
}

const scheduleRows = computed<ScheduleRow[]>(() => {
  const list = schedule.value;
  const anchor = anchorMs.value;
  const at = playhead.value.phaseIndex;
  return list.map((phase, i) => ({
    key: phase.index,
    label: PHASE_LABEL[phase.kind],
    minutes: phase.minutes,
    accent: PHASE_ACCENT[phase.kind],
    endsAt: anchor === null ? null : formatTimeOfDay(anchor + offsetOf(list, i + 1)),
    state: isFinished.value || i < at ? "done" : i === at ? "current" : "upcoming",
  }));
});

/* ------------------------------------------------------------------ *
 * fragment state
 * ------------------------------------------------------------------ */

function timerState(): TimerState {
  const state: TimerState = {
    config: config.value,
    elapsedBeforePauseMs: elapsedBeforePauseMs.value,
    phaseIndex: playhead.value.phaseIndex,
  };
  if (startedAtMs.value !== undefined) state.startedAtMs = startedAtMs.value;
  if (pausedAtMs.value !== undefined) state.pausedAtMs = pausedAtMs.value;
  return state;
}

/**
 * Mirror the timer into the URL fragment. Only on a real transition, never on
 * a tick: elapsed derives from `startedAtMs`, so the link stays correct
 * without a `history.replaceState` call every quarter second.
 */
function persist(): void {
  if (!ready) return;
  const params = new URLSearchParams(encodeState(timerState()));
  const flat: Record<string, string> = {};
  for (const [key, value] of params) flat[key] = value;
  writeFragment({ opts: flat });
}

/* ------------------------------------------------------------------ *
 * the chime
 * ------------------------------------------------------------------ */

/** Called from a click, so the autoplay policy lets the context start. */
function ensureAudio(): void {
  if (audioCtx) {
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return;
  }
  try {
    audioCtx = new AudioContext();
  } catch {
    // No audio in this browser. The timer itself still runs.
    audioCtx = null;
  }
}

function playChime(kind: ChimeKind): void {
  const ctx = audioCtx;
  if (!chimeOn.value || !ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  try {
    const samples = chimeSamples(ctx.sampleRate, kind);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = CHIME_GAIN;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  } catch {
    // A chime that will not play is not worth an error banner.
  }
}

/* ------------------------------------------------------------------ *
 * the clock
 * ------------------------------------------------------------------ */

/**
 * Reconcile the derived phase with the last one the panel announced.
 *
 * Everything here is driven by the elapsed total, so a tick that arrives late,
 * or a machine that slept through three phases, lands on the right phase and
 * plays a single chime rather than one per boundary.
 */
function syncPhase(): void {
  if (startedAtMs.value === undefined || pausedAtMs.value !== undefined) return;

  const list = schedule.value;
  const total = totalDuration(list);

  if (elapsedMs.value >= total) {
    elapsedBeforePauseMs.value = total;
    pausedAtMs.value = Date.now();
    if (lastPhaseIndex !== FINISHED_INDEX) {
      lastPhaseIndex = FINISHED_INDEX;
      playChime("work-end");
    }
    commit();
    return;
  }

  const index = phaseAt(list, elapsedMs.value).phaseIndex;
  if (index === lastPhaseIndex) return;

  // With auto advance off, stop on the first boundary crossed, not the last.
  const target = config.value.autoStartBreaks ? index : Math.min(lastPhaseIndex + 1, index);
  if (!config.value.autoStartBreaks) {
    // Bank the exact boundary, not the current instant, so nothing accrues.
    elapsedBeforePauseMs.value = offsetOf(list, target);
    pausedAtMs.value = Date.now();
  }
  lastPhaseIndex = target;
  playChime(list[target]?.kind === "work" ? "break-end" : "work-end");
  commit();
}

/**
 * Book the next phase change on its own timeout, using the logic layer's
 * `nextTransition`. The sampling interval alone would do, but a backgrounded
 * tab clamps intervals to about one a second, and a chime a second late is a
 * chime in the wrong phase.
 */
function scheduleBoundary(): void {
  if (boundaryTimer !== null) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }
  if (!ready) return;
  let ms: number | null;
  try {
    ms = nextTransition(timerState(), Date.now());
  } catch {
    // A schedule that cannot be built has no next boundary to book.
    ms = null;
  }
  if (ms === null) return;
  boundaryTimer = setTimeout(
    () => {
      boundaryTimer = null;
      nowMs.value = Date.now();
      syncPhase();
      scheduleBoundary();
    },
    Math.max(0, ms) + BOUNDARY_GRACE_MS,
  );
}

/** Everything a transition owes the rest of the page. */
function commit(): void {
  persist();
  scheduleBoundary();
}

function tick(): void {
  nowMs.value = Date.now();
  syncPhase();
}

/* ------------------------------------------------------------------ *
 * transport
 * ------------------------------------------------------------------ */

function start(): void {
  if (isFinished.value || scheduleInfo.value.error) return;
  ensureAudio();
  nowMs.value = Date.now();
  startedAtMs.value = Date.now();
  pausedAtMs.value = undefined;
  lastPhaseIndex = playhead.value.phaseIndex;
  commit();
}

function pause(): void {
  if (!isRunning.value) return;
  // Sample the clock first: the last tick can be a quarter second stale, and
  // while paused the logic reads elapsedBeforePauseMs alone.
  nowMs.value = Date.now();
  elapsedBeforePauseMs.value = elapsedMs.value;
  pausedAtMs.value = Date.now();
  commit();
}

function toggle(): void {
  if (isRunning.value) pause();
  else start();
}

/** Jump to the start of the next phase, keeping the running or paused state. */
function skip(): void {
  if (isFinished.value || scheduleInfo.value.error) return;
  // Any transport click is a gesture, so it can arm the chime for a timer
  // that was restored from a link and never pressed Start here.
  ensureAudio();
  const list = schedule.value;
  const at = playhead.value.phaseIndex;
  const target = Math.min(at + 1, list.length);
  elapsedBeforePauseMs.value = target >= list.length ? totalMs.value : offsetOf(list, target);
  if (isRunning.value) startedAtMs.value = Date.now();
  nowMs.value = Date.now();
  lastPhaseIndex = elapsedMs.value >= totalMs.value ? FINISHED_INDEX : target;
  commit();
}

function reset(): void {
  startedAtMs.value = undefined;
  pausedAtMs.value = undefined;
  elapsedBeforePauseMs.value = 0;
  nowMs.value = Date.now();
  lastPhaseIndex = 0;
  stateError.value = null;
  commit();
}

const primaryLabel = computed(() => {
  if (isFinished.value) return "Done";
  if (isRunning.value) return "Pause";
  return hasStarted.value || elapsedBeforePauseMs.value > 0 ? "Resume" : "Start";
});

const canReset = computed(() => hasStarted.value || elapsedBeforePauseMs.value > 0);

function toggleChime(): void {
  chimeOn.value = !chimeOn.value;
  if (chimeOn.value) ensureAudio();
}

/* ------------------------------------------------------------------ *
 * page title
 * ------------------------------------------------------------------ */

function updateTitle(): void {
  if (!ready || originalTitle === null) return;
  document.title = isRunning.value
    ? `${clockLabel.value} ${phaseLabel.value} | ${props.meta.name}`
    : originalTitle;
}

watch([isRunning, clockLabel, phaseLabel], updateTitle);

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

function applyState(state: TimerState): void {
  opts.value = {
    work: state.config.work,
    shortBreak: state.config.shortBreak,
    longBreak: state.config.longBreak,
    cyclesBeforeLong: state.config.cyclesBeforeLong,
    sessions: state.config.sessions,
    autoStartBreaks: state.config.autoStartBreaks,
  };
  elapsedBeforePauseMs.value = state.elapsedBeforePauseMs;
  startedAtMs.value = state.startedAtMs;
  pausedAtMs.value = state.pausedAtMs;
}

function restoreFromFragment(): void {
  const frag = readFragment();
  // "w" is the first key encodeState writes, so its absence means this
  // fragment belongs to something else and should be left alone.
  if (frag.opts["w"] === undefined) return;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(frag.opts)) params.set(key, value);
  try {
    applyState(decodeState(params.toString()));
  } catch (err) {
    stateError.value = toFieldError(err, "That timer link could not be read.");
  }
}

function onVisibilityChange(): void {
  // Intervals are throttled while hidden, so resync against the wall clock.
  nowMs.value = Date.now();
  syncPhase();
  scheduleBoundary();
}

// Option edits are transitions too, but only ones the reader made: `ready`
// keeps the restore above from writing the fragment it just read.
watch(opts, () => commit(), { deep: true });

onMounted(() => {
  originalTitle = document.title;
  restoreFromFragment();
  nowMs.value = Date.now();
  lastPhaseIndex = isFinished.value ? FINISHED_INDEX : playhead.value.phaseIndex;
  ready = true;
  tickTimer = setInterval(tick, TICK_MS);
  scheduleBoundary();
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onUnmounted(() => {
  ready = false;
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = null;
  if (boundaryTimer !== null) clearTimeout(boundaryTimer);
  boundaryTimer = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (originalTitle !== null) document.title = originalTitle;
  if (audioCtx) void audioCtx.close();
  audioCtx = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- the phase clock -->
    <div
      class="flex flex-col items-center gap-4 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)] sm:p-6"
      :style="{ color: accent }"
    >
      <div class="relative aspect-square w-full max-w-[min(17rem,64vw)]">
        <svg viewBox="0 0 120 120" class="size-full -rotate-90" aria-hidden="true">
          <circle
            cx="60"
            cy="60"
            :r="RING_RADIUS"
            fill="none"
            stroke="var(--border)"
            stroke-width="7"
          />
          <circle
            cx="60"
            cy="60"
            :r="RING_RADIUS"
            fill="none"
            stroke="currentColor"
            stroke-width="7"
            stroke-linecap="round"
            :stroke-dasharray="RING_CIRCUMFERENCE"
            :stroke-dashoffset="ringOffset"
            class="transition-[stroke-dashoffset] duration-150 ease-out"
          />
        </svg>

        <div
          class="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center"
          role="timer"
          :aria-label="`${clockLabel} left in ${phaseLabel}`"
        >
          <span
            class="font-mono leading-none font-semibold text-foreground tabular-nums"
            style="font-size: clamp(2.25rem, 13vw, 4.25rem)"
            >{{ clockLabel }}</span
          >
          <span class="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <span
              class="size-2 shrink-0 rounded-full"
              :style="{ backgroundColor: accent }"
              aria-hidden="true"
            ></span>
            {{ phaseLabel }}
          </span>
          <span class="text-xs text-muted-foreground tabular-nums">
            {{
              isFinished
                ? "Schedule complete"
                : `Session ${Math.min(sessionsDone + 1, workPhases.length)} of ${workPhases.length}`
            }}
          </span>
        </div>
      </div>

      <!-- session dots -->
      <ol class="flex max-w-full flex-wrap justify-center gap-1.5" aria-label="Work sessions">
        <li
          v-for="(phase, i) in workPhases"
          :key="phase.index"
          class="size-2.5 rounded-full border transition-colors duration-[120ms]"
          :class="
            i < sessionsDone
              ? 'border-transparent bg-current'
              : i === currentSessionIndex
                ? 'scale-125 border-current bg-current/30'
                : 'border-border bg-transparent'
          "
          :title="`Session ${i + 1} of ${workPhases.length}`"
        ></li>
      </ol>

      <!-- transport -->
      <div class="flex flex-wrap items-center justify-center gap-2 text-foreground">
        <Button
          type="button"
          class="min-w-28"
          :disabled="isFinished || scheduleInfo.error !== null"
          @click="toggle"
        >
          <Pause v-if="isRunning" class="size-3.5" aria-hidden="true" />
          <Play v-else class="size-3.5" aria-hidden="true" />
          {{ primaryLabel }}
        </Button>
        <Button
          type="button"
          variant="outline"
          :disabled="isFinished || scheduleInfo.error !== null"
          @click="skip"
        >
          <SkipForward class="size-3.5" aria-hidden="true" />
          Skip
        </Button>
        <Button type="button" variant="outline" :disabled="!canReset" @click="reset">
          <RotateCcw class="size-3.5" aria-hidden="true" />
          Reset
        </Button>
        <Button
          type="button"
          variant="ghost"
          :aria-pressed="chimeOn"
          :title="chimeOn ? 'Turn the end of phase chime off' : 'Turn the end of phase chime on'"
          @click="toggleChime"
        >
          <Bell v-if="chimeOn" class="size-3.5" aria-hidden="true" />
          <BellOff v-else class="size-3.5" aria-hidden="true" />
          {{ chimeOn ? "Chime on" : "Chime off" }}
        </Button>
      </div>
    </div>

    <!-- options -->
    <div class="flex flex-col gap-3">
      <div
        class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        :class="hasStarted ? 'pointer-events-none opacity-55' : undefined"
        :aria-disabled="hasStarted ? 'true' : undefined"
      >
        <OptionControl
          v-for="spec in numberSpecs"
          :key="spec.id"
          v-model="opts[spec.id]"
          :spec="spec"
        />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <OptionControl v-if="autoSpec" v-model="opts['autoStartBreaks']" :spec="autoSpec" />
        <p class="text-xs text-muted-foreground">
          {{
            config.autoStartBreaks
              ? "Each phase rolls straight into the next one."
              : "The timer pauses at every phase change and waits for you."
          }}
        </p>
      </div>

      <p v-if="hasStarted" class="text-xs text-muted-foreground">
        The schedule is locked while a timer is running or paused. Press Reset to change it.
      </p>
    </div>

    <!-- errors -->
    <template v-for="(err, i) in [scheduleInfo.error, stateError]" :key="i">
      <ErrorBanner v-if="err" :message="err.message" :hint="err.fix" />
    </template>

    <!-- summary -->
    <dl class="flex flex-wrap gap-x-6 gap-y-2">
      <div class="flex flex-col gap-0.5">
        <dt class="text-xs text-muted-foreground">Focused so far</dt>
        <dd class="font-mono text-sm tabular-nums">{{ focusedLabel }}</dd>
      </div>
      <div v-if="totalLabel" class="flex flex-col gap-0.5">
        <dt class="text-xs text-muted-foreground">Whole schedule</dt>
        <dd class="font-mono text-sm tabular-nums">{{ totalLabel }}</dd>
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-xs text-muted-foreground">Work sessions</dt>
        <dd class="font-mono text-sm tabular-nums">
          {{ sessionsDone }} of {{ workPhases.length }} done
        </dd>
      </div>
    </dl>

    <!-- schedule overview -->
    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Schedule
      </span>
      <ol class="flex flex-col gap-1">
        <li
          v-for="(row, i) in scheduleRows"
          :key="row.key"
          class="flex items-center gap-3 rounded-[10px] px-2.5 py-1.5 text-sm"
          :class="
            row.state === 'current'
              ? 'bg-secondary shadow-[var(--sh-inset)]'
              : row.state === 'done'
                ? 'opacity-55'
                : undefined
          "
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :style="{ backgroundColor: row.accent }"
            aria-hidden="true"
          ></span>
          <span class="w-6 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {{ i + 1 }}
          </span>
          <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
          <span class="shrink-0 font-mono text-xs tabular-nums">{{ row.minutes }} min</span>
          <span
            v-if="row.endsAt"
            class="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums"
          >
            {{ row.endsAt }}
          </span>
        </li>
      </ol>
      <p class="text-xs text-muted-foreground">
        End times are projections from the current playhead, so they shift whenever you pause. The
        countdown is computed from timestamps rather than counted up, so it stays accurate while
        this tab is in the background, and the running timer lives in this page's URL: your files
        and inputs never leave your device.
      </p>
    </div>
  </div>
</template>
