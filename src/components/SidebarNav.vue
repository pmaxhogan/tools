<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { highlightHtml, searchTools, type SearchTool } from '@/lib/search';

/**
 * Interactive island for the sidebar: live search over the tool list with
 * arrow-key navigation and Enter to open, on top of the full categorized list.
 * Persisted across Astro view transitions, so it tracks the active route from
 * `astro:after-swap` rather than trusting the build-time `currentSlug`.
 */
export type SidebarTool = SearchTool;

const props = defineProps<{ tools: SidebarTool[]; currentSlug: string }>();

const query = ref('');
const activeIndex = ref(-1);
const currentPath = ref(props.currentSlug);
const inputEl = ref<HTMLInputElement | null>(null);
const itemEls = ref<HTMLAnchorElement[]>([]);

const ordered = computed(() => {
  const results = searchTools(props.tools, query.value);
  if (!query.value.trim()) {
    return [...results].sort(
      (a, b) =>
        a.tool.category.localeCompare(b.tool.category) ||
        a.tool.name.localeCompare(b.tool.name)
    );
  }
  return results;
});

const sections = computed(() => {
  const flat = ordered.value;
  if (query.value.trim()) {
    return [{ heading: null as string | null, items: flat.map((r, i) => ({ tool: r.tool, index: i })) }];
  }
  const out: { heading: string | null; items: { tool: SearchTool; index: number }[] }[] = [];
  flat.forEach((r, i) => {
    const last = out[out.length - 1];
    if (last && last.heading === r.tool.category) last.items.push({ tool: r.tool, index: i });
    else out.push({ heading: r.tool.category, items: [{ tool: r.tool, index: i }] });
  });
  return out;
});

function onKeydown(e: KeyboardEvent) {
  const count = ordered.value.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (count) activeIndex.value = activeIndex.value < 0 ? 0 : (activeIndex.value + 1) % count;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (count) activeIndex.value = activeIndex.value <= 0 ? count - 1 : activeIndex.value - 1;
  } else if (e.key === 'Enter') {
    if (count && activeIndex.value >= 0) {
      e.preventDefault();
      itemEls.value[activeIndex.value]?.click();
    }
  } else if (e.key === 'Escape' && query.value) {
    // Clear the search first; let a second Escape reach the drawer handler.
    e.stopPropagation();
    query.value = '';
  }
}

watch(query, (q) => {
  activeIndex.value = q.trim() ? 0 : -1;
  // Drop refs to rows that unmounted on this query change.
  itemEls.value.length = ordered.value.length;
});

watch(activeIndex, async (i) => {
  if (i < 0) return;
  await nextTick();
  itemEls.value[i]?.scrollIntoView({ block: 'nearest' });
});

/** Scroll the sidebar (not the page) so the active tool is visible. */
function revealActive() {
  const aside = document.getElementById('site-sidebar');
  const active = aside?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!aside || !active) return;
  const top = active.offsetTop - 96;
  aside.scrollTop = Math.max(0, top);
}

function syncPath() {
  currentPath.value = window.location.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  nextTick(revealActive);
}

onMounted(() => {
  document.addEventListener('astro:after-swap', syncPath);
  nextTick(revealActive);
});
onUnmounted(() => {
  document.removeEventListener('astro:after-swap', syncPath);
});
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <div class="px-2 pt-3 pb-2">
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
      >
    </div>

    <nav class="px-2 pt-1 pb-8">
      <p
        v-if="ordered.length === 0"
        class="px-2 py-4 text-sm text-muted-foreground"
      >
        No tools match "{{ query }}".
      </p>

      <div
        v-for="(section, si) in sections"
        :key="si"
        class="mt-5 first:mt-0"
      >
        <h3
          v-if="section.heading"
          class="px-2 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          {{ section.heading }}
        </h3>
        <ul :class="section.heading ? 'mt-1' : ''">
          <li
            v-for="entry in section.items"
            :key="entry.tool.slug"
          >
            <a
              :ref="(el) => { if (el) itemEls[entry.index] = el as HTMLAnchorElement; }"
              :href="`/${entry.tool.slug}`"
              :aria-current="entry.tool.slug === currentPath ? 'page' : undefined"
              :data-active="entry.index === activeIndex ? 'true' : undefined"
              class="sidebar-link block rounded-md px-2 py-1.5 text-sm"
              @mousemove="activeIndex = entry.index"
            >
              <!-- eslint-disable-next-line vue/no-v-html, vue/max-attributes-per-line -- highlightHtml escapes its input -->
              <span v-html="highlightHtml(entry.tool.name, query)" />
            </a>
          </li>
        </ul>
      </div>
    </nav>
  </div>
</template>

<style scoped>
.sidebar-search:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
  box-shadow: 0 0 0 6px var(--accent-soft);
}

.sidebar-link {
  color: var(--muted-foreground);
  transition: background-color 120ms ease-out, color 120ms ease-out;
}

.sidebar-link:hover {
  background: var(--accent);
  color: var(--foreground);
}

.sidebar-link[aria-current='page'] {
  background: var(--accent-soft);
  color: var(--primary);
  font-weight: 500;
}

.sidebar-link[data-active='true'] {
  background: var(--accent-soft);
  color: var(--primary);
}

.sidebar-link :deep(mark) {
  background: transparent;
  color: var(--primary);
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-link {
    transition: none;
  }
}
</style>
