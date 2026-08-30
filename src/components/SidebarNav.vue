<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { History, Star } from "lucide-vue-next";
import { highlightHtml, searchTools, type SearchTool } from "@/lib/search";
import { iconFor } from "@/lib/tool-icons";
import { FAVORITES_KEY } from "@/lib/favorites";
import { onPrefsChange, readList } from "@/lib/prefs";
import { RECENT_TOOLS_KEY } from "@/lib/recent-tools";
import {
  CATEGORIES,
  categoryByLabel,
  categoryPath,
  categoryRank,
  type ToolCategory,
} from "@/tools/categories";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  parseSidebarWidth,
  sidebarWidthCss,
  sidebarWidthFromPx,
  stepSidebarWidth,
} from "@/lib/sidebar-width";

/**
 * Interactive island for the sidebar: live search over the tool list with
 * arrow-key navigation and Enter to open, on top of the full categorized list.
 * Persisted across Astro view transitions, so it tracks the active route from
 * `astro:after-swap` rather than trusting the build-time `currentSlug`.
 *
 * Because it is the one part of the sidebar that survives a swap, it also owns
 * the two behaviors that need continuity across navigations: the aside's scroll
 * position, and the width drag handle that Sidebar.astro renders next to it.
 */
export type SidebarTool = SearchTool & { icon?: string };

const props = defineProps<{ tools: SidebarTool[]; currentSlug: string }>();

const query = ref("");
const activeIndex = ref(-1);
const currentPath = ref(props.currentSlug);
const inputEl = ref<HTMLInputElement | null>(null);
const itemEls = ref<HTMLAnchorElement[]>([]);

/** One rendered block: an optional heading, an optional category, its tools. */
interface Section {
  key: string;
  label: string | null;
  category: ToolCategory | null;
  items: SidebarTool[];
  /**
   * A Pinned or Recent shortcut block. These repeat tools that also appear
   * further down, so they never carry `aria-current`: the page marker belongs
   * on the one row that sits in the categorized list.
   */
  shortcut?: boolean;
  /** Heading icon for a block that names no category. */
  lead?: Component;
}

const byName = (a: SidebarTool, b: SidebarTool) => a.name.localeCompare(b.name);

/* ------------------------------------------------------- pinned and recent */

/**
 * The two preference lists (rule 7: slugs are a preference, not content). Read
 * on mount and kept in step with the other surfaces through `prefs-change`, so
 * starring a tool on its page adds it to this list without a reload.
 */
const favorites = ref<string[]>([]);
const recents = ref<string[]>([]);
const stops: Array<() => void> = [];

/** How many tools the sidebar's Recent block shows. The stored list is longer. */
const RECENT_GROUP_MAX = 5;

const bySlug = computed(() => {
  const map = new Map<string, SidebarTool>();
  for (const tool of props.tools) if (!map.has(tool.slug)) map.set(tool.slug, tool);
  return map;
});

/** The tools named by a slug list, in list order, skipping ones we do not have. */
function resolve(slugs: readonly string[], max = Number.POSITIVE_INFINITY): SidebarTool[] {
  const out: SidebarTool[] = [];
  for (const slug of slugs) {
    const tool = bySlug.value.get(slug);
    if (tool) out.push(tool);
    if (out.length >= max) break;
  }
  return out;
}

function refreshFavorites(): void {
  favorites.value = readList(FAVORITES_KEY);
}

function refreshRecents(): void {
  recents.value = readList(RECENT_TOOLS_KEY);
}

/**
 * The single category a query names, if any. The whole trimmed query is matched
 * against each category label and slug: an exact hit wins, then a prefix, then
 * a substring, with shorter labels and the canonical display order breaking
 * ties. Two characters are enough to prefix-match and three to substring-match,
 * so a single letter never collapses the list onto one category.
 */
