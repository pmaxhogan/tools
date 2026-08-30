<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from "vue";
import { Dices, History, Star } from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import FavoriteButton from "@/components/tool/FavoriteButton.vue";
import { highlightHtml, searchTools, type SearchTool } from "@/lib/search";
import { iconFor } from "@/lib/tool-icons";
import { FAVORITES_KEY } from "@/lib/favorites";
import { onPrefsChange, readList } from "@/lib/prefs";
import { RECENT_TOOLS_KEY } from "@/lib/recent-tools";
import { newBadgeSlugs } from "@/lib/tool-dates";
import { categoryByLabel, categoryPath, categoryRank } from "@/tools/categories";

/**
 * Tool grid: search + category-grouped cards. Server-rendered at build (full
 * list in the HTML for SEO), hydrates for filtering.
 *
 * Two shapes from one component. The homepage passes every tool and gets the
 * grouped three-column grid with linked category headings. A category page
 * passes `category` and gets one ungrouped section of larger two-column cards,
 * because that page already says which category you are in.
 *
 * Three things here only exist after hydration, because all three read
 * localStorage and none of them may change the server-rendered HTML: the Pinned
 * row, the Recent row, and every card's star. They are appended above the grid
 * rather than reserving space in it, so the categorized list never moves.
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

/** How many tools the Recent row shows. The stored list is longer. */
const RECENT_ROW_MAX = 6;

interface GridSection {
  /** Stable render key: a category label collides with nothing else here. */
  key: string;
  label: string;
  /** Category page href, omitted for a label that is not in the registry. */
  path?: string;
  icon?: string;
  /** Lucide component for the rows that are not categories. */
  lead?: Component;
  items: GridTool[];
  /** Pinned and Recent rows are shortcuts, so they never show a count. */
  counted: boolean;
}

const scoped = computed(() =>
  props.category ? props.tools.filter((t) => t.category === props.category) : props.tools,
);

const filtered = computed(() => searchTools(scoped.value, query.value).map((r) => r.tool));

const isLarge = computed(() => props.large === true || props.category !== undefined);

/* ------------------------------------------------------- pinned and recent */

/**
 * Preference lists, read after mount only. `mounted` gates the rows so the
 * first client render matches the static HTML exactly.
 */
const mounted = ref(false);
const favorites = ref<string[]>([]);
const recents = ref<string[]>([]);
const stops: Array<() => void> = [];

const bySlug = computed(() => {
  const map = new Map<string, GridTool>();
  for (const tool of props.tools) if (!map.has(tool.slug)) map.set(tool.slug, tool);
  return map;
});

