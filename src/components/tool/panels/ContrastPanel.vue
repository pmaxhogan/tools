<script setup lang="ts">
/**
 * Bespoke panel for the Color Contrast Checker.
 *
 * A contrast number means very little on its own, so this panel puts the two
 * colors on screen doing the job they were picked for: body text, a heading, a
 * disabled line, and a bordered control, all drawn with the exact pair being
 * measured. Reading the sample is usually faster than reading the ratio.
 *
 * Rule 27 holds: every number comes from the pure layer in
 * `src/tools/color-contrast-checker/`. `parseColor` reads a token, `analyzePair`
 * produces the whole report (ratio, per level verdicts, APCA Lc, guidance, and
 * the nearest passing foreground), and the formatters render the colors. This
 * file owns the inputs, the preview, and the URL fragment.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ArrowLeftRight, Check, X } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import {
  analyzePair,
  formatHex,
  formatHsl,
  formatOklch,
  formatRgb,
  parseColor,
} from "@/tools/color-contrast-checker/index";
import type { ContrastReport } from "@/tools/color-contrast-checker/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";

const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

function defaultText(id: string, fallback: string): string {
  const spec = props.meta.options?.find((o) => o.kind === "text" && o.id === id);
  return spec && spec.kind === "text" ? spec.default : fallback;
}

const foreground = ref(defaultText("foreground", "#5b4bd6"));
const background = ref(defaultText("background", "#ffffff"));
const target = ref("aa-normal");

const targetSpec = computed<SelectOptionSpec>(() => {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === "target");
  if (found && found.kind === "select") return found;
  return {
    kind: "select",
    id: "target",
    label: "Target level",
    default: "aa-normal",
    options: [{ value: "aa-normal", label: "AA normal text (4.5:1)", synonyms: ["aa"] }],
  };
});

const report = ref<ContrastReport | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

function recompute(): void {
  try {
    report.value = analyzePair(
      parseColor(foreground.value),
      parseColor(background.value),
      target.value,
    );
    error.value = null;
  } catch (err) {
    report.value = null;
    error.value =
      err instanceof ToolError
        ? { message: err.message, fix: err.fix }
        : { message: err instanceof Error ? err.message : "That pair could not be measured." };
  }
  writeFragment({
    opts: {
      foreground: foreground.value,
      background: background.value,
      target: target.value,
    },
  });
}

watch([foreground, background, target], recompute);

onMounted(() => {
  const { opts } = readFragment();
  if (opts["foreground"]) foreground.value = opts["foreground"];
  if (opts["background"]) background.value = opts["background"];
  if (opts["target"]) target.value = opts["target"];
  recompute();
});

/* ------------------------------------------------------------------ *
 * derived
 * ------------------------------------------------------------------ */

/** The colors actually painted, which is the flattened pair when alpha was used. */
const fgHex = computed(() => (report.value ? formatHex(report.value.effectiveForeground) : "#000"));
const bgHex = computed(() => (report.value ? formatHex(report.value.effectiveBackground) : "#fff"));

const ratioText = computed(() => (report.value ? `${report.value.ratio.toFixed(2)}:1` : ""));
const lcText = computed(() => (report.value ? report.value.lc.toFixed(1) : ""));

const formats = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  const current = report.value;
  if (!current) return out;
  out["Foreground hex"] = formatHex(current.effectiveForeground);
  out["Foreground rgb"] = formatRgb(current.effectiveForeground);
  out["Foreground hsl"] = formatHsl(current.effectiveForeground);
  out["Foreground oklch"] = formatOklch(current.effectiveForeground);
  out["Background hex"] = formatHex(current.effectiveBackground);
  out["Background oklch"] = formatOklch(current.effectiveBackground);
  return out;
});

/** The whole report as text, for the copy everything button. */
const reportText = computed(() => {
  const current = report.value;
  if (!current) return "";
  const lines = [
    `Foreground: ${formatHex(current.effectiveForeground)}`,
    `Background: ${formatHex(current.effectiveBackground)}`,
    `Contrast ratio: ${current.ratio.toFixed(2)}:1`,
    ...current.checks.map((c) => `${c.label}: ${c.pass ? "pass" : "fail"} (needs ${c.min}:1)`),
    `APCA Lc: ${current.lc.toFixed(1)}`,
    `APCA guidance: ${current.guidance}`,
  ];
  if (current.suggestion) {
    lines.push(
      `Nearest passing foreground for ${current.target.label}: ${current.suggestion.hex} at ${current.suggestion.ratio.toFixed(2)}:1`,
    );
  }
  return lines.join("\n");
});

function swap(): void {
  const held = foreground.value;
  foreground.value = background.value;
  background.value = held;
}

function applySuggestion(): void {
  const hex = report.value?.suggestion?.hex;
  if (hex) foreground.value = hex;
}

/**
 * The native color input only speaks #rrggbb, so it gets the flattened color
 * and hands back a plain hex. Typing in the text box stays the way to write
 * `oklch()` or a color name.
 */
