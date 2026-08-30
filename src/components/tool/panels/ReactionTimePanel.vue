<script setup lang="ts">
/**
 * Bespoke panel for the Reaction Time Test.
 *
 * The pure logic layer (src/tools/reaction-time-test/index.ts) owns every
 * number: the seeded sequence of waits before the cue, the classification of
 * a press against the trial's phase (start, false start, or a real
 * reaction), and the summary statistics. This file only owns the DOM: the
 * target surface, the timeout that flips its color, and the pointer and
 * keyboard listeners that feed real timestamps into classifyPress.
 *
 * The cue itself never carries a CSS transition: a delayed flip would add
 * measurement bias to every reading, so the color change is instant. The
 * moment recorded as `cueAtMs` is read inside the timeout callback at the
 * instant of the flip, not the scheduled delay, so a throttled tab cannot
 * make a reading look faster than the target actually turned.
 *
 * Rounds is the only thing written to the URL fragment (rule 6): a run's
 * measured times are session state, not shareable content, so they are never
 * persisted anywhere.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Redo2, RotateCcw } from "lucide-vue-next";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  RATING_BANDS,
  TYPICAL_RANGE_MS,
  classifyPress,
  delayForTrial,
  report,
  type PressOutcome,
  type TrialPhase,
} from "@/tools/reaction-time-test/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import ProgressBar from "../ProgressBar.vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * Options: rounds only. The full choice list matches meta.ts, so a
 * scripted addition of a fourth round count there needs no change here.
 * ------------------------------------------------------------------ */

const roundsSpec = computed(() =>
  props.meta.options?.find((o) => o.id === "rounds" && o.kind === "select"),
);
const roundOptions = computed<SegmentedOption[]>(() =>
  roundsSpec.value?.kind === "select"
    ? (roundsSpec.value.options?.map((o) => ({ value: o.value, label: o.label })) ?? [])
    : [],
);
const defaultRounds = computed(() =>
  roundsSpec.value?.kind === "select" ? roundsSpec.value.default : "5",
);

const rounds = ref(defaultRounds.value);
const roundsN = computed(() => Number(rounds.value) || 5);

/* ------------------------------------------------------------------ *
 * Session seed: a fresh random draw per run, never written to the
 * fragment. Reaction times are measured live, so a replayable link would
 * only reproduce the waits, not the thing being measured.
 * ------------------------------------------------------------------ */

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

let sessionSeed = randomSeed();

/* ------------------------------------------------------------------ *
 * Trial state
 * ------------------------------------------------------------------ */

const trialPhase = ref<TrialPhase>("idle");
const trialIndex = ref(0);
/** The scheduled or actual cue time on the performance.now() clock. */
const cueAtMs = ref<number | null>(null);
const times = ref<number[]>([]);
const falseStarts = ref(0);
const lastOutcome = ref<PressOutcome | null>(null);
const panelError = ref<{ message: string; fix?: string } | null>(null);

let timeoutId: number | undefined;
const targetEl = ref<HTMLElement>();

const isDone = computed(() => trialPhase.value === "done");
const isWaiting = computed(() => trialPhase.value === "waiting");
const isCue = computed(() => trialPhase.value === "cue");

/** True once a round has actually started, used to pick the idle prompt. */
const started = computed(() => trialIndex.value > 0 || lastOutcome.value !== null || isDone.value);

function clearTimer() {
  if (timeoutId !== undefined) {
    window.clearTimeout(timeoutId);
    timeoutId = undefined;
  }
}

function resetAll() {
  clearTimer();
  sessionSeed = randomSeed();
  trialPhase.value = "idle";
  trialIndex.value = 0;
  cueAtMs.value = null;
  times.value = [];
  falseStarts.value = 0;
  lastOutcome.value = null;
  panelError.value = null;
}

function armRound() {
  panelError.value = null;
  try {
    const delay = delayForTrial(trialIndex.value, { seed: sessionSeed });
    const scheduledAt = performance.now() + delay;
    cueAtMs.value = scheduledAt;
    trialPhase.value = "waiting";
    timeoutId = window.setTimeout(() => {
      cueAtMs.value = performance.now();
      trialPhase.value = "cue";
    }, delay);
  } catch (e) {
    panelError.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: "That round could not be armed." };
  }
}

