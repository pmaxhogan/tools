<script setup lang="ts">
import type { OptionSpec } from '@/tools/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

defineProps<{ spec: OptionSpec; modelValue: unknown }>();
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>();

function set(v: unknown) {
  emit('update:modelValue', v);
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5">
    <Label
      :for="spec.id"
      class="text-xs text-muted-foreground"
    >{{ spec.label }}</Label>

    <Select
      v-if="spec.kind === 'select'"
      :model-value="String(modelValue)"
      @update:model-value="set($event)"
    >
      <SelectTrigger
        :id="spec.id"
        size="sm"
        class="w-full"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          v-for="c in spec.choices"
          :key="c.value"
          :value="c.value"
        >
          {{ c.label }}
        </SelectItem>
      </SelectContent>
    </Select>

    <Input
      v-else-if="spec.kind === 'text'"
      :id="spec.id"
      :model-value="String(modelValue)"
      :placeholder="spec.placeholder"
      class="h-8"
      @update:model-value="set(String($event))"
    />

    <Input
      v-else-if="spec.kind === 'number' || spec.kind === 'slider'"
      :id="spec.id"
      type="number"
      :model-value="Number(modelValue)"
      :min="spec.min"
      :max="spec.max"
      :step="spec.step"
      class="h-8"
      @update:model-value="set(Number($event))"
    />

    <Switch
      v-else-if="spec.kind === 'boolean'"
      :id="spec.id"
      :model-value="Boolean(modelValue)"
      @update:model-value="set(Boolean($event))"
    />
  </div>
</template>
