<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import type { ToolMeta } from "@/tools/types";
import { ToolError, type ToolLogic } from "@/tools/types";
import { loaders } from "@/tools/registry";
import { readFragment, writeFragment } from "@/lib/fragment";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X } from "lucide-vue-next";
import OptionControl from "./OptionControl.vue";
import OutputView from "./OutputView.vue";

/**
 * The generic tool island. Renders input (paste / drop / file picker),
 * schema-driven options, and output with copy actions. State round-trips
 * through the URL fragment. Tools needing bespoke UI provide their own
 * island instead — this shell covers the common shape.
 */
const props = defineProps<{ meta: ToolMeta }>();

/**
 * Tools whose string output is wide "ASCII art" rows rather than prose: each
 * row is meaningful as a whole line, so the generic word-wrapping the shell
 * gives every other string output would slice a row (and the glyph it draws)
 * in half. These scroll horizontally instead of wrapping. Keyed off the slug
 * rather than a new meta field so every other string-output tool is
 * untouched by this change.
 */
const HORIZONTAL_SCROLL_TOOLS = new Set(["figlet"]);
const scrollsHorizontally = HORIZONTAL_SCROLL_TOOLS.has(props.meta.slug);

const hasInput = props.meta.input !== "none";
const acceptsFiles = props.meta.input === "File" || props.meta.input.startsWith("image/");

/** Types whose `run()` takes raw bytes; everything else stays a string. */
const BINARY_INPUTS: string[] = ["File", "image/*", "image/png", "application/octet-stream"];
const isBinary = computed(() => BINARY_INPUTS.includes(props.meta.input));

const input = ref("");
/** Bytes of the loaded file, for binary tools only. Never hits the fragment. */
const fileBytes = shallowRef<Uint8Array | null>(null);
const fileName = ref("");
const fileSize = ref(0);
const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);
const output = ref<string | Record<string, string> | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

/** Narrows the picker for known types; leaves it open for File and raw bytes. */
const acceptAttr = computed(() => {
  if (props.meta.input === "image/*" || props.meta.input === "image/png") return props.meta.input;
  if (acceptsFiles || isBinary.value) return undefined;
  return "text/*,.json,.csv,.txt";
});

/**
 * A tool that rejects an empty input is not reporting a failure on first load,
 * it is waiting. Those messages render as a neutral hint, not a red error.
 */
const isHint = computed(() => hasInput && !input.value && !fileBytes.value);

const placeholder = computed(() =>
  isBinary.value
    ? "Drop or pick a file, or paste text here…"
    : `Paste or drop ${props.meta.input === "text/plain" ? "text" : props.meta.input} here…`,
);

let logic: ToolLogic | null = null;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function run() {
  if (!logic) return;
  try {
    const value = fileBytes.value ?? input.value;
    const result = await logic.run(hasInput ? value : undefined, opts.value);
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
      // File bytes are never shareable state, so they are simply not persisted.
      input: hasInput && !fileBytes.value ? input.value : undefined,
      opts: Object.fromEntries(Object.entries(opts.value).map(([k, v]) => [k, String(v)])),
    });
  }, 150);
}

watch(input, (value) => {
  // Whichever input was set last wins: real typing drops a loaded file, but
  // the empty string we write when a file loads must leave the file alone.
  if (value && fileBytes.value) clearFileState();
  scheduleRun();
});
watch(opts, scheduleRun, { deep: true });

onMounted(async () => {
  const mod = (await loaders[props.meta.slug]()) as ToolLogic;
  logic = mod;

  const frag = readFragment();
  if (frag.input !== undefined) input.value = frag.input;
  for (const spec of props.meta.options ?? []) {
    const raw = frag.opts[spec.id];
    if (raw === undefined) continue;
    if (spec.kind === "number" || spec.kind === "slider") opts.value[spec.id] = Number(raw);
    else if (spec.kind === "boolean") opts.value[spec.id] = raw === "true";
    else opts.value[spec.id] = raw;
  }
  run();
});

function clearFileState() {
  fileBytes.value = null;
  fileName.value = "";
  fileSize.value = 0;
  if (fileInput.value) fileInput.value.value = "";
}

/** The x on the file chip: drop the bytes and re-run on the empty string. */
function clearFile() {
  clearFileState();
  scheduleRun();
}

async function readFile(file: File) {
  if (isBinary.value) {
    fileBytes.value = new Uint8Array(await file.arrayBuffer());
    fileName.value = file.name;
    fileSize.value = file.size;
    // Clearing the textarea leaves the bytes intact (see the input watcher).
    input.value = "";
    scheduleRun();
    return;
  }
  clearFileState();
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
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = "";
  });
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
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Input</span
        >
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open file… </Button>
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            :accept="acceptAttr"
            @change="onPickFile"
          />
        </div>
      </div>

      <div v-if="fileBytes" class="px-3 pt-2">
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
          <button
            type="button"
            aria-label="Remove file"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearFile"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <Textarea
        v-model="input"
        :placeholder="placeholder"
        class="max-h-80 min-h-28 overflow-y-auto border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        @paste="onPaste"
      />
    </div>

    <div v-if="meta.options?.length" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <OptionControl
        v-for="spec in meta.options"
        :key="spec.id"
        v-model="opts[spec.id]"
        :spec="spec"
      />
    </div>

    <Button v-if="!hasInput" class="self-start" @click="run"> Generate </Button>

    <div
      v-if="error"
      :role="isHint ? 'status' : 'alert'"
      class="rounded-lg border px-3 py-2 text-sm"
      :class="isHint ? 'bg-secondary/60' : 'border-destructive/50 bg-destructive/5'"
    >
      <p :class="isHint ? 'font-medium text-muted-foreground' : 'font-medium text-destructive'">
        {{ error.message }}
      </p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">
        {{ error.fix }}
      </p>
    </div>

    <div :class="scrollsHorizontally ? 'output-scrolls-horizontally' : undefined">
      <OutputView v-if="output !== null && !error" :output="output" />
    </div>
  </div>
</template>

<style scoped>
/*
 * Overrides OutputView's default `white-space: pre-wrap; word-break: break-all`
 * (tuned for prose-like string output) for tools registered in
 * HORIZONTAL_SCROLL_TOOLS above, where each output row must stay one line.
 * Higher selector specificity than OutputView's single utility classes wins
 * without touching that component.
 */
.output-scrolls-horizontally :deep(pre) {
  white-space: pre;
  word-break: normal;
  overflow-x: auto;
}
</style>
