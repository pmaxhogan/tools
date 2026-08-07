<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-vue-next";

const props = defineProps<{ text: string; label?: string }>();
const copied = ref(false);

async function copy() {
  await navigator.clipboard.writeText(props.text);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <Button variant="ghost" size="sm" :aria-label="label ?? 'Copy to clipboard'" @click="copy">
    <Check v-if="copied" class="size-4" />
    <Copy v-else class="size-4" />
    <span v-if="label">{{ copied ? "Copied" : label }}</span>
  </Button>
</template>
