<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Search, Sparkles, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import {
  DISCLAIMER,
  describeChemical,
  lookup,
  pubchemUrl,
  suggestions,
  wikipediaUrl,
} from "@/tools/chemical-lookup/index";
import { diamondSvg } from "@/tools/nfpa-704-fire-diamond/index";
import { PICTOGRAM_INFO } from "@/tools/ghs-pictogram-lookup/index";
import type { Chemical, NfpaRating } from "@/tools/_generated/chem-data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { recordToRows, rowsToText, type KeyValueRow } from "@/lib/key-value";
import KeyValueGrid from "../KeyValueGrid.vue";
import CopyButton from "../CopyButton.vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Bespoke panel for Chemical Lookup, the hub the other chemistry tools link
 * into.
 *
 * The generic shell can only print `describeChemical` as a list of strings.
 * The three things worth seeing here are pictures: the NFPA diamond, the GHS
 * pictograms, and the choice between the candidates a loose query matched. So
 * the panel owns layout, the artwork, and URL fragment state, and every value
 * still comes from the pure logic layer (PROJECT.md rule 27).
 *   src/tools/chemical-lookup/index.ts        lookup, suggestions,
 *                                             describeChemical, wikipediaUrl,
 *                                             pubchemUrl, DISCLAIMER
 *   src/tools/nfpa-704-fire-diamond/index.ts  diamondSvg
 *   src/tools/ghs-pictogram-lookup/index.ts   PICTOGRAM_INFO (code, name, and
 *                                             the path to the self hosted UN
 *                                             artwork under /ghs/)
 *
 * NO ERROR PATH, ON PURPOSE
 * -------------------------
 * `run()` throws when a query is ambiguous, because an API answering with one
 * of ten equally good matches would be lying. A panel can do better: it lists
 * the candidates and lets you pick, which is the same information without the
 * dead end. Nothing here calls `run()`.
 *
 * WHAT THE GRID LEAVES OUT
 * ------------------------
 * Four rows of `describeChemical` are rendered as something better than text
 * and are dropped from the grid to avoid printing them twice: the pictogram
 * list becomes the artwork strip, the two links become the links row, and the
 * note becomes the disclaimer band. The Sources row stays: it carries the
 * CC BY-SA attribution for anything Wikipedia supplied, so it is not ours to
 * drop, and it points at the article link that the links row renders.
 *
 * Nothing reads the DOM before mount: readFragment runs in onMounted, the
 * fragment writer stays quiet until then, and the example is only prefilled
 * when the fragment carried nothing, so a shared link always wins.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Rows this panel renders as artwork, links, or the disclaimer band instead. */
const HIDDEN_ROWS = new Set(["GHS pictograms", "Wikipedia", "PubChem", "Note"]);

/** Candidates offered under the box. `lookup` caps its own list too. */
const CANDIDATE_CAP = 10;

/** Long enough that a fast typist does not re-filter 3,050 rows per keystroke. */
const DEBOUNCE_MS = 140;

const PICTOGRAM_BY_CODE = new Map(PICTOGRAM_INFO.map((p) => [p.code, p]));

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const query = ref("");
const debounced = ref("");
const pickedId = ref<string | null>(null);
const exampleActive = ref(false);
const mounted = ref(false);

let timer: ReturnType<typeof setTimeout> | undefined;

watch(query, (text) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    debounced.value = text;
    // A new query invalidates the old choice: the pick belonged to the list
    // the previous text produced.
    pickedId.value = null;
  }, DEBOUNCE_MS);
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

/* ------------------------------------------------------------------ *
 * matches
 * ------------------------------------------------------------------ */

const candidates = computed(() => lookup(debounced.value, CANDIDATE_CAP));

/** The chosen candidate, or the best one when nothing has been chosen yet. */
const selected = computed<Chemical | undefined>(() => {
  const list = candidates.value;
  if (!list.length) return undefined;
  const picked = list.find((m) => m.chemical.id === pickedId.value);
  return (picked ?? list[0])!.chemical;
});

const missSuggestions = computed<Chemical[]>(() =>
  debounced.value.trim() && !candidates.value.length ? suggestions(debounced.value, 3) : [],
);

const sheet = computed<Record<string, string>>(() =>
  selected.value ? describeChemical(selected.value) : {},
);

const rows = computed<KeyValueRow[]>(() =>
  recordToRows(sheet.value).filter((row) => !HIDDEN_ROWS.has(row.key)),
);

