<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Plus, X } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  DISCLAIMER,
  PICTOGRAM_INFO,
  commonHCodes,
  hStatementText,
  matchByHCodes,
  matchByPictograms,
  normalizeHCodes,
  normalizePictogramCodes,
  type MatchMode,
} from "@/tools/ghs-pictogram-lookup/index";
import type { Chemical } from "@/tools/_generated/chem-data";
import { readFragment, writeFragment } from "@/lib/fragment";
import CopyButton from "../CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";

/**
 * Bespoke panel for the GHS pictogram lookup.
 *
 * The point of this tool is that you recognize the symbol before you can name
 * it, so the picker has to be the drawn UN artwork rather than nine word chips
 * (the locked design delta). The artwork is self hosted under /ghs/, so the
 * page still makes no third party request.
 *
 * Every match comes from the pure logic layer (PROJECT.md rule 27); this file
 * owns DOM, layout, and URL fragment state only.
 *   src/tools/ghs-pictogram-lookup/index.ts  PICTOGRAM_INFO, matchByPictograms,
 *                                            matchByHCodes, normalizeHCodes,
 *                                            normalizePictogramCodes,
 *                                            hStatementText, commonHCodes,
 *                                            DISCLAIMER
 *
 * WHERE THE THROWING CALLS LIVE
 * -----------------------------
 * `normalizeHCodes` throws a ToolError for a code the GHS reference does not
 * list, and that is the useful behavior: the message names the problem and the
 * fix. So it is called in the add handler and when a shared link is read, never
 * in a computed. By the time the results computed runs, every code in state has
 * already come back out of `normalizeHCodes`, so `matchByHCodes` cannot throw.
 *
 * The two filters combine the way `run()` combines them: each side is matched
 * independently under the same all/any mode, and a query that uses both keeps
 * the chemicals that satisfy both.
 *
 * Nothing reads the DOM before mount: readFragment runs in onMounted and the
 * fragment writer stays quiet until then, so the server rendered markup is
 * always the empty picker.
 */
defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Values match meta.ts, so a shared link doubles as an /api query string. */
const MODE_OPTIONS: SegmentedOption[] = [
  { value: "all", label: "All of them" },
  { value: "any", label: "Any of them" },
];

/** Results shown before the expander. The mockup shows twenty. */
const VISIBLE_CAP = 20;

/**
 * Results shown after it. One common symbol matches well over a thousand
 * compounds, and mounting a thousand rows of artwork to answer "show me
 * everything" is a frozen tab, not an answer. The count line always tells the
 * truth about the total.
 */
const EXPANDED_CAP = 300;

/** Hazard codes summarized under the results. */
const COMMON_CAP = 6;

/** Hazard codes listed on one result row before the rest are counted. */
const ROW_CODE_CAP = 4;

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

const picked = ref<string[]>([]);
const mode = ref<MatchMode>("all");
const hcodes = ref<string[]>([]);
const draft = ref("");
const codeError = ref<{ message: string; fix?: string } | null>(null);
const showAll = ref(false);
const mounted = ref(false);

/* ------------------------------------------------------------------ *
 * the picker
 * ------------------------------------------------------------------ */

function togglePictogram(code: string): void {
  const next = picked.value.includes(code)
    ? picked.value.filter((c) => c !== code)
    : [...picked.value, code];
  // Canonical GHS01 to GHS09 order, so the URL and the summary read the same
  // way no matter which symbol was clicked first.
  picked.value = normalizePictogramCodes(next);
  showAll.value = false;
}

function isPicked(code: string): boolean {
  return picked.value.includes(code);
}

/** The control speaks strings; MatchMode has two members and this is the narrowing. */
function setMode(value: string): void {
  mode.value = value === "any" ? "any" : "all";
  showAll.value = false;
}

/* ------------------------------------------------------------------ *
 * hazard codes
 * ------------------------------------------------------------------ */

/**
 * Add whatever is in the box. The draft is passed through whole, so "H225,
 * H319" in one paste adds both, and an unknown code leaves the text in place
 * with the logic layer's own message under it.
 */