function matchedCategory(raw: string): ToolCategory | null {
  const needle = raw.trim().toLowerCase();
  if (needle.length < 2) return null;
  let best: { category: ToolCategory; tier: number } | null = null;
  for (const category of CATEGORIES) {
    const label = category.label.toLowerCase();
    const slug = category.slug.toLowerCase();
    let tier = 0;
    if (label === needle || slug === needle) tier = 3;
    else if (label.startsWith(needle) || slug.startsWith(needle)) tier = 2;
    else if (needle.length >= 3 && (label.includes(needle) || slug.includes(needle))) tier = 1;
    if (tier === 0) continue;
    const better =
      !best ||
      tier > best.tier ||
      (tier === best.tier && label.length < best.category.label.length);
    if (better) best = { category, tier };
  }
  return best?.category ?? null;
}

const sections = computed<Section[]>(() => {
  const q = query.value.trim();

  // No query: every tool, grouped in the canonical category order.
  if (!q) {
    const groups = new Map<string, SidebarTool[]>();
    for (const tool of props.tools) {
      const list = groups.get(tool.category);
      if (list) list.push(tool);
      else groups.set(tool.category, [tool]);
    }
    const all: Section[] = [...groups.entries()]
      .sort(([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
      .map(([label, items]) => ({
        key: label,
        label,
        category: categoryByLabel(label) ?? null,
        items: [...items].sort(byName),
      }));

    // Shortcuts ride above the categorized list, and only with an empty search
    // box: once someone is searching, the results are what the list is for.
    const recent = resolve(recents.value, RECENT_GROUP_MAX);
    if (recent.length) {
      all.unshift({
        key: "recent",
        label: "Recent",
        category: null,
        items: recent,
        shortcut: true,
        lead: History,
      });
    }
    const pinned = resolve(favorites.value);
    if (pinned.length) {
      all.unshift({
        key: "pinned",
        label: "Pinned",
        category: null,
        items: pinned,
        shortcut: true,
        lead: Star,
      });
    }
    return all;
  }

  const matches = searchTools(props.tools, q).map((result) => result.tool);
  const flat: Section[] = matches.length
    ? [{ key: "results", label: null, category: null, items: matches }]
    : [];

  // Typing a category name collapses the list onto that category: the whole
  // category first, then whatever else the query matched by name.
  const category = matchedCategory(q);
  if (!category) return flat;
  const inCategory = props.tools.filter((tool) => tool.category === category.label).sort(byName);
  if (inCategory.length === 0) return flat;

  const seen = new Set(inCategory.map((tool) => tool.slug));
  const rest = matches.filter((tool) => !seen.has(tool.slug));
  const out: Section[] = [
    { key: `category:${category.slug}`, label: category.label, category, items: inCategory },
  ];
  if (rest.length) out.push({ key: "more", label: "More matches", category: null, items: rest });
  return out;
});

/** Where a category header links, for the sections that name a category. */
function categoryHref(category: ToolCategory | null): string | undefined {
  return category ? categoryPath(category) : undefined;
}

/** Every rendered tool, in rendered order: the arrow-key sequence. */
const ordered = computed(() => sections.value.flatMap((section) => section.items));

/** The sections again, with each tool carrying its index in `ordered`. */
const rendered = computed(() => {
  let index = 0;
  return sections.value.map((section) => ({
    ...section,
    items: section.items.map((tool) => ({ tool, index: index++ })),
  }));
});

/**
 * True only for the arrow keys. Hovering a row sets `activeIndex` too, and
 * scrolling the list under the pointer would make it creep away as the reader
 * moves the mouse across a row that the sticky search box half covers.
 */
let keyNav = false;

function onKeydown(e: KeyboardEvent) {
  const count = ordered.value.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (count) {
      keyNav = true;
      activeIndex.value = activeIndex.value < 0 ? 0 : (activeIndex.value + 1) % count;
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (count) {
      keyNav = true;
      activeIndex.value = activeIndex.value <= 0 ? count - 1 : activeIndex.value - 1;
    }
  } else if (e.key === "Enter") {
    if (count && activeIndex.value >= 0) {
      e.preventDefault();
      itemEls.value[activeIndex.value]?.click();
    }
  } else if (e.key === "Escape" && query.value) {
    // Clear the search first; let a second Escape reach the drawer handler.
    e.stopPropagation();
    query.value = "";
  }
}

/** Hover arms a row for Enter, but never scrolls the list under the pointer. */
function onHover(index: number) {
  keyNav = false;
  activeIndex.value = index;
}

watch(query, (q) => {
  activeIndex.value = q.trim() ? 0 : -1;
  // Drop refs to rows that unmounted on this query change.
  itemEls.value.length = ordered.value.length;
  // A new result set reads from the top. Clearing the search puts the reader
  // back on the tool they are looking at, where the list was before they typed.
  const aside = sidebarEl();
  if (!aside) return;
  if (q.trim()) aside.scrollTop = 0;
  else nextTick(settleActive);
});

watch(activeIndex, async (i) => {
  if (i < 0 || !keyNav) return;
  keyNav = false;
  await nextTick();
  const row = itemEls.value[i];
  if (row) scrollIntoSidebar(row);
});

/* ---------------------------------------------------------------- scrolling */

/** The sidebar's own scroll box, or null when it is not on screen. */
function sidebarEl(): HTMLElement | null {
  const aside = document.getElementById("site-sidebar");
  // Hidden at xl (`sb-closed`) means display:none, so it has no scroll box and
  // writing scrollTop would silently do nothing. The closed drawer below xl is
  // only `visibility: hidden`, so it still measures and still scrolls.
  return aside && aside.clientHeight > 0 ? aside : null;
}

/** How much of the top of the scroll box the sticky header and search cover. */
function stickyCover(aside: HTMLElement): number {
  const header = document.getElementById("sidebar-header");
  const dock = aside.querySelector<HTMLElement>(".sidebar-search-dock");
  return (header?.offsetHeight ?? 0) + (dock?.offsetHeight ?? 0);
}

/** Where `el` starts, in the sidebar's scroll coordinates. */
function offsetInSidebar(aside: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - aside.getBoundingClientRect().top + aside.scrollTop;
}

/**
 * Scroll the sidebar (never the page) the minimum amount needed to show `el`
 * clear of the sticky header and search box. A row that is already visible
 * leaves the scroll position exactly where it was.
 */
function scrollIntoSidebar(el: HTMLElement) {
  const aside = sidebarEl();
  if (!aside) return;
  const gap = 8;
  const top = offsetInSidebar(aside, el);
  const bottom = top + el.offsetHeight;
  const viewTop = aside.scrollTop + stickyCover(aside) + gap;
  const viewBottom = aside.scrollTop + aside.clientHeight - gap;
  if (top < viewTop) aside.scrollTop = Math.max(0, aside.scrollTop - (viewTop - top));
  else if (bottom > viewBottom) aside.scrollTop += bottom - viewBottom;
}

/** The link for the page being viewed, if the sidebar is showing it. */
function activeLink(aside: HTMLElement): HTMLElement | null {
  return aside.querySelector<HTMLElement>('[aria-current="page"]');
}

/** First load: park the active tool near the top rather than merely in view. */
function settleActive() {
  const aside = sidebarEl();
  const active = aside && activeLink(aside);
  if (!aside || !active) return;
  aside.scrollTop = Math.max(0, offsetInSidebar(aside, active) - stickyCover(aside) - 24);
}

/**
 * The aside is rebuilt by every view-transition swap, so its scrollTop resets
 * to 0. Save it before the swap and put it back after, before paint. The saved
 * value is kept when the sidebar is off screen, so closing it, navigating and
 * reopening still lands where the reader left off.
 */
let savedScroll = 0;

function saveScroll() {
  const aside = sidebarEl();
  if (aside) savedScroll = aside.scrollTop;
}

function restoreScroll() {
  const aside = sidebarEl();
  if (aside) aside.scrollTop = savedScroll;
}

function onAfterSwap() {
  currentPath.value = window.location.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  // A navigation is the one moment the recent list is most likely to have moved.
  refreshRecents();
  refreshFavorites();
  restoreScroll();
  // The handle is server rendered fresh on every swap, so its value resets.
  applyWidth(widthRem);
  nextTick(() => {
    const aside = sidebarEl();
    const active = aside && activeLink(aside);
    if (active) scrollIntoSidebar(active);
  });
}

/* ------------------------------------------------------------------- resize */

/**
 * Width drag handle (xl and up). Sidebar.astro renders `#sidebar-resize`; the
 * behavior lives here because this island survives navigations, so the
 * listeners bind once, and because it can import the tested width helpers.
 * Listeners are delegated from `document` since the handle element itself is
 * replaced on every swap.
 */
let widthRem = SIDEBAR_WIDTH_DEFAULT;
let grabOffsetPx = 0;
let rootFontPx = 16;

function fromHandle(e: Event): boolean {
  return e.target instanceof Element && !!e.target.closest("#sidebar-resize");
}

function readStoredWidth(): number {
  try {
    return parseSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY)) ?? SIDEBAR_WIDTH_DEFAULT;
  } catch {
    // Storage can be unavailable (private modes, blocked cookies). Not fatal.
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function storeWidth() {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthRem));
  } catch {
    // A preference that cannot be saved is not worth breaking the page over.
  }
}