const sheetText = computed(() => rowsToText(recordToRows(sheet.value)));

/* ------------------------------------------------------------------ *
 * artwork
 * ------------------------------------------------------------------ */

interface DiamondView {
  source: string;
  svg: string;
}

/**
 * One diamond per rating the dataset holds. When PubChem and Wikipedia
 * disagree the row carries both, and both are drawn with their source named,
 * which is the same answer the data sheet gives in words.
 */
const diamonds = computed<DiamondView[]>(() => {
  const c = selected.value;
  if (!c) return [];
  const out: DiamondView[] = [];
  const draw = (rating: NfpaRating): DiamondView => ({
    source: rating.source,
    svg: diamondSvg({
      h: rating.h,
      f: rating.f,
      r: rating.r,
      special: [...rating.special],
    }),
  });
  if (c.nfpa) out.push(draw(c.nfpa));
  if (c.nfpaAlt) out.push(draw(c.nfpaAlt));
  return out;
});

const pictograms = computed(() =>
  (selected.value?.ghs?.pictograms ?? [])
    .map((code) => PICTOGRAM_BY_CODE.get(code))
    .filter((info): info is (typeof PICTOGRAM_INFO)[number] => info !== undefined),
);

/* ------------------------------------------------------------------ *
 * cross links
 * ------------------------------------------------------------------ */

/**
 * The other two chemistry tools read their state from the URL fragment, so a
 * link into them is just the option ids this chemical's data fills in.
 */
const diamondLink = computed(() => {
  const rating = selected.value?.nfpa;
  if (!rating) return undefined;
  const params = new URLSearchParams({
    health: String(rating.h),
    fire: String(rating.f),
    instability: String(rating.r),
  });
  return `/nfpa-704-fire-diamond#${params.toString()}`;
});

const ghsLink = computed(() => {
  const codes = selected.value?.ghs?.pictograms ?? [];
  if (!codes.length) return undefined;
  return `/ghs-pictogram-lookup#${new URLSearchParams({ pictograms: codes.join(",") }).toString()}`;
});

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

function setQuery(text: string): void {
  query.value = text;
  exampleActive.value = false;
  // Answer immediately: this path is a click, not typing, so there is no
  // keystroke storm to smooth out.
  if (timer) clearTimeout(timer);
  debounced.value = text;
  pickedId.value = null;
}

function clearExample(): void {
  setQuery("");
}

function matchedLabel(field: string): string {
  return field === "CAS" ? "CAS number" : field;
}

function subtitle(c: Chemical): string {
  return [c.formula, c.cas].filter(Boolean).join(" · ");
}

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

/**
 * The example never writes itself into the URL. Watchers flush after the mount
 * hook returns, so without the second guard a first visit would rewrite its own
 * address to #i=acetone, and the next reload would read that back as a shared
 * link: the chip would be gone and the prefill would be unclearable. Every path
 * that leaves the example (typing, a suggestion, the chip's clear button)
 * lowers the flag before `debounced` changes.
 */
watch(debounced, (text) => {
  if (!mounted.value || exampleActive.value) return;
  writeFragment({ input: text, opts: {} });
});

onMounted(() => {
  const fragment = readFragment();
  const shared = fragment.input?.trim();
  if (shared) {
    query.value = shared;
    debounced.value = shared;
  } else {
    // Same behavior the generic shell gives every text tool: example one is
    // prefilled, flagged with a chip, and cleared in one click.
    const example = props.meta.examples?.[0]?.input;
    if (example) {
      query.value = example;
      debounced.value = example;
      exampleActive.value = true;
    }
  }
  mounted.value = true;
});
</script>

