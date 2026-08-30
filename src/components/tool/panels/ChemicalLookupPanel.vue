<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Search, Sparkles, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import {
  DISCLAIMER,
  describeChemical,
  isBroadId,
  narrowChemical,
  prepareChemIndex,
  provenanceLines,
  pubchemUrl,
  recordPubchemUrl,
  recordWikipediaUrl,
  renderRecord,
  searchChemicals,
  wikipediaAttribution,
  wikipediaUrl,
  type ChemUnionHit,
  type PreparedChemIndex,
} from "@/tools/chemical-lookup/index";
import {
  CHEM_INDEX_URL,
  chemRecordFrom,
  chemShardUrl,
  type ChemIndexRow,
  type ChemShard,
} from "@/tools/_generated/chem-index";
import { H_STATEMENTS, P_STATEMENTS } from "@/tools/_generated/ghs-statements";
import { diamondSvg } from "@/tools/nfpa-704-fire-diamond/index";
import { PICTOGRAM_INFO } from "@/tools/ghs-pictogram-lookup/index";
import type { Chemical } from "@/tools/_generated/chem-data";
import { readFragment, writeFragment } from "@/lib/fragment";
import { formatBytes } from "@/lib/format";
import { recordToRows, rowsToText, type KeyValueRow } from "@/lib/key-value";
import KeyValueGrid from "../KeyValueGrid.vue";
import CopyButton from "../CopyButton.vue";
import EmptyState from "../EmptyState.vue";
import ErrorBanner from "../ErrorBanner.vue";
import ProgressBar from "../ProgressBar.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Bespoke panel for Chemical Lookup, the hub the other chemistry tools link
 * into.
 *
 * TWO TIERS, ONE SEARCH BOX
 * -------------------------
 * The tool's dataset ships in two pieces. 3,050 compounds are bundled into the
 * logic module and searchable the moment the page loads. 25,248 more live in
 * `/data/chem/`, which is far too large to bundle, so this panel fetches the
 * index once on mount (a 631 KB gzipped file, reported by the progress bar)
 * and hands the rows to `prepareChemIndex`. Every keystroke after that is a
 * pure call into `searchChemicals`, which searches both tiers and merges them.
 * Picking a compound from the broad tier costs one shard fetch, a 128th of the
 * corpus, cached here for the rest of the session.
 *
 * Nothing else goes over the network, and nothing the person types leaves the
 * device: the query never reaches a server, because both files are static
 * assets of this site fetched by URL.
 *
 * Every value on screen comes from the pure logic layer (PROJECT.md rule 27):
 *   src/tools/chemical-lookup/index.ts        searchChemicals, renderRecord,
 *                                             describeChemical, provenanceLines,
 *                                             the link builders, DISCLAIMER
 *   src/tools/nfpa-704-fire-diamond/index.ts  diamondSvg
 *   src/tools/ghs-pictogram-lookup/index.ts   PICTOGRAM_INFO (code, name, and
 *                                             the path to the self hosted UN
 *                                             artwork under /ghs/)
 *
 * NO ERROR PATH FOR AN AMBIGUOUS QUERY, ON PURPOSE
 * ------------------------------------------------
 * `run()` throws when a query matches several compounds equally well, because
 * an API answering with one of ten equally good matches would be lying. A
 * panel can do better: it lists the candidates and lets you pick, which is the
 * same information without the dead end. Nothing here calls `run()`.
 *
 * WHAT THE GRID LEAVES OUT
 * ------------------------
 * Rows that are rendered as something better than text are dropped from the
 * grid so they are not printed twice: the pictogram list becomes the artwork
 * strip, the two links become the links row, the description and its
 * attribution become the quoted block, and the note becomes the disclaimer
 * band. The Sources row stays: it carries the CC BY-SA credit for anything
 * Wikipedia supplied, so it is not ours to drop.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Rows this panel renders as artwork, links, prose, or the disclaimer band. */
const HIDDEN_ROWS = new Set([
  "GHS pictograms",
  "Wikipedia",
  "PubChem",
  "Note",
  "Description",
  "Attribution",
]);

