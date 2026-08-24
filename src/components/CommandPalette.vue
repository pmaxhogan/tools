<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { highlightHtml, searchAll, type SearchTool } from "@/lib/search";
import { RECENT_TOOLS_KEY, rememberRecent } from "@/lib/recent-tools";
import { iconFor } from "@/lib/tool-icons";
import {
  CATEGORIES,
  categoryByLabel,
  categoryPath,
  categoryRank,
  type ToolCategory,
} from "@/tools/categories";

/**
 * Ctrl+K palette over the tool registry. Mounted on every page.
 *
 * Two panes at sm and up: results on the left, a preview of the highlighted
 * entry on the right. Below sm the preview is dropped and the sheet stays a
 * single column. Both panes read the same flat row list, so arrow keys walk
 * every visible row in order no matter which section it sits in.
 *
 * Rows are tools AND categories. An empty query shows Recent, then every
 * category, then all tools grouped by category in registry order; a typed
 * query hands both lists to `searchAll` and renders one ranked column.
 */
export type PaletteTool = SearchTool & { icon?: string };

/** One navigable row. Tools and categories share a single index space. */
type Row = { kind: "tool"; tool: PaletteTool } | { kind: "category"; category: ToolCategory };

/**
 * A row flattened for rendering. Every field the template needs is resolved
 * here so the markup never has to narrow the union, and `index` is the row's
 * position in the flat list that the arrow keys and the preview both use.
 */
interface RowView {
  index: number;
  row: Row;
  href: string;
  /** Lucide export name, resolved through iconFor. */
  icon?: string;
  title: string;
  description: string;
  /** Tiny chip on the right: the category label, or "Category". */
  badge: string;
}

interface Section {
  key: string;
  heading: string | null;
  /** Lucide export name for the heading, when the heading names a category. */
  icon?: string;
  items: RowView[];
}

/** What the right pane shows for the highlighted row. */
interface PreviewView {
  icon?: string;
  title: string;
  description: string;
  chipIcon?: string;
  chipLabel: string;
}

const props = defineProps<{ tools: PaletteTool[] }>();
const open = ref(false);
const query = ref("");
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const itemEls = ref<HTMLAnchorElement[]>([]);
const recent = ref<string[]>([]);

const bySlug = computed(() => new Map(props.tools.map((tool) => [tool.slug, tool])));

const countByCategory = computed(() => {
  const counts = new Map<string, number>();
  for (const tool of props.tools) counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
  return counts;
});

/**
 * A list of recently opened slugs is a preference, not content, so it is one
 * of the few things localStorage is allowed to hold (rule 4). Every read is
 * guarded: storage can be disabled, full, or hold something another version
 * wrote, and none of those may take the palette down with them.
 */
function readRecent(): string[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(RECENT_TOOLS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/** Move `slug` to the front of the recent list, in memory and in storage. */
function remember(slug: string): void {
  const next = rememberRecent(readRecent(), slug);
  recent.value = next;
  try {
    localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full: the in-memory list still ranks this session.
  }
}

function toolView(tool: PaletteTool): Omit<RowView, "index"> {
  return {
    row: { kind: "tool", tool },
    href: `/${tool.slug}`,
    icon: tool.icon,
    title: tool.name,
    description: tool.description,
    badge: tool.category,
  };
}

function categoryView(category: ToolCategory): Omit<RowView, "index"> {
  return {
    row: { kind: "category", category },
    href: categoryPath(category),
    icon: category.icon,
    title: category.label,
    description: category.description,
    badge: "Category",
  };
}

/**
 * Sections drive rendering, the flat list drives the keyboard and the preview.
 * They are built together so an index can never drift between the two.
 */
const model = computed<{ sections: Section[]; flat: Row[] }>(() => {
  const flat: Row[] = [];
  const sections: Section[] = [];

  function push(
    key: string,
    heading: string | null,
    icon: string | undefined,
    rows: Omit<RowView, "index">[],
  ): void {
    if (rows.length === 0) return;
    const items = rows.map((view) => {
      const index = flat.length;
      flat.push(view.row);
      return { ...view, index };
    });
    sections.push({ key, heading, icon, items });
  }

  if (query.value.trim()) {
    const results = searchAll(props.tools, CATEGORIES, query.value, { recent: recent.value });
    push(
      "results",
      null,
      undefined,
      results.map((result) =>
        result.kind === "tool" ? toolView(result.tool) : categoryView(result.category),
      ),
    );
    return { sections, flat };
  }

  const recentTools: Omit<RowView, "index">[] = [];
  for (const slug of recent.value) {
    const tool = bySlug.value.get(slug);
    if (tool) recentTools.push(toolView(tool));
  }
  push("recent", "Recent", undefined, recentTools);
  push("categories", "Categories", undefined, CATEGORIES.map(categoryView));

  const groups = new Map<string, PaletteTool[]>();
  for (const tool of props.tools) {
    const list = groups.get(tool.category);
    if (list) list.push(tool);
    else groups.set(tool.category, [tool]);
  }
  // Display order comes from categories.ts, not the alphabet. The label
  // tie-break only matters for a label the registry does not know, which
  // registry.test forbids but which should still render in a stable order.
  const ordered = [...groups.entries()].sort(
    (a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]),
  );
  for (const [label, list] of ordered) {
    push(
      `group:${label}`,
      label,
      categoryByLabel(label)?.icon,
      [...list].sort((a, b) => a.name.localeCompare(b.name)).map(toolView),
    );
  }

  return { sections, flat };
});

const sections = computed(() => model.value.sections);
const flat = computed(() => model.value.flat);

/**
 * The right pane, resolved for the highlighted row only: 210 rows render, one
 * preview does. A category previews its own copy plus how many tools it holds.
 */
const preview = computed<PreviewView | null>(() => {
  const row = flat.value[activeIndex.value];
  if (!row) return null;
  if (row.kind === "category") {
    const count = countByCategory.value.get(row.category.label) ?? 0;
    return {
      icon: row.category.icon,
      title: row.category.label,
      description: row.category.description,
      chipLabel: count === 1 ? "1 tool" : `${count} tools`,
    };
  }
  return {
    icon: row.tool.icon,
    title: row.tool.name,
    description: row.tool.description,
    chipIcon: categoryByLabel(row.tool.category)?.icon,
    chipLabel: row.tool.category,
  };
});

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (open.value) open.value = false;
    else void openPalette();
  }
}