/** Push a width to the CSS variable the layout reads and to the handle's ARIA. */
function applyWidth(rem: number) {
  widthRem = clampSidebarWidth(rem);
  document.documentElement.style.setProperty("--sidebar-w", sidebarWidthCss(widthRem));
  document.getElementById("sidebar-resize")?.setAttribute("aria-valuenow", String(widthRem));
}

function onHandlePointerDown(e: PointerEvent) {
  if (e.button !== 0 || !fromHandle(e)) return;
  const aside = sidebarEl();
  if (!aside) return;
  const rect = aside.getBoundingClientRect();
  rootFontPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  // Keep the grab point under the pointer so the column does not jump.
  grabOffsetPx = rect.right - e.clientX;
  document.documentElement.classList.add("sb-resizing");
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  document.addEventListener("pointermove", onHandlePointerMove);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
}

function onHandlePointerMove(e: PointerEvent) {
  const aside = sidebarEl();
  if (!aside) return;
  const left = aside.getBoundingClientRect().left;
  applyWidth(sidebarWidthFromPx(e.clientX + grabOffsetPx - left, rootFontPx));
}

/** Teardown for both a finished drag and a canceled one. Safe to run twice. */
function endDrag() {
  document.removeEventListener("pointermove", onHandlePointerMove);
  document.removeEventListener("pointerup", endDrag);
  document.removeEventListener("pointercancel", endDrag);
  if (!document.documentElement.classList.contains("sb-resizing")) return;
  document.documentElement.classList.remove("sb-resizing");
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  storeWidth();
}