function addCode(): void {
  const text = draft.value.trim();
  if (!text) return;
  try {
    hcodes.value = normalizeHCodes([...hcodes.value, text]);
    draft.value = "";
    codeError.value = null;
    showAll.value = false;
  } catch (e) {
    codeError.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: "That hazard code could not be read." };
  }
}

function removeCode(code: string): void {
  hcodes.value = hcodes.value.filter((c) => c !== code);
  codeError.value = null;
  showAll.value = false;
}

function clearAll(): void {
  picked.value = [];
  hcodes.value = [];
  draft.value = "";
  codeError.value = null;
  showAll.value = false;
}

/* ------------------------------------------------------------------ *
 * results
 * ------------------------------------------------------------------ */

const hasFilter = computed(() => picked.value.length > 0 || hcodes.value.length > 0);

const results = computed<Chemical[]>(() => {
  const byPictogram = picked.value.length ? matchByPictograms(picked.value, mode.value) : undefined;
  const byCode = hcodes.value.length ? matchByHCodes(hcodes.value, mode.value) : undefined;
  if (byPictogram && byCode) {
    const ids = new Set(byCode.map((c) => c.id));
    return byPictogram.filter((c) => ids.has(c.id));
  }
  return byPictogram ?? byCode ?? [];
});

const visible = computed(() => results.value.slice(0, showAll.value ? EXPANDED_CAP : VISIBLE_CAP));

const common = computed(() => commonHCodes(results.value, COMMON_CAP));

const resultText = computed(() => results.value.map((c) => c.name).join("\n"));

/** "Flame and Exclamation Mark, H225" and so on, for the count line. */
const filterSummary = computed(() => {
  const parts: string[] = [];
  const names = picked.value
    .map((code) => PICTOGRAM_INFO.find((p) => p.code === code)?.name ?? code)
    .join(mode.value === "all" ? " and " : " or ");
  if (names) parts.push(names);
  if (hcodes.value.length) parts.push(hcodes.value.join(mode.value === "all" ? " and " : " or "));
  return parts.join(", ");
});

/* ------------------------------------------------------------------ *
 * small view helpers
 * ------------------------------------------------------------------ */

function pictogramsOf(c: Chemical): typeof PICTOGRAM_INFO {
  const codes = c.ghs?.pictograms ?? [];
  return PICTOGRAM_INFO.filter((p) => codes.includes(p.code));
}

function statementsOf(c: Chemical): { code: string; text: string }[] {
  return (c.ghs?.h ?? []).slice(0, ROW_CODE_CAP);
}

/** "Danger", "Warning", or nothing. Read here so the template needs no narrowing. */
function signalOf(c: Chemical): string {
  return c.ghs?.signal ?? "";
}

function extraStatements(c: Chemical): number {
  return Math.max(0, (c.ghs?.h.length ?? 0) - ROW_CODE_CAP);
}

/** The canonical UN wording, for a title attribute. Empty when there is none. */
function codeTitle(code: string): string {
  const text = hStatementText(code);
  return text ? `${code}: ${text}` : code;
}

/* ------------------------------------------------------------------ *
 * URL fragment
 * ------------------------------------------------------------------ */

/**
 * One object, one write: writeFragment rebuilds the whole hash from what it is
 * given. The keys are the meta option ids and the values are the comma
 * separated form the logic layer already parses, so a shared link works as an
 * /api/ghs-pictogram-lookup query string too. Defaults are left out.
 */
const fragmentOpts = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  if (picked.value.length) out.pictograms = picked.value.join(",");
  if (mode.value !== "all") out.mode = mode.value;
  if (hcodes.value.length) out.hcodes = hcodes.value.join(",");
  return out;
});

watch(fragmentOpts, (opts) => {
  if (!mounted.value) return;
  writeFragment({ opts });
});