/** Rows kept in the list, and how many more one click reveals. */
const PAGE_SIZE = 50;
/** The most `searchChemicals` is ever asked for, so the list can grow twice. */
const RESULT_CAP = 200;

/**
 * Long enough that a fast typist does not re-scan 28,000 rows per keystroke,
 * short enough that the list feels attached to the box. A settled query costs
 * roughly 10 ms of search, so this is the whole latency budget.
 */
const DEBOUNCE_MS = 180;

const PICTOGRAM_BY_CODE = new Map(PICTOGRAM_INFO.map((p) => [p.code, p]));
const PROVENANCE = provenanceLines();

/** The compact index, gzipped, as the progress caption's denominator. */
const INDEX_GZIP_BYTES = 631135;

/* ------------------------------------------------------------------ *
 * the index download
 * ------------------------------------------------------------------ */

const index = ref<PreparedChemIndex | undefined>(undefined);
const indexLoading = ref(false);
const indexError = ref("");
const loadedBytes = ref(0);
const totalBytes = ref<number | null>(null);

/**
 * The response is gzipped, so `content-length` counts compressed bytes while
 * the stream hands back decompressed ones. Once the count passes the header
 * the ratio is meaningless, so the bar drops to indeterminate rather than
 * pinning itself at 100 percent for the rest of the download.
 */
const indexPercent = computed<number | undefined>(() => {
  const total = totalBytes.value;
  if (!total || loadedBytes.value > total) return undefined;
  return (loadedBytes.value / total) * 100;
});

const indexDetail = computed(() =>
  loadedBytes.value
    ? `${formatBytes(loadedBytes.value)} of about ${formatBytes(INDEX_GZIP_BYTES)}`
    : `about ${formatBytes(INDEX_GZIP_BYTES)}`,
);

async function fetchIndex(): Promise<ChemIndexRow[]> {
  const response = await fetch(CHEM_INDEX_URL);
  if (!response.ok) throw new Error(`The compound index did not load (HTTP ${response.status}).`);
  const header = response.headers.get("content-length");
  totalBytes.value = header ? Number(header) : null;

  if (!response.body) return (await response.json()) as ChemIndexRow[];

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      loadedBytes.value = received;
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as ChemIndexRow[];
}

