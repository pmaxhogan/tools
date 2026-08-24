<script setup lang="ts">
import type { OptionSpec } from "@/tools/types";
import { computed } from "vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Segmented } from "@/components/ui/segmented";
import { flattenSelectOptions, shouldRenderSegmented } from "@/lib/select-options";

const props = defineProps<{ spec: OptionSpec; modelValue: unknown }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

/**
 * A short, flat select becomes a segmented button group; everything else stays
 * the searchable dropdown. `shouldRenderSegmented` owns the rule so the worker
 * and the tests can ask the same question.
 */
const segmented = computed(() => props.spec.kind === "select" && shouldRenderSegmented(props.spec));

/** The flat leaf options a segmented group renders. Empty for other kinds. */
const segmentedOptions = computed(() =>
  props.spec.kind === "select" ? flattenSelectOptions(props.spec) : [],
);

function set(v: unknown) {
  emit("update:modelValue", v);
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5">
    <!-- A segmented group is a div, which `for` cannot target, so that branch
         drops the attribute and names the group with aria-label instead. -->
    <Label
      :for="segmented ? undefined : spec.id"
      class="text-xs text-muted-foreground"
      :class="spec.kind === 'boolean' ? 'w-fit cursor-pointer' : undefined"
      >{{ spec.label }}</Label
    >

    <Segmented
      v-if="spec.kind === 'select' && segmented"
      :id="spec.id"
      :options="segmentedOptions"
      :label="spec.label"
      :model-value="String(modelValue)"
      @update:model-value="set($event)"
    />

    <SearchableSelect
      v-else-if="spec.kind === 'select'"
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
