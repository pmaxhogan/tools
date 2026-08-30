<script setup lang="ts">
/**
 * The one error banner. DESIGN.md asks that errors show the message plus the
 * fix hint, so `hint` is a first class prop rather than something each panel
 * remembers to render.
 *
 * Tone tokens: error uses --destructive. There is no warning or info token in
 * global.css, so warning reuses the amber pair the chemical and safety panels
 * already ship, and info reuses the neutral secondary hint block. Both stay
 * inside the existing vocabulary rather than inventing new variables.
 */
import { computed } from "vue";
import { CircleAlert, Info, TriangleAlert, X } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    /** What went wrong, in one sentence. */
    message: string;
    /** Optional headline above the message. */
    title?: string;
    /** How to fix it. */
    hint?: string;
    variant?: "error" | "warning" | "info";
    dismissible?: boolean;
  }>(),
  {
    title: undefined,
    hint: undefined,
    variant: "error",
    dismissible: false,
  },
);

defineEmits<{ dismiss: [] }>();

const TONES = {
  error: {
    box: "border-destructive/40 bg-destructive/10",
    icon: "text-destructive",
    strong: "text-destructive",
    component: CircleAlert,
  },
  warning: {
    box: "border-amber-500/45 bg-amber-500/10",
    icon: "text-amber-700 dark:text-amber-400",
    strong: "text-amber-700 dark:text-amber-400",
    component: TriangleAlert,
  },
  info: {
    box: "border-border bg-secondary/60",
    icon: "text-muted-foreground",
    strong: "text-foreground",
    component: Info,
  },
} as const;

const tone = computed(() => TONES[props.variant]);
const role = computed(() => (props.variant === "error" ? "alert" : "status"));
</script>

<template>
  <div
    :role="role"
    aria-live="polite"
    class="flex gap-2 rounded-[10px] border px-3 py-2 text-sm"
    :class="tone.box"
  >
    <component
      :is="tone.component"
      class="mt-0.5 size-4 shrink-0"
      :class="tone.icon"
      aria-hidden="true"
    />

    <div class="min-w-0 flex-1">
      <p v-if="title" class="font-medium" :class="tone.strong">{{ title }}</p>
      <p :class="title ? 'mt-1 text-muted-foreground' : ['font-medium', tone.strong]">
        {{ message }}
      </p>
      <p v-if="hint" class="mt-1 text-muted-foreground">{{ hint }}</p>
      <div v-if="$slots.default" class="mt-2"><slot /></div>
    </div>

    <button
      v-if="dismissible"
      type="button"
      aria-label="Dismiss this message"
      class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-[120ms] hover:bg-secondary hover:text-foreground"
      @click="$emit('dismiss')"
    >
      <X class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
