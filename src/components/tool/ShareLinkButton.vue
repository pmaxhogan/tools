<script setup lang="ts">
import { computed } from "vue";
import { Link } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

/**
 * Shares the current page, fragment state and all.
 *
 * Tool state lives in the URL fragment (rule 4), so `location.href` is already
 * the shareable thing: there is nothing to serialize here.
 *
 * Two behaviors, one button. On a touch device with the Web Share API, hand
 * the URL to the system share sheet, which is what people expect on a phone.
 * Everywhere else, copy it, because a share sheet on a desktop is a worse copy
 * button. The choice is made at click time rather than on mount, so the server
 * render and the first client render are identical and hydration stays clean.
 */
const props = withDefaults(defineProps<{ label?: string }>(), { label: "Share" });

/**
 * "Share" alone does not say what is being shared, so the default label gets a
 * fuller spoken name. A custom label is already specific, so it stands as is
 * rather than being glued into a sentence that would not parse.
 */
const ariaLabel = computed(() =>
  props.label === "Share" ? "Share a link to this tool" : props.label,
);

function prefersShareSheet(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse)").matches
  );
}

async function share() {
  const url = window.location.href;
  if (prefersShareSheet()) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch {
      // Canceling the sheet rejects, and so does a browser that refuses the
      // call. Neither is worth a message, and the copy fallback below is a
      // reasonable thing to do in both cases only when the sheet never opened,
      // so bail quietly instead of copying behind the user's back.
      return;
    }
  }
  await copyText(url, "Link copied");
}
</script>

<template>
  <Button variant="ghost" size="sm" :aria-label="ariaLabel" @click="share">
    <Link />
    {{ props.label }}
  </Button>
</template>
