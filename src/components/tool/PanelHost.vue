<script setup lang="ts">
import { defineAsyncComponent, type Component } from 'vue';
import type { ToolMeta } from '@/tools/types';
import ToolShell from './ToolShell.vue';
import CapabilityGate from './CapabilityGate.vue';
import PopoutButton from './PopoutButton.vue';

/**
 * Picks the tool's UI surface: a bespoke panel when one exists, else the
 * generic ToolShell. Panels are async components so each one stays in its
 * own chunk, loaded only on its page (rule 14). Tools that declare
 * `meta.requires` go through CapabilityGate first (rule 15). The wrapper
 * carries `data-popout-root` so PopoutButton can float the whole panel in a
 * Document Picture-in-Picture window.
 */
const panels: Record<string, Component> = {
  'clipboard-inspector': defineAsyncComponent(() => import('./panels/ClipboardPanel.vue')),
  'favicon-generator': defineAsyncComponent(() => import('./panels/FaviconPanel.vue')),
  'image-toolbox': defineAsyncComponent(() => import('./panels/ImageToolboxPanel.vue')),
  keycode: defineAsyncComponent(() => import('./panels/KeycodePanel.vue')),
  'qr-code-generator': defineAsyncComponent(() => import('./panels/QrPanel.vue')),
  'unicode-picker': defineAsyncComponent(() => import('./panels/UnicodePanel.vue')),
};

const props = defineProps<{ meta: ToolMeta }>();
const panel = panels[props.meta.slug] ?? ToolShell;
</script>

<template>
  <div class="mb-2 flex justify-end">
    <PopoutButton />
  </div>
  <div data-popout-root>
    <CapabilityGate
      v-if="meta.requires?.length"
      :requires="meta.requires"
    >
      <component
        :is="panel"
        :meta="meta"
      />
    </CapabilityGate>
    <component
      :is="panel"
      v-else
      :meta="meta"
    />
  </div>
</template>
