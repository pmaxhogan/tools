<script setup lang="ts">
import { computed, ref } from 'vue';
import { Input } from '@/components/ui/input';

/**
 * Homepage tool grid: search + category-grouped cards. Server-rendered at
 * build (full list in the HTML for SEO), hydrates for filtering.
 */
export interface GridTool {
  slug: string;
  name: string;
  description: string;
  category: string;
  keywords: string[];
}

const props = defineProps<{ tools: GridTool[] }>();
const query = ref('');

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.tools;
  return props.tools.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.keywords.some((k) => k.includes(q))
  );
});

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
            class="block h-full rounded-[14px] border bg-card p-5 shadow-[var(--sh-sm)] transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-[var(--sh-md)]"
          >
            <span class="font-semibold">{{ t.name }}</span>
            <span class="mt-1 block text-sm text-muted-foreground">{{ t.description }}</span>
          </a>
        </li>
      </ul>
    </section>
  </div>
</template>
