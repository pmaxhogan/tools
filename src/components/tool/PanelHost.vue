<script setup lang="ts">
import { defineAsyncComponent, type Component } from 'vue';
import type { ToolMeta } from '@/tools/types';
import ToolShell from './ToolShell.vue';

/**
 * Picks the tool's UI surface: a bespoke panel when one exists, else the
 * generic ToolShell. Panels are async components so each one stays in its
 * own chunk, loaded only on its page (rule 14).
 */
const panels: Record<string, Component> = {
  keycode: defineAsyncComponent(() => import('./panels/KeycodePanel.vue')),
  'qr-code-generator': defineAsyncComponent(() => import('./panels/QrPanel.vue')),
  'unicode-picker': defineAsyncComponent(() => import('./panels/UnicodePanel.vue')),
};

const props = defineProps<{ meta: ToolMeta }>();
const panel = panels[props.meta.slug] ?? ToolShell;
</script>

<template>
  <component
    :is="panel"
    :meta="meta"
  />
</template>
