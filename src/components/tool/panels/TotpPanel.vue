<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type ComponentPublicInstance } from "vue";
import { ToolError, type OptionSpec, type ToolMeta } from "@/tools/types";
import { run } from "@/tools/totp-generator/index";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import OptionControl from "../OptionControl.vue";
import ProgressBar from "../ProgressBar.vue";

/**
 * Bespoke panel for the TOTP generator: a live authenticator rather than the
 * generic run-once shell. A short interval re-runs the same pure `run()` the
 * textarea version uses, so the code, the seconds left, and the neighboring
 * codes all stay current without the reader pressing anything.
 *
 * The secret is a long lived credential, so it lives in this component's
 * memory only: never localStorage, never the URL fragment, never a request.
 */
const props = defineProps<{ meta: ToolMeta }>();

/** How often the live clock is sampled. Fine enough for a smooth bar. */
const TICK_MS = 250;

const secret = ref("");

/**
 * The three panel controls, held in the loose shape OptionControl speaks
 * (a select emits a string, a number control emits a number).
 */
const opts = ref<Record<string, unknown>>({ algorithm: "SHA1", digits: "6", period: 30 });

const result = ref<Record<string, string> | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);
/** Wall clock sampled at the start of each compute, so the countdown bar and
 * the "Valid for" value the logic returned always describe the same instant. */
const tickMs = ref(0);

const secretInput = ref<ComponentPublicInstance | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

/* ------------------------------------------------------------------ *
 * option controls, driven by the tool's own meta
 * ------------------------------------------------------------------ */

/** Only these three are panel controls. The matrix meta also declares a "now"
 * time override, which this surface replaces with the live clock. */
function specFor(id: string): OptionSpec | undefined {
  return props.meta.options?.find((o) => o.id === id);
}

const algorithmSpec = computed(() => specFor("algorithm"));
const digitsSpec = computed(() => specFor("digits"));
const periodSpec = computed(() => specFor("period"));

/** An otpauth URI names its own algorithm, digit count, and period, and the
 * logic layer lets those win, so the controls are shown as inert. */
const isUri = computed(() => /^otpauth:\/\//i.test(secret.value.trim()));

/* ------------------------------------------------------------------ *
 * the live computation
 * ------------------------------------------------------------------ */

function compute() {
  if (!secret.value.trim()) {
    result.value = null;
    error.value = null;
    return;
  }

  tickMs.value = Date.now();
  try {
    result.value = run(secret.value, {
      algorithm: String(opts.value.algorithm ?? "SHA1"),
      digits: String(opts.value.digits ?? "6"),
      period: Number(opts.value.period ?? 30),
      now: 0,
    });
    error.value = null;
  } catch (e) {
    result.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : "Could not generate a code." };
  }
}

watch([secret, opts], compute, { deep: true });

onMounted(() => {
  compute();
  timer = setInterval(compute, TICK_MS);
  const el = secretInput.value?.$el as HTMLInputElement | undefined;
  el?.focus();
});

onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
  timer = null;
});

/* ------------------------------------------------------------------ *
 * derived display values
 * ------------------------------------------------------------------ */

/** "123 456" as shown, and "123456" for the clipboard: a space breaks paste
 * into most login forms. */
const groupedCode = computed(() => result.value?.["Code"] ?? null);
const plainCode = computed(() => (groupedCode.value ?? "").replace(/\s/g, ""));

const isCounterBased = computed(() => result.value !== null && !("Valid for" in result.value));

/** Seconds left, straight from the logic layer. */
const validForSeconds = computed(() => {
  const raw = result.value?.["Valid for"];
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
});

/** The period actually in force, which an otpauth URI may have overridden. */
const effectivePeriod = computed(() => {
  const raw = result.value?.["Period"];
  const n = raw === undefined ? Number(opts.value.period) : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 30;
});

/**
 * Fraction of the step still to run, 0 to 1, sampled from the same instant as
 * the code itself so the bar never disagrees with the number beside it.
 */
