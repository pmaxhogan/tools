<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  DEFAULT_LAYER,
  SHADOW_PRESETS,
  formatShadow,
  formatShadowLayer,
  formatTailwind,
  parseBoxShadow,
  presetLayers,
  type ShadowLayer,
} from "@/tools/box-shadow-generator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";

/**
 * Bespoke panel for the Box Shadow Generator.
 *
 * Every number on screen belongs to the layer model in
 * `src/tools/box-shadow-generator/` (PROJECT.md rule 27): this file owns the
 * layer list, the drag-free reordering, the URL fragment, and the two preview
 * cards, and never formats a shadow itself. The preview needs no iframe,
 * because a box-shadow applied as an inline style cannot leak a class name or
 * a keyframe name into the site's own stylesheet.
 *
 * A native `<input type="color">` carries no alpha, which is why the model
 * keeps the hue and the opacity apart and only recombines them at format time.
 */
defineProps<{ meta: ToolMeta }>();

const COLOR_SYNTAXES = [
  { value: "rgba", label: "rgba()" },
  { value: "hex", label: "hex" },
  { value: "modern", label: "rgb() /" },
] as const;

type ColorSyntax = (typeof COLOR_SYNTAXES)[number]["value"];

interface PanelError {
  message: string;
  fix?: string;
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const layers = ref<ShadowLayer[]>(presetLayers("material-2"));
const colorSyntax = ref<ColorSyntax>("rgba");
const pasted = ref("");
const error = ref<PanelError | null>(null);
/** Index of the layer whose editor is expanded. */
const openIndex = ref(0);

const cssValue = computed(() => formatShadow(layers.value, colorSyntax.value));
const cssDeclaration = computed(() => `box-shadow: ${cssValue.value};`);
const tailwindValue = computed(() => formatTailwind(layers.value, colorSyntax.value));
/** One line, for the fragment and for the inline preview style. */
const flatValue = computed(() => formatShadow(layers.value, colorSyntax.value, false));

/* ------------------------------------------------------------------ *
 * fragment
 * ------------------------------------------------------------------ */

let ready = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function syncFragment(): void {
  if (!ready) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    writeFragment({ input: flatValue.value, opts: { syntax: colorSyntax.value } });
  }, 200);
}

/* ------------------------------------------------------------------ *
 * editing
 * ------------------------------------------------------------------ */

function toPanelError(e: unknown): PanelError {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  return { message: e instanceof Error ? e.message : String(e) };
}

function setLayers(next: ShadowLayer[]): void {
  layers.value = next;
  if (openIndex.value >= next.length) openIndex.value = Math.max(0, next.length - 1);
  syncFragment();
}

function update(index: number, patch: Partial<ShadowLayer>): void {
  const next = layers.value.map((l, i) => (i === index ? { ...l, ...patch } : l));
  setLayers(next);
}

function addLayer(): void {
  setLayers([...layers.value, { ...DEFAULT_LAYER }]);
  openIndex.value = layers.value.length - 1;
}

function duplicateLayer(index: number): void {
  const next = layers.value.slice();
  next.splice(index + 1, 0, { ...layers.value[index] });
  setLayers(next);
  openIndex.value = index + 1;
}

function removeLayer(index: number): void {
  setLayers(layers.value.filter((_, i) => i !== index));
}

function move(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= layers.value.length) return;
  const next = layers.value.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  setLayers(next);
  openIndex.value = target;
}