function move(delta: number): void {
  const count = flat.value.length;
  if (!count) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    move(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    move(-1);
  } else if (e.key === "Enter") {
    if (flat.value.length) {
      e.preventDefault();
      itemEls.value[activeIndex.value]?.click();
    }
  } else if (e.key === "Escape" && query.value !== "") {
    // First Escape clears the query, a second one closes. reka-ui listens for
    // Escape on the window in the bubble phase, so stopping the event here is
    // what keeps the dialog open; preventDefault covers the layer regardless.
    e.preventDefault();
    e.stopPropagation();
    query.value = "";
  }
}

// Arrow keys scroll the list under a stationary cursor, and the browser fires
// mousemove for that. Without the coordinate check the pointer would yank the
// selection back to whatever row slid beneath it on every keypress.
let pointerX = -1;
let pointerY = -1;

function onRowPointer(e: MouseEvent, index: number): void {
  if (e.clientX === pointerX && e.clientY === pointerY) return;
  pointerX = e.clientX;
  pointerY = e.clientY;
  activeIndex.value = index;
}

/** Opening a tool from the palette counts as using it. */
function onSelect(row: Row): void {
  if (row.kind === "tool") remember(row.tool.slug);
}

async function openPalette(): Promise<void> {
  open.value = true;
  await nextTick();
  inputEl.value?.focus();
}

function onOpenRequest(): void {
  void openPalette();
}

/**
 * Recent has to reflect real usage, not just palette picks, so every tool page
 * load records itself. The island is client:idle and remounts on each view
 * transition, hence both the mount call and the astro:page-load listener.
 */
function recordVisit(): void {
  const match = /^\/([^/]+)\/?$/.exec(window.location.pathname);
  const slug = match?.[1];
  if (slug && bySlug.value.has(slug)) remember(slug);
  else recent.value = readRecent();
}

// Reset selection whenever the visible list changes, and drop refs to any rows
// that just unmounted so Enter/scroll can never touch a detached anchor.
watch(flat, (list) => {
  activeIndex.value = 0;
  itemEls.value.length = list.length;
});

// Keep the active row in view.
watch(activeIndex, async (i) => {
  await nextTick();
  itemEls.value[i]?.scrollIntoView({ block: "nearest" });
});

