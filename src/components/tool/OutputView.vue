<script setup lang="ts">
import { computed } from "vue";
import CopyButton from "./CopyButton.vue";
import KeyValueGrid from "./KeyValueGrid.vue";
import { recordToRows, rowsToText } from "@/lib/key-value";

/**
 * Renders tool output. Supports:
 *  - string: single mono block with one copy button
 *  - Record<string, string>: a responsive labeled grid, each row with its own
 *    copy button, sitting under one copy everything button
 *
 * The record branch used to be a single tall stack, which wasted most of a wide
 * screen on tools that report a dozen short facts. KeyValueGrid owns that
 * layout now, including the rule for when a value is too long to share a row.
 */
const props = defineProps<{ output: string | Record<string, string> }>();

const isRecord = computed(() => typeof props.output !== "string");
const rows = computed(() => (typeof props.output === "string" ? [] : recordToRows(props.output)));
const all = computed(() =>
  typeof props.output === "string" ? props.output : rowsToText(rows.value),
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

    <KeyValueGrid v-if="isRecord" :rows="rows" />

    <pre
      v-else
      class="max-h-96 overflow-auto px-3 py-2 font-mono text-sm whitespace-pre-wrap break-all"
      >{{ output }}</pre>
  </div>
</template>