function applyPreset(value: string): void {
  try {
    error.value = null;
    setLayers(presetLayers(value));
    openIndex.value = 0;
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function applyPasted(): void {
  const text = pasted.value.trim();
  if (!text) {
    error.value = {
      message: "There is nothing to read yet.",
      fix: "Paste a box-shadow value, for example 0 1px 3px rgba(0, 0, 0, 0.2).",
    };
    return;
  }
  try {
    setLayers(parseBoxShadow(text));
    error.value = null;
    openIndex.value = 0;
  } catch (e) {
    error.value = toPanelError(e);
  }
}

function setColorSyntax(value: string): void {
  colorSyntax.value = value as ColorSyntax;
  syncFragment();
}

/** A native color input only accepts #rrggbb, so a typed value is vetted first. */
function setHex(index: number, raw: string): void {
  const text = raw.trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) update(index, { color: text.toLowerCase() });
  else if (/^[0-9a-f]{6}$/i.test(text)) update(index, { color: `#${text.toLowerCase()}` });
}

/* ------------------------------------------------------------------ *
 * preview
 * ------------------------------------------------------------------ */

/** The inline style for a preview card. Inset shadows need a visible surface. */
const previewStyle = computed(() => ({ boxShadow: flatValue.value || "none" }));

const summary = computed(() =>
  layers.value.map((l, i) => ({
    index: i,
    text: formatShadowLayer(l, colorSyntax.value),
    swatch: l.color,
  })),
);

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onMounted(() => {
  const frag = readFragment();
  const syntax = frag.opts["syntax"];
  if (syntax && COLOR_SYNTAXES.some((s) => s.value === syntax)) {
    colorSyntax.value = syntax as ColorSyntax;
  }
  if (frag.input) {
    try {
      layers.value = parseBoxShadow(frag.input);
    } catch {
      // A stale or hand-edited link should not break the page: the preset stands.
    }
  }
  ready = true;
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  timer = undefined;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- presets -->
    <div class="flex flex-col gap-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Presets
      </span>
      <div class="flex flex-wrap gap-1.5">
        <Button
          v-for="preset in SHADOW_PRESETS"
          :key="preset.value"
          type="button"
          variant="outline"
          size="sm"
          :title="preset.note"
          @click="applyPreset(preset.value)"
        >
          {{ preset.label }}
        </Button>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <!-- layer editor -->
      <div class="flex min-w-0 flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Layers
          </span>
          <Button type="button" variant="outline" size="sm" @click="addLayer">
            <Plus class="size-3.5" aria-hidden="true" />
            Add layer
          </Button>
        </div>

        <EmptyState
          v-if="!layers.length"
          title="No shadow layers"
          hint="Add a layer or pick a preset above. An empty list is box-shadow: none."
          icon="Layers"
        />

        <div
          v-for="(entry, index) in summary"
          :key="index"
          class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] px-1 py-0.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ring)]"
              :aria-expanded="openIndex === index"
              @click="openIndex = openIndex === index ? -1 : index"
            >
              <span
                class="size-4 shrink-0 rounded-[4px] border"
                :style="{ background: entry.swatch }"
                aria-hidden="true"
              ></span>
              <span class="min-w-0 truncate font-mono text-xs">{{ entry.text }}</span>
            </button>
            <div class="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                :disabled="index === 0"
                :aria-label="`Move layer ${index + 1} up`"
                @click="move(index, -1)"
              >
                <ArrowUp class="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                :disabled="index === layers.length - 1"
                :aria-label="`Move layer ${index + 1} down`"
                @click="move(index, 1)"
              >
                <ArrowDown class="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                :aria-label="`Duplicate layer ${index + 1}`"
                @click="duplicateLayer(index)"
              >
                <Copy class="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                :aria-label="`Remove layer ${index + 1}`"
                @click="removeLayer(index)"
              >
                <Trash2 class="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div v-if="openIndex === index" class="mt-3 flex flex-col gap-2.5">
            <div
              v-for="field in [
                { key: 'x', label: 'X offset', min: -100, max: 100 },
                { key: 'y', label: 'Y offset', min: -100, max: 100 },
                { key: 'blur', label: 'Blur', min: 0, max: 150 },
                { key: 'spread', label: 'Spread', min: -100, max: 100 },
              ] as const"
              :key="field.key"
              class="flex items-center gap-3"
            >
              <Label
                :for="`shadow-${index}-${field.key}`"
                class="w-20 shrink-0 text-xs text-muted-foreground"
              >
                {{ field.label }}
              </Label>
              <Slider
                :id="`shadow-${index}-${field.key}`"
                :model-value="[layers[index][field.key]]"
                :min="field.min"
                :max="field.max"
                :step="1"
                :aria-label="`${field.label} of layer ${index + 1}, in pixels`"
                class="min-w-0 flex-1"
                @update:model-value="
                  (v) => update(index, { [field.key]: Number(v?.[0] ?? 0) } as Partial<ShadowLayer>)
                "
              />
              <span class="w-14 shrink-0 text-right font-mono text-xs tabular-nums">
                {{ layers[index][field.key] }}px
              </span>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <Label
                :for="`shadow-${index}-color`"
                class="w-20 shrink-0 text-xs text-muted-foreground"
              >
                Color
              </Label>
              <input
                :id="`shadow-${index}-color`"
                type="color"
                :value="layers[index].color"
                class="h-8 w-12 shrink-0 cursor-pointer rounded-[8px] border bg-card p-1"
                @input="update(index, { color: ($event.target as HTMLInputElement).value })"
              />
              <Input
                :model-value="layers[index].color"
                type="text"
                spellcheck="false"
                autocomplete="off"
                :aria-label="`Hex color of layer ${index + 1}`"
                class="h-8 w-28 font-mono"
                @update:model-value="(v) => setHex(index, String(v))"
              />
            </div>

            <div class="flex items-center gap-3">
              <Label
                :for="`shadow-${index}-opacity`"
                class="w-20 shrink-0 text-xs text-muted-foreground"
              >
                Opacity
              </Label>
              <Slider
                :id="`shadow-${index}-opacity`"
                :model-value="[layers[index].opacity]"
                :min="0"
                :max="1"
                :step="0.01"
                :aria-label="`Opacity of layer ${index + 1}`"
                class="min-w-0 flex-1"
                @update:model-value="(v) => update(index, { opacity: Number(v?.[0] ?? 0) })"
              />
              <span class="w-14 shrink-0 text-right font-mono text-xs tabular-nums">
                {{ Math.round(layers[index].opacity * 100) }}%
              </span>
            </div>

            <div class="flex items-center gap-2">
              <Switch
                :id="`shadow-${index}-inset`"
                :model-value="layers[index].inset"
                @update:model-value="(v) => update(index, { inset: Boolean(v) })"
              />
              <Label :for="`shadow-${index}-inset`" class="text-xs text-muted-foreground">
                Inset: draw the shadow inside the box
              </Label>
            </div>
          </div>
        </div>

        <!-- read an existing value back -->
        <div class="flex flex-col gap-1.5">
          <Label for="shadow-paste" class="text-xs text-muted-foreground">
            Read an existing box-shadow
          </Label>
          <div class="flex flex-wrap gap-2">
            <Input
              id="shadow-paste"
              v-model="pasted"
              type="text"
              spellcheck="false"
              autocomplete="off"
              placeholder="0 1px 3px rgba(0, 0, 0, 0.2)"
              class="h-8 min-w-0 flex-1 font-mono"
              @keydown.enter.prevent="applyPasted"
            />
            <Button type="button" variant="outline" size="sm" @click="applyPasted">
              Load layers
            </Button>
          </div>
        </div>
      </div>

      <!-- preview and output -->
      <div class="flex min-w-0 flex-col gap-3">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Preview
        </span>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="grid place-items-center rounded-[10px] bg-[#f6f4f1] p-7">
            <div
              class="grid h-20 w-full place-items-center rounded-[12px] bg-white text-sm text-[#2a2622]"
              :style="previewStyle"
            >
              On light
            </div>
          </div>
          <div class="grid place-items-center rounded-[10px] bg-[#141311] p-7">
            <div
              class="grid h-20 w-full place-items-center rounded-[12px] bg-[#1d1b18] text-sm text-[#ede9e3]"
              :style="previewStyle"
            >
              On dark
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label id="shadow-syntax-label" class="text-xs text-muted-foreground">
            Color syntax
          </Label>
          <Segmented
            :model-value="colorSyntax"
            :options="[...COLOR_SYNTAXES]"
            label="Color syntax"
            size="sm"
            @update:model-value="setColorSyntax"
          />
        </div>

        <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              CSS
            </span>
            <CopyButton :text="cssDeclaration" label="Copy" />
          </div>
          <pre class="max-h-52 overflow-auto px-3 pb-2 font-mono text-sm whitespace-pre-wrap">{{
            cssDeclaration
          }}</pre>
        </div>

        <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
          <div class="flex items-center justify-between px-3 pt-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Tailwind
            </span>
            <CopyButton :text="tailwindValue" label="Copy" />
          </div>
          <pre
            class="max-h-40 overflow-auto px-3 pb-2 font-mono text-sm break-all whitespace-pre-wrap"
            >{{ tailwindValue }}</pre>
        </div>
      </div>
    </div>

    <ErrorBanner
      v-if="error"
      :message="error.message"
      :hint="error.fix"
      dismissible
      @dismiss="error = null"
    />

    <p class="text-xs text-muted-foreground">
      {{ meta.name }} runs entirely in this page: your files and inputs never leave your device.
    </p>
  </div>
</template>
