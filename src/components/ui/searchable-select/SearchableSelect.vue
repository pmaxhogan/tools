<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from "reka-ui";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "@lucide/vue";
import type { SelectOptionSpec } from "@/tools/types";
import { filterSelectTree, flattenSelectOptions, shouldShowSearch } from "@/lib/select-options";
import SearchableSelectGroup from "./SearchableSelectGroup.vue";
import { ITEM_CLASS, itemPadding } from "./styles";

/**
 * The shared searchable dropdown. One component behind every select on the
 * site: it renders a Select-styled trigger, a portalled listbox, hierarchical
 * category groups when the spec provides them, and, once the flat leaf-option
 * count passes the threshold, a search field that filters on option labels,
 * option synonyms, group labels, and group synonyms (see src/lib/select-options).
 *
 * Contract matches the old Select usage: `modelValue` is the selected value
 * string, and choosing an option emits `update:modelValue`.
 */
const props = defineProps<{
  spec: SelectOptionSpec;
  modelValue: string;
  /** Forwarded to the trigger so an external <label for> associates with it. */
  id?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const open = ref(false);
const search = ref("");

/** The host element travels with the panel into a Document PiP window, so its
 * ownerDocument is the right teleport target. Resolved each time the panel
 * opens (a template ref does not re-fire when the node is moved between
 * documents), and left undefined until then so SSR renders nothing. */
const hostEl = ref<HTMLElement | null>(null);
const teleportTarget = ref<HTMLElement | undefined>(undefined);

const flat = computed(() => flattenSelectOptions(props.spec));
const showSearch = computed(() => shouldShowSearch(props.spec));
const selectedLabel = computed(
  () => flat.value.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
);
const filtered = computed(() => filterSelectTree(props.spec, showSearch.value ? search.value : ""));

function onOpenChange(next: boolean) {
  open.value = next;
  if (next) {
    search.value = "";
    teleportTarget.value = hostEl.value?.ownerDocument.body ?? undefined;
  }
}

/**
 * Belt and braces with :display-value below: if anything still seeds the
 * auto-focused input (reka resyncs on open in some paths), select it so the
 * first keystroke replaces it instead of concatenating.
 */
function onSearchFocus(e: FocusEvent) {
  (e.target as HTMLInputElement | null)?.select?.();
}

/**
 * reka's ComboboxInput renders the SELECTED item into the input when the
 * panel opens, and without a display-value it stringifies the option's CODE
 * value (not its label), so an open dropdown started life pre-searched for
 * e.g. "blocks/diamond_ore" and showed no matches. The input is a pure
 * search field here (the trigger shows the selection), so display nothing.
 */
const emptyDisplayValue = () => "";

function onSelect(value: string) {
  emit("update:modelValue", value);
  // Single-select always collapses once a value is chosen.
  open.value = false;
}
</script>

<template>
  <div ref="hostEl" class="min-w-0">
    <ComboboxRoot
      :model-value="modelValue"
      :open="open"
      :ignore-filter="true"
      :reset-search-term-on-blur="true"
      @update:model-value="(v) => onSelect(String(v))"
      @update:open="onOpenChange"
    >
      <ComboboxAnchor as-child>
        <ComboboxTrigger
          :id="id"
          :title="selectedLabel"
          :class="[
            'border-input dark:bg-input/30 dark:hover:bg-input/50 data-[state=open]:border-[color:var(--brand-hairline)] data-[state=open]:ring-3 data-[state=open]:ring-ring/40 focus-visible:border-ring focus-visible:ring-ring/50 flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-md border bg-transparent py-2 pr-2 pl-2.5 text-sm shadow-xs transition-[color,box-shadow] duration-100 outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none',
          ]"
        >
          <span class="block truncate">{{ selectedLabel }}</span>
          <ChevronDownIcon class="text-muted-foreground pointer-events-none size-4 shrink-0" />
        </ComboboxTrigger>
      </ComboboxAnchor>

      <ComboboxPortal :to="teleportTarget">
        <ComboboxContent
          position="popper"
          :side-offset="4"
          :class="[
            'bg-popover text-popover-foreground ring-foreground/10 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 relative z-50 max-h-(--reka-combobox-content-available-height) min-w-(--reka-combobox-trigger-width) origin-(--reka-combobox-content-transform-origin) overflow-hidden rounded-md shadow-md ring-1 duration-100 motion-reduce:animate-none',
          ]"
        >
          <!-- Search field: shown only past the threshold. When hidden it stays
               mounted (sr-only) so it still holds focus for arrow-key navigation. -->
          <div
            :class="
              showSearch
                ? 'border-border bg-popover flex items-center gap-2 border-b px-2.5'
                : 'sr-only'
            "
          >
            <SearchIcon v-if="showSearch" class="text-muted-foreground size-4 shrink-0" />
            <ComboboxInput
              v-model="search"
              auto-focus
              :display-value="emptyDisplayValue"
              :aria-label="`Filter ${spec.label} options`"
              :placeholder="showSearch ? 'Search options' : undefined"
              @focus="onSearchFocus"
              :class="
                showSearch
                  ? 'placeholder:text-muted-foreground h-9 w-full bg-transparent text-sm outline-hidden'
                  : ''
              "
            />
          </div>

          <ComboboxViewport class="max-h-72 overflow-x-hidden overflow-y-auto p-1">
            <!-- Hierarchical category groups. -->
            <SearchableSelectGroup
              v-for="group in filtered.groups"
              :key="group.label"
              :group="group"
              :depth="0"
            />

            <!-- Ungrouped flat options (from `options` or legacy `choices`). -->
            <ComboboxItem
              v-for="option in filtered.options"
              :key="option.value"
              :value="option.value"
              :text-value="option.label"
              :class="ITEM_CLASS"
              :style="{ paddingLeft: itemPadding(-1) }"
            >
              <span class="truncate">{{ option.label }}</span>
              <ComboboxItemIndicator class="ml-auto flex items-center">
                <CheckIcon class="text-primary size-4 shrink-0" />
              </ComboboxItemIndicator>
            </ComboboxItem>

            <div v-if="filtered.count === 0" class="text-muted-foreground py-6 text-center text-sm">
              No matches
            </div>
          </ComboboxViewport>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>
  </div>
</template>