async function loadIndex(): Promise<void> {
  if (indexLoading.value || index.value) return;
  indexLoading.value = true;
  indexError.value = "";
  loadedBytes.value = 0;
  totalBytes.value = null;
  try {
    index.value = prepareChemIndex(await fetchIndex());
  } catch (e) {
    indexError.value = e instanceof Error ? e.message : String(e);
  } finally {
    indexLoading.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * search state
 * ------------------------------------------------------------------ */

const query = ref("");
const debounced = ref("");
const exampleActive = ref(false);
const mounted = ref(false);

const filterNfpa = ref(false);
const filterGhs = ref(false);
const filterDrug = ref(false);

const shown = ref(PAGE_SIZE);
const activeIndex = ref(0);
const selectedId = ref<string | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;

watch(query, (text) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    debounced.value = text;
  }, DEBOUNCE_MS);
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

const filters = computed(() => ({
  nfpa: filterNfpa.value,
  ghs: filterGhs.value,
  drug: filterDrug.value,
}));

const filterChips = computed(
  () =>
    [
      { id: "nfpa", label: "Has NFPA rating", active: filterNfpa.value },
      { id: "ghs", label: "Has GHS classification", active: filterGhs.value },
      { id: "drug", label: "Drugs", active: filterDrug.value },
    ] as const,
);

const results = computed<ChemUnionHit[]>(() =>
  searchChemicals(index.value, debounced.value, {
    limit: RESULT_CAP,
    filters: filters.value,
  }),
);

const visible = computed(() => results.value.slice(0, shown.value));
const hasMore = computed(() => results.value.length > visible.value.length);

/** A new query, or a new filter, invalidates the highlight and the page size. */
watch([debounced, filters], () => {
  shown.value = PAGE_SIZE;
  activeIndex.value = 0;
});

/**
 * A shared link names both a query and a compound, and the compound is the
 * point of the link. The result list is capped, so the named compound is not
 * always in it, and without this the auto selection below would quietly open
 * something else. Cleared by the first thing the reader does.
 */
const sharedPick = ref(false);

/**
 * The top result opens on its own, so a settled query always shows an answer
 * rather than a list to click through. Arrow keys move the highlight without
 * loading anything; Enter is what commits to a different compound.
 */
watch(
  results,
  (list) => {
    if (sharedPick.value) return;
    const first = list[0];
    if (!first) {
      selectedId.value = null;
      return;
    }
    if (!list.some((h) => h.id === selectedId.value)) selectedId.value = first.id;
  },
  { immediate: true },
);

/* ------------------------------------------------------------------ *
 * the detail sheet
 * ------------------------------------------------------------------ */

interface DiamondView {
  source: string;
  svg: string;
}

interface Detail {
  id: string;
  name: string;
  subtitle: string;
  sheet: Record<string, string>;
  diamonds: DiamondView[];
  pictogramCodes: string[];
  description?: string;
  attribution?: string;
  wikipedia?: string;
  pubchem?: string;
  /** The rating the cross link to the fire diamond tool carries, if any. */
  nfpa?: { h: number; f: number; r: number };
  ghsCodes: string[];
}

const detail = ref<Detail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");

/** One entry per shard actually opened, so re-picking never refetches. */
const shardCache = new Map<number, ChemShard>();

function subtitleOf(formula: string | undefined, cas: string | undefined): string {
  return [formula, cas].filter(Boolean).join(" · ");
}

function detailFromNarrow(c: Chemical): Detail {
  const sheet = describeChemical(c);
  const diamonds: DiamondView[] = [];
  for (const rating of [c.nfpa, c.nfpaAlt]) {
    if (!rating) continue;
    diamonds.push({
      source: rating.source,
      svg: diamondSvg({
        h: rating.h,
        f: rating.f,
        r: rating.r,
        special: [...rating.special],
      }),
    });
  }
  const primary = c.nfpa ?? c.nfpaAlt;
  const out: Detail = {
    id: c.id,
    name: c.name,
    subtitle: subtitleOf(c.formula, c.cas),
    sheet,
    diamonds,
    pictogramCodes: c.ghs?.pictograms ?? [],
    ghsCodes: c.ghs?.pictograms ?? [],
  };
  const wiki = wikipediaUrl(c);
  const pubchem = pubchemUrl(c);
  if (wiki) out.wikipedia = wiki;
  if (pubchem) out.pubchem = pubchem;
  if (primary) out.nfpa = { h: primary.h, f: primary.f, r: primary.r };
  return out;
}

function detailFromBroad(id: string, record: import("@/tools/_generated/chem-index").ChemRecord) {
  const sheet = renderRecord(record, H_STATEMENTS, P_STATEMENTS);
  const diamonds: DiamondView[] = record.nfpa
    ? [
        {
          source: record.nfpa.source,
          svg: diamondSvg({
            h: record.nfpa.h,
            f: record.nfpa.f,
            r: record.nfpa.r,
            special: [...record.nfpa.special],
          }),
        },
      ]
    : [];
  const out: Detail = {
    id,
    name: record.name,
    subtitle: subtitleOf(record.formula, record.cas),
    sheet,
    diamonds,
    pictogramCodes: record.ghs?.pictograms ?? [],
    ghsCodes: record.ghs?.pictograms ?? [],
  };
  if (record.description) out.description = record.description;
  if (record.description && record.wikipedia)
    out.attribution = wikipediaAttribution(record.wikipedia);
  const wiki = recordWikipediaUrl(record);
  const pubchem = recordPubchemUrl(record);
  if (wiki) out.wikipedia = wiki;
  if (pubchem) out.pubchem = pubchem;
  if (record.nfpa) out.nfpa = { h: record.nfpa.h, f: record.nfpa.f, r: record.nfpa.r };
  return out;
}

async function loadShard(shard: number): Promise<ChemShard> {
  const held = shardCache.get(shard);
  if (held) return held;
  const response = await fetch(chemShardUrl(shard));
  if (!response.ok) throw new Error(`That compound's data did not load (HTTP ${response.status}).`);
  const parsed = (await response.json()) as ChemShard;
  shardCache.set(shard, parsed);
  return parsed;
}

/** Guards against an out of order shard response overwriting a newer pick. */
let detailToken = 0;

async function loadDetail(id: string | null): Promise<void> {
  const token = ++detailToken;
  detailError.value = "";
  if (!id) {
    detail.value = null;
    detailLoading.value = false;
    return;
  }

  if (!isBroadId(id)) {
    const c = narrowChemical(id);
    detail.value = c ? detailFromNarrow(c) : null;
    detailLoading.value = false;
    if (!c) detailError.value = `No compound in the dataset has the id "${id}".`;
    return;
  }

  const numeric = Number(id);
  detailLoading.value = true;
  try {
    const shard = await loadShard(numeric % 128);
    if (token !== detailToken) return;
    const record = chemRecordFrom(shard, numeric);
    if (!record) {
      detail.value = null;
      detailError.value = `No compound in the dataset has the id "${id}".`;
      return;
    }
    detail.value = detailFromBroad(id, record);
  } catch (e) {
    if (token !== detailToken) return;
    detail.value = null;
    detailError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === detailToken) detailLoading.value = false;
  }
}

