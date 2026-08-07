<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Check, Search } from 'lucide-vue-next';
import type { ToolMeta } from '@/tools/types';
import { readFragment, writeFragment } from '@/lib/fragment';
import { search } from '@/tools/unicode-picker/index';
import { CATEGORIES, type UnicodeEntry } from '@/tools/unicode-picker/data';
import { Input } from '@/components/ui/input';
import CopyButton from '../CopyButton.vue';

/**
 * Bespoke panel for the unicode picker: a glyph grid you can scan, not a list
 * of rows. Search and category round-trip through the URL fragment so a
 * filtered view is shareable. Copying happens on the cell itself; the detail
 * strip below carries the name, code point and HTML entity for the last pick.
 */
defineProps<{ meta: ToolMeta }>();

/** Rendered cells are capped so a bare "all categories" browse stays cheap. */
const CAP = 200;

/** Short stand-in labels for characters that have nothing to draw. */
const ABBREVIATIONS: Record<string, string> = {
  'no-break space': 'NBSP',
  'narrow no-break space': 'NNBSP',
  'zero width space': 'ZWSP',
  'zero width joiner': 'ZWJ',
  'zero width non-joiner': 'ZWNJ',
  'zero width no-break space': 'ZWNBSP',
  'soft hyphen': 'SHY',
  'word joiner': 'WJ',
  'en space': 'ENSP',
  'em space': 'EMSP',
  'thin space': 'THINSP',
  'hair space': 'HAIRSP',
  'figure space': 'FIGSP',
  'punctuation space': 'PUNCSP',
};

const pills = [{ id: 'all', label: 'All' }, ...CATEGORIES];

const typed = ref('');
const query = ref('');
const category = ref('all');
const selected = ref<UnicodeEntry | null>(null);
const copiedKey = ref<string | null>(null);
const grid = ref<HTMLElement>();
const mounted = ref(false);

let debounce: ReturnType<typeof setTimeout> | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const results = computed(() => search(query.value, category.value));
const visible = computed(() => results.value.slice(0, CAP));

function isInvisible(entry: UnicodeEntry): boolean {
  return entry.category === 'invisible';
}

/** "NBSP" where we have a familiar abbreviation, else the code point. */
function chipLabel(entry: UnicodeEntry): string {
  return ABBREVIATIONS[entry.name] ?? entry.codepoint;
}

function tooltip(entry: UnicodeEntry): string {
  return `${entry.name} ${entry.codepoint}`;
}

async function pick(entry: UnicodeEntry) {
  selected.value = entry;
  try {
    await navigator.clipboard.writeText(entry.char);
  } catch {
    return;
  }
  copiedKey.value = entry.codepoint;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copiedKey.value = null), 1200);
}

/** Arrow keys move focus between cells. Tab order is untouched. */
function columns(): number {
  if (!grid.value) return 1;
  const tracks = getComputedStyle(grid.value).gridTemplateColumns.split(' ').filter(Boolean);
  return Math.max(1, tracks.length);
}

function onGridKeydown(event: KeyboardEvent) {
  const steps: Record<string, number> = {
    ArrowRight: 1,
    ArrowLeft: -1,
    ArrowDown: columns(),
    ArrowUp: -columns(),
  };
  const step = steps[event.key];
  if (!step || !grid.value) return;
  const cells = Array.from(grid.value.querySelectorAll<HTMLButtonElement>('button[data-cell]'));
  const from = cells.indexOf(document.activeElement as HTMLButtonElement);
  if (from === -1) return;
  const to = Math.min(cells.length - 1, Math.max(0, from + step));
  if (to === from) return;
  event.preventDefault();
  cells[to].focus();
}

watch(typed, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => (query.value = value), 100);
});

watch([query, category], () => {
  if (!mounted.value) return;
  writeFragment({
    input: query.value,
    opts: category.value === 'all' ? {} : { cat: category.value },
  });
});

onMounted(() => {
  const frag = readFragment();
  if (frag.input) {
    typed.value = frag.input;
    query.value = frag.input;
  }
  const cat = frag.opts.cat;
  if (cat && CATEGORIES.some((c) => c.id === cat)) category.value = cat;
  mounted.value = true;
});

onUnmounted(() => {
  clearTimeout(debounce);
  clearTimeout(copyTimer);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-col gap-3">
      <div
        class="flex items-center gap-2 rounded-[10px] bg-secondary px-3 shadow-[var(--sh-inset)]"
      >
        <Search
          class="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          v-model="typed"
          type="text"
          aria-label="Search Unicode characters"
          placeholder="Search by name: arrow, em dash, greek, rupee, zero width"
          class="h-10 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>

      <div
        role="group"
        aria-label="Filter by category"
        class="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
      >
        <button
          v-for="pill in pills"
          :key="pill.id"
          type="button"
          :aria-pressed="category === pill.id"
          class="shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-[120ms]"
          :class="
            category === pill.id
              ? 'border-transparent bg-primary text-primary-foreground'
              : 'border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground'
          "
          @click="category = pill.id"
        >
          {{ pill.label }}
        </button>
      </div>
    </div>

    <p
      v-if="results.length > CAP"
      class="text-xs text-muted-foreground"
    >
      Showing {{ CAP }} of {{ results.length }} matches. Narrow the search or pick a category to see
      the rest.
    </p>

    <div
      v-if="visible.length"
      ref="grid"
      class="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2"
      @keydown="onGridKeydown"
    >
      <button
        v-for="entry in visible"
        :key="entry.codepoint"
        data-cell
        type="button"
        :title="tooltip(entry)"
        :aria-label="entry.name"
        class="relative flex h-16 items-center justify-center rounded-[10px] border bg-secondary px-1 transition-colors duration-[120ms] hover:bg-accent"
        :class="selected?.codepoint === entry.codepoint ? 'border-primary' : 'border-transparent'"
        @click="pick(entry)"
      >
        <span
          v-if="isInvisible(entry)"
          class="rounded-[6px] bg-background px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground"
        >
          {{ chipLabel(entry) }}
        </span>
        <span
          v-else
          class="font-mono text-2xl leading-none"
        >{{ entry.char }}</span>

        <span
          v-if="copiedKey === entry.codepoint"
          class="absolute inset-0 flex items-center justify-center rounded-[10px] bg-[var(--positive-soft)] text-[var(--positive)]"
        >
          <Check
            class="size-5"
            aria-hidden="true"
          />
          <span class="sr-only">Copied</span>
        </span>
      </button>
    </div>

    <p
      v-else
      class="rounded-[10px] bg-secondary px-3 py-6 text-center text-sm text-muted-foreground shadow-[var(--sh-inset)]"
    >
      Nothing matches that search. Try something shorter like "arrow", "dash" or "space", or paste
      the character itself.
    </p>

    <div
      v-if="selected"
      class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <span
        v-if="isInvisible(selected)"
        class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[6px] bg-background font-mono text-[10px] font-semibold text-muted-foreground"
      >
        {{ chipLabel(selected) }}
      </span>
      <span
        v-else
        class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[6px] bg-background font-mono text-3xl leading-none"
      >{{ selected.char }}</span>

      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">
          {{ selected.name }}
        </p>
        <p class="font-mono text-xs text-muted-foreground">
          {{ selected.codepoint }} &middot; {{ selected.htmlEntity }}
        </p>
      </div>

      <div class="flex items-center gap-1">
        <CopyButton
          :text="selected.char"
          label="Copy character"
        />
        <CopyButton
          :text="selected.htmlEntity"
          label="Copy entity"
        />
      </div>
    </div>
  </div>
</template>
