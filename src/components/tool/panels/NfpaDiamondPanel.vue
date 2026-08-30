<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Download, Search, TriangleAlert } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import {
  DISCLAIMER,
  NFPA_COLORS,
  QUADRANT_LABELS,
  RATING_LABELS,
  SPECIAL_LABELS,
  SPECIAL_ORDER,
  describeQuery,
  diamondSvg,
  formatRating,
  matchChemicals,
  nearbyChemicals,
  queryFromOpts,
  searchChemical,
  specialsFor,
  type DiamondSpec,
  type NfpaQuery,
  type Special,
} from "@/tools/nfpa-704-fire-diamond/index";
import { pubchemUrl, suggestions, wikipediaUrl } from "@/tools/chemical-lookup/index";
import type { Chemical, NfpaRating } from "@/tools/_generated/chem-data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { downloadBlob, downloadText } from "@/lib/download";
import CopyButton from "../CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";

/**
 * Bespoke panel for the NFPA 704 fire diamond.
 *
 * Two searches over one dataset, plus the placard itself. Everything numeric,
 * every match, every string of SVG comes from the pure logic layer
 * (PROJECT.md rule 27); this file owns DOM, layout, downloads, and URL
 * fragment state only.
 *   src/tools/nfpa-704-fire-diamond/index.ts  queryFromOpts, matchChemicals,
 *                                             nearbyChemicals, searchChemical,
 *                                             diamondSvg, describeQuery,
 *                                             formatRating, specialsFor,
 *                                             DISCLAIMER, NFPA_COLORS,
 *                                             RATING_LABELS, QUADRANT_LABELS,
 *                                             SPECIAL_LABELS, SPECIAL_ORDER
 *   src/tools/chemical-lookup/index.ts        wikipediaUrl, pubchemUrl
 *
 * WHY THE CONTROL AND THE PLACARD DISAGREE ABOUT INK
 * --------------------------------------------------
 * The placard follows NFPA 704: white numerals on the blue and the red
 * quadrant, black on the yellow one. The segmented controls follow WCAG AA
 * instead, and `aaInk` picks whichever of the two NFPA ink colors has the
 * higher contrast ratio against the fill. They agree on blue (white, 5.1:1)
 * and on yellow (black, 17.9:1) and disagree on red, where white is 4.35:1 and
 * black is 4.83:1, so the control shows a black 3 on red while the diamond one
 * pane over shows a white 3 on red. That is a deliberate split: a placard that
 * does not look like the standard is wrong, and a control that fails AA is
 * unreadable.
 *
 * FRAGMENT VALUES ARE VALIDATED BEFORE THEY REACH A COMPUTED
 * ----------------------------------------------------------
 * `queryFromOpts` and `diamondSvg` both throw on a value outside 0 to 4, and a
 * shared link is just text, so a stale `#health=7` would otherwise blank the
 * island on mount. `readState` drops anything that is not one of the values
 * this panel emits, so the render path only ever sees valid state.
 *
 * Nothing reads the DOM before mount: readFragment runs in onMounted and the
 * fragment writer stays quiet until then, so the server rendered markup is
 * always the empty diamond.
 */
defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

type QuadrantKey = "h" | "f" | "r";

/** Blue, red, yellow, in the order the rows and the rating chips read. */
const QUADRANT_KEYS: QuadrantKey[] = ["h", "f", "r"];

/** Option ids, shared with meta.ts and with the /api/nfpa-704-fire-diamond query. */
const RATING_IDS: Record<QuadrantKey, "health" | "fire" | "instability"> = {
  h: "health",
  f: "fire",
  r: "instability",
};

const SPECIAL_IDS: Record<Special, "water" | "oxidizer" | "asphyxiant"> = {
  W: "water",
  OX: "oxidizer",
  SA: "asphyxiant",
};

const FILL: Record<QuadrantKey, string> = {
  h: NFPA_COLORS.health,
  f: NFPA_COLORS.fire,
  r: NFPA_COLORS.instability,
};