watch(selectedId, (id) => void loadDetail(id), { immediate: true });

const rows = computed<KeyValueRow[]>(() =>
  detail.value ? recordToRows(detail.value.sheet).filter((r) => !HIDDEN_ROWS.has(r.key)) : [],
);

const reportText = computed(() =>
  detail.value ? rowsToText(recordToRows(detail.value.sheet)) : "",
);

const pictograms = computed(() =>
  (detail.value?.pictogramCodes ?? [])
    .map((code) => PICTOGRAM_BY_CODE.get(code))
    .filter((info): info is (typeof PICTOGRAM_INFO)[number] => info !== undefined),
);

/* ------------------------------------------------------------------ *
 * cross links
 * ------------------------------------------------------------------ */

/**
 * The other two chemistry tools read their state from the URL fragment, so a
 * link into them is just the option ids this compound's data fills in.
 */
const diamondLink = computed(() => {
  const rating = detail.value?.nfpa;
  if (!rating) return undefined;
  const params = new URLSearchParams({
    health: String(rating.h),
    fire: String(rating.f),
    instability: String(rating.r),
  });
  return `/nfpa-704-fire-diamond#${params.toString()}`;
});

const ghsLink = computed(() => {
  const codes = detail.value?.ghsCodes ?? [];
  if (!codes.length) return undefined;
  return `/ghs-pictogram-lookup#${new URLSearchParams({ pictograms: codes.join(",") }).toString()}`;
});

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

function setQuery(text: string): void {
  query.value = text;
  exampleActive.value = false;
  sharedPick.value = false;
  // Answer immediately: this path is a click, not typing, so there is no
  // keystroke storm to smooth out.
  if (timer) clearTimeout(timer);
  debounced.value = text;
}

function onQueryInput(value: string | number): void {
  query.value = String(value);
  exampleActive.value = false;
  sharedPick.value = false;
}

function toggleFilter(which: "nfpa" | "ghs" | "drug"): void {
  sharedPick.value = false;
  if (which === "nfpa") filterNfpa.value = !filterNfpa.value;
  else if (which === "ghs") filterGhs.value = !filterGhs.value;
  else filterDrug.value = !filterDrug.value;
}

function clearExample(): void {
  setQuery("");
}

function pick(hit: ChemUnionHit, at: number): void {
  sharedPick.value = false;
  activeIndex.value = at;
  selectedId.value = hit.id;
}

const listRef = ref<HTMLElement | null>(null);

function scrollActiveIntoView(): void {
  void nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  });
}

function onSearchKeydown(event: KeyboardEvent): void {
  const list = visible.value;
  if (!list.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    activeIndex.value = (activeIndex.value + step + list.length) % list.length;
    scrollActiveIntoView();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const hit = list[activeIndex.value];
    if (hit) pick(hit, activeIndex.value);
  }
}

