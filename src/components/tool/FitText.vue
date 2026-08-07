<script setup lang="ts">
/**
 * Auto-fitting text. Scales its font size up or down so the text fills the
 * parent box without overflowing, wrapping across lines as needed. Used by the
 * bingo cells, where item length varies wildly and a single fixed size either
 * clips long items or wastes space on short ones.
 *
 * It measures via the DOM (a ResizeObserver on the box plus a binary search on
 * font size), so it lives in the component layer, never the pure tool logic.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    text: string;
    /** Smallest font size in px before the text is simply allowed to clip. */
    min?: number;
    /** Largest font size in px; the text never grows past this. */
    max?: number;
  }>(),
  { min: 7, max: 20 },
);

const box = ref<HTMLElement | null>(null);
const inner = ref<HTMLElement | null>(null);
const fontSize = ref(props.max);

let observer: ResizeObserver | null = null;

/** True when `inner` at the given size fits inside `box` on both axes. */
function fits(size: number): boolean {
  const el = inner.value;
  const container = box.value;
  if (!el || !container) return true;
  el.style.fontSize = `${size}px`;
  // A 0.5px slack absorbs sub-pixel rounding so a snug fit is not rejected.
  return (
    el.scrollWidth <= container.clientWidth + 0.5 &&
    el.scrollHeight <= container.clientHeight + 0.5
  );
}

/** Binary-search the largest font size (within [min, max]) that still fits. */
function fit() {
  const container = box.value;
  const el = inner.value;
  if (!container || !el) return;
  if (container.clientWidth === 0 || container.clientHeight === 0) return;

  let lo = props.min;
  let hi = props.max;
  let best = props.min;
  for (let i = 0; i < 12 && hi - lo > 0.5; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  fontSize.value = best;
  el.style.fontSize = `${best}px`;
}

onMounted(() => {
  observer = new ResizeObserver(() => fit());
  if (box.value) observer.observe(box.value);
  nextTick(fit);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

// Reshuffling swaps a cell's text without remounting; refit on change.
watch(
  () => props.text,
  () => nextTick(fit),
);
</script>

<template>
  <div ref="box" class="flex h-full w-full items-center justify-center overflow-hidden">
    <span
      ref="inner"
      class="block w-full text-center leading-tight break-words hyphens-auto"
      :style="{ fontSize: `${fontSize}px` }"
    >
      {{ text }}
    </span>
  </div>
</template>
