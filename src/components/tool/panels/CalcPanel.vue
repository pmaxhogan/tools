<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import { run, EXAMPLES } from "@/tools/calc/index";
import { FX_DATE } from "@/tools/calc/rates";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import CopyButton from "../CopyButton.vue";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for the unit calculator: one big monospace expression line
 * that evaluates as you type, with the answer shown large instead of buried
 * in a generic output row. All the math still comes from the pure run() the
 * generic shell would call, so the two never diverge.
 *
 * Every browser read happens in onMounted or a handler, so the server
 * rendered shell never touches window, history, or the DOM.
 */
defineProps<{ meta: ToolMeta }>();

const DEFAULT_PRECISION = 6;
const MIN_PRECISION = 1;
const MAX_PRECISION = 15;

const expr = ref<string>("");
const precision = ref<number>(DEFAULT_PRECISION);

const output = ref<Record<string, string> | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const inputEl = ref<InstanceType<typeof Input> | null>(null);
/** Guards the fragment write so it never fires before the fragment is read. */
const mounted = ref(false);
let debounce: ReturnType<typeof setTimeout> | undefined;

/** The headline answer, or null while the box is empty or the input is bad. */
const resultValue = computed(() => output.value?.Result ?? null);

/** Everything except Result, which already renders large above the rows. */
const detailRows = computed<Record<string, string> | null>(() => {
  const out = output.value;
  if (!out) return null;
  const rows = Object.fromEntries(Object.entries(out).filter(([k]) => k !== "Result"));
  return Object.keys(rows).length > 0 ? rows : null;
});

const usesCurrency = computed(() => output.value !== null && "Rates as of" in output.value);

function clampPrecision(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_PRECISION;
  return Math.min(MAX_PRECISION, Math.max(MIN_PRECISION, Math.round(raw)));
}

/**
 * An empty box is not a failure, it is a tool waiting for input, so it never
 * calls run() (which rejects empty input) and never shows a red error.
 */
function evaluate() {
  if (!expr.value.trim()) {
    output.value = null;
    error.value = null;
    return;
  }
  try {
    output.value = run(expr.value, { precision: precision.value });
    error.value = null;
  } catch (e) {
    output.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * mathjs throws on almost every half typed expression, so evaluation and the
 * URL write both wait for a short pause instead of flashing an error per key.
 */
function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    evaluate();
    if (!mounted.value) return;
    writeFragment({
      input: expr.value || undefined,
      opts: { precision: String(precision.value) },
    });
  }, 120);
}

watch([expr, precision], schedule);

function useExample(example: string) {
  expr.value = example;
}

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) expr.value = frag.input;
  const rawPrecision = frag.opts.precision;
  if (rawPrecision !== undefined) precision.value = clampPrecision(Number(rawPrecision));
  mounted.value = true;

  evaluate();

  // The autofocus attribute is unreliable on a hydrated island, so focus is
  // taken here, after the shared expression has been restored from the URL.
  inputEl.value?.$el?.focus?.();
});

onUnmounted(() => clearTimeout(debounce));
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-col gap-2">
      <label
        for="calc-expression"
        class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
      >
        Expression
      </label>
      <Input
        id="calc-expression"
        ref="inputEl"
        :model-value="expr"
        type="text"
        inputmode="text"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="20 miles to km"
        class="h-auto rounded-[10px] border-0 bg-secondary px-4 py-3 font-mono text-lg shadow-[var(--sh-inset)] md:text-lg"
        @update:model-value="(v) => (expr = String(v))"
      />
    </div>

    <div
      class="flex min-h-[92px] flex-col justify-center gap-1 rounded-[10px] bg-secondary px-4 py-3 shadow-[var(--sh-inset)]"
      aria-live="polite"
    >
      <template v-if="resultValue !== null">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs text-muted-foreground">Result</div>
            <div class="font-mono text-2xl leading-tight font-semibold break-words sm:text-3xl">
              {{ resultValue }}
            </div>
          </div>
          <CopyButton :text="resultValue" label="Copy" />
        </div>
      </template>

      <template v-else-if="error">
        <div class="flex flex-col gap-1">
          <p class="text-sm font-medium text-destructive">{{ error.message }}</p>
          <p v-if="error.fix" class="text-sm text-muted-foreground">{{ error.fix }}</p>
        </div>
      </template>

      <template v-else>
        <p class="text-sm text-muted-foreground">
          Type an expression to see the answer here. It updates as you type.
        </p>
      </template>
    </div>

    <p v-if="usesCurrency" class="text-xs text-muted-foreground">
      Currency rates as of {{ FX_DATE }}, not live.
    </p>

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-3">
        <label
          for="calc-precision"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          Significant digits
        </label>
        <span class="font-mono text-sm tabular-nums">{{ precision }}</span>
      </div>
      <Slider
        id="calc-precision"
        :model-value="[precision]"
        :min="MIN_PRECISION"
        :max="MAX_PRECISION"
        :step="1"
        aria-label="Significant digits"
        class="py-2"
        @update:model-value="(v) => (precision = clampPrecision(Number(v?.[0] ?? precision)))"
      />
    </div>

    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Examples
      </span>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="example in EXAMPLES"
          :key="example"
          type="button"
          class="rounded-[8px] border px-3 py-1.5 font-mono text-sm transition-colors"
          :class="example === expr ? 'border-ring bg-accent' : 'bg-secondary hover:bg-accent'"
          :aria-pressed="example === expr"
          @click="useExample(example)"
        >
          {{ example }}
        </button>
      </div>
    </div>

    <OutputView v-if="detailRows" :output="detailRows" />
  </div>
</template>
