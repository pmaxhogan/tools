<script lang="ts">
/**
 * Slugs whose worked example the visitor has cleared. Module scope on purpose:
 * the island remounts on every view transition, and re-filling a box someone
 * just emptied is the most annoying thing an example could do. It is a
 * session-lifetime preference, so nothing is written to storage.
 */
const dismissedExamples = new Set<string>();
</script>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import type { SelectOptionSpec, ToolExample, ToolMeta } from "@/tools/types";
import { ToolError, type ToolLogic } from "@/tools/types";
import { loaders } from "@/tools/registry";
import { coerceOpts, readFragment, writeFragment } from "@/lib/fragment";
import { exampleOptsToState, isTextLike, pickExample, quickEntryPlaceholder } from "@/lib/examples";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ChevronRight, Sparkles, X } from "lucide-vue-next";
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

/**
 * Set when the text box is a shorthand shortcut rather than the main event
 * (a "6x4TB raidz2" line, a pasted slicer summary). The options alone are a
 * complete UI for those tools, so they read options-first and the box lives
 * under a toggle.
 */
const quickEntry = props.meta.inputOptional;
const quickEntryOpen = ref(false);

/** Examples the textarea can hold, and examples that arrive as a sample file. */
const textExamples: ToolExample[] = isTextLike(props.meta.input)
  ? (props.meta.examples ?? []).filter((example) => example.input !== undefined)
  : [];
type FileExample = ToolExample & { file: string };
const fileExamples: FileExample[] = (props.meta.examples ?? []).filter(
  (example): example is FileExample => example.file !== undefined,
);

const input = ref("");
/** Bytes of the loaded file, for binary tools only. Never hits the fragment. */
const fileBytes = shallowRef<Uint8Array | null>(null);
const fileName = ref("");
const fileSize = ref(0);

function defaultOpts(): Record<string, unknown> {
  return Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default]));
}

const opts = ref<Record<string, unknown>>(defaultOpts());
const output = ref<string | Record<string, string> | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

/** True while the box still holds exactly the example text the shell put there. */
const exampleActive = ref(false);
const exampleIndex = ref(0);
const sampleLoading = ref(false);
let appliedExampleInput = "";
let appliedExampleOpts: Record<string, unknown> = {};
/** Option state from before the example landed, so clearing restores it. */
let optsBeforeExample: Record<string, unknown> | null = null;

/** The example picker, when a tool ships more than one worked example. */
const exampleSpec: SelectOptionSpec = {
  kind: "select",
  id: `${props.meta.slug}-example`,
  label: "Example",
  default: "0",
  options: textExamples.map((example, index) => ({
    value: String(index),
    label: example.label,
    synonyms: [],
  })),
};

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

const placeholder = computed(() => {
  if (quickEntry) return quickEntryPlaceholder(quickEntry.hint);
  return isBinary.value
    ? "Drop or pick a file, or paste text here…"
    : `Paste or drop ${props.meta.input === "text/plain" ? "text" : props.meta.input} here…`;
});

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
    // An untouched example is the shell's suggestion, not the visitor's state,
    // so it stays out of the URL: a link copied from a fresh page is either
    // clean or exactly what they typed. The first real edit ends that.
    if (exampleActive.value) return;
    writeFragment({
      // File bytes are never shareable state, so they are simply not
      // persisted; neither is a secret input (passwords, signing keys).
      input: hasInput && !fileBytes.value && !props.meta.sensitiveInput ? input.value : undefined,
      opts: Object.fromEntries(Object.entries(opts.value).map(([k, v]) => [k, String(v)])),
    });
  }, 150);
}

/** True while every option still matches what the example asked for. */
function optsMatchExample(): boolean {
  const current = opts.value;
  for (const key of Object.keys(current)) {
    if (current[key] !== appliedExampleOpts[key]) return false;
  }
  return true;
}

watch(input, (value) => {
  // Whichever input was set last wins: real typing drops a loaded file, but
  // the empty string we write when a file loads must leave the file alone.
  if (value && fileBytes.value) clearFileState();
  if (exampleActive.value && value !== appliedExampleInput) exampleActive.value = false;
  scheduleRun();
});
watch(
  opts,
  () => {
    if (exampleActive.value && !optsMatchExample()) exampleActive.value = false;
    scheduleRun();
  },
  { deep: true },
);

function applyExample(index: number) {
  const example = textExamples[index];
  if (!example) return;
  optsBeforeExample ??= { ...opts.value };
  exampleIndex.value = index;
  appliedExampleInput = example.input ?? "";
  appliedExampleOpts = {
    ...optsBeforeExample,
    ...exampleOptsToState(example, props.meta.options),
  };
  // Set before writing the refs so the watchers above see an active example.
  exampleActive.value = true;
  opts.value = { ...appliedExampleOpts };
  input.value = appliedExampleInput;
}

function selectExample(value: string) {
  applyExample(Number(value));
}

