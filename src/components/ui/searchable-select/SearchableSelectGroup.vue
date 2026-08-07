<script setup lang="ts">
import { ComboboxGroup, ComboboxItem, ComboboxItemIndicator, ComboboxLabel } from "reka-ui";
import { CheckIcon } from "@lucide/vue";
import type { FilteredGroup } from "@/lib/select-options";
import { ITEM_CLASS, itemPadding, labelPadding } from "./styles";

/**
 * One hierarchical category inside the searchable-select panel. Renders the
 * group label, its leaf options, then recurses into child groups. Indentation
 * grows with depth so the nesting reads as a tree. Selection and keyboard
 * highlight are handled by the parent ComboboxRoot via ComboboxItem.
 */
defineProps<{ group: FilteredGroup; depth: number }>();
</script>

<template>
  <ComboboxGroup class="w-full">
    <ComboboxLabel
      class="text-muted-foreground flex items-center py-1.5 pr-2 text-xs font-medium tracking-[0.02em] select-none"
      :style="{ paddingLeft: labelPadding(depth) }"
    >
      {{ group.label }}
    </ComboboxLabel>

    <ComboboxItem
      v-for="option in group.options"
      :key="option.value"
      :value="option.value"
      :text-value="option.label"
      :class="ITEM_CLASS"
      :style="{ paddingLeft: itemPadding(depth) }"
    >
      <span class="truncate">{{ option.label }}</span>
      <ComboboxItemIndicator class="ml-auto flex items-center">
        <CheckIcon class="text-primary size-4 shrink-0" />
      </ComboboxItemIndicator>
    </ComboboxItem>

    <SearchableSelectGroup
      v-for="child in group.groups"
      :key="child.label"
      :group="child"
      :depth="depth + 1"
    />
  </ComboboxGroup>
</template>