function matchedLabel(hit: ChemUnionHit): string {
  if (hit.matchedOn === "cas") return "CAS number";
  if (hit.matchedOn === "mass") return "molar mass";
  if (hit.matchedOn === "fuzzy") return "close spelling";
  return hit.matchedOn;
}

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

function filterFragment(): string {
  return [
    filterNfpa.value ? "nfpa" : "",
    filterGhs.value ? "ghs" : "",
    filterDrug.value ? "drug" : "",
  ]
    .filter(Boolean)
    .join(",");
}

/**
 * The example never writes itself into the URL. Watchers flush after the mount
 * hook returns, so without the second guard a first visit would rewrite its own
 * address to #i=acetone, and the next reload would read that back as a shared
 * link: the chip would be gone and the prefill would be unclearable. Every path
 * that leaves the example (typing, a suggestion, the chip's clear button)
 * lowers the flag before `debounced` changes.
 */
watch([debounced, selectedId, filters], () => {
  if (!mounted.value || exampleActive.value) return;
  const opts: Record<string, string> = {};
  if (selectedId.value) opts["id"] = selectedId.value;
  const f = filterFragment();
  if (f) opts["filters"] = f;
  writeFragment({ input: debounced.value, opts });
});

onMounted(() => {
  const fragment = readFragment();
  const shared = fragment.input?.trim();
  const sharedFilters = (fragment.opts["filters"] ?? "").split(",");
  filterNfpa.value = sharedFilters.includes("nfpa");
  filterGhs.value = sharedFilters.includes("ghs");
  filterDrug.value = sharedFilters.includes("drug");

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

  // A shared link names a compound, and a narrow id resolves with no network
  // at all, so the sheet can be on screen before the index finishes.
  const sharedId = fragment.opts["id"];
  if (sharedId) {
    selectedId.value = sharedId;
    sharedPick.value = true;
  }

  mounted.value = true;
  void loadIndex();
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
            role="combobox"
            aria-controls="chem-results"
            :aria-expanded="visible.length > 0"
            placeholder="acetone, 67-64-1, H2SO4, or mass:98-99"
            class="pl-9"
            @keydown="onSearchKeydown"
            @update:model-value="onQueryInput"
          />
        </div>

        <!-- ----------------------------------------------------- filters -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-muted-foreground">Show only</span>
          <button
            v-for="chip in filterChips"
            :key="chip.id"
            type="button"
            :aria-pressed="chip.active"
            class="rounded-[8px] border px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            :class="
              chip.active
                ? 'border-primary bg-[color:var(--accent-soft)] text-primary'
                : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
            "
            @click="toggleFilter(chip.id)"
          >
            {{ chip.label }}
          </button>
        </div>

        <!-- ------------------------------------------------- index state -->
        <ProgressBar
          v-if="indexLoading"
          :value="indexPercent"
          label="Loading the full compound index"
          :detail="indexDetail"
          size="sm"
        />
        <ErrorBanner
          v-else-if="indexError"
          :message="indexError"
          title="The full compound index is not available"
          hint="The 3,050 compound set bundled with this page is still searchable. Retry to load the rest."
          variant="warning"
        >
          <Button size="sm" variant="outline" @click="loadIndex">Retry</Button>
        </ErrorBanner>

        <!-- ----------------------------------------------------- results -->
        <p v-if="!debounced.trim()" class="text-xs text-muted-foreground">
          Search more than 25,000 compounds by name, synonym, CAS registry number, molecular
          formula, or molar mass.
        </p>
        <template v-else>
          <p class="text-xs text-muted-foreground" role="status">
            {{ results.length }}{{ results.length === RESULT_CAP ? " or more" : "" }}
            {{ results.length === 1 ? "match" : "matches" }}. Use the arrow keys and Enter to move
            through them.
          </p>
          <ul
            v-if="visible.length"
            id="chem-results"
            ref="listRef"
            class="flex max-h-[19rem] flex-col gap-1 overflow-y-auto"
          >
            <li v-for="(hit, i) in visible" :key="hit.id">
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 rounded-[10px] border px-3 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                :class="[
                  hit.id === selectedId
                    ? 'border-primary bg-[color:var(--accent-soft)]'
                    : 'bg-card',
                  i === activeIndex && hit.id !== selectedId ? 'border-[color:var(--ring)]' : '',
                ]"
                :data-active="i === activeIndex"
                :aria-current="hit.id === selectedId"
                @click="pick(hit, i)"
              >
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium">{{ hit.name }}</span>
                  <span class="block truncate font-mono text-[11px] text-muted-foreground">
                    {{ [hit.formula, hit.cas].filter(Boolean).join(" · ") || "no formula on file" }}
                  </span>
                </span>
                <span class="flex shrink-0 items-center gap-1.5">
                  <span
                    v-if="hit.hasNfpa"
                    class="rounded-[8px] bg-secondary px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] uppercase"
                  >
                    NFPA
                  </span>
                  <span
                    v-if="hit.hasGhs"
                    class="rounded-[8px] bg-secondary px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] uppercase"
                  >
                    GHS
                  </span>
                  <span class="text-[11px] text-muted-foreground">{{ matchedLabel(hit) }}</span>
                </span>
              </button>
            </li>
          </ul>
          <div v-if="hasMore" class="flex justify-center">
            <Button size="sm" variant="outline" @click="shown += PAGE_SIZE">
              Show {{ Math.min(PAGE_SIZE, results.length - visible.length) }} more
            </Button>
          </div>
          <EmptyState
            v-if="!visible.length"
            title="Nothing matches that"
            :hint="
              filterNfpa || filterGhs || filterDrug
                ? 'Try the common name, a CAS registry number, or a formula, and switch a filter off.'
                : 'Try the common name, a synonym, the CAS registry number, the molecular formula, or a molar mass like mass:98-99.'
            "
            icon="FlaskConical"
          />
        </template>
      </div>
    </section>

    <!-- ----------------------------------------------------------- sheet -->
    <EmptyState
      v-if="!debounced.trim()"
      title="Nothing looked up yet"
      hint="Type a name, a CAS number, or a formula above to open a compound's data sheet."
      icon="FlaskConical"
    />

    <ErrorBanner v-else-if="detailError" :message="detailError" />

    <section
      v-else-if="detail"
      class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
      :aria-busy="detailLoading"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-[22px] leading-tight font-semibold tracking-[-0.014em]">
            {{ detail.name }}
          </h2>
          <p v-if="detail.subtitle" class="mt-1 font-mono text-sm text-muted-foreground">
            {{ detail.subtitle }}
          </p>
        </div>
        <CopyButton :text="reportText" label="Copy report" />
      </div>

      <!-- ----------------------------------------------------- artwork -->
      <div
        v-if="detail.diamonds.length || pictograms.length"
        class="flex flex-wrap items-start gap-6"
      >
        <div v-if="detail.diamonds.length" class="flex flex-wrap gap-4">
          <figure
            v-for="(d, i) in detail.diamonds"
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

      <!-- ------------------------------------------------- description -->
      <figure v-if="detail.description" class="flex flex-col gap-1.5">
        <blockquote class="max-w-[68ch] text-sm leading-relaxed">
          {{ detail.description }}
        </blockquote>
        <figcaption v-if="detail.attribution" class="text-xs text-muted-foreground">
          {{ detail.attribution }}
        </figcaption>
      </figure>

      <KeyValueGrid :rows="rows" surface="secondary" />

      <!-- ------------------------------------------------------- links -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <a v-if="detail.wikipedia" :href="detail.wikipedia" rel="noopener">Wikipedia</a>
        <a v-if="detail.pubchem" :href="detail.pubchem" rel="noopener">PubChem</a>
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

    <ProgressBar v-else-if="detailLoading" aria-label="Loading the compound data sheet" size="sm" />

    <!-- ------------------------------------------------------ provenance -->
    <footer class="flex flex-col gap-1 px-1 text-xs text-muted-foreground">
      <p v-for="line in PROVENANCE" :key="line">{{ line }}</p>
    </footer>
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