/** sRGB relative luminance, the WCAG definition. Input is "#rrggbb". */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Whichever NFPA ink reads better on this fill. See the header comment. */
function aaInk(fill: string): string {
  return contrast(fill, NFPA_COLORS.lightText) >= contrast(fill, NFPA_COLORS.darkText)
    ? NFPA_COLORS.lightText
    : NFPA_COLORS.darkText;
}

const INK: Record<QuadrantKey, string> = {
  h: aaInk(FILL.h),
  f: aaInk(FILL.f),
  r: aaInk(FILL.r),
};

/** 0 to 4 then Any, the order the approved mockup lays the row out in. */
const RATING_VALUES = ["0", "1", "2", "3", "4", "any"];

const RATING_OPTIONS: SegmentedOption[] = RATING_VALUES.map((value) => ({
  value,
  label: value === "any" ? "Any" : value,
}));

/** Three state filter. The values are the ones queryFromOpts accepts. */
const FILTER_OPTIONS: SegmentedOption[] = [
  { value: "require", label: "Require" },
  { value: "exclude", label: "Exclude" },
  { value: "any", label: "Any" },
];

const FILTER_VALUES = FILTER_OPTIONS.map((o) => o.value);

/** Every option id starts on "any", which is also the meta default. */
const DEFAULTS: Record<string, string> = {
  health: "any",
  fire: "any",
  instability: "any",
  water: "any",
  oxidizer: "any",
  asphyxiant: "any",
};

/** Matches shown before the expander. Long enough to be useful, short enough to scan. */
const VISIBLE_CAP = 24;

/**
 * Matches shown after it. Every quadrant on Any matches nearly three thousand
 * chemicals, and mounting three thousand rows of chips, badges, and links to
 * answer "show me everything" is a frozen tab, not an answer. The count line
 * always tells the truth about the total, and narrowing a quadrant is the way
 * to see the rest.
 */
const EXPANDED_CAP = 300;

/** Reverse search results offered under the box. */
const SEARCH_CAP = 8;

/** Raster export scale, the same headroom the barcode and QR exports use. */
const PNG_SCALE = 2;

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const state = ref<Record<string, string>>({ ...DEFAULTS });
const captionOn = ref(false);
const caption = ref("");
const search = ref("");
const loadedFrom = ref("");
const showAll = ref(false);
const pngError = ref<string | null>(null);
const mounted = ref(false);
const diamondCard = ref<HTMLElement | null>(null);

/* ------------------------------------------------------------------ *
 * the query and its results
 * ------------------------------------------------------------------ */

/**
 * Safe by construction: every value in `state` is one this panel emitted or
 * one `readState` already checked, so the throwing paths inside queryFromOpts
 * are unreachable from here.
 */
const query = computed<NfpaQuery>(() => queryFromOpts(state.value));

const pinnedQuadrants = computed(
  () => (["h", "f", "r"] as const).filter((k) => query.value[k] !== undefined).length,
);

const matches = computed<Chemical[]>(() => matchChemicals(query.value));

const visibleMatches = computed(() =>
  matches.value.slice(0, showAll.value ? EXPANDED_CAP : VISIBLE_CAP),
);

/**
 * The closest other ratings, offered only when the exact list is thin and the
 * query actually pins a quadrant. With every quadrant on Any there is no such
 * thing as a near miss, and the list would just be the dataset again.
 */
const nearby = computed(() =>
  matches.value.length < 5 && pinnedQuadrants.value > 0 ? nearbyChemicals(query.value, 12) : [],
);

const searchResults = computed<Chemical[]>(() =>
  search.value.trim() ? searchChemical(search.value, SEARCH_CAP) : [],
);

/**
 * The typo path. `searchChemical` is exact by design, so a slipped letter
 * turns up nothing at all; `suggestions` is the bounded edit distance scan the
 * chemical lookup already owns. Only rows carrying a rating are offered here,
 * because a row without one has nothing to load into the diamond.
 */
