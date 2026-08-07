<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { highlightHtml, searchTools, type SearchTool } from '@/lib/search';

/** Ctrl+K palette over the tool registry. Mounted on every page. */
export type PaletteTool = SearchTool;

const props = defineProps<{ tools: PaletteTool[] }>();
const open = ref(false);
const query = ref('');
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const itemEls = ref<HTMLAnchorElement[]>([]);

/** Tools in display order: score order when searching, category+name when idle. */
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

/** Flat list drives arrow-key navigation; sections drive rendering. */
const sections = computed(() => {
  const flat = ordered.value;
  if (query.value.trim()) {
    return [
      { heading: null as string | null, items: flat.map((r, i) => ({ tool: r.tool, index: i })) },
    ];
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    open.value = !open.value;
  }
}

function onInputKeydown(e: KeyboardEvent) {
  const count = ordered.value.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (count) activeIndex.value = (activeIndex.value + 1) % count;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (count) activeIndex.value = (activeIndex.value - 1 + count) % count;
  } else if (e.key === 'Enter') {
    if (count) {
      e.preventDefault();
      itemEls.value[activeIndex.value]?.click();
    }
  }
}

// Reset selection whenever the visible list changes, and drop refs to any rows
// that just unmounted so Enter/scroll can never touch a detached anchor.
watch(ordered, (list) => {
  activeIndex.value = 0;
  itemEls.value.length = list.length;
});

// Keep the active row in view.
watch(activeIndex, async (i) => {
  await nextTick();
  itemEls.value[i]?.scrollIntoView({ block: 'nearest' });
});

// Fresh palette every open: clear query, focus the input.
watch(open, async (isOpen) => {
  if (!isOpen) return;
  query.value = '';
  activeIndex.value = 0;
  await nextTick();
  inputEl.value?.focus();
});

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="cmd-palette top-[15%] w-full max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      :show-close-button="false"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>Search tools</DialogTitle>
        <DialogDescription>Jump to any tool</DialogDescription>
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
        >
      </div>

      <div class="max-h-[min(60vh,24rem)] overflow-y-auto p-1">
        <p
          v-if="ordered.length === 0"
          class="px-3 py-6 text-center text-sm text-muted-foreground"
        >
          No tools match "{{ query }}".
        </p>

        <div
          v-for="(section, si) in sections"
          :key="si"
        >
          <p
            v-if="section.heading"
            class="px-2 pt-3 pb-1 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase first:pt-1"
          >
            {{ section.heading }}
          </p>
          <a
            v-for="entry in section.items"
            :key="entry.tool.slug"
            :ref="(el) => { if (el) itemEls[entry.index] = el as HTMLAnchorElement; }"
            :href="`/${entry.tool.slug}`"
            :data-active="entry.index === activeIndex ? 'true' : undefined"
            class="cmd-row flex items-center gap-2 rounded-md px-2 py-2 text-sm"
            @mousemove="activeIndex = entry.index"
          >
            <!-- eslint-disable-next-line vue/no-v-html, vue/max-attributes-per-line -- highlightHtml escapes its input -->
            <span class="shrink-0 font-medium" v-html="highlightHtml(entry.tool.name, query)" />
            <!-- eslint-disable-next-line vue/no-v-html, vue/max-attributes-per-line -- highlightHtml escapes its input -->
            <span class="truncate text-xs text-muted-foreground" v-html="highlightHtml(entry.tool.description, query)" />
          </a>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.cmd-row {
  color: var(--foreground);
  transition: background-color 120ms ease-out, color 120ms ease-out;
}

.cmd-row[data-active='true'] {
  background: var(--accent-soft);
  color: var(--primary);
}

.cmd-row[data-active='true'] .text-muted-foreground {
  color: color-mix(in oklab, var(--primary) 72%, var(--muted-foreground));
}

.cmd-palette :deep(mark) {
  background: transparent;
  color: var(--primary);
  font-weight: 600;
}

.cmd-row[data-active='true'] :deep(mark) {
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
