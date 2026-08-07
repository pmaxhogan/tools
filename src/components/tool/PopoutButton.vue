<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { PictureInPicture2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { findPopoutRoot, isPopoutSupported, popOut, type PopoutHandle } from "@/lib/popout";

/**
 * Floats the tool panel in an always-on-top window (Document
 * Picture-in-Picture). Chromium only, so this renders nothing at all where the
 * API is missing: progressive enhancement, no dead control, no apology text.
 *
 * The panel it moves is the element carrying `data-popout-root`, the contract
 * documented in `src/lib/popout.ts`. PanelHost owns that attribute; this
 * component only needs to be somewhere on the same page.
 *
 * SSR: support is unknown at build time, so the button starts hidden and is
 * revealed in `onMounted`. The static build and the first client render agree,
 * which keeps hydration clean (same approach as CapabilityGate).
 *
 * Note the button keeps working after the panel moves. Component code always
 * runs in the opener's JavaScript realm, so "bring it back" goes through the
 * stored handle rather than a fresh query, which would not find a node that
 * now lives in the other document.
 */
const props = withDefaults(defineProps<{ width?: number; height?: number }>(), {
  width: 420,
  height: 560,
});

const supported = ref(false);
const handle = shallowRef<PopoutHandle | null>(null);

onMounted(() => {
  supported.value = isPopoutSupported();
});

// Leaving the page with the panel detached would strand it, so put it back.
onBeforeUnmount(() => handle.value?.close());

async function toggle() {
  if (handle.value) {
    handle.value.close();
    return;
  }
  const root = findPopoutRoot();
  if (!root) {
    console.warn("[popout] No [data-popout-root] element found on this page.");
    return;
  }
  handle.value = await popOut(root, {
    width: props.width,
    height: props.height,
    onClosed: () => {
      handle.value = null;
    },
  });
}
</script>

<template>
  <Button
    v-if="supported"
    variant="ghost"
    size="sm"
    :aria-pressed="handle !== null"
    title="Float this tool in a small always-on-top window"
    @click="toggle"
  >
    <PictureInPicture2 />
    {{ handle ? "Bring it back" : "Pop out" }}
  </Button>
</template>