const searchSuggestions = computed<Chemical[]>(() =>
  search.value.trim() && !searchResults.value.length
    ? suggestions(search.value, 12)
        .filter((c) => c.nfpa)
        .slice(0, 3)
    : [],
);

/** The same query, handed to the tool that searches every compound. */
const searchAllLink = computed(
  () => `/chemical-lookup#${new URLSearchParams({ i: search.value.trim() }).toString()}`,
);

/** The names of every exact match, one per line, for the copy button. */
const matchText = computed(() => matches.value.map((c) => c.name).join("\n"));

/* ------------------------------------------------------------------ *
 * the diamond
 * ------------------------------------------------------------------ */

/** Only a required symbol is drawn: Exclude and Any say nothing to place. */
const drawnSpecials = computed(() =>
  SPECIAL_ORDER.filter((s) => query.value.special[s] === "require"),
);

const captionText = computed(() => (captionOn.value ? caption.value.trim() : ""));

function buildSpec(background?: string): DiamondSpec {
  const spec: DiamondSpec = {};
  if (query.value.h !== undefined) spec.h = query.value.h;
  if (query.value.f !== undefined) spec.f = query.value.f;
  if (query.value.r !== undefined) spec.r = query.value.r;
  if (drawnSpecials.value.length) spec.special = drawnSpecials.value;
  if (captionText.value) spec.caption = captionText.value;
  if (background) spec.background = background;
  return spec;
}

/** Our own SVG string, built from validated numbers. Injected with v-html below. */
const diamond = computed(() => diamondSvg(buildSpec()));

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const fileBase = computed(() => {
  const named = slugify(captionText.value);
  if (named) return `nfpa-704-${named}`;
  const digits = (["h", "f", "r"] as const)
    .map((k) => (query.value[k] === undefined ? "x" : String(query.value[k])))
    .join("-");
  return `nfpa-704-${digits}`;
});

function downloadSvg(): void {
  downloadText(diamond.value, `${fileBase.value}.svg`, "image/svg+xml");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That diamond could not be rendered as an image."));
    img.src = src;
  });
}

/**
 * The PNG is drawn at twice the SVG's own pixel size, on white twice over: the
 * SVG carries a white background rect and the canvas is filled white before
 * the draw, so a placard pasted onto a dark slide never shows through.
 */
async function downloadPng(): Promise<void> {
  pngError.value = null;
  try {
    const source = diamondSvg(buildSpec("#ffffff"));
    const img = await loadImage(`data:image/svg+xml,${encodeURIComponent(source)}`);
    const width = Math.max(1, Math.round((img.naturalWidth || img.width || 400) * PNG_SCALE));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height || 400) * PNG_SCALE));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      pngError.value = "This browser did not provide a 2D canvas, so the PNG could not be drawn.";
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    canvas.toBlob((blob) => {
      if (!blob) {
        pngError.value = "The canvas produced no image data.";
        return;
      }
      downloadBlob(blob, `${fileBase.value}.png`);
    }, "image/png");
  } catch (e) {
    pngError.value = e instanceof Error ? e.message : "The PNG could not be composed.";
  }
}

/* ------------------------------------------------------------------ *
 * reading a chemical back into the picker
 * ------------------------------------------------------------------ */

/**
 * Load one chemical's rating into the controls. Present symbols become
 * Require; absent ones go back to Any rather than Exclude, because the white
 * quadrant is frequently just missing from a source rather than known empty.
 */
function pick(c: Chemical): void {
  const rating = c.nfpa;
  if (!rating) return;
  const next = { ...state.value };
  next.health = String(rating.h);
  next.fire = String(rating.f);
  next.instability = String(rating.r);
  const have = specialsFor(c);
  for (const symbol of SPECIAL_ORDER) {
    next[SPECIAL_IDS[symbol]] = have.includes(symbol) ? "require" : "any";
  }
  state.value = next;
  caption.value = c.name;
  captionOn.value = true;
  loadedFrom.value = c.name;
  search.value = "";
  showAll.value = false;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  diamondCard.value?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
}

