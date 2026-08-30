<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId } from "vue";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  bandHex,
  bandLabel,
  bandRole,
  bandsToCode,
  codeToBands,
  defaultBands,
  encodeToBands,
  legalColorsForPosition,
  parseBandList,
  resizeBands,
  run,
  type BandOption,
  type BandRole,
} from "@/tools/resistor-color-code-calculator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import ErrorBanner from "../ErrorBanner.vue";
import KeyValueGrid from "../KeyValueGrid.vue";
import OptionControl from "../OptionControl.vue";

/**
 * Bespoke panel for the Resistor Color Code Calculator.
 *
 * A resistor is a picture, not a sentence. The generic shell can only ask the
 * reader to type "yellow violet red gold", which is the exact step they came
 * here to avoid: they are holding the part and want to point at a band. So this
 * panel draws the part, makes every band a picker, and keeps the typed path as
 * a secondary input for people who already know the words.
 *
 * Every number and every legality rule still comes from the pure layer
 * (PROJECT.md rule 27). The panel owns the drawing and nothing else:
 * legalColorsForPosition decides which swatches a band may offer, run decides
 * what a set of bands is worth, encodeToBands decides which colors a typed value
 * paints, and resizeBands decides what happens when the band count changes. That
 * is what stops the picker from ever offering a color the decoder would reject.
 *
 * The drawing is a dog-bone axial resistor: lead wires, bulged end caps, a
 * narrower body, and bands that follow the body outline instead of sitting on it
 * as flat rectangles. One profile function feeds both the band edges and the hit
 * targets, and the band group is clipped to the body path, so a band on the cap
 * slope can never overhang the part.
 */
const props = defineProps<{ meta: ToolMeta }>();

interface PanelError {
  message: string;
  fix?: string;
}

