<script setup lang="ts">
/**
 * The one progress bar. Determinate when `value` is a number, indeterminate
 * when it is omitted.
 *
 * Reduced motion: global.css kills every animation with !important, so the
 * indeterminate stripe is authored to look deliberate when frozen. It rests
 * at 40 percent width, offset 30 percent, which reads as a busy bar rather
 * than an empty one stuck at zero.
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** 0 to 100. Omit for an indeterminate bar. */
    value?: number;
    /** Left hand caption above the bar. */
    label?: string;
    /** Right hand caption, e.g. "3 of 12". */
    detail?: string;
    size?: "sm" | "md";
  }>(),
  {
    value: undefined,
    label: undefined,
    detail: undefined,
    size: "md",
  },
);

const determinate = computed(() => typeof props.value === "number" && Number.isFinite(props.value));
const percent = computed(() => Math.min(100, Math.max(0, props.value ?? 0)));
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div v-if="label || detail" class="flex items-baseline justify-between gap-3">
      <span v-if="label" class="min-w-0 truncate text-xs font-medium text-muted-foreground">
        {{ label }}
      </span>
      <span
        v-if="detail"
        class="ml-auto shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
      >
        {{ detail }}
      </span>
    </div>

    <div
      role="progressbar"
      :aria-label="label ?? 'Progress'"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="determinate ? Math.round(percent) : undefined"
      class="overflow-hidden rounded-full bg-secondary"
      :class="size === 'sm' ? 'h-1.5' : 'h-2'"
    >
      <div
        v-if="determinate"
        class="h-full rounded-full bg-[image:var(--grad-brand)] transition-[width] duration-150 ease-out"
        :style="{ width: `${percent}%` }"
      />
      <div v-else class="stripe h-full rounded-full bg-[image:var(--grad-brand)]" />
    </div>
  </div>
</template>

<style scoped>
.stripe {
  width: 40%;
  margin-inline-start: 30%;
  animation: progress-stripe 1.1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes progress-stripe {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .stripe {
    animation: none;
  }
}
</style>