function reset(): void {
  state.value = { ...DEFAULTS };
  caption.value = "";
  captionOn.value = false;
  loadedFrom.value = "";
  showAll.value = false;
}

/* ------------------------------------------------------------------ *
 * small view helpers
 * ------------------------------------------------------------------ */

function ratingMeaning(key: QuadrantKey): string {
  const value = state.value[RATING_IDS[key]];
  if (!value || value === "any") return "Any value matches.";
  return RATING_LABELS[key][Number(value)] ?? "";
}

function ratingTitle(key: QuadrantKey, value: string): string {
  if (value === "any") return `${QUADRANT_LABELS[key]}: any value matches`;
  return `${QUADRANT_LABELS[key]} ${value}: ${RATING_LABELS[key][Number(value)] ?? ""}`;
}

/**
 * The custom properties the scoped rule below paints the active segment with.
 * Left empty while the row is on Any, so that segment keeps the brand gradient
 * every other active toggle on the site uses: Any is the absence of a rating,
 * not a rating painted in the quadrant's color.
 */
function rowVars(key: QuadrantKey): Record<string, string> {
  if (state.value[RATING_IDS[key]] === "any") return {};
  return { "--nfpa-fill": FILL[key], "--nfpa-ink": INK[key], "--nfpa-image": "none" };
}

function subtitle(c: Chemical): string {
  return [c.cas, c.formula].filter(Boolean).join(" · ");
}

/**
 * The rating every list in this panel renders. Narrowing here rather than in
 * the template keeps TypeScript-only syntax out of the compiled expressions:
 * matchChemicals, nearbyChemicals, and searchChemical all skip rows with no
 * rating, so the fallback is unreachable and exists only to satisfy the type.
 */
function rating(c: Chemical): NfpaRating {
  return c.nfpa ?? { h: 0, f: 0, r: 0, special: [], source: "HSDB" };
}

function distanceLabel(distance: number): string {
  return distance === 1 ? "1 step away" : `${distance} steps away`;
}

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

/**
 * One object, one write: writeFragment rebuilds the whole hash from what it is
 * given. Values equal to the meta default are left out so a plain visit keeps
 * a clean URL, and the keys are the option ids, so a shared link also works as
 * an /api/nfpa-704-fire-diamond query string.
 */
const fragmentOpts = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(state.value)) {
    if (value !== DEFAULTS[key]) out[key] = value;
  }
  return out;
});

watch(fragmentOpts, (opts) => {
  if (!mounted.value) return;
  writeFragment({ opts });
});

/** Anything this panel would never emit is dropped, so a stale link degrades. */
function readState(raw: Record<string, string>): void {
  for (const key of ["h", "f", "r"] as const) {
    const value = raw[RATING_IDS[key]];
    if (value !== undefined && RATING_VALUES.includes(value)) state.value[RATING_IDS[key]] = value;
  }
  for (const symbol of SPECIAL_ORDER) {
    const value = raw[SPECIAL_IDS[symbol]];
    if (value !== undefined && FILTER_VALUES.includes(value))
      state.value[SPECIAL_IDS[symbol]] = value;
  }
}

onMounted(() => {
  readState(readFragment().opts);
  mounted.value = true;
});
</script>