/** The x on the example chip: empty the box and do not offer it again. */
function clearExample() {
  dismissedExamples.add(props.meta.slug);
  exampleActive.value = false;
  exampleIndex.value = 0;
  appliedExampleInput = "";
  appliedExampleOpts = {};
  if (optsBeforeExample) opts.value = { ...optsBeforeExample };
  optsBeforeExample = null;
  input.value = "";
  scheduleRun();
}

/**
 * Loads a bundled sample through the same path as a dropped file. The file is
 * a static asset of this site, so this is a same-origin request for something
 * already on the page's own server, not a third-party call.
 */
async function loadSample(example: FileExample) {
  if (sampleLoading.value) return;
  sampleLoading.value = true;
  try {
    const response = await fetch(`/samples/${example.file}`);
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    const name = example.file.split("/").pop() ?? example.file;
    Object.assign(opts.value, exampleOptsToState(example, props.meta.options));
    await readFile(new File([blob], name, { type: blob.type }));
  } catch {
    output.value = null;
    error.value = {
      message: "Could not load the sample file.",
      fix: "Try again, or pick a file of your own with Open file.",
    };
  } finally {
    sampleLoading.value = false;
  }
}

onMounted(async () => {
  const mod = (await loaders[props.meta.slug]()) as ToolLogic;
  logic = mod;

  const frag = readFragment();
  if (frag.input !== undefined) input.value = frag.input;
  Object.assign(opts.value, coerceOpts(props.meta.options, frag.opts));

  // A shared link always wins over an example, and a shared shorthand has to
  // be visible, so a fragment input opens a collapsed quick-entry box.
  const hasFragmentInput = frag.input !== undefined && frag.input !== "";
  if (quickEntry && hasFragmentInput) quickEntryOpen.value = true;

  if (!dismissedExamples.has(props.meta.slug)) {
    const example = pickExample(props.meta, hasFragmentInput, fileBytes.value !== null);
    if (example) {
      if (quickEntry) quickEntryOpen.value = true;
      applyExample(textExamples.indexOf(example));
    }
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
    <!--
      Quick-entry tools read options first: the text box is a shorthand for the
      controls below it, not the thing you came to fill in. The grid is spelled
      out twice rather than reordered with CSS so the tab order keeps matching
      what is on screen.
    -->
    <div
      v-if="quickEntry && meta.options?.length"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
    >
      <OptionControl
        v-for="spec in meta.options"
        :key="spec.id"
        v-model="opts[spec.id]"
        :spec="spec"
      />
    </div>

    <div v-if="hasInput" class="flex flex-col gap-2">
      <div v-if="quickEntry">
        <Button
          variant="ghost"
          size="sm"
          class="-ml-2.5 text-muted-foreground"
          :aria-expanded="quickEntryOpen"
          aria-controls="tool-input-well"
          @click="quickEntryOpen = !quickEntryOpen"
        >
          <ChevronRight
            class="size-4 transition-transform duration-150 motion-reduce:transition-none"
            :class="quickEntryOpen ? 'rotate-90' : ''"
          />
          {{ quickEntry.label }}
        </Button>
      </div>

      <div
        v-show="!quickEntry || quickEntryOpen"
        id="tool-input-well"
        class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        :class="dragging ? 'ring-2 ring-ring' : ''"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span
              v-if="!quickEntry"
              class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >Input</span
            >

            <!-- One example: a chip saying what the box holds, cleared in one click. -->
            <span
              v-if="exampleActive && textExamples.length < 2"
              class="inline-flex max-w-full items-center gap-1.5 rounded-[8px] border bg-card py-1 pr-1 pl-2 text-xs shadow-[var(--sh-sm)]"
            >
              <Sparkles class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate font-medium">Example input</span>
              <button
                type="button"
                aria-label="Clear example"
                class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                @click="clearExample"
              >
                <X class="size-3.5" />
              </button>
            </span>

            <!-- Several examples: the chip becomes a picker over their labels. -->
            <span v-else-if="exampleActive" class="inline-flex min-w-0 items-center gap-1.5">
              <Sparkles class="size-3.5 shrink-0 text-muted-foreground" />
              <SearchableSelect
                class="w-48"
                :spec="exampleSpec"
                :model-value="String(exampleIndex)"
                @update:model-value="selectExample"
              />
              <button
                type="button"
                aria-label="Clear example"
                class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                @click="clearExample"
              >
                <X class="size-3.5" />
              </button>
            </span>
          </div>

          <div class="flex items-center gap-1">
            <Button
              v-for="example in fileExamples"
              :key="example.file"
              variant="outline"
              size="sm"
              :disabled="sampleLoading"
              @click="loadSample(example)"
            >
              <Sparkles class="size-4" />
              {{
                sampleLoading
                  ? "Loading sample…"
                  : fileExamples.length > 1
                    ? example.label
                    : "Try a sample"
              }}
            </Button>
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

        <p v-if="quickEntry" class="px-3 pt-2 text-xs text-muted-foreground">
          {{ quickEntry.hint }}
        </p>

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
    </div>

    <div
      v-if="!quickEntry && meta.options?.length"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
    >
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