function onHandleKeydown(e: KeyboardEvent) {
  if (!fromHandle(e)) return;
  let next: number | null = null;
  if (e.key === "ArrowLeft") next = stepSidebarWidth(widthRem, -1);
  else if (e.key === "ArrowRight") next = stepSidebarWidth(widthRem, 1);
  else if (e.key === "Home") next = SIDEBAR_WIDTH_MIN;
  else if (e.key === "End") next = SIDEBAR_WIDTH_MAX;
  if (next === null) return;
  e.preventDefault();
  applyWidth(next);
  storeWidth();
}

function onHandleDoubleClick(e: MouseEvent) {
  if (!fromHandle(e)) return;
  applyWidth(SIDEBAR_WIDTH_DEFAULT);
  storeWidth();
}

/* ---------------------------------------------------------------- lifecycle */

onMounted(() => {
  document.addEventListener("astro:before-swap", saveScroll);
  document.addEventListener("astro:after-swap", onAfterSwap);
  document.addEventListener("pointerdown", onHandlePointerDown);
  document.addEventListener("keydown", onHandleKeydown);
  document.addEventListener("dblclick", onHandleDoubleClick);
  applyWidth(readStoredWidth());
  refreshFavorites();
  refreshRecents();
  stops.push(onPrefsChange(FAVORITES_KEY, refreshFavorites));
  stops.push(onPrefsChange(RECENT_TOOLS_KEY, refreshRecents));
  nextTick(settleActive);
});

