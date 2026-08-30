<script setup lang="ts">
/**
 * Bespoke panel for the Click Speed Test (CPS).
 *
 * The pure logic layer (src/tools/click-speed-test/index.ts) owns every
 * number: clicks per second, the rank band, and the full summarize() report
 * built from raw click timestamps. This file owns the DOM: the big target,
 * the timer that starts on the first press rather than a countdown, and the
 * pointer and keyboard listeners that feed real timestamps in.
 *
 * Rule 6: only the chosen test length is written to the URL fragment. A run's
 * click count is session state, not shareable content.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RotateCcw, Trash2 } from "lucide-vue-next";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { ToolError, type ToolMeta } from "@/tools/types";
import { summarize, type ClickSummary } from "@/tools/click-speed-test/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import ProgressBar from "../ProgressBar.vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * Options: duration (fragment carried) and input mode (label only, both
 * pointer and keyboard presses always count so nobody is locked out).
 * ------------------------------------------------------------------ */

function selectOptions(id: string): SegmentedOption[] {
  const spec = props.meta.options?.find((o) => o.id === id && o.kind === "select");
  return spec?.kind === "select"
    ? (spec.options?.map((o) => ({ value: o.value, label: o.label })) ?? [])
    : [];
}

function selectDefault(id: string, fallback: string): string {
  const spec = props.meta.options?.find((o) => o.id === id && o.kind === "select");
  return spec?.kind === "select" ? spec.default : fallback;
}

const durationOptions = computed(() => selectOptions("duration"));
const modeOptions = computed(() => selectOptions("mode"));

const duration = ref(selectDefault("duration", "10"));
const mode = ref(selectDefault("mode", "mouse"));
const durationSeconds = computed(() => Number(duration.value) || 10);

/* ------------------------------------------------------------------ *
 * Run state
 * ------------------------------------------------------------------ */

type RunPhase = "idle" | "running" | "finished";

const phase = ref<RunPhase>("idle");
const clickTimestamps = ref<number[]>([]);
const panelError = ref<{ message: string; fix?: string } | null>(null);
let startAtMs: number | null = null;
let frame = 0;

const elapsedMs = ref(0);

const targetEl = ref<HTMLElement>();

function tick() {
  if (phase.value !== "running" || startAtMs === null) return;
  const now = performance.now();
  elapsedMs.value = now - startAtMs;
  if (elapsedMs.value >= durationSeconds.value * 1000) {
    elapsedMs.value = durationSeconds.value * 1000;
    finishRun();
    return;
  }
  frame = requestAnimationFrame(tick);
}

function startRun(firstClickMs: number) {
  phase.value = "running";
  startAtMs = firstClickMs;
  clickTimestamps.value = [0];
  elapsedMs.value = 0;
  frame = requestAnimationFrame(tick);
}

function registerClick(atMs: number) {
  if (phase.value === "finished") return;
  if (phase.value === "idle") {
    startRun(atMs);
    return;
  }
  if (startAtMs === null) return;
  const relative = atMs - startAtMs;
  if (relative > durationSeconds.value * 1000) return; // window already closed
  clickTimestamps.value = [...clickTimestamps.value, relative];
}

function finishRun() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  phase.value = "finished";
  maybeUpdateBest();
}

function resetRun() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  phase.value = "idle";
  clickTimestamps.value = [];
  elapsedMs.value = 0;
  startAtMs = null;
  panelError.value = null;
}

/* ------------------------------------------------------------------ *
 * Input: pointer on the target, plus keyboard from anywhere that is not a
 * real form control (so choosing a duration with Space is never also a
 * click). auto repeat is filtered so holding a key cannot fake clicks.
 * ------------------------------------------------------------------ */

function onTargetPointerDown(e: PointerEvent) {
  e.preventDefault();
  registerClick(e.timeStamp);
}

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
  registerClick(e.timeStamp);
}

function onVisibilityChange() {
  if (document.hidden && phase.value === "running") finishRun();
}

function onDurationChange(value: string) {
  duration.value = value;
  resetRun();
}