<template>
  <div class="nfpa-panel flex flex-col gap-4">
    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
      <!-- ------------------------------------------------------ picker -->
      <section class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
        <div class="flex flex-col gap-5">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="text-[17px] font-semibold">Rating</h2>
            <p class="text-xs text-muted-foreground">Any leaves a quadrant open.</p>
          </div>

          <div
            v-for="key in QUADRANT_KEYS"
            :key="key"
            class="flex flex-col gap-1.5"
            :style="rowVars(key)"
          >
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span
                class="w-24 shrink-0 text-xs font-semibold tracking-[0.04em] uppercase"
                :style="{ color: FILL[key] }"
                >{{ QUADRANT_LABELS[key] }}</span
              >
              <Segmented
                :options="RATING_OPTIONS"
                :label="`${QUADRANT_LABELS[key]} rating`"
                :model-value="state[RATING_IDS[key]] ?? 'any'"
                @update:model-value="state[RATING_IDS[key]] = $event"
              >
                <template #default="{ option }">
                  <span :title="ratingTitle(key, option.value)">{{ option.label }}</span>
                </template>
              </Segmented>
            </div>
            <p class="text-xs text-muted-foreground">{{ ratingMeaning(key) }}</p>
          </div>

          <div class="h-px bg-border"></div>

          <div class="flex flex-col gap-3">
            <div
              v-for="symbol in SPECIAL_ORDER"
              :key="symbol"
              class="flex flex-wrap items-center gap-x-3 gap-y-1.5"
            >
              <span class="flex w-44 shrink-0 items-baseline gap-1.5 text-xs">
                <!-- W is drawn with a bar through it on the placard, so it is
                     drawn with one here too. -->
                <span
                  class="font-mono font-semibold"
                  :class="symbol === 'W' ? 'line-through' : ''"
                  >{{ symbol }}</span
                >
                <span class="text-muted-foreground">{{ SPECIAL_LABELS[symbol] }}</span>
              </span>
              <Segmented
                :options="FILTER_OPTIONS"
                size="sm"
                :label="`${SPECIAL_LABELS[symbol]} filter`"
                :model-value="state[SPECIAL_IDS[symbol]] ?? 'any'"
                @update:model-value="state[SPECIAL_IDS[symbol]] = $event"
              />
            </div>
          </div>

          <div class="h-px bg-border"></div>

          <!-- ------------------------------------------- reverse lookup -->
          <div class="flex flex-col gap-1.5">
            <Label for="nfpa-search" class="text-xs text-muted-foreground">
              Or look up a chemical
            </Label>
            <div class="relative">
              <Search
                class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="nfpa-search"
                :model-value="search"
                type="search"
                autocomplete="off"
                placeholder="Name, synonym, CAS number, or formula"
                class="pl-9"
                @update:model-value="search = String($event)"
              />
            </div>

            <ul
              v-if="searchResults.length"
              class="mt-1 flex flex-col gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
            >
              <li v-for="c in searchResults" :key="c.id">
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-3 rounded-[8px] px-2.5 py-1.5 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                  @click="pick(c)"
                >
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-medium">{{ c.name }}</span>
                    <span
                      v-if="subtitle(c)"
                      class="block truncate font-mono text-xs text-muted-foreground"
                      >{{ subtitle(c) }}</span
                    >
                  </span>
                  <span class="shrink-0 font-mono text-xs text-muted-foreground">
                    {{ rating(c).h }}-{{ rating(c).f }}-{{ rating(c).r }}
                  </span>
                </button>
              </li>
            </ul>
            <p v-else-if="search.trim()" class="mt-1 text-xs text-muted-foreground">
              Nothing rated matches that.
              <template v-if="searchSuggestions.length">
                Did you mean
                <button
                  v-for="(c, i) in searchSuggestions"
                  :key="c.id"
                  type="button"
                  class="text-primary underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  @click="pick(c)"
                >
                  {{ c.name }}{{ i < searchSuggestions.length - 1 ? "," : "?" }}
                </button>
              </template>
              <template v-else>
                Try the common name, a synonym, the CAS registry number, or the formula.
              </template>
            </p>
            <p v-if="search.trim()" class="mt-1 text-xs text-muted-foreground">
              This box searches only the compounds with a published rating.
              <a :href="searchAllLink" class="text-primary underline underline-offset-2">
                Search all 25,000 compounds
              </a>
              instead.
            </p>
          </div>
        </div>
      </section>

      <!-- ----------------------------------------------------- diamond -->
      <section
        ref="diamondCard"
        class="flex flex-col items-center gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- built by this tool's own logic layer (diamondSvg), which escapes every string it writes and formats every number as an NFPA degree -->
        <div class="nfpa-figure w-full max-w-[300px]" v-html="diamond"></div>

        <div class="flex w-full flex-col gap-3">
          <div class="flex flex-wrap items-center justify-center gap-2">
            <Button variant="secondary" size="sm" @click="downloadSvg">
              <Download class="size-4" aria-hidden="true" />
              SVG
            </Button>
            <Button variant="secondary" size="sm" @click="downloadPng">
              <Download class="size-4" aria-hidden="true" />
              PNG
            </Button>
            <CopyButton :text="diamond" aria-label="Copy the diamond as SVG markup" />
          </div>

          <div class="flex items-center justify-between gap-3">
            <Label for="nfpa-caption-toggle" class="cursor-pointer text-xs text-muted-foreground">
              Caption with a name
            </Label>
            <Switch
              id="nfpa-caption-toggle"
              :model-value="captionOn"
              @update:model-value="(v) => (captionOn = Boolean(v))"
            />
          </div>
          <Input
            v-if="captionOn"
            id="nfpa-caption"
            :model-value="caption"
            placeholder="Acetone"
            aria-label="Caption text"
            class="h-8"
            @update:model-value="caption = String($event)"
          />

          <p v-if="pngError" class="text-xs text-destructive">{{ pngError }}</p>
          <p class="text-center text-xs text-muted-foreground">
            Standard NFPA 704 colors and layout. Required symbols are drawn in the white quadrant, W
            with its bar.
          </p>
        </div>
      </section>
    </div>

    <!-- ------------------------------------------------------ disclaimer -->
    <p
      role="note"
      class="flex items-start gap-2.5 rounded-[14px] border border-amber-500/45 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <TriangleAlert
        class="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
        aria-hidden="true"
      />
      <span>{{ DISCLAIMER }}</span>
    </p>

    <!-- --------------------------------------------------------- results -->
    <section class="overflow-hidden rounded-[18px] border bg-card shadow-[var(--sh-sm)]">
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-b bg-secondary px-4 py-3 sm:px-5"
      >
        <div class="min-w-0">
          <p class="text-sm font-semibold">
            {{ matches.length }}
            {{ matches.length === 1 ? "chemical matches" : "chemicals match" }}
          </p>
          <p class="truncate text-xs text-muted-foreground">{{ describeQuery(query) }}</p>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="loadedFrom" class="text-xs text-muted-foreground">
            Loaded from {{ loadedFrom }}
          </span>
          <Button v-if="loadedFrom" variant="ghost" size="sm" @click="reset">Clear</Button>
          <CopyButton
            v-if="matches.length"
            :text="matchText"
            aria-label="Copy every matching chemical name"
          />
        </div>
      </div>

      <ul v-if="matches.length" class="divide-y">
        <li
          v-for="c in visibleMatches"
          :key="c.id"
          class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
        >
          <span
            class="flex shrink-0 gap-1"
            :title="formatRating(rating(c), specialsFor(c))"
            aria-hidden="true"
          >
            <span
              v-for="key in QUADRANT_KEYS"
              :key="key"
              class="grid size-6 place-items-center rounded-[6px] font-mono text-xs font-bold"
              :style="{ backgroundColor: FILL[key], color: INK[key] }"
              >{{ rating(c)[key] }}</span
            >
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">{{ c.name }}</span>
            <span class="block text-xs text-muted-foreground">
              <span class="sr-only">{{ formatRating(rating(c), specialsFor(c)) }}. </span>
              <span v-if="subtitle(c)" class="font-mono">{{ subtitle(c) }}</span>
            </span>
          </span>
          <span class="flex flex-wrap items-center gap-1.5">
            <span
              v-for="symbol in specialsFor(c)"
              :key="symbol"
              class="rounded-[8px] bg-secondary px-2 py-0.5 font-mono text-[11px] font-semibold"
              :title="SPECIAL_LABELS[symbol]"
            >
              {{ symbol }}
            </span>
            <span
              class="rounded-[8px] bg-[color:var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-primary"
            >
              {{ rating(c).source }}
            </span>
          </span>
          <span class="flex shrink-0 gap-3 text-xs">
            <a v-if="wikipediaUrl(c)" :href="wikipediaUrl(c)" rel="noopener">Wikipedia</a>
            <a v-if="pubchemUrl(c)" :href="pubchemUrl(c)" rel="noopener">PubChem</a>
          </span>
        </li>
      </ul>

      <p v-else class="px-4 py-6 text-sm text-muted-foreground sm:px-5">
        No chemical in the dataset carries that exact diamond. Loosen a quadrant to Any, or read the
        nearby ratings below.
      </p>

      <div
        v-if="matches.length > VISIBLE_CAP"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-3 sm:px-5"
      >
        <Button variant="ghost" size="sm" @click="showAll = !showAll">
          {{
            showAll
              ? "Show fewer"
              : matches.length > EXPANDED_CAP
                ? `Show ${EXPANDED_CAP}`
                : `Show all ${matches.length}`
          }}
        </Button>
        <span v-if="showAll && matches.length > EXPANDED_CAP" class="text-xs text-muted-foreground">
          The first {{ EXPANDED_CAP }} of {{ matches.length }}. Set a quadrant to narrow the list.
        </span>
      </div>
    </section>

    <!-- ---------------------------------------------------------- nearby -->
    <section
      v-if="nearby.length"
      class="overflow-hidden rounded-[18px] border bg-card shadow-[var(--sh-sm)]"
    >
      <div class="border-b bg-secondary px-4 py-3 sm:px-5">
        <p class="text-sm font-semibold">Nearby ratings</p>
        <p class="text-xs text-muted-foreground">
          The closest diamonds that still satisfy the symbol filters, ranked by how far the
          quadrants you pinned have to move.
        </p>
      </div>
      <ul class="divide-y">
        <li
          v-for="item in nearby"
          :key="item.chemical.id"
          class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
        >
          <span class="flex shrink-0 gap-1" aria-hidden="true">
            <span
              v-for="key in QUADRANT_KEYS"
              :key="key"
              class="grid size-6 place-items-center rounded-[6px] font-mono text-xs font-bold"
              :style="{ backgroundColor: FILL[key], color: INK[key] }"
              >{{ rating(item.chemical)[key] }}</span
            >
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">{{ item.chemical.name }}</span>
            <span class="block text-xs text-muted-foreground">
              {{ formatRating(rating(item.chemical), specialsFor(item.chemical)) }}
            </span>
          </span>
          <span class="shrink-0 text-xs text-muted-foreground">
            {{ distanceLabel(item.distance) }}
          </span>
          <Button variant="ghost" size="sm" @click="pick(item.chemical)">Load</Button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/*
 * The shared Segmented control paints its active button with the brand
 * gradient. A quadrant row overrides that with the NFPA color for the quadrant,
 * passed in as custom properties so NFPA_COLORS stays the single source of
 * truth and no hex value is written here. The fallbacks are the tokens the
 * gradient uses, so a row sitting on Any keeps the standard look.
 *
 * Only the checked button is repainted; the attribute selector inside the
 * scoped wrapper outranks the single class utilities it is overriding,
 * including the hover variants.
 */
.nfpa-panel :deep([role="radio"][aria-checked="true"]) {
  background-color: var(--nfpa-fill, var(--primary));
  background-image: var(--nfpa-image, var(--grad-brand));
  color: var(--nfpa-ink, var(--primary-foreground));
}

/* The diamond arrives as a fixed 400 unit SVG string; let it fill its column. */
.nfpa-figure :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
</style>
