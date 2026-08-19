<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import { FEATURE_PROBES, run } from "@/tools/wasm-feature-detector/index";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, RefreshCw, X } from "lucide-vue-next";
import CopyButton from "../CopyButton.vue";

/**
 * Bespoke panel for WebAssembly Feature Check: the pure layer only knows how
 * to format a { featureId: boolean } report, so this panel owns the one
 * thing it cannot do, calling WebAssembly.validate() itself. Every probe
 * bytes array in FEATURE_PROBES only parses if the engine implements that
 * proposal, so validate() is a purely local, synchronous computation with no
 * network access or permission prompt, which is why this panel probes on
 * mount rather than waiting for a click, following GpuInspectorPanel and
 * DisplayInfoPanel's pattern for browser reads that must stay out of the
 * server rendered shell.
 */
defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * live state
 * ------------------------------------------------------------------ */

const loading = ref(true);
const hasWasm = ref(true);
const userAgent = ref("");
const results = ref<Record<string, boolean> | null>(null);

function runProbes() {
  loading.value = true;

  if (typeof WebAssembly === "undefined") {
    hasWasm.value = false;
    results.value = null;
    loading.value = false;
    return;
  }

  hasWasm.value = true;
  const next: Record<string, boolean> = {};
  for (const probe of FEATURE_PROBES) {
    try {
      // probe.bytes carries the default Uint8Array<ArrayBufferLike> type,
      // which validate()'s BufferSource parameter rejects because
      // ArrayBufferLike also covers SharedArrayBuffer. Passing it back
      // through the ArrayLike constructor overload (see PasskeyPanel's
      // randomBytes) narrows it to Uint8Array<ArrayBuffer> without naming
      // the BufferSource type, which eslint's no-undef does not know.
      next[probe.id] = WebAssembly.validate(new Uint8Array(probe.bytes));
    } catch {
      next[probe.id] = false;
    }
  }
  results.value = next;
  loading.value = false;
}

onMounted(() => {
  userAgent.value = navigator.userAgent;
  runProbes();
});

/* ------------------------------------------------------------------ *
 * feed the results into the pure logic layer
 * ------------------------------------------------------------------ */

const output = computed<Record<string, string> | null>(() => {
  if (!results.value) return null;
  try {
    return run(JSON.stringify(results.value), {});
  } catch {
    return null;
  }
});

const summaryLine = computed(() => output.value?.["Summary"] ?? null);
const baselineLine = computed(() => output.value?.["Baseline"] ?? null);
const baselineMet = computed(() => baselineLine.value?.trim().endsWith("yes") ?? false);

interface FeatureRow {
  id: string;
  label: string;
  proposal: string;
  since: string;
  supported: boolean;
}

const featureRows = computed<FeatureRow[]>(() => {
  const r = results.value;
  if (!r) return [];
  return FEATURE_PROBES.map((probe) => ({
    id: probe.id,
    label: probe.label,
    proposal: probe.proposal,
    since: probe.since,
    supported: r[probe.id] === true,
  }));
});

function badgeClass(supported: boolean): string {
  return supported
    ? "border-[var(--positive)]/40 text-[var(--positive)]"
    : "border-border text-muted-foreground";
}

/* ------------------------------------------------------------------ *
 * copy formats: the raw results object as JSON, and a full readable
 * report as text, both self describing since they carry the UA line
 * ------------------------------------------------------------------ */

const jsonReport = computed(() => (results.value ? JSON.stringify(results.value, null, 2) : ""));

const textReport = computed(() => {
  if (!output.value) return "";
  const lines = [`User agent: ${userAgent.value}`, ""];
  for (const [k, v] of Object.entries(output.value)) {
    lines.push(`${k}: ${v}`);
  }
  return lines.join("\n");
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground">
        Runs WebAssembly.validate() over a tiny module per feature entirely in this browser: your
        files and inputs never leave your device.
      </p>

      <Button variant="ghost" size="sm" :disabled="loading" @click="runProbes">
        <RefreshCw class="size-3.5" aria-hidden="true" />
        {{ loading ? "Running…" : "Re-run" }}
      </Button>
    </div>

    <div
      v-if="loading"
      class="flex min-h-[120px] items-center justify-center rounded-[10px] bg-secondary p-6 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
      aria-live="polite"
    >
      Running the WebAssembly probes
    </div>

    <div
      v-else-if="!hasWasm"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <span class="font-semibold text-destructive">WebAssembly is not available</span>
      <span class="text-muted-foreground">
        This browser has no global WebAssembly object at all, so none of these features can be
        tested here. Open this page in a browser that implements WebAssembly and reload.
      </span>
    </div>

    <template v-else>
      <div class="flex flex-col gap-1">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >User agent</span
        >
        <p
          class="rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs break-all text-muted-foreground shadow-[var(--sh-inset)]"
        >
          {{ userAgent }}
        </p>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1 rounded-[14px] border p-4 shadow-[var(--sh-sm)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >Summary</span
          >
          <span class="text-lg font-semibold text-foreground">{{ summaryLine }}</span>
        </div>

        <div
          class="flex flex-col gap-1 rounded-[14px] border p-4 shadow-[var(--sh-sm)]"
          :class="
            baselineMet
              ? 'border-[var(--positive)]/30 bg-[var(--positive-soft)]/40'
              : 'border-[var(--brand-hairline)] bg-[var(--accent-soft)]/50'
          "
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >Baseline</span
            >
            <Badge variant="outline" :class="badgeClass(baselineMet)">
              <Check v-if="baselineMet" class="size-3" aria-hidden="true" />
              <X v-else class="size-3" aria-hidden="true" />
              {{ baselineMet ? "Met" : "Not met" }}
            </Badge>
          </div>
          <span class="text-sm text-muted-foreground">{{ baselineLine }}</span>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <CopyButton :text="jsonReport" label="Copy JSON" />
        <CopyButton :text="textReport" label="Copy as text" />
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div
          v-for="feature in featureRows"
          :key="feature.id"
          class="flex flex-col gap-1.5 rounded-[14px] border bg-card p-4 shadow-[var(--sh-sm)]"
        >
          <div class="flex items-start justify-between gap-3">
            <span class="text-sm font-semibold text-foreground">{{ feature.label }}</span>
            <Badge variant="outline" class="shrink-0" :class="badgeClass(feature.supported)">
              <Check v-if="feature.supported" class="size-3" aria-hidden="true" />
              <X v-else class="size-3" aria-hidden="true" />
              {{ feature.supported ? "Supported" : "Not supported" }}
            </Badge>
          </div>
          <span class="font-mono text-xs text-muted-foreground">{{ feature.proposal }}</span>
          <span class="text-xs text-muted-foreground">{{ feature.since }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