onUnmounted(() => {
  endDrag();
  for (const stop of stops.splice(0)) stop();
  document.removeEventListener("astro:before-swap", saveScroll);
  document.removeEventListener("astro:after-swap", onAfterSwap);
  document.removeEventListener("pointerdown", onHandlePointerDown);
  document.removeEventListener("keydown", onHandleKeydown);
  document.removeEventListener("dblclick", onHandleDoubleClick);
});
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <div class="sidebar-search-dock px-2 pt-3 pb-2">
      <input
        ref="inputEl"
        v-model="query"
        type="search"
        placeholder="Search tools…"
        aria-label="Search tools"
        autocomplete="off"
        spellcheck="false"
        class="sidebar-search h-9 w-full rounded-[10px] border border-input bg-secondary px-3 text-sm outline-none placeholder:text-muted-foreground"
        @keydown="onKeydown"
      />
    </div>

    <nav class="px-2 pt-1 pb-8">
      <p v-if="ordered.length === 0" class="px-2 py-4 text-sm text-muted-foreground">
        No tools match "{{ query }}".
      </p>

      <div v-for="section in rendered" :key="section.key" class="mt-5 first:mt-0">
        <h3
          v-if="section.label"
          class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          <a
            v-if="section.category"
            :href="categoryHref(section.category)"
            class="sidebar-category flex items-center gap-2 rounded-md px-2 py-1"
          >
            <component
              :is="iconFor(section.category?.icon)"
              class="size-4 shrink-0"
              :stroke-width="2"
              aria-hidden="true"
            />
            <span class="min-w-0 truncate">{{ section.label }}</span>
          </a>
          <span v-else class="flex items-center gap-2 px-2 py-1">
            <component
              :is="section.lead"
              v-if="section.lead"
              class="size-4 shrink-0"
              :stroke-width="2"
              aria-hidden="true"
            />
            <span class="min-w-0 truncate">{{ section.label }}</span>
          </span>
        </h3>
        <ul :class="section.label ? 'mt-1' : ''">
          <li v-for="entry in section.items" :key="entry.tool.slug">
            <a
              :ref="
                (el) => {
                  if (el) itemEls[entry.index] = el as HTMLAnchorElement;
                }
              "
              :href="`/${entry.tool.slug}`"
              :aria-current="
                !section.shortcut && entry.tool.slug === currentPath ? 'page' : undefined
              "
              :data-active="entry.index === activeIndex ? 'true' : undefined"
              class="sidebar-link flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
              @mousemove="onHover(entry.index)"
            >
              <component
                :is="iconFor(entry.tool.icon)"
                class="size-4 shrink-0 opacity-70"
                :stroke-width="2"
                aria-hidden="true"
              />
              <!-- eslint-disable-next-line vue/no-v-html, vue/max-attributes-per-line -- highlightHtml escapes its input -->
              <span class="min-w-0 truncate" v-html="highlightHtml(entry.tool.name, query)" />
            </a>
          </li>
        </ul>
      </div>
    </nav>
  </div>
</template>

<style scoped>
/* The search box rides under the sidebar header (which pins its own height in
   Sidebar.astro) so the list scrolls under it cleanly instead of taking it
   away. Card fill plus a hairline in both themes, so nothing shows through. */
.sidebar-search-dock {
  position: sticky;
  top: var(--sidebar-header-h, 3.375rem);
  z-index: 9;
  background: var(--card);
  border-bottom: 1px solid var(--border);
}

.sidebar-category {
  color: var(--muted-foreground);
  transition:
    background-color 120ms ease-out,
    color 120ms ease-out;
}

.sidebar-category:hover {
  background: var(--accent);
  color: var(--foreground);
}

.sidebar-search:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
  box-shadow: 0 0 0 6px var(--accent-soft);
}

.sidebar-link {
  color: var(--muted-foreground);
  transition:
    background-color 120ms ease-out,
    color 120ms ease-out;
}

.sidebar-link:hover {
  background: var(--accent);
  color: var(--foreground);
}

.sidebar-link[aria-current="page"] {
  background: var(--accent-soft);
  color: var(--primary);
  font-weight: 500;
}

.sidebar-link[data-active="true"] {
  background: var(--accent-soft);
  color: var(--primary);
}

.sidebar-link :deep(mark) {
  background: transparent;
  color: var(--primary);
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-link,
  .sidebar-category {
    transition: none;
  }
}
</style>