/** The tools named by a slug list, in list order, skipping ones we do not have. */
function resolve(slugs: readonly string[], max = Number.POSITIVE_INFINITY): GridTool[] {
  const out: GridTool[] = [];
  for (const slug of slugs) {
    const tool = bySlug.value.get(slug);
    if (tool) out.push(tool);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Shortcut rows show on the full grid only, and only with an empty search box:
 * once someone is searching, the answer to their query is the whole point of
 * the page, and a category page already answers "which tools are these".
 */
const showShortcuts = computed(() => mounted.value && !props.category && query.value.trim() === "");

const pinnedTools = computed(() => (showShortcuts.value ? resolve(favorites.value) : []));
const recentTools = computed(() =>
  showShortcuts.value ? resolve(recents.value, RECENT_ROW_MAX) : [],
);

function refreshFavorites(): void {
  favorites.value = readList(FAVORITES_KEY);
}

function refreshRecents(): void {
  recents.value = readList(RECENT_TOOLS_KEY);
}

onMounted(() => {
  mounted.value = true;
  refreshFavorites();
  refreshRecents();
  stops.push(onPrefsChange(FAVORITES_KEY, refreshFavorites));
  stops.push(onPrefsChange(RECENT_TOOLS_KEY, refreshRecents));
});

onUnmounted(() => {
  for (const stop of stops.splice(0)) stop();
});

/* ------------------------------------------------------------ new tool badge */

/**
 * Which cards wear a "New" badge. Computed once at mount from a fixed instant,
 * so the answer cannot change under the reader mid session, and routed through
 * `newBadgeSlugs`, which keeps the badge on the newest batch instead of on
 * every card that happens to be under a month old.
 */
const now = Date.now();
const newSlugs = computed(() =>
  mounted.value
    ? newBadgeSlugs(
        scoped.value.map((t) => t.slug),
        now,
      )
    : new Set<string>(),
);

/* ------------------------------------------------------------------ sections */

const sections = computed<GridSection[]>(() => {
  if (props.category) {
    return filtered.value.length
      ? [{ key: "category", label: props.category, items: filtered.value, counted: false }]
      : [];
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
  const out: GridSection[] = [...map.entries()]
    .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([label, items]) => {
      const category = categoryByLabel(label);
      return {
        key: `category:${label}`,
        label,
        path: category && categoryPath(category),
        icon: category?.icon,
        items,
        counted: true,
      };
    });

  if (recentTools.value.length) {
    out.unshift({
      key: "recent",
      label: "Recent",
      lead: History,
      items: recentTools.value,
      counted: false,
    });
  }
  if (pinnedTools.value.length) {
    out.unshift({
      key: "pinned",
      label: "Pinned",
      lead: Star,
      items: pinnedTools.value,
      counted: false,
    });
  }
  return out;
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

/** Open a tool at random, from whatever this grid is currently showing. */
function openRandom(): void {
  const pool = filtered.value.length ? filtered.value : scoped.value;
  if (pool.length === 0) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  window.location.href = `/${pick.slug}`;
}
</script>

<template>
  <div>
    <div class="mx-auto flex max-w-2xl items-center gap-2">
      <div class="relative min-w-0 flex-1">
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
      <Button
        variant="outline"
        size="icon-lg"
        type="button"
        class="size-11 shrink-0"
        aria-label="Open a random tool"
        title="Open a random tool"
        @click="openRandom"
      >
        <Dices aria-hidden="true" />
      </Button>
    </div>

    <p v-if="filtered.length === 0" class="mt-10 text-center text-muted-foreground">
      {{ emptyMessage }}
    </p>

    <section v-for="section in sections" :key="section.key" class="mt-10">
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
          <span v-if="section.counted" class="font-normal tabular-nums opacity-70">
            {{ section.items.length }}
          </span>
        </a>
        <span v-else class="inline-flex items-center gap-1.5">
          <component
            :is="section.lead"
            v-if="section.lead"
            class="size-3.5"
            :stroke-width="2"
            aria-hidden="true"
          />
          {{ section.label }}
          <span v-if="section.counted" class="font-normal tabular-nums opacity-70">
            {{ section.items.length }}
          </span>
        </span>
      </h2>
      <ul
        class="mt-3 grid gap-4"
        :class="isLarge ? 'lg:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'"
      >
        <li v-for="t in section.items" :key="t.slug" class="relative">
          <a
            :href="`/${t.slug}`"
            class="tool-card flex h-full rounded-[14px] border bg-card shadow-[var(--sh-sm)]"
            :class="isLarge ? 'gap-4 p-6 pr-14' : 'gap-3 p-5 pr-12'"
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
              <!-- The badge rides on the title line rather than under it: it
                   is added after hydration, and a new line would move the card. -->
              <span class="flex items-start gap-2">
                <!-- eslint-disable vue/no-v-html -- highlightHtml escapes its input, so the marked-up output is safe -->
                <span
                  class="min-w-0 font-semibold"
                  :class="isLarge ? 'text-lg tracking-tight' : ''"
                  v-html="highlightHtml(t.name, query)"
                />
                <Badge
                  v-if="newSlugs.has(t.slug)"
                  as="span"
                  variant="secondary"
                  class="mt-0.5 shrink-0"
                >
                  New
                </Badge>
              </span>
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
          <!-- Sibling of the card link, never inside it: a button nested in an
               anchor is invalid, and the star must not open the tool. -->
          <FavoriteButton v-if="mounted" :slug="t.slug" class="card-star absolute top-2 right-2" />
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

/* The star stays out of the way until it is wanted: on hover, on keyboard
   focus, and always once the tool is pinned. Opacity rather than display, so it
   is still in the tab order and still announced. */
.card-star {
  opacity: 0;
  transition: opacity 120ms ease-out;
}

li:hover > .card-star,
.card-star:focus-visible,
.card-star[data-favorite="true"] {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .tool-card {
    transition: border-color 120ms ease-out;
  }

  .tool-card:hover {
    transform: none;
  }

  .card-star {
    transition: none;
  }
}
</style>
