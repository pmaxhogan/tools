<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { ToolMeta } from '@/tools/types';
import { ToolError, type ToolLogic } from '@/tools/types';
import { loaders } from '@/tools/registry';
import { readFragment, writeFragment } from '@/lib/fragment';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import OptionControl from './OptionControl.vue';
import OutputView from './OutputView.vue';

/**
 * The generic tool island. Renders input (paste / drop / file picker),
 * schema-driven options, and output with copy actions. State round-trips
 * through the URL fragment. Tools needing bespoke UI provide their own
 * island instead — this shell covers the common shape.
 */
const props = defineProps<{ meta: ToolMeta }>();

const hasInput = props.meta.input !== 'none';
const acceptsFiles = props.meta.input === 'File' || props.meta.input.startsWith('image/');

const input = ref('');
const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default]))
);
const output = ref<string | Record<string, string> | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

let logic: ToolLogic | null = null;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function run() {
  if (!logic) return;
  try {
    const result = await logic.run(hasInput ? input.value : undefined, opts.value);
    output.value = result as string | Record<string, string>;
    error.value = null;
  } catch (e) {
    output.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}

function scheduleRun() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    run();
    writeFragment({
      input: hasInput ? input.value : undefined,
      opts: Object.fromEntries(Object.entries(opts.value).map(([k, v]) => [k, String(v)])),
    });
  }, 150);
}

watch(input, scheduleRun);
watch(opts, scheduleRun, { deep: true });

onMounted(async () => {
  const mod = (await loaders[props.meta.slug]()) as ToolLogic;
  logic = mod;

  const frag = readFragment();
  if (frag.input !== undefined) input.value = frag.input;
  for (const spec of props.meta.options ?? []) {
    const raw = frag.opts[spec.id];
    if (raw === undefined) continue;
    if (spec.kind === 'number' || spec.kind === 'slider') opts.value[spec.id] = Number(raw);
    else if (spec.kind === 'boolean') opts.value[spec.id] = raw === 'true';
    else opts.value[spec.id] = raw;
  }
  run();
});

async function readFile(file: File) {
  input.value = await file.text();
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
}

function onPaste(e: ClipboardEvent) {
  const file = e.clipboardData?.files[0];
  if (file) {
    e.preventDefault();
    readFile(file);
  }
}

function onPickFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) readFile(file);
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div
      v-if="hasInput"
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      :class="dragging ? 'ring-2 ring-ring' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">Input</span>
        <div class="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            @click="fileInput?.click()"
          >
            Open file…
          </Button>
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            :accept="acceptsFiles ? undefined : 'text/*,.json,.csv,.txt'"
            @change="onPickFile"
          >
        </div>
      </div>
      <Textarea
        v-model="input"
        :placeholder="`Paste or drop ${meta.input === 'text/plain' ? 'text' : meta.input} here…`"
        class="min-h-28 border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        @paste="onPaste"
      />
    </div>

    <div
      v-if="meta.options?.length"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
    >
      <OptionControl
        v-for="spec in meta.options"
        :key="spec.id"
        v-model="opts[spec.id]"
        :spec="spec"
      />
    </div>

    <Button
      v-if="!hasInput"
      class="self-start"
      @click="run"
    >
      Generate
    </Button>

    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ error.message }}
      </p>
      <p
        v-if="error.fix"
        class="mt-1 text-muted-foreground"
      >
        {{ error.fix }}
      </p>
    </div>

    <OutputView
      v-if="output !== null && !error"
      :output="output"
    />
  </div>
</template>