onMounted(() => {
  const fragment = readFragment().opts;
  // A shared link is just text. Anything the logic layer rejects is dropped
  // rather than left to blow up a computed on the next render.
  try {
    if (fragment.pictograms) picked.value = normalizePictogramCodes(fragment.pictograms);
  } catch {
    picked.value = [];
  }
  try {
    if (fragment.hcodes) hcodes.value = normalizeHCodes(fragment.hcodes);
  } catch {
    hcodes.value = [];
  }
  if (fragment.mode === "any" || fragment.mode === "all") mode.value = fragment.mode;
  mounted.value = true;
});
</script>

<template>
  <div class="ghs-panel flex flex-col gap-4">
    <!-- ---------------------------------------------------------- picker -->
    <section class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-col gap-5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-[17px] font-semibold">Pictograms</h2>
          <p class="text-xs text-muted-foreground">
            The official UN artwork, served from this site.
          </p>
        </div>

        <ul class="flex flex-wrap gap-2">
          <li v-for="p in PICTOGRAM_INFO" :key="p.code">
            <button
              type="button"
              :aria-pressed="isPicked(p.code)"
              :title="
                p.hazardClass ? `${p.code} ${p.name}, ${p.hazardClass}` : `${p.code} ${p.name}`
              "
              class="flex w-[84px] flex-col items-center gap-1.5 rounded-[10px] border bg-card px-2 py-2.5 transition-[background-color,box-shadow] duration-[120ms] outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
              :class="
                isPicked(p.code)
                  ? 'border-primary bg-[color:var(--accent-soft)] ring-2 ring-primary'
                  : ''
              "
              @click="togglePictogram(p.code)"
            >
              <img :src="p.svgPath" alt="" width="44" height="44" class="size-11" />
              <span class="text-center text-[11px] leading-tight">{{ p.name }}</span>
            </button>
          </li>
        </ul>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span class="text-xs text-muted-foreground">Match</span>
          <Segmented
            :options="MODE_OPTIONS"
            :model-value="mode"
            size="sm"
            label="Match all or any of the selected symbols and codes"
            @update:model-value="setMode"
          />
        </div>

        <div class="h-px bg-border"></div>

        <!-- ------------------------------------------------- hazard codes -->
        <div class="flex flex-col gap-2">
          <Label for="ghs-hcode" class="text-xs text-muted-foreground">Hazard codes</Label>
          <div class="flex flex-wrap items-center gap-2">
            <ul v-if="hcodes.length" class="flex flex-wrap gap-1.5">
              <li v-for="code in hcodes" :key="code">
                <span
                  class="inline-flex items-center gap-1 rounded-[8px] bg-secondary py-1 pr-1 pl-2 font-mono text-xs shadow-[var(--sh-inset)]"
                  :title="codeTitle(code)"
                >
                  {{ code }}
                  <button
                    type="button"
                    :aria-label="`Remove ${code}`"
                    class="grid size-5 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                    @click="removeCode(code)"
                  >
                    <X class="size-3.5" />
                  </button>
                </span>
              </li>
            </ul>

            <div class="flex items-center gap-2">
              <Input
                id="ghs-hcode"
                :model-value="draft"
                autocomplete="off"
                placeholder="H225"
                class="h-8 w-28 font-mono"
                @update:model-value="draft = String($event)"
                @keydown.enter.prevent="addCode"
              />
              <Button variant="secondary" size="sm" @click="addCode">
                <Plus class="size-4" aria-hidden="true" />
                Add
              </Button>
            </div>
          </div>

          <p v-if="codeError" class="text-xs text-destructive">
            {{ codeError.message }}
            <span v-if="codeError.fix" class="text-muted-foreground">{{ codeError.fix }}</span>
          </p>
          <p v-else class="text-xs text-muted-foreground">
            Press Enter to add. Hover a code to read the UN wording.
          </p>
        </div>
      </div>
    </section>

    <!-- --------------------------------------------------------- results -->
    <section class="overflow-hidden rounded-[18px] border bg-card shadow-[var(--sh-sm)]">
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-b bg-secondary px-4 py-3 sm:px-5"
      >
        <div class="min-w-0">
          <p class="text-sm font-semibold">
            <template v-if="hasFilter">
              {{ results.length }}
              {{ results.length === 1 ? "chemical matches" : "chemicals match" }}
            </template>
            <template v-else>Pick a symbol or add a hazard code</template>
          </p>
          <p v-if="hasFilter && filterSummary" class="truncate text-xs text-muted-foreground">
            {{ filterSummary }}
            <template v-if="results.length > VISIBLE_CAP && !showAll">
              · showing {{ VISIBLE_CAP }}, sorted by name
            </template>
          </p>
          <p v-else-if="!hasFilter" class="text-xs text-muted-foreground">
            Click any of the nine symbols above to see the chemicals classified with it.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Button v-if="hasFilter" variant="ghost" size="sm" @click="clearAll">Clear</Button>
          <CopyButton
            v-if="results.length"
            :text="resultText"
            aria-label="Copy every matching chemical name"
          />
        </div>
      </div>

      <ul v-if="results.length" class="divide-y">
        <li
          v-for="c in visible"
          :key="c.id"
          class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
        >
          <span class="flex shrink-0 gap-1">
            <img
              v-for="p in pictogramsOf(c)"
              :key="p.code"
              :src="p.svgPath"
              :alt="p.name"
              :title="`${p.code} ${p.name}`"
              width="28"
              height="28"
              class="size-7"
            />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">{{ c.name }}</span>
            <span v-if="c.formula || c.cas" class="block font-mono text-xs text-muted-foreground">
              {{ [c.formula, c.cas].filter(Boolean).join(" · ") }}
            </span>
          </span>
          <span
            v-if="signalOf(c)"
            class="shrink-0 rounded-[8px] px-2 py-0.5 text-[11px] font-semibold"
            :class="
              signalOf(c) === 'Danger'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
            "
          >
            {{ signalOf(c) }}
          </span>
          <span class="flex flex-wrap items-center gap-1">
            <span
              v-for="h in statementsOf(c)"
              :key="h.code"
              class="rounded-[8px] bg-secondary px-2 py-0.5 font-mono text-[11px]"
              :title="h.text"
            >
              {{ h.code }}
            </span>
            <span v-if="extraStatements(c)" class="text-[11px] text-muted-foreground">
              +{{ extraStatements(c) }}
            </span>
          </span>
        </li>
      </ul>

      <p v-else-if="hasFilter" class="px-4 py-6 text-sm text-muted-foreground sm:px-5">
        No chemical in the dataset carries that combination. Switch the match to Any of them, or
        drop one of the filters.
      </p>

      <div
        v-if="results.length > VISIBLE_CAP"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-3 sm:px-5"
      >
        <Button variant="ghost" size="sm" @click="showAll = !showAll">
          {{
            showAll
              ? "Show fewer"
              : results.length > EXPANDED_CAP
                ? `Show ${EXPANDED_CAP}`
                : `Show all ${results.length}`
          }}
        </Button>
        <span v-if="showAll && results.length > EXPANDED_CAP" class="text-xs text-muted-foreground">
          The first {{ EXPANDED_CAP }} of {{ results.length }}. Add a filter to narrow the list.
        </span>
      </div>
    </section>

    <!-- ------------------------------------------------ common statements -->
    <section
      v-if="common.length"
      class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <h2 class="text-[17px] font-semibold">Most common hazard statements</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        What these {{ results.length }} chemicals are actually classified for, counted across the
        result set.
      </p>
      <ul class="mt-3 flex flex-wrap gap-2">
        <li
          v-for="h in common"
          :key="h.code"
          class="flex max-w-full items-baseline gap-2 rounded-[8px] bg-secondary px-2.5 py-1.5 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-mono font-semibold">{{ h.code }}</span>
          <span class="min-w-0 truncate text-muted-foreground">{{ hStatementText(h.code) }}</span>
          <span class="shrink-0 font-mono text-muted-foreground">{{ h.count }}</span>
        </li>
      </ul>
    </section>

    <p
      role="note"
      class="flex items-start gap-2.5 rounded-[14px] border border-amber-500/45 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <span class="mt-0.5 shrink-0 font-semibold text-amber-700 dark:text-amber-400">Note</span>
      <span>{{ DISCLAIMER }}</span>
    </p>
  </div>
</template>