function onModeChange(value: string) {
  mode.value = value;
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

const summary = computed<{
  result: ClickSummary | null;
  error: { message: string; fix?: string } | null;
}>(() => {
  if (phase.value !== "finished") return { result: null, error: null };
  try {
    return { result: summarize(clickTimestamps.value, durationSeconds.value), error: null };
  } catch (e) {
    return {
      result: null,
      error:
        e instanceof ToolError
          ? { message: e.message, fix: e.fix }
          : { message: "That run could not be scored." },
    };
  }
});

const summaryRows = computed<Record<string, string> | null>(() => {
  const s = summary.value.result;
  if (!s) return null;
  return {
    "Clicks per second": s.cps.toFixed(2),
    "Total clicks": String(s.clicks),
    "Test length": `${s.durationSeconds} second${s.durationSeconds === 1 ? "" : "s"}`,
    "Peak in any one second": String(s.peakCps),
    "Clicks by second": s.perSecond.join(", "),
    Ranking: s.rank.label,
    "What that means": s.rank.description,
  };
});

const summaryText = computed(() => {
  const rows = summaryRows.value;
  if (!rows) return "";
  return Object.entries(rows)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
});

const liveCount = computed(() => clickTimestamps.value.length);
const remainingSeconds = computed(() =>
  Math.max(0, Math.ceil((durationSeconds.value * 1000 - elapsedMs.value) / 1000)),
);
const progressPercent = computed(() =>
  Math.min(100, (elapsedMs.value / (durationSeconds.value * 1000)) * 100),
);

const targetPrompt = computed(() => {
  if (phase.value === "running") return "Keep going";
  if (phase.value === "finished") return "Test complete";
  return mode.value === "keyboard" ? "Press Space or Enter to start" : "Click or tap to start";
});

/* ------------------------------------------------------------------ *
 * Best score: a single number per test length, kept as a preference (rule 7).
 * Never a click count history, never a timestamp.
 * ------------------------------------------------------------------ */

const STORAGE_PREFIX = "click-speed-test-best-";
const storageBlocked = ref(false);
const best = ref<number | null>(null);

function bestKey(): string {
  return `${STORAGE_PREFIX}${duration.value}`;
}

function readBest(): number | null {
  try {
    const raw = window.localStorage.getItem(bestKey());
    const parsed = raw === null ? null : Number(raw);
    storageBlocked.value = false;
    return parsed !== null && Number.isFinite(parsed) ? parsed : null;
  } catch {
    storageBlocked.value = true;
    return null;
  }
}

function writeBest(value: number | null) {
  try {
    if (value === null) window.localStorage.removeItem(bestKey());
    else window.localStorage.setItem(bestKey(), String(value));
    storageBlocked.value = false;
  } catch {
    storageBlocked.value = true;
  }
}

function maybeUpdateBest() {
  const s = summary.value.result ?? summarize(clickTimestamps.value, durationSeconds.value);
  if (best.value === null || s.cps > best.value) {
    best.value = s.cps;
    writeBest(s.cps);
  }
}

function clearBest() {
  best.value = null;
  writeBest(null);
}

/* ------------------------------------------------------------------ *
 * Fragment: duration only (rule 6)
 * ------------------------------------------------------------------ */

const mounted = ref(false);

watch(duration, () => {
  best.value = readBest();
  if (!mounted.value) return;
  writeFragment({ opts: { duration: duration.value } });
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const frag = readFragment();
  const allowed = new Set(durationOptions.value.map((o) => o.value));
  if (frag.opts.duration && allowed.has(frag.opts.duration)) duration.value = frag.opts.duration;

  best.value = readBest();

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("visibilitychange", onVisibilityChange);

  mounted.value = true;
});

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame);
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Test length
        </span>
        <Segmented
          :model-value="duration"
          :options="durationOptions"
          label="Test length"
          size="sm"
          @update:model-value="onDurationChange"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Input
        </span>
        <Segmented
          :model-value="mode"
          :options="modeOptions"
          label="Input mode"
          size="sm"
          @update:model-value="onModeChange"
        />
      </div>
      <Button variant="ghost" size="sm" class="ml-auto" @click="resetRun">
        <RotateCcw class="size-3.5" aria-hidden="true" />
        Reset
      </Button>
    </div>

    <ProgressBar
      v-if="phase !== 'idle'"
      :value="progressPercent"
      label="Time remaining"
      :detail="phase === 'finished' ? 'Done' : `${remainingSeconds}s left`"
    />

    <ErrorBanner v-if="panelError" :message="panelError.message" :hint="panelError.fix" />

    <div
      ref="targetEl"
      role="button"
      tabindex="0"
      class="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-[14px] bg-secondary p-6 text-center shadow-[var(--sh-inset)] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      @pointerdown="onTargetPointerDown"
      @contextmenu.prevent
    >
      <p class="max-w-[52ch] text-base font-medium" aria-live="off">{{ targetPrompt }}</p>
      <p class="font-mono text-4xl tabular-nums" aria-live="polite">{{ liveCount }}</p>
      <p class="text-xs text-muted-foreground">clicks</p>
    </div>

    <p class="max-w-[68ch] text-xs text-muted-foreground">
      The timer starts on your first press, not a countdown. Reset clears the current run without
      touching your saved best. Your files and inputs never leave your device.
    </p>

    <!-- Results -->
    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Results
        </span>
        <CopyButton v-if="summaryText" :text="summaryText" label="Copy results" />
      </div>

      <ErrorBanner
        v-if="summary.error"
        :message="summary.error.message"
        :hint="summary.error.fix"
      />

      <EmptyState
        v-else-if="!summaryRows"
        title="No results yet"
        hint="Click or tap the target above to start a run."
      />

      <KeyValueGrid v-else :record="summaryRows" />

      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p class="text-xs text-muted-foreground">
          <span v-if="best !== null">
            Best for {{ durationSeconds }}s:
            <span class="font-mono tabular-nums">{{ best.toFixed(2) }}</span> CPS
          </span>
          <span v-else>No saved best for this test length yet.</span>
          <span v-if="storageBlocked"> (this browser is blocking saved preferences)</span>
        </p>
        <Button v-if="best !== null" variant="ghost" size="sm" @click="clearBest">
          <Trash2 class="size-3.5" aria-hidden="true" />
          Clear best
        </Button>
      </div>
    </section>
  </div>
</template>