// Fresh palette every open: clear query, re-read recents, focus the input.
watch(open, async (isOpen) => {
  if (!isOpen) return;
  query.value = "";
  activeIndex.value = 0;
  recent.value = readRecent();
  await nextTick();
  inputEl.value?.focus();
});

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  document.addEventListener("tools:open-palette", onOpenRequest);
  document.addEventListener("astro:page-load", recordVisit);
  recordVisit();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("tools:open-palette", onOpenRequest);
  document.removeEventListener("astro:page-load", recordVisit);
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="cmd-palette top-[15%] w-full max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:top-[8%] sm:max-w-3xl"
      :show-close-button="false"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>Search tools</DialogTitle>
        <DialogDescription>Jump to any tool or category</DialogDescription>
      </DialogHeader>

      <div class="border-b border-border px-3">
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          placeholder="Type a tool name, keyword, or category"
          aria-label="Search tools"
          autocomplete="off"
          spellcheck="false"
          class="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          @keydown="onInputKeydown"
        />
      </div>

      <div class="flex max-h-[min(60vh,24rem)] min-h-0 sm:h-[min(75vh,40rem)] sm:max-h-none">
        <div class="w-full min-w-0 overflow-y-auto p-1 sm:w-[55%]">
          <p v-if="flat.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing matches "{{ query }}".
          </p>

          <div v-for="section in sections" :key="section.key" class="pt-2 first:pt-0">
            <p
              v-if="section.heading"
              class="flex items-center gap-1.5 px-2 pb-1 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >
              <component
                :is="iconFor(section.icon)"
                v-if="section.icon"
                class="size-3.5"
                :stroke-width="2"
                aria-hidden="true"
              />
              {{ section.heading }}
            </p>
            <a
              v-for="view in section.items"
              :key="view.index"
              :ref="
                (el) => {
                  if (el) itemEls[view.index] = el as HTMLAnchorElement;
                }
              "
              :href="view.href"
              :data-active="view.index === activeIndex ? 'true' : undefined"
              class="cmd-row flex items-center gap-2 rounded-md px-2 py-2 text-sm"
              @mousemove="onRowPointer($event, view.index)"
              @click="onSelect(view.row)"
            >
              <component
                :is="iconFor(view.icon)"
                class="size-4 shrink-0 text-muted-foreground"
                :stroke-width="2"
                aria-hidden="true"
              />
              <!-- eslint-disable vue/no-v-html -- highlightHtml escapes its input, so the marked-up output is safe -->
              <span class="shrink-0 font-medium" v-html="highlightHtml(view.title, query)" />
              <span
                class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                v-html="highlightHtml(view.description, query)"
              />
              <!-- eslint-enable vue/no-v-html -->
              <span
                class="cmd-badge hidden shrink-0 rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground md:inline-block"
              >
                {{ view.badge }}
              </span>
            </a>
          </div>
        </div>

        <aside class="hidden min-w-0 flex-col border-l border-border sm:flex sm:w-[45%]">
          <div v-if="preview" class="min-h-0 flex-1 overflow-y-auto p-5">
            <span
              class="cmd-tile grid size-10 place-items-center rounded-[12px]"
              aria-hidden="true"
            >
              <component :is="iconFor(preview.icon)" class="size-5" :stroke-width="2" />
            </span>
            <p class="mt-3 text-base font-semibold tracking-tight">{{ preview.title }}</p>
            <p class="mt-2 text-sm text-muted-foreground">{{ preview.description }}</p>
            <span
              class="mt-3 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              <component
                :is="iconFor(preview.chipIcon)"
                v-if="preview.chipIcon"
                class="size-3"
                :stroke-width="2"
                aria-hidden="true"
              />
              {{ preview.chipLabel }}
            </span>
          </div>
          <p v-else class="min-h-0 flex-1 p-5 text-sm text-muted-foreground">
            Search {{ tools.length }} tools by name, keyword, or category.
          </p>
          <p
            class="flex items-center gap-1.5 border-t border-border px-5 py-3 text-xs text-muted-foreground"
          >
            <kbd>Enter</kbd>
            <span>to open,</span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            <span>to move</span>
          </p>
        </aside>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.cmd-row {
  color: var(--foreground);
  transition:
    background-color 120ms ease-out,
    color 120ms ease-out;
}

.cmd-row[data-active="true"] {
  background: var(--accent-soft);
  color: var(--primary);
}

.cmd-row[data-active="true"] .text-muted-foreground {
  color: color-mix(in oklab, var(--primary) 72%, var(--muted-foreground));
}

.cmd-row[data-active="true"] .cmd-badge {
  border-color: color-mix(in oklab, var(--primary) 40%, var(--border));
}

/* Same icon tile as a homepage card, so the preview reads as the card you are
   about to open rather than as a second, unrelated style. */
.cmd-tile {
  background: var(--accent-soft);
  color: var(--primary);
}

.cmd-palette :deep(mark) {
  background: transparent;
  color: var(--primary);
  font-weight: 600;
}

.cmd-row[data-active="true"] :deep(mark) {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .cmd-row {
    transition: none;
  }
}
</style>