<template>
  <div class="chem-panel flex flex-col gap-4">
    <!-- ---------------------------------------------------------- search -->
    <section class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="chem-search" class="text-xs font-semibold tracking-[0.04em] uppercase">
            Chemical
          </Label>
          <span
            v-if="exampleActive"
            class="inline-flex max-w-full items-center gap-1.5 rounded-[8px] border bg-card py-1 pr-1 pl-2 text-xs shadow-[var(--sh-sm)]"
          >
            <Sparkles class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="truncate font-medium">Example input</span>
            <button
              type="button"
              aria-label="Clear example"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearExample"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>

        <div class="relative">
          <Search
            class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="chem-search"
            :model-value="query"
            type="search"
            autocomplete="off"
            placeholder="acetone, 67-64-1, or H2SO4"
            class="pl-9"
            @update:model-value="
              (v) => {
                query = String(v);
                exampleActive = false;
              }
            "
          />
        </div>

        <!-- The candidate list: a loose query matches several compounds, and
             picking one is better information than an ambiguity error. -->
        <ul v-if="candidates.length > 1" class="flex flex-wrap gap-1.5">
          <li v-for="m in candidates" :key="m.chemical.id">
            <button
              type="button"
              class="flex items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-left text-xs transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              :class="
                m.chemical.id === selected?.id
                  ? 'border-primary bg-[color:var(--accent-soft)] text-primary'
                  : 'bg-card text-foreground'
              "
              :aria-pressed="m.chemical.id === selected?.id"
              @click="pickedId = m.chemical.id"
            >
              <span class="font-medium">{{ m.chemical.name }}</span>
              <span class="font-mono text-[11px] text-muted-foreground">
                {{ matchedLabel(m.matchedOn) }}
              </span>
            </button>
          </li>
        </ul>

        <p v-if="!debounced.trim()" class="text-xs text-muted-foreground">
          Search 3,050 compounds by name, synonym, CAS registry number, or molecular formula.
        </p>
        <p v-else-if="!candidates.length" class="text-sm text-muted-foreground">
          Nothing in the dataset matches "{{ debounced }}".
          <template v-if="missSuggestions.length">
            Did you mean
            <button
              v-for="(c, i) in missSuggestions"
              :key="c.id"
              type="button"
              class="text-primary underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="setQuery(c.name)"
            >
              {{ c.name }}{{ i < missSuggestions.length - 1 ? "," : "?" }}
            </button>
          </template>
          <template v-else>
            Try the common name, a synonym, the CAS registry number, or the molecular formula.
          </template>
        </p>
      </div>
    </section>

    <!-- ----------------------------------------------------------- sheet -->
    <section
      v-if="selected"
      class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-[22px] leading-tight font-semibold tracking-[-0.014em]">
            {{ selected.name }}
          </h2>
          <p v-if="subtitle(selected)" class="mt-1 font-mono text-sm text-muted-foreground">
            {{ subtitle(selected) }}
          </p>
        </div>
        <CopyButton :text="sheetText" label="Copy all" />
      </div>

      <!-- ----------------------------------------------------- artwork -->
      <div v-if="diamonds.length || pictograms.length" class="flex flex-wrap items-start gap-6">
        <div v-if="diamonds.length" class="flex flex-wrap gap-4">
          <figure
            v-for="(d, i) in diamonds"
            :key="`${d.source}-${i}`"
            class="flex flex-col items-center gap-1"
          >
            <!-- eslint-disable-next-line vue/no-v-html -- built by the NFPA tool's own logic layer (diamondSvg), which escapes every string it writes and formats every number as an NFPA degree -->
            <div class="chem-figure w-[88px]" v-html="d.svg"></div>
            <figcaption class="text-[11px] text-muted-foreground">{{ d.source }}</figcaption>
          </figure>
        </div>

        <ul v-if="pictograms.length" class="flex flex-wrap gap-3">
          <li
            v-for="p in pictograms"
            :key="p.code"
            class="flex w-[76px] flex-col items-center gap-1"
          >
            <img :src="p.svgPath" alt="" width="44" height="44" class="size-11" />
            <span class="text-center text-[11px] leading-tight text-muted-foreground">
              {{ p.name }}
            </span>
          </li>
        </ul>
      </div>

      <KeyValueGrid :rows="rows" surface="secondary" />

      <!-- ------------------------------------------------------- links -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <a v-if="wikipediaUrl(selected)" :href="wikipediaUrl(selected)" rel="noopener">Wikipedia</a>
        <a v-if="pubchemUrl(selected)" :href="pubchemUrl(selected)" rel="noopener">PubChem</a>
        <a v-if="diamondLink" :href="diamondLink">Fire diamond</a>
        <a v-if="ghsLink" :href="ghsLink">GHS pictograms</a>
      </div>

      <p
        role="note"
        class="flex items-start gap-2.5 rounded-[14px] border border-amber-500/45 bg-amber-500/10 px-4 py-3 text-sm"
      >
        <span class="mt-0.5 shrink-0 font-semibold text-amber-700 dark:text-amber-400">Note</span>
        <span>{{ DISCLAIMER }}</span>
      </p>
    </section>
  </div>
</template>

<style scoped>
/* The diamonds arrive as fixed 400 unit SVG strings; let them fill their box. */
.chem-figure :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
</style>