function finishReaction(timeMs: number) {
  times.value = [...times.value, timeMs];
  const next = trialIndex.value + 1;
  trialIndex.value = next;
  trialPhase.value = next >= roundsN.value ? "done" : "idle";
}

function handlePress(pressedAtMs: number) {
  const outcome = classifyPress({
    phase: trialPhase.value,
    pressedAtMs,
    cueAtMs: cueAtMs.value,
  });
  lastOutcome.value = outcome;

  if (outcome.kind === "start") {
    armRound();
  } else if (outcome.kind === "false-start") {
    clearTimer();
    falseStarts.value += 1;
    cueAtMs.value = null;
    trialPhase.value = "idle";
  } else if (outcome.kind === "reaction") {
    finishReaction(outcome.timeMs);
  }
  // "ignored" outcomes need no state change.
}

function onTargetPointerDown(e: PointerEvent) {
  e.preventDefault();
  handlePress(e.timeStamp);
}

/** Reaction key presses are read from the whole document, except on a real
 * form control, so choosing a rounds count with Space does not also count as
 * a reaction. The target area itself is exempt from that guard, since Tab
 * naturally lands focus there. */
function isFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target === targetEl.value) return false;
  return (
    ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"].includes(target.tagName) ||
    target.isContentEditable
  );
}

function onKeyDown(e: KeyboardEvent) {
  if (e.repeat) return;
  if (e.key !== " " && e.key !== "Spacebar" && e.key !== "Enter") return;
  if (isFormControl(e.target)) return;
  e.preventDefault();
  handlePress(e.timeStamp);
}

function onVisibilityChange() {
  if (document.hidden && (trialPhase.value === "waiting" || trialPhase.value === "cue")) {
    clearTimer();
    cueAtMs.value = null;
    trialPhase.value = "idle";
  }
}

