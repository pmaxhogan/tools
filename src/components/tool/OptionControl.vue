<script setup lang="ts">
import type { OptionSpec } from "@/tools/types";
import { computed, ref } from "vue";
import { Eye, EyeOff } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
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

/* ---------------------------------------------------------------- */
/* secrets                                                           */
/* ---------------------------------------------------------------- */

/**
 * A `sensitive` text option holds a password, a shared secret, or a signing
 * key. Two shapes, because a textarea has no masked form:
 *
 *   - one line: a real `<input type="password">` with a show and hide toggle.
 *   - multiline: once it holds a value it collapses to a one line summary
 *     with a Reveal button, so a PEM block is not left open on screen.
 *
 * Nothing here decides whether the value is shareable. ToolShell keeps a
 * sensitive value out of the URL fragment in both directions; this component
 * only decides what is on screen.
 */
const sensitive = computed(() => props.spec.kind === "text" && props.spec.sensitive === true);
const multiline = computed(() => props.spec.kind === "text" && props.spec.multiline === true);

/** Toggled by the show and hide button. Always starts hidden. */
const revealed = ref(false);

const text = computed(() => String(props.modelValue ?? ""));

/** True while a sensitive multiline value is folded into its summary line. */
const collapsed = computed(
  () => sensitive.value && multiline.value && !revealed.value && text.value !== "",
);

/** The summary that stands in for a hidden PEM block or other long secret. */
const summary = computed(() => `Key set (${text.value.length.toLocaleString("en-US")} characters)`);

/** Nothing to point a label at while the control is a summary line. */
const labelFor = computed(() => (segmented.value || collapsed.value ? undefined : props.spec.id));

function set(v: unknown) {
  emit("update:modelValue", v);
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1.5">
    <!-- A segmented group is a div, which `for` cannot target, so that branch
         drops the attribute and names the group with aria-label instead. -->
    <Label
      :for="labelFor"
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

    <!-- A sensitive value that wraps: the folded summary, or the box plus Hide. -->
    <div v-else-if="spec.kind === 'text' && sensitive && multiline" class="flex flex-col gap-1.5">
      <div v-if="collapsed" class="flex min-w-0 items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-sm text-muted-foreground">{{ summary }}</span>
        <Button
          variant="outline"
          size="xs"
          :aria-pressed="false"
          :aria-label="`Show ${spec.label}`"
          @click="revealed = true"
        >
          <Eye />
          Reveal
        </Button>
      </div>
      <template v-else>
        <Textarea
          :id="spec.id"
          :model-value="text"
          :placeholder="spec.placeholder"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          class="max-h-48 min-h-20 overflow-y-auto font-mono text-xs"
          @update:model-value="set(String($event))"
        />
        <Button
          v-if="text !== ''"
          variant="outline"
          size="xs"
          class="self-start"
          :aria-pressed="true"
          :aria-label="`Show ${spec.label}`"
          @click="revealed = false"
        >
          <EyeOff />
          Hide
        </Button>
      </template>
    </div>

    <!-- A one line secret: masked, with a show and hide toggle beside it. -->
    <div v-else-if="spec.kind === 'text' && sensitive" class="flex min-w-0 items-center gap-1">
      <Input
        :id="spec.id"
        :type="revealed ? 'text' : 'password'"
        :model-value="text"
        :placeholder="spec.placeholder"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        class="h-8 min-w-0 flex-1"
        @update:model-value="set(String($event))"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        :aria-pressed="revealed"
        :aria-label="`Show ${spec.label}`"
        @click="revealed = !revealed"
      >
        <component :is="revealed ? EyeOff : Eye" />
      </Button>
    </div>

    <Textarea
      v-else-if="spec.kind === 'text' && multiline"
      :id="spec.id"
      :model-value="text"
      :placeholder="spec.placeholder"
      class="max-h-48 min-h-20 overflow-y-auto font-mono text-xs"
      @update:model-value="set(String($event))"
    />

    <Input
      v-else-if="spec.kind === 'text'"
      :id="spec.id"
      :model-value="text"
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
