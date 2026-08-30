<script setup lang="ts">
import { type Component, ref } from "vue";
import { Check, Copy } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import type { ButtonVariants } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

/**
 * The shared copy affordance. Writes through `@/lib/clipboard`, so the success
 * and failure toasts read the same wherever a copy happens.
 *
 * Two ways to supply the text:
 *  - `text` for a value that already exists in the panel's state.
 *  - `getText` when the value has to be produced at click time: serializing an
 *    SVG, flushing the URL fragment before reading the address bar, or anything
 *    else too expensive to keep computed. It may be async.
 *
 * `variant` and `size` pass straight through to Button so a panel can drop this
 * in without changing how the control looks.
 */
const props = withDefaults(
  defineProps<{
    /** The value to copy. Ignored when `getText` is supplied. */
    text?: string;
    /** Produces the value at click time. Takes precedence over `text`. */
    getText?: () => string | Promise<string>;
    /** Visible label. Swaps to "Copied" for 1.5s after a successful copy. */
    label?: string;
    variant?: ButtonVariants["variant"];
    size?: ButtonVariants["size"];
    disabled?: boolean;
    /**
     * Rest-state icon. Defaults to the clipboard glyph; a button that copies a
     * shareable link passes a link glyph so it keeps reading as a link.
     */
    icon?: Component;
    /** Toast headline on success. Defaults to "Copied". */
    toastTitle?: string;
  }>(),
  {
    text: undefined,
    getText: undefined,
    label: undefined,
    variant: "ghost",
    size: "sm",
    icon: undefined,
    toastTitle: undefined,
  },
);

const emit = defineEmits<{ copied: []; failed: [unknown] }>();

const copied = ref(false);
let timer = 0;

async function copy() {
  let value: string;
  try {
    value = props.getText ? await props.getText() : (props.text ?? "");
  } catch (e) {
    // Producing the text failed, so nothing reached the clipboard. Say so
    // rather than copying an empty string.
    toast({
      title: "Copy failed",
      description: "This tool could not build the text to copy. Try again.",
      variant: "error",
    });
    emit("failed", e);
    return;
  }

  const ok = await copyText(value, props.toastTitle);
  if (!ok) {
    emit("failed", new Error("The browser blocked the clipboard write."));
    return;
  }
  copied.value = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => (copied.value = false), 1500);
  emit("copied");
}
</script>

<template>
  <Button
    :variant="variant"
    :size="size"
    :disabled="disabled"
    :aria-label="label ?? 'Copy to clipboard'"
    @click="copy"
  >
    <Check v-if="copied" class="size-4" />
    <component :is="icon ?? Copy" v-else class="size-4" />
    <span v-if="label">{{ copied ? "Copied" : label }}</span>
  </Button>
</template>