function readError(e: unknown): PanelError {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

/* ------------------------------------------------------------------ *
 * drawing geometry
 *
 * viewBox units throughout. The body outline is the approved artwork, kept
 * verbatim; the profile table below is that same outline sampled off its own
 * curves, so the bands and the hit targets agree with it point for point.
 * ------------------------------------------------------------------ */

const VIEW_W = 420;
const VIEW_H = 140;
/** The centerline the leads and the body are symmetric about. */
const AXIS = 70;
/** The body's midpoint, and the axis the profile table mirrors around. */
const BODY_CENTER = 210;

const BODY_PATH = [
  "M 82 70",
  "C 82 44, 96 40, 112 42",
  "C 122 34, 134 34, 142 40",
  "L 278 40",
  "C 286 34, 298 34, 308 42",
  "C 324 40, 338 44, 338 70",
  "C 338 96, 324 100, 308 98",
  "C 298 106, 286 106, 278 100",
  "L 142 100",
  "C 134 106, 122 106, 112 98",
  "C 96 100, 82 96, 82 70 Z",
].join(" ");

/** The sheen across the upper third of the body. */
const HIGHLIGHT_PATH = "M 92 52 C 120 46, 300 46, 328 52";

/**
 * Half the body height at a given x: zero where the lead enters, a fast rise,
 * the slight waist behind the cap, the cap bulge that makes the silhouette a
 * dog-bone, then the flat body. Mirrored about BODY_CENTER for the right half.
 */
const PROFILE: [number, number][] = [
  [82, 0],
  [82.6, 8.8],
  [84.4, 15.6],
  [87.3, 20.8],
  [91, 24.5],
  [95.5, 26.9],
  [100.6, 28.1],
  [106.1, 28.4],
  [112, 28],
  [119.8, 32.5],
  [127.8, 34.3],
  [135.4, 33.3],
  [142, 30],
];

function halfHeight(x: number): number {
  const mirrored = x <= BODY_CENTER ? x : VIEW_W - x;
  const first = PROFILE[0];
  const last = PROFILE[PROFILE.length - 1];
  if (mirrored <= first[0]) return 0;
  if (mirrored >= last[0]) return last[1];
  for (let i = 1; i < PROFILE.length; i += 1) {
    const [x1, h1] = PROFILE[i];
    if (mirrored <= x1) {
      const [x0, h0] = PROFILE[i - 1];
      return h0 + ((h1 - h0) * (mirrored - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/**
 * Where each band sits, by band count. Digits and the multiplier are grouped
 * toward the left cap and the tolerance band sits apart near the right one,
 * which is how a real part tells you which end to start reading from.
 */
const BAND_CENTERS: Record<number, number[]> = {
  3: [128, 178, 226],
  4: [128, 178, 226, 293],
  5: [118, 156, 194, 232, 293],
  6: [116, 152, 188, 224, 268, 304],
};
const BAND_HALF_WIDTH: Record<number, number> = { 3: 10, 4: 10, 5: 9, 6: 8 };
/** How far a band's vertical edges lean, at the far ends of the body. */
const MAX_BOW = 4;
/** Extra hit area around a band, so a 16 unit stripe is still easy to hit. */
const HIT_PAD = 3;

function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * One band as a closed path. The top and bottom edges are quadratics forced
 * through the body outline at the band's midpoint, so a band on the cap slope
 * curves with the part. The vertical edges lean by the same amount in the same
 * direction, which reads as a stripe wrapped around a cylinder rather than a
 * rectangle painted on a flat shape.
 */
function bandPath(cx: number, hw: number): string {
  const x0 = cx - hw;
  const x1 = cx + hw;
  const h0 = halfHeight(x0);
  const h1 = halfHeight(x1);
  const hc = halfHeight(cx);
  const top0 = AXIS - h0;
  const bottom0 = AXIS + h0;
  const top1 = AXIS - h1;
  const bottom1 = AXIS + h1;
  const bow = (MAX_BOW * (cx - BODY_CENTER)) / 128;
  const lift0 = h0 * 0.56;
  const lift1 = h1 * 0.56;
  const topControl = (4 * (AXIS - hc) - top0 - top1) / 2;
  const bottomControl = (4 * (AXIS + hc) - bottom0 - bottom1) / 2;
  return [
    `M ${num(x0)} ${num(top0)}`,
    `C ${num(x0 + bow)} ${num(top0 + lift0)} ${num(x0 + bow)} ${num(bottom0 - lift0)} ${num(x0)} ${num(bottom0)}`,
    `Q ${num(cx)} ${num(bottomControl)} ${num(x1)} ${num(bottom1)}`,
    `C ${num(x1 + bow)} ${num(bottom1 - lift1)} ${num(x1 + bow)} ${num(top1 + lift1)} ${num(x1)} ${num(top1)}`,
    `Q ${num(cx)} ${num(topControl)} ${num(x0)} ${num(top0)}`,
    "Z",
  ].join(" ");
}

/* ------------------------------------------------------------------ *
 * paint
 * ------------------------------------------------------------------ */

/** Unique per instance, so a popped out copy cannot steal this one's gradients. */
const uid = useId();
const bodyGradientId = `resistor-body-${uid}`;
const bodyClipId = `resistor-clip-${uid}`;
const goldGradientId = `resistor-gold-${uid}`;
const silverGradientId = `resistor-silver-${uid}`;

/** Gold and silver are metal, not ink, so they get a gradient, not a flat fill. */
function fillFor(color: string): string {
  if (color === "gold") return `url(#${goldGradientId})`;
  if (color === "silver") return `url(#${silverGradientId})`;
  return bandHex(color);
}

const SWATCH_METAL: Record<string, string> = {
  gold: "linear-gradient(135deg, #f2dd8a 0%, #c9a227 48%, #8d6d15 100%)",
  silver: "linear-gradient(135deg, #f2f1ee 0%, #b8b8b6 48%, #83837d 100%)",
};

function swatchFill(option: BandOption): string {
  return SWATCH_METAL[option.color] ?? option.hex;
}

/* ------------------------------------------------------------------ *
 * labels
 * ------------------------------------------------------------------ */

const DIGIT_ORDINAL = ["first", "second", "third"];
const DIGIT_SHORT = ["1st", "2nd", "3rd"];
const ROLE_TITLE: Record<BandRole, string> = {
  digit: "Digit band",
  multiplier: "Multiplier band",
  tolerance: "Tolerance band",
  tempco: "Temperature coefficient band",
};

/** The caption under a band. Six bands leave no room for the long words. */
function captionFor(bands: number, index: number): string {
  const role = bandRole(bands, index);
  if (role === "digit") return DIGIT_SHORT[index] ?? "";
  if (role === "multiplier") return bands === 6 ? "mult" : "multiplier";
  if (role === "tolerance") return bands === 6 ? "tol" : "tolerance";
  return "ppm/K";
}

/** How a screen reader hears the band's job. */
function roleWords(bands: number, index: number): string {
  const role = bandRole(bands, index);
  if (role === "digit") return `${DIGIT_ORDINAL[index] ?? "next"} digit`;
  if (role === "multiplier") return "multiplier";
  if (role === "tolerance") return "tolerance";
  return "temperature coefficient";
}

function popoverTitle(bands: number, index: number): string {
  const role = bandRole(bands, index);
  if (role === "digit") {
    const word = DIGIT_ORDINAL[index] ?? "next";
    return `${word.charAt(0).toUpperCase()}${word.slice(1)} digit band`;
  }
  return ROLE_TITLE[role ?? "digit"];
}

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const MODE_OPTIONS: SegmentedOption[] = [
  { value: "decode", label: "Decode" },
  { value: "encode", label: "Encode" },
];
const DECODE_BAND_OPTIONS: SegmentedOption[] = ["3", "4", "5", "6"].map((v) => ({
  value: v,
  label: v,
}));
const ENCODE_BAND_OPTIONS: SegmentedOption[] = DECODE_BAND_OPTIONS.slice(1);

const mode = ref<"decode" | "encode">("decode");
/** Decode mode's model: the bands themselves. */
const bandColors = ref<string[]>(defaultBands(4));
/** Encode mode's model: a value, plus the band count to spend on it. */
const encodeBands = ref(4);
const value = ref("4.7k");
const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);
const typed = ref(bandColors.value.map((c) => bandLabel(c).toLowerCase()).join(" "));
const typedError = ref<PanelError | null>(null);
const openIndex = ref<number | null>(null);

/** Legal values for one of the meta selects, used to vet a shared link. */
function optionValues(id: string): string[] {
  const spec = props.meta.options?.find((o) => o.id === id);
  if (!spec || spec.kind !== "select") return [];
  return (spec.options ?? []).map((o) => o.value);
}

/**
 * The option specs encode mode renders. Mode and band count are already drawn
 * as segmented controls above, so rendering them from the meta as well would
 * ship two controls for the same value.
 */
const encodeSpecs = computed(() =>
  (props.meta.options ?? []).filter(
    (spec) => spec.id === "tolerance" || (spec.id === "tempco" && encodeBands.value === 6),
  ),
);

const bandCount = computed(() =>
  mode.value === "decode" ? bandColors.value.length : encodeBands.value,
);

const encodeOpts = computed(() => ({
  mode: "encode",
  bands: String(encodeBands.value),
  tolerance: String(opts.value.tolerance ?? "5"),
  tempco: String(opts.value.tempco ?? "100"),
}));

/**
 * The single source of truth for both halves of the panel: which colors the
 * drawing paints, and what the readout says about them. Decode keeps painting
 * the bands through an error, because someone who typed "gold black red gold"
 * should be able to see the gold band the message is complaining about. Encode
 * has nothing to paint until the value parses.
 */
const outcome = computed<{
  result: Record<string, string> | null;
  error: PanelError | null;
  colors: string[];
}>(() => {
  if (mode.value === "decode") {
    const colors = bandColors.value;
    try {
      return { result: run(colors.join(" "), { mode: "decode" }), error: null, colors };
    } catch (e) {
      return { result: null, error: readError(e), colors };
    }
  }
  try {
    return {
      result: run(value.value, encodeOpts.value),
      error: null,
      colors: encodeToBands(value.value, encodeOpts.value),
    };
  } catch (e) {
    return { result: null, error: readError(e), colors: [] };
  }
});

const shownColors = computed(() => outcome.value.colors);

interface BandView {
  index: number;
  color: string;
  fill: string;
  path: string;
  caption: string;
  captionX: number;
  aria: string;
  title: string;
  hit: Record<string, string>;
}

const bandViews = computed<BandView[]>(() => {
  const colors = shownColors.value;
  const count = colors.length;
  const centers = BAND_CENTERS[count] ?? [];
  const hw = BAND_HALF_WIDTH[count] ?? 10;
  return colors.map((color, index) => {
    const cx = centers[index] ?? BODY_CENTER;
    const reach = Math.max(halfHeight(cx - hw), halfHeight(cx), halfHeight(cx + hw)) + HIT_PAD;
    return {
      index,
      color,
      fill: fillFor(color),
      path: bandPath(cx, hw),
      caption: captionFor(count, index),
      captionX: cx,
      aria: `Band ${index + 1}: ${bandLabel(color).toLowerCase()}, ${roleWords(count, index)}`,
      title: popoverTitle(count, index),
      hit: {
        left: `${((cx - hw - HIT_PAD) / VIEW_W) * 100}%`,
        top: `${((AXIS - reach) / VIEW_H) * 100}%`,
        width: `${(((hw + HIT_PAD) * 2) / VIEW_W) * 100}%`,
        height: `${((reach * 2) / VIEW_H) * 100}%`,
      },
    };
  });
});

/** A plain description of the painted code, for the read-only encode drawing. */
const drawingLabel = computed(() => {
  const names = shownColors.value.map((c) => bandLabel(c).toLowerCase());
  return names.length
    ? `Resistor with ${names.length} bands: ${names.join(", ")}.`
    : "Resistor with no bands yet.";
});

/* ------------------------------------------------------------------ *
 * the picker
 *
 * The bands are drawn in the SVG and the hit targets are real buttons laid
 * over them, positioned in percentages of the same viewBox. That way one tab
 * stop per band, Enter and Space, the focus ring, and the popover anchor all
 * come from the platform, and the SVG only has to be a picture.
 * ------------------------------------------------------------------ */

const SWATCH_COLUMNS = 4;
const NAV_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

function optionsFor(index: number): BandOption[] {
  return legalColorsForPosition(bandCount.value, index);
}

function gridId(index: number): string {
  return `${uid}-swatches-${index}`;
}

function swatchButtons(grid: Element | null): HTMLButtonElement[] {
  return grid ? Array.from(grid.querySelectorAll<HTMLButtonElement>("button")) : [];
}

function setOpen(index: number, open: boolean): void {
  if (open) openIndex.value = index;
  else if (openIndex.value === index) openIndex.value = null;
}

/**
 * Open onto the color the band already has rather than the first swatch, so the
 * arrow keys start from where the reader is instead of from black.
 */
function onOpenAutoFocus(event: Event, index: number): void {
  event.preventDefault();
  const current = optionsFor(index).findIndex((o) => o.color === shownColors.value[index]);
  const target = current === -1 ? 0 : current;
  void nextTick(() => {
    const grid = document.querySelector(`[data-swatch-grid="${gridId(index)}"]`);
    swatchButtons(grid)[target]?.focus();
  });
}

function onSwatchKeydown(event: KeyboardEvent, index: number): void {
  if (!NAV_KEYS.includes(event.key)) return;
  const buttons = swatchButtons((event.currentTarget as HTMLElement).parentElement);
  if (!buttons.length) return;
  const last = buttons.length - 1;
  let next: number;
  if (event.key === "ArrowLeft") next = index - 1;
  else if (event.key === "ArrowRight") next = index + 1;
  else if (event.key === "ArrowUp") next = index - SWATCH_COLUMNS;
  else if (event.key === "ArrowDown") next = index + SWATCH_COLUMNS;
  else if (event.key === "Home") next = 0;
  else next = last;
  event.preventDefault();
  buttons[Math.min(last, Math.max(0, next))]?.focus();
}

function chooseColor(bandIndex: number, color: string): void {
  const next = [...bandColors.value];
  next[bandIndex] = color;
  bandColors.value = next;
  syncTyped();
  openIndex.value = null;
  schedule();
}

/* ------------------------------------------------------------------ *
 * controls
 * ------------------------------------------------------------------ */

function setMode(next: string): void {
  mode.value = next === "encode" ? "encode" : "decode";
  openIndex.value = null;
  schedule();
}

function setBandCount(next: string): void {
  const count = Number(next);
  if (!Number.isFinite(count)) return;
  openIndex.value = null;
  if (mode.value === "decode") {
    bandColors.value = resizeBands(bandColors.value, count);
    syncTyped();
  } else {
    encodeBands.value = Math.min(6, Math.max(4, count));
  }
  schedule();
}

/** Mirror the bands into the typed field, in US English, lowercased. */
function syncTyped(): void {
  typed.value = bandColors.value.map((c) => bandLabel(c).toLowerCase()).join(" ");
  typedError.value = null;
}

function onTyped(next: string): void {
  typed.value = next;
  if (!next.trim()) {
    typedError.value = null;
    return;
  }
  try {
    bandColors.value = parseBandList(next);
    typedError.value = null;
  } catch (e) {
    typedError.value = readError(e);
  }
  schedule();
}

function setOption(id: string, next: unknown): void {
  opts.value = { ...opts.value, [id]: next };
  schedule();
}

function onValueInput(next: string): void {
  value.value = next;
  schedule();
}

/* ------------------------------------------------------------------ *
 * shareable state (rule 6: the fragment, never the query string)
 * ------------------------------------------------------------------ */

const ready = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function persist(): void {
  if (mode.value === "decode") {
    writeFragment({ opts: { mode: "decode", b: bandsToCode(bandColors.value) } });
    return;
  }
  writeFragment({
    input: value.value.trim() || undefined,
    opts: {
      mode: "encode",
      bands: String(encodeBands.value),
      tolerance: String(opts.value.tolerance ?? "5"),
      tempco: String(opts.value.tempco ?? "100"),
    },
  });
}

function schedule(): void {
  if (!ready.value) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    persist();
  }, 200);
}

onMounted(() => {
  // A shared link carries the mode, the bands as a compact code, and, for
  // encode, the value and its options. Anything the meta does not list is
  // dropped rather than applied, so an old link can never load the drawing
  // into a state the decoder refuses.
  const frag = readFragment();
  const fragMode = frag.opts["mode"];
  if (fragMode === "decode" || fragMode === "encode") mode.value = fragMode;

  const code = frag.opts["b"];
  const fromCode = code ? codeToBands(code) : null;
  if (fromCode) {
    bandColors.value = fromCode;
  } else if (frag.input && fragMode !== "encode") {
    try {
      bandColors.value = parseBandList(frag.input);
    } catch {
      /* A stale or hand-edited link just leaves the default bands in place. */
    }
  }
  syncTyped();

  if (frag.input !== undefined && mode.value === "encode") value.value = frag.input;
  const linkBands = frag.opts["bands"];
  if (linkBands && optionValues("bands").includes(linkBands)) {
    encodeBands.value = Number(linkBands);
  }
  for (const id of ["tolerance", "tempco"]) {
    const linked = frag.opts[id];
    if (linked && optionValues(id).includes(linked)) opts.value[id] = linked;
  }

  ready.value = true;
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  timer = undefined;
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- mode and band count -->
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Mode</span>
        <Segmented
          :model-value="mode"
          :options="MODE_OPTIONS"
          label="Mode"
          @update:model-value="setMode"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">Bands</span>
        <Segmented
          :model-value="String(bandCount)"
          :options="mode === 'decode' ? DECODE_BAND_OPTIONS : ENCODE_BAND_OPTIONS"
          label="Band count"
          @update:model-value="setBandCount"
        />
      </div>
    </div>

    <!-- encode inputs -->
    <div v-if="mode === 'encode'" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="resistor-value" class="text-xs text-muted-foreground">Resistance</Label>
        <Input
          id="resistor-value"
          :model-value="value"
          placeholder="4.7k"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="h-8 font-mono"
          :aria-invalid="outcome.error ? 'true' : undefined"
          @update:model-value="onValueInput(String($event))"
        />
      </div>
      <OptionControl
        v-for="spec in encodeSpecs"
        :key="spec.id"
        :spec="spec"
        :model-value="opts[spec.id]"
        @update:model-value="setOption(spec.id, $event)"
      />
    </div>

    <!-- the part -->
    <div class="rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]">
      <div class="relative mx-auto w-full max-w-[420px]">
        <svg
          viewBox="0 0 420 140"
          class="block h-auto w-full"
          :role="mode === 'encode' ? 'img' : undefined"
          :aria-label="mode === 'encode' ? drawingLabel : undefined"
          :aria-hidden="mode === 'decode' ? 'true' : undefined"
        >
          <defs>
            <linearGradient :id="bodyGradientId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#e8d5b5" />
              <stop offset="0.35" stop-color="#d9c3a0" />
              <stop offset="1" stop-color="#b89d74" />
            </linearGradient>
            <linearGradient :id="goldGradientId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#f2dd8a" />
              <stop offset="0.45" stop-color="#c9a227" />
              <stop offset="1" stop-color="#8d6d15" />
            </linearGradient>
            <linearGradient :id="silverGradientId" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#f2f1ee" />
              <stop offset="0.45" stop-color="#b8b8b6" />
              <stop offset="1" stop-color="#83837d" />
            </linearGradient>
            <clipPath :id="bodyClipId">
              <path :d="BODY_PATH" />
            </clipPath>
          </defs>

          <!-- leads -->
          <line
            x1="6"
            y1="70"
            x2="82"
            y2="70"
            stroke="#9a958e"
            stroke-width="5"
            stroke-linecap="round"
          />
          <line
            x1="338"
            y1="70"
            x2="414"
            y2="70"
            stroke="#9a958e"
            stroke-width="5"
            stroke-linecap="round"
          />

          <!-- body -->
          <path
            :d="BODY_PATH"
            :fill="`url(#${bodyGradientId})`"
            stroke="#a8895c"
            stroke-width="2"
          />

          <!-- bands, clipped so none can hang off the end caps -->
          <g :clip-path="`url(#${bodyClipId})`">
            <path
              v-for="band in bandViews"
              :key="band.index"
              :d="band.path"
              :fill="band.fill"
              :stroke="openIndex === band.index ? 'var(--ring)' : 'none'"
              stroke-width="2.5"
            />
          </g>

          <!-- sheen, over the bands so the part reads as one glazed body -->
          <path
            :d="HIGHLIGHT_PATH"
            fill="none"
            stroke="#ffffff"
            stroke-opacity="0.4"
            stroke-width="5"
            stroke-linecap="round"
          />

          <text
            v-for="band in bandViews"
            :key="`caption-${band.index}`"
            :x="band.captionX"
            y="126"
            text-anchor="middle"
            font-size="10.5"
            fill="currentColor"
            class="text-muted-foreground"
          >
            {{ band.caption }}
          </text>
        </svg>

        <!-- one picker per band, sitting exactly on top of it -->
        <template v-if="mode === 'decode'">
          <Popover
            v-for="band in bandViews"
            :key="`pick-${band.index}`"
            :open="openIndex === band.index"
            @update:open="setOpen(band.index, $event)"
          >
            <PopoverTrigger as-child>
              <button
                type="button"
                class="absolute cursor-pointer rounded-[6px] border-0 bg-transparent p-0 transition-colors duration-[120ms] hover:bg-foreground/10"
                :style="band.hit"
                :aria-label="band.aria"
              ></button>
            </PopoverTrigger>
            <PopoverContent
              class="w-auto max-w-[min(21rem,calc(100vw-2rem))] gap-2 p-3"
              align="center"
              side="bottom"
              @open-auto-focus="onOpenAutoFocus($event, band.index)"
            >
              <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                {{ band.title }}
              </p>
              <div :data-swatch-grid="gridId(band.index)" class="grid grid-cols-4 gap-1">
                <button
                  v-for="(option, i) in optionsFor(band.index)"
                  :key="option.color"
                  type="button"
                  class="flex cursor-pointer flex-col items-center gap-1 rounded-[8px] px-1 py-1.5 transition-colors duration-[120ms] hover:bg-accent"
                  :class="option.color === band.color ? 'bg-accent' : ''"
                  :aria-pressed="option.color === band.color"
                  @click="chooseColor(band.index, option.color)"
                  @keydown="onSwatchKeydown($event, i)"
                >
                  <span
                    class="size-7 rounded-full ring-1 ring-foreground/15"
                    :class="option.color === band.color ? 'ring-2 ring-[color:var(--ring)]' : ''"
                    :style="{ background: swatchFill(option) }"
                  ></span>
                  <span class="text-[11px] leading-tight">{{ option.label }}</span>
                  <span class="font-mono text-[10px] leading-tight text-muted-foreground">
                    {{ option.meaning }}
                  </span>
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </template>
      </div>

      <p v-if="mode === 'decode'" class="mt-2 text-center text-xs text-muted-foreground">
        Click a band to change its color. Only the colors that band can legally carry are offered.
      </p>
    </div>

    <!-- what the bands are worth -->
    <ErrorBanner v-if="outcome.error" :message="outcome.error.message" :hint="outcome.error.fix" />
    <KeyValueGrid v-else-if="outcome.result" :record="outcome.result" />

    <!-- the typed path, secondary to the drawing -->
    <template v-if="mode === 'decode'">
      <div class="h-px bg-border"></div>
      <div class="flex flex-col gap-1.5">
        <Label for="resistor-typed" class="text-xs text-muted-foreground">
          Or type it: band colors in order
        </Label>
        <Input
          id="resistor-typed"
          :model-value="typed"
          placeholder="brown black red gold"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="h-8 font-mono"
          :aria-invalid="typedError ? 'true' : undefined"
          :aria-describedby="typedError ? 'resistor-typed-error' : undefined"
          @update:model-value="onTyped(String($event))"
        />
        <div v-if="typedError" id="resistor-typed-error" role="alert" class="text-sm">
          <p class="font-medium text-destructive">{{ typedError.message }}</p>
          <p v-if="typedError.fix" class="text-muted-foreground">{{ typedError.fix }}</p>
        </div>
      </div>
    </template>
  </div>
</template>
