<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

/** Ctrl+K palette over the tool registry. Mounted on every page. */
export interface PaletteTool {
  slug: string;
  name: string;
  description: string;
  category: string;
  keywords: string[];
}

const props = defineProps<{ tools: PaletteTool[] }>();
const open = ref(false);

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    open.value = !open.value;
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const grouped = [...new Set(props.tools.map((t) => t.category))].sort().map((c) => ({
  category: c,
  items: props.tools.filter((t) => t.category === c),
}));

function go(slug: string) {
  window.location.href = `/${slug}`;
}
</script>

<template>
  <CommandDialog v-model:open="open" title="Search tools" description="Jump to any tool">
    <CommandInput placeholder="Type a tool name…" />
    <CommandList>
      <CommandEmpty>No matching tools.</CommandEmpty>
      <CommandGroup v-for="g in grouped" :key="g.category" :heading="g.category">
        <CommandItem
          v-for="t in g.items"
          :key="t.slug"
          :value="`${t.name} ${t.keywords.join(' ')}`"
          @select="go(t.slug)"
        >
          <span>{{ t.name }}</span>
          <span class="text-muted-foreground ml-2 truncate text-xs">{{ t.description }}</span>
        </CommandItem>
      </CommandGroup>
    </CommandList>
  </CommandDialog>
</template>
