<script setup lang="ts">
import { computed } from 'vue';
import CopyButton from './CopyButton.vue';

/**
 * Renders tool output. Supports:
 *  - string: single mono block with one copy button
 *  - Record<string, string>: labeled rows, each with its own copy button
 */
const props = defineProps<{ output: string | Record<string, string> }>();

const isRecord = computed(() => typeof props.output !== 'string');
const entries = computed(() =>
  typeof props.output === 'string' ? [] : Object.entries(props.output)
);
const all = computed(() =>
  typeof props.output === 'string'
    ? props.output
    : entries.value.map(([k, v]) => `${k}: ${v}`).join('\n')
);
</script>

<template>
  <div class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
    <div class="flex items-center justify-between px-3 pt-2">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >Output</span
      >
      <CopyButton :text="all" label="Copy" />
    </div>

    <div v-if="isRecord" class="divide-y divide-border/60">
      <div
        v-for="[k, v] in entries"
        :key="k"
        class="flex items-center justify-between gap-3 px-3 py-2"
      >
        <div class="min-w-0">
          <div class="text-xs text-muted-foreground">{{ k }}</div>
          <div class="truncate font-mono text-sm">{{ v }}</div>
        </div>
        <CopyButton :text="v" />
      </div>
    </div>

    <pre
      v-else
      class="max-h-96 overflow-auto px-3 py-2 font-mono text-sm whitespace-pre-wrap break-all"
      >{{ output }}</pre
    >
  </div>
</template>