function onSwatch(which: "fg" | "bg", value: string): void {
  if (which === "fg") foreground.value = value;
  else background.value = value;
}
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- inputs -->
    <div class="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
      <div class="flex flex-col gap-1.5">
        <Label for="contrast-fg" class="text-xs text-muted-foreground">Foreground</Label>
        <div class="flex items-center gap-2">
          <input
            type="color"
            :value="fgHex"
            aria-label="Pick a foreground color"
            class="h-9 w-10 shrink-0 cursor-pointer rounded-[8px] border bg-card p-1"
            @input="onSwatch('fg', ($event.target as HTMLInputElement).value)"
          />
          <Input
            id="contrast-fg"
            v-model="foreground"
            class="h-9 bg-card font-mono"
            spellcheck="false"
            autocapitalize="off"
            placeholder="#5b4bd6"
            :aria-invalid="error ? 'true' : undefined"
          />
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-9 self-end"
        aria-label="Swap the foreground and background"
        @click="swap"
      >
        <ArrowLeftRight class="size-3.5" aria-hidden="true" />
        Swap
      </Button>

      <div class="flex flex-col gap-1.5">
        <Label for="contrast-bg" class="text-xs text-muted-foreground">Background</Label>
        <div class="flex items-center gap-2">
          <input
            type="color"
            :value="bgHex"
            aria-label="Pick a background color"
            class="h-9 w-10 shrink-0 cursor-pointer rounded-[8px] border bg-card p-1"
            @input="onSwatch('bg', ($event.target as HTMLInputElement).value)"
          />
          <Input
            id="contrast-bg"
            v-model="background"
            class="h-9 bg-card font-mono"
            spellcheck="false"
            autocapitalize="off"
            placeholder="#ffffff"
          />
        </div>
      </div>
    </div>

    <div class="flex w-full flex-col gap-1.5 sm:w-72">
      <Label for="contrast-target" class="text-xs text-muted-foreground">Target level</Label>
      <SearchableSelect
        id="contrast-target"
        :spec="targetSpec"
        :model-value="target"
        class="w-full bg-card"
        @update:model-value="(v: string) => (target = v)"
      />
    </div>

    <p class="text-xs text-muted-foreground">
      Hex, rgb(), hsl(), hwb(), lab(), lch(), oklab(), oklch() and all 148 CSS color names are
      accepted. Everything is measured in this tab, so your files and inputs never leave your
      device.
    </p>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <template v-if="report">
      <!-- sample -->
      <div
        class="flex flex-col gap-3 rounded-[14px] border p-5"
        :style="{ backgroundColor: bgHex, color: fgHex }"
      >
        <p class="text-[26px] leading-tight font-semibold">Large text at 26 pixels</p>
        <p class="text-[15px] leading-[1.6]">
          Normal body text at 15 pixels. Read this paragraph rather than the number: if it takes
          effort here, it will take more effort on a phone in daylight.
        </p>
        <p class="text-[13px] opacity-70">Secondary text at 70 percent opacity</p>
        <span
          class="inline-flex w-fit items-center rounded-[10px] border px-3 py-1.5 text-sm"
          :style="{ borderColor: fgHex }"
        >
          A bordered control
        </span>
      </div>

      <!-- headline numbers -->
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            WCAG 2.x ratio
          </span>
          <span class="font-mono text-3xl tabular-nums">{{ ratioText }}</span>
        </div>
        <div class="flex flex-col gap-1 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            APCA Lc
          </span>
          <span class="font-mono text-3xl tabular-nums">{{ lcText }}</span>
          <span class="text-xs text-muted-foreground">{{ report.guidance }}</span>
        </div>
      </div>

      <!-- verdicts -->
      <ul class="flex flex-wrap gap-2">
        <li v-for="check in report.checks" :key="check.id">
          <span
            class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs"
            :class="
              check.pass
                ? 'border-[color:var(--positive)] text-[color:var(--positive)]'
                : 'border-destructive text-destructive'
            "
          >
            <Check v-if="check.pass" class="size-3.5" aria-hidden="true" />
            <X v-else class="size-3.5" aria-hidden="true" />
            {{ check.label }}
            <span class="text-muted-foreground tabular-nums">{{ check.min }}:1</span>
          </span>
        </li>
      </ul>

      <p v-if="report.composited" class="text-xs text-muted-foreground">
        One of the colors was translucent, so it was flattened before measuring: the foreground over
        the background, and the background over white.
      </p>

      <!-- suggestion -->
      <div
        v-if="report.suggestion"
        class="flex flex-wrap items-center gap-3 rounded-[10px] border p-4"
      >
        <span
          class="size-9 shrink-0 rounded-[8px] border"
          :style="{ backgroundColor: report.suggestion.hex }"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-col">
          <span class="text-sm">
            Nearest foreground that meets {{ report.target.label }}:
            <span class="font-mono">{{ report.suggestion.hex }}</span>
            at
            <span class="font-mono tabular-nums">{{ report.suggestion.ratio.toFixed(2) }}:1</span>
          </span>
          <span class="text-xs text-muted-foreground">
            {{ report.suggestion.direction }} than the color you gave, with the same hue and chroma
            in OKLCH
          </span>
        </div>
        <div class="ml-auto flex items-center gap-1">
          <CopyButton :text="report.suggestion.hex" label="Copy" variant="ghost" />
          <Button type="button" variant="outline" size="sm" @click="applySuggestion">
            Use this color
          </Button>
        </div>
      </div>

      <!-- formats -->
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            The pair in every syntax
          </span>
          <CopyButton :text="reportText" label="Copy report" />
        </div>
        <KeyValueGrid :record="formats" :columns="2" surface="secondary" />
      </div>
    </template>
  </div>
</template>