const remainingFraction = computed(() => {
  if (result.value === null || isCounterBased.value || tickMs.value === 0) return 0;
  const p = effectivePeriod.value;
  const into = (((tickMs.value / 1000) % p) + p) % p;
  return Math.min(1, Math.max(0, (p - into) / p));
});

/** Under five seconds left, the countdown turns urgent. */
const isExpiring = computed(() => (validForSeconds.value ?? Infinity) <= 5);

/** Metadata rows below the code, in a fixed order, skipping absent keys. */
const META_KEYS = ["Issuer", "Account", "Algorithm", "Digits", "Period", "Type", "Counter"];

const metaRows = computed(() => {
  const out = result.value;
  if (!out) return [];
  return META_KEYS.filter((k) => k in out).map((k) => ({ key: k, value: out[k]! }));
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- secret -->
    <div class="flex flex-col gap-1.5">
      <Label for="totp-secret" class="text-xs text-muted-foreground">Secret</Label>
      <Input
        id="totp-secret"
        ref="secretInput"
        v-model="secret"
        type="text"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        class="font-mono"
        placeholder="Base32 secret or otpauth:// URI"
      />
      <p class="text-xs text-muted-foreground">
        Codes are generated in this browser and the secret is never saved: your files and inputs
        never leave your device.
      </p>
    </div>

    <!-- options -->
    <div class="flex flex-col gap-2">
      <div
        class="grid gap-3 sm:grid-cols-3"
        :class="isUri ? 'pointer-events-none opacity-55' : undefined"
        :aria-disabled="isUri ? 'true' : undefined"
      >
        <OptionControl v-if="algorithmSpec" v-model="opts.algorithm" :spec="algorithmSpec" />
        <OptionControl v-if="digitsSpec" v-model="opts.digits" :spec="digitsSpec" />
        <OptionControl v-if="periodSpec" v-model="opts.period" :spec="periodSpec" />
      </div>
      <p v-if="isUri" class="text-xs text-muted-foreground">
        This otpauth URI names its own algorithm, digit count, and period, so these controls are
        ignored.
      </p>
    </div>

    <!-- the live code -->
    <div
      v-if="groupedCode !== null"
      class="flex flex-col gap-4 rounded-[10px] bg-secondary p-5 shadow-[var(--sh-inset)] sm:p-6"
    >
      <!-- Only the code itself is a live region: the countdown beside it
           changes every tick and would be announced without end. -->
      <div
        class="flex flex-wrap items-center justify-between gap-3"
        role="status"
        aria-live="polite"
      >
        <span
          class="font-mono text-4xl leading-none font-semibold tracking-[0.06em] tabular-nums sm:text-5xl"
          >{{ groupedCode }}</span
        >
        <CopyButton :text="plainCode" label="Copy code" />
      </div>

      <div v-if="!isCounterBased" class="flex flex-col gap-1.5">
        <ProgressBar
          size="sm"
          :value="remainingFraction * 100"
          :tone="isExpiring ? 'destructive' : 'brand'"
          aria-label="Seconds until this code changes"
        />
        <p class="text-xs" :class="isExpiring ? 'text-destructive' : 'text-muted-foreground'">
          Valid for {{ validForSeconds ?? 0 }}s of {{ effectivePeriod }}s
        </p>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <!-- Both branches return codes here: for HOTP they are the codes at
               the counter either side, and the counter itself is a metadata row. -->
        <div class="flex flex-col gap-0.5">
          <span class="text-xs text-muted-foreground">Previous code</span>
          <span class="font-mono text-sm tabular-nums">{{ result?.["Previous"] }}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-xs text-muted-foreground">Next code</span>
          <span class="font-mono text-sm tabular-nums">{{ result?.["Next"] }}</span>
        </div>
      </div>
    </div>

    <EmptyState
      v-else-if="error === null"
      title="No code yet"
      hint="Paste a Base32 secret or an otpauth:// URI to start generating codes."
    />

    <EmptyState v-else title="No code yet" />

    <!-- error -->
    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <!-- metadata -->
    <KeyValueGrid :rows="metaRows" surface="card" :copy="false" />
  </div>
</template>