function onRoundsChange(value: string) {
  rounds.value = value;
  resetAll();
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

const average = computed(() =>
  times.value.length ? times.value.reduce((s, t) => s + t, 0) / times.value.length : null,
);

const summaryRows = computed<Record<string, string> | null>(() => {
  if (!isDone.value || times.value.length === 0) return null;
  try {
    return report(times.value, falseStarts.value);
  } catch {
    return null;
  }
});

const summaryText = computed(() => {
  const rows = summaryRows.value;
  if (!rows) return "";
  return Object.entries(rows)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
});

/** Position (0 to 100) on the comparison scale for a millisecond reading. */
const SCALE_MIN_MS = 100;
const SCALE_MAX_MS = 400;
function scalePosition(ms: number): number {
  const clamped = Math.min(SCALE_MAX_MS, Math.max(SCALE_MIN_MS, ms));
  return ((clamped - SCALE_MIN_MS) / (SCALE_MAX_MS - SCALE_MIN_MS)) * 100;
}
const scaleTicks = [150, 200, 250, 300] as const;
const averageRatingLabel = computed(() => {
  const avg = average.value;
  if (avg === null) return null;
  const band = RATING_BANDS.find((b) => avg < b.maxMs) ?? RATING_BANDS[RATING_BANDS.length - 1]!;
  return band.label;
});

/* ------------------------------------------------------------------ *
 * Target area state (text and tone)
 * ------------------------------------------------------------------ */

const targetPrompt = computed(() => {
  if (isCue.value) return "React now";
  if (isWaiting.value) return "Wait for it to change color";
  if (isDone.value) return "Test complete";
  if (lastOutcome.value?.kind === "false-start") {
    return `Too soon, by ${Math.round(lastOutcome.value.earlyByMs)} ms. Click, tap, or press Space to try this round again.`;
  }
  if (lastOutcome.value?.kind === "reaction") {
    return `Round ${trialIndex.value} of ${roundsN.value}: ${Math.round(lastOutcome.value.timeMs)} ms. Click, tap, or press Space for the next round.`;
  }
  return "Click, tap, or press Space to start";
});

const targetToneClass = computed(() => {
  if (isCue.value) return "bg-[image:var(--grad-brand)] text-primary-foreground";
  if (lastOutcome.value?.kind === "false-start" && trialPhase.value === "idle")
    return "bg-secondary ring-2 ring-destructive/50";
  return "bg-secondary";
});

/* ------------------------------------------------------------------ *
 * Fragment: rounds only, never a live run's timing (rule 6)
 * ------------------------------------------------------------------ */

const mounted = ref(false);

watch(rounds, () => {
  if (!mounted.value) return;
  writeFragment({ opts: { rounds: rounds.value } });
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

onMounted(async () => {
  const frag = readFragment();
  const allowed = new Set(roundOptions.value.map((o) => o.value));
  if (frag.opts.rounds && allowed.has(frag.opts.rounds)) rounds.value = frag.opts.rounds;

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("visibilitychange", onVisibilityChange);

  await nextTick();
  mounted.value = true;
});

onBeforeUnmount(() => {
  clearTimer();
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <div
    class="reaction-time-test-root flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
  >
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Rounds
        </span>
        <Segmented
          :model-value="rounds"
          :options="roundOptions"
          label="Number of rounds"
          size="sm"
          @update:model-value="onRoundsChange"
        />
      </div>
      <Button variant="ghost" size="sm" @click="resetAll">
        <RotateCcw class="size-3.5" aria-hidden="true" />
        New test
      </Button>
    </div>

    <ProgressBar
      v-if="started"
      :value="(Math.min(trialIndex, roundsN) / roundsN) * 100"
      :label="`Round ${Math.min(trialIndex + (isDone ? 0 : isCue || isWaiting ? 1 : 0), roundsN)} of ${roundsN}`"
      :detail="`${times.length} of ${roundsN} timed`"
    />

    <ErrorBanner v-if="panelError" :message="panelError.message" :hint="panelError.fix" />

    <div
      ref="targetEl"
      role="button"
      tabindex="0"
      class="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-[14px] p-6 text-center shadow-[var(--sh-inset)] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      :class="targetToneClass"
      @pointerdown="onTargetPointerDown"
    >
      <p class="max-w-[52ch] text-base font-medium" aria-live="polite">{{ targetPrompt }}</p>
      <p v-if="isWaiting" class="text-xs opacity-80">Do not press yet.</p>
    </div>

    <p class="max-w-[68ch] text-xs text-muted-foreground">
      Every wait is drawn from a random 2 to 5 second range so the timing cannot be learned.
      Reacting before the target changes color counts as a false start, not a reaction, and does not
      use up a round. Your files and inputs never leave your device.
    </p>

    <!-- Results -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Results
        </span>
        <CopyButton v-if="summaryText" :text="summaryText" label="Copy results" />
      </div>

      <EmptyState
        v-if="times.length === 0"
        title="No results yet"
        hint="Complete a round to see your reaction times here."
      />

      <template v-else>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="(t, i) in times"
            :key="i"
            class="rounded-[8px] bg-secondary px-2.5 py-1 font-mono text-xs tabular-nums"
          >
            {{ i + 1 }}: {{ Math.round(t) }} ms
          </span>
        </div>

        <div v-if="average !== null" class="flex flex-col gap-2">
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>{{ SCALE_MIN_MS }} ms</span>
            <span
              >Typical is {{ TYPICAL_RANGE_MS.min }} to {{ TYPICAL_RANGE_MS.max }} ms ({{
                averageRatingLabel
              }})</span
            >
            <span>{{ SCALE_MAX_MS }}+ ms</span>
          </div>
          <div class="relative h-2 rounded-full bg-secondary shadow-[var(--sh-inset)]">
            <div
              class="absolute inset-y-0 rounded-full bg-[image:var(--grad-brand-soft)]"
              :style="{
                left: `${scalePosition(TYPICAL_RANGE_MS.min)}%`,
                right: `${100 - scalePosition(TYPICAL_RANGE_MS.max)}%`,
              }"
            />
            <div
              v-for="tick in scaleTicks"
              :key="tick"
              class="absolute top-0 h-2 w-px bg-border"
              :style="{ left: `${scalePosition(tick)}%` }"
            />
            <div
              class="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-primary shadow-[var(--sh-sm)]"
              :style="{ left: `${scalePosition(average)}%` }"
              :title="`Average: ${Math.round(average)} ms`"
            />
          </div>
        </div>

        <KeyValueGrid v-if="summaryRows" :record="summaryRows" />

        <div v-if="isDone" class="flex justify-end">
          <Button size="sm" @click="resetAll">
            <Redo2 class="size-3.5" aria-hidden="true" />
            Run again
          </Button>
        </div>
      </template>
    </section>
  </div>
</template>

<style>
@media (prefers-reduced-motion: reduce) {
  .reaction-time-test-root * {
    transition: none !important;
    animation: none !important;
  }
}
</style>
