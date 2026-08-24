<script setup lang="ts">
import { computed, ref } from "vue";
import { Input } from "@/components/ui/input";
import { highlightHtml, searchTools, type SearchTool } from "@/lib/search";
import { iconFor } from "@/lib/tool-icons";
import { categoryByLabel, categoryPath, categoryRank } from "@/tools/categories";

/**
 * Tool grid: search + category-grouped cards. Server-rendered at build (full
 * list in the HTML for SEO), hydrates for filtering.
 *
 * Two shapes from one component. The homepage passes every tool and gets the
 * grouped three-column grid with linked category headings. A category page
 * passes `category` and gets one ungrouped section of larger two-column cards,
 * because that page already says which category you are in.
 */
export type GridTool = SearchTool & { icon?: string };

const props = defineProps<{
  tools: GridTool[];
  /** Restrict to one category label: no headings, larger cards. */
  category?: string;
  /** Force the larger card layout without restricting to one category. */
  large?: boolean;
}>();

const query = ref("");

/** Keyword chips shown on large cards: short ones only, so a card stays one shape. */
const CHIP_LIMIT = 4;
const CHIP_MAX_LENGTH = 18;

interface GridSection {
  label: string;
  /** Category page href, omitted for a label that is not in the registry. */
  path?: string;
  icon?: string;
  items: GridTool[];
}

const scoped = computed(() =>
  props.category ? props.tools.filter((t) => t.category === props.category) : props.tools,
);

const filtered = computed(() => searchTools(scoped.value, query.value).map((r) => r.tool));

const isLarge = computed(() => props.large === true || props.category !== undefined);

const sections = computed<GridSection[]>(() => {
  if (props.category) {
    return filtered.value.length ? [{ label: props.category, items: filtered.value }] : [];
  }

  const map = new Map<string, GridTool[]>();
  for (const t of filtered.value) {
    const list = map.get(t.category) ?? [];
    list.push(t);
    map.set(t.category, list);
  }

  // Display order comes from categories.ts, not the alphabet. The label
  // tie-break only matters for a label the registry does not know, which the
  // registry test forbids but which should still render in a stable order.
  return [...map.entries()]
    .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([label, items]) => {
      const category = categoryByLabel(label);
      return { label, path: category && categoryPath(category), icon: category?.icon, items };
    });
});

const searchLabel = computed(() =>
  props.category ? `Search ${props.category} tools` : "Search tools",
);

const emptyMessage = computed(() =>
  query.value.trim()
    ? `No tools match "${query.value}" yet. Try a different word, or check the full list on GitHub.`
    : "No tools in this category yet. New ones show up here as they ship.",
);

function chipsFor(tool: GridTool): string[] {
  return tool.keywords.filter((k) => k.length <= CHIP_MAX_LENGTH).slice(0, CHIP_LIMIT);
}

/** The Ctrl K chip in the search field opens the palette, same as the header. */
function openPalette(): void {
  document.dispatchEvent(new CustomEvent("tools:open-palette"));
}
</script>

<template>
  <div>
    <div class="relative mx-auto max-w-2xl">
      <Input
        v-model="query"
        type="search"
        :placeholder="`${searchLabel}…`"
        :aria-label="searchLabel"
        class="h-11 bg-card pr-16 shadow-[var(--sh-sm)]"
      />
      <button
        type="button"
        aria-label="Search tools"
        aria-keyshortcuts="Control+K"
        class="absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        @click="openPalette"
      >
        <kbd class="block">Ctrl K</kbd>
      </button>
    </div>

    <p v-if="filtered.length === 0" class="mt-10 text-center text-muted-foreground">
      {{ emptyMessage }}
    </p>

    <section v-for="section in sections" :key="section.label" class="mt-10">
      <h2
        v-if="!category"
        class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
      >
        <a
          v-if="section.path"
          :href="section.path"
          class="inline-flex items-center gap-1.5 rounded-[6px] transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <component
            :is="iconFor(section.icon)"
            class="size-3.5"
            :stroke-width="2"
            aria-hidden="true"
          />
          {{ section.label }}
        </a>
        <template v-else>{{ section.label }}</template>
      </h2>
      <ul
        class="mt-3 grid gap-4"
        :class="isLarge ? 'lg:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'"
      >
        <li v-for="t in section.items" :key="t.slug">
          <a
            :href="`/${t.slug}`"
            class="tool-card flex h-full rounded-[14px] border bg-card shadow-[var(--sh-sm)]"
            :class="isLarge ? 'gap-4 p-6' : 'gap-3 p-5'"
          >
            <span
              class="tool-tile grid shrink-0 place-items-center"
              :class="isLarge ? 'size-11 rounded-[12px]' : 'size-9 rounded-[10px]'"
              aria-hidden="true"
            >
              <component
                :is="iconFor(t.icon)"
                :class="isLarge ? 'size-[22px]' : 'size-[18px]'"
                :stroke-width="2"
              />
            </span>
            <span class="min-w-0">
              <!-- eslint-disable vue/no-v-html -- highlightHtml escapes its input, so the marked-up output is safe -->
              <span
                class="block font-semibold"
                :class="isLarge ? 'text-lg tracking-tight' : ''"
                v-html="highlightHtml(t.name, query)"
              />
              <span
                class="mt-1 block text-sm text-muted-foreground"
                v-html="highlightHtml(t.description, query)"
              />
              <!-- eslint-enable vue/no-v-html -->
              <span v-if="isLarge" class="mt-3 flex flex-wrap gap-1.5">
                <span
                  v-for="k in chipsFor(t)"
                  :key="k"
                  class="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {{ k }}
                </span>
              </span>
            </span>
          </a>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.tool-card {
  transition:
    transform 160ms cubic-bezier(0.2, 0.7, 0.3, 1),
    box-shadow 160ms cubic-bezier(0.2, 0.7, 0.3, 1),
    border-color 120ms ease-out;
}

.tool-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--sh-md);
  border-color: color-mix(in oklab, var(--primary) 35%, var(--border));
}

.tool-tile {
  background: var(--accent-soft);
  color: var(--primary);
  transition: background-color 120ms ease-out;
}

.tool-card:hover .tool-tile {
  background: color-mix(in oklab, var(--primary) 20%, var(--accent-soft));
}

.tool-card :deep(mark) {
  background: transparent;
  color: var(--primary);
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .tool-card {
    transition: border-color 120ms ease-out;
  }

  .tool-card:hover {
    transform: none;
  }
}
</style>
