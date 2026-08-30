<script setup lang="ts">
/**
 * The one empty state. DESIGN.md asks that an empty area is designed, never
 * blank, so a panel with nothing to show yet renders this instead of a bare
 * paragraph.
 *
 * `icon` is a lucide export name resolved through src/lib/tool-icons.ts. That
 * map is curated: a name it does not carry falls back to the wrench, so add
 * the icon there first if it is missing.
 */
import { computed } from "vue";
import { iconFor } from "@/lib/tool-icons";

const props = withDefaults(
  defineProps<{
    /** One short line saying what is missing. */
    title: string;
    /** How to fill it. */
    hint?: string;
    /** Lucide export name, e.g. "FileSearch". */
    icon?: string;
  }>(),
  {
    hint: undefined,
    icon: undefined,
  },
);

const iconComponent = computed(() => (props.icon ? iconFor(props.icon) : null));
</script>

<template>
  <div
    class="flex flex-col items-center gap-2 rounded-[10px] bg-secondary px-4 py-8 text-center shadow-[var(--sh-inset)]"
  >
    <component
      :is="iconComponent"
      v-if="iconComponent"
      class="size-5 text-muted-foreground"
      aria-hidden="true"
    />
    <p class="text-sm font-medium">{{ title }}</p>
    <p v-if="hint" class="max-w-[52ch] text-sm text-muted-foreground">{{ hint }}</p>
    <div v-if="$slots.actions" class="mt-1 flex flex-wrap items-center justify-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
