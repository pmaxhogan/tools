<script setup lang="ts">
import { computed, ref } from "vue";
import { Input } from "@/components/ui/input";
import { highlightHtml, searchTools, type SearchTool } from "@/lib/search";
import { iconFor } from "@/lib/tool-icons";

/**
 * Homepage tool grid: search + category-grouped cards. Server-rendered at
 * build (full list in the HTML for SEO), hydrates for filtering.
 */
export type GridTool = SearchTool & { icon?: string };

const props = defineProps<{ tools: GridTool[] }>();
const query = ref("");

const filtered = computed(() => searchTools(props.tools, query.value).map((r) => r.tool));

const grouped = computed(() => {
  const map = new Map<string, GridTool[]>();
  for (const t of filtered.value) {
    const list = map.get(t.category) ?? [];
    list.push(t);
    map.set(t.category, list);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
});
</script>

<template>
  <div>
    <div class="relative mx-auto max-w-2xl">
      <Input
        v-model="query"
        type="search"
        placeholder="Search tools…"
        aria-label="Search tools"
        class="h-11 bg-card pr-16 shadow-[var(--sh-sm)]"
      />
      <kbd class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2">Ctrl K</kbd>
    </div>

    <p v-if="filtered.length === 0" class="mt-10 text-center text-muted-foreground">
      No tools match "{{ query }}" yet. Try a different word, or check the full list on GitHub.
    </p>

    <section v-for="[category, items] in grouped" :key="category" class="mt-10">
      <h2 class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {{ category }}
      </h2>
      <ul class="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="t in items" :key="t.slug">
          <a
            :href="`/${t.slug}`"
            class="tool-card flex h-full gap-3 rounded-[14px] border bg-card p-5 shadow-[var(--sh-sm)]"
          >
            <span
              class="tool-tile grid size-9 shrink-0 place-items-center rounded-[10px]"
              aria-hidden="true"
            >
              <component :is="iconFor(t.icon)" class="size-[18px]" :stroke-width="2" />
            </span>
            <span class="min-w-0">
              <!-- eslint-disable vue/no-v-html -- highlightHtml escapes its input, so the marked-up output is safe -->
              <span class="block font-semibold" v-html="highlightHtml(t.name, query)" />
              <span
                class="mt-1 block text-sm text-muted-foreground"
                v-html="highlightHtml(t.description, query)"
              />
              <!-- eslint-enable vue/no-v-html -->
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
