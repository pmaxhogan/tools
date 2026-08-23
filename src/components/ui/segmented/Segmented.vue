<script setup lang="ts">
import type { ComponentPublicInstance, HTMLAttributes } from "vue";
import { computed, nextTick, ref } from "vue";
import type { SegmentedOption } from ".";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/**
 * The shared segmented control: a small set of mutually exclusive choices
 * rendered as a row of buttons instead of a dropdown. Used by the generic
 * OptionControl for selects with a handful of short options, and directly by
 * tool panels that need a mode switch.
 *
 * Semantics are a radio group, not a toolbar: the container is a
 * `role="radiogroup"` and each button is a `role="radio"` with `aria-checked`,
 * with a roving tabindex so the whole group is one tab stop. Arrow keys, Home,
 * and End move the selection the way a native radio group does, skipping
 * disabled options and wrapping at the ends. Native buttons mean a wrapping
 * `<fieldset disabled>` disables the group for free.
 *
 * The active segment carries the brand gradient DESIGN.md prescribes for
 * active toggles, matching the Switch and the primary button.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: SegmentedOption[];
    /** Accessible name for the group. Renders as `aria-label`. */
    label?: string;
    /** "md" matches a small Button (32px); "sm" is the compact 24px row. */
    size?: "sm" | "md";
    /** Let options wrap onto another row rather than overflow horizontally. */
    wrap?: boolean;
    /** Forwarded to the group container so an external label can point at it. */
    id?: string;
    class?: HTMLAttributes["class"];
  }>(),
  {
    label: undefined,
    size: "md",
    wrap: true,
    id: undefined,
    class: undefined,
  },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const itemRefs = ref<(HTMLButtonElement | null)[]>([]);

function setItemRef(el: Element | ComponentPublicInstance | null, index: number): void {
  itemRefs.value[index] = (el as HTMLButtonElement | null) ?? null;
}

/**
 * The single option that sits in the tab order: the checked one, or, when the
 * value matches nothing (a stale shared link, say), the first option that is
 * not disabled.
 */
const rovingIndex = computed(() => {
  const checked = props.options.findIndex((o) => o.value === props.modelValue);
  if (checked !== -1) return checked;
  const firstEnabled = props.options.findIndex((o) => !o.disabled);
  return firstEnabled === -1 ? 0 : firstEnabled;
});

function itemClass(option: SegmentedOption): string {
  const active = option.value === props.modelValue;
  return cn(
    buttonVariants({ variant: "ghost", size: props.size === "sm" ? "xs" : "sm" }),
    // Buttons are nowrap and fixed height by default. A long label would then
    // push the group past its container, so segments wrap their own text and
    // grow taller instead, keeping the row inside the column it sits in.
    "min-w-0 py-1 whitespace-normal",
    props.size === "sm" ? "h-auto min-h-6" : "h-auto min-h-8",
    active &&
      "bg-primary text-primary-foreground bg-[image:var(--grad-brand)] shadow-[var(--sh-sm)] hover:bg-primary hover:text-primary-foreground hover:bg-[image:var(--grad-brand-strong)] dark:hover:bg-primary",
  );
}

function choose(option: SegmentedOption): void {
  if (option.disabled || option.value === props.modelValue) return;
  emit("update:modelValue", option.value);
}

/** The next selectable index from `from`, wrapping, skipping disabled options. */
function step(from: number, delta: number): number | null {
  const n = props.options.length;
  if (n === 0) return null;
  for (let i = 1; i <= n; i += 1) {
    const index = (((from + delta * i) % n) + n) % n;
    if (!props.options[index]?.disabled) return index;
  }
  return null;
}

/** The first (delta 1) or last (delta -1) selectable index. */
function edge(delta: number): number | null {
  const n = props.options.length;
  const start = delta > 0 ? 0 : n - 1;
  for (let i = 0; i < n; i += 1) {
    const index = start + delta * i;
    if (!props.options[index]?.disabled) return index;
  }
  return null;
}

/**
 * Select by index and move focus there. A radio group selects as it moves, so
 * the emit comes first and the focus lands after the parent has re-rendered.
 */
async function selectIndex(index: number): Promise<void> {
  const option = props.options[index];
  if (!option || option.disabled) return;
  if (option.value !== props.modelValue) emit("update:modelValue", option.value);
  await nextTick();
  itemRefs.value[index]?.focus();
}

const NAV_KEYS = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"];

function onKeydown(event: KeyboardEvent, index: number): void {
  if (!NAV_KEYS.includes(event.key)) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? edge(1)
      : event.key === "End"
        ? edge(-1)
        : step(index, event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
  if (next !== null) void selectIndex(next);
}
</script>

<template>
  <div
    :id="props.id"
    role="radiogroup"
    :aria-label="props.label"
    :class="
      cn(
        'inline-flex w-fit max-w-full justify-self-start items-center gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]',
        props.wrap ? 'flex-wrap' : '',
        props.class,
      )
    "
  >
    <button
      v-for="(option, index) in props.options"
      :key="option.value"
      :ref="(el) => setItemRef(el, index)"
      type="button"
      role="radio"
      :aria-checked="option.value === props.modelValue"
      :disabled="option.disabled"
      :tabindex="index === rovingIndex ? 0 : -1"
      :class="itemClass(option)"
      @click="choose(option)"
      @keydown="onKeydown($event, index)"
    >
      <slot :option="option" :active="option.value === props.modelValue">{{ option.label }}</slot>
    </button>
  </div>
</template>
