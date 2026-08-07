<script setup lang="ts">
import type { OptionSpec } from "@/tools/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { SearchableSelect } from "@/components/ui/searchable-select";

defineProps<{ spec: OptionSpec; modelValue: unknown }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

function set(v: unknown) {
  emit("update:modelValue", v);
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5">
    <Label
      :for="spec.id"
      class="text-xs text-muted-foreground"
      :class="spec.kind === 'boolean' ? 'w-fit cursor-pointer' : undefined"
      >{{ spec.label }}</Label
    >

    <SearchableSelect
      v-if="spec.kind === 'select'"
      :id="spec.id"
      :spec="spec"
      :model-value="String(modelValue)"
      @update:model-value="set($event)"
    />

    <Input
      v-else-if="spec.kind === 'text'"
      :id="spec.id"
      :model-value="String(modelValue)"
      :placeholder="spec.placeholder"
      class="h-8"
      @update:model-value="set(String($event))"
    />

    <Input
      v-else-if="spec.kind === 'number'"
      :id="spec.id"
      type="number"
      :model-value="Number(modelValue)"
      :min="spec.min"
      :max="spec.max"
      :step="spec.step"
      class="h-8"
      @update:model-value="set(Number($event))"
    />

    <div v-else-if="spec.kind === 'slider'" class="flex items-center gap-3">
      <Slider
        :id="spec.id"
        :model-value="[Number(modelValue)]"
        :min="spec.min"
        :max="spec.max"
        :step="spec.step ?? 1"
        :aria-label="spec.label"
        class="min-w-0 flex-1"
        @update:model-value="set(Number($event?.[0] ?? modelValue))"
      />
      <span class="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {{ Number(modelValue) }}
      </span>
    </div>

    <Switch
      v-else-if="spec.kind === 'boolean'"
      :id="spec.id"
      :model-value="Boolean(modelValue)"
      @update:model-value="set(Boolean($event))"
    />
  </div>
</template>
