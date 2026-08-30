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
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from "vue";
import type { SelectOptionSpec, ToolExample, ToolMeta } from "@/tools/types";
import { ToolError, type ToolLogic } from "@/tools/types";
import { loaders } from "@/tools/registry";
import { coerceOpts, readFragment, withoutSensitiveOpts, writeFragment } from "@/lib/fragment";
import { exampleOptsToState, isTextLike, pickExample, quickEntryPlaceholder } from "@/lib/examples";
import { formatBytes } from "@/lib/format";
import { recordToRows, rowsToText } from "@/lib/key-value";
import { copyText } from "@/lib/clipboard";
import { installToolShortcuts } from "@/lib/shortcuts";
import {
  clearCarriedInput,
  getCarriedInput,
  setCarriedInput,
  shouldOfferCarried,
  subscribeCarriedInput,
  type CarriedInput,
} from "@/lib/carry-input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ChevronRight, Sparkles, X } from "lucide-vue-next";
import FileDrop from "./FileDrop.vue";
import OptionControl from "./OptionControl.vue";
import OutputView from "./OutputView.vue";
import ShortcutSheet from "./ShortcutSheet.vue";

/**
 * The generic tool island. Renders input (paste / drop / file picker),
 * schema-driven options, and output with copy actions. State round-trips
 * through the URL fragment. Tools needing bespoke UI provide their own
 * island instead; this shell covers the common shape.
 */
const props = defineProps<{ meta: ToolMeta }>();

// Shared components (FileDrop, ShareLinkButton, ...) read these instead of
// taking the whole meta as a prop. PanelHost already provides both for every
// panel it mounts, including this one, but ToolShell provides them again so
// the generic shell always has them even if it is ever mounted on its own.
provide("toolSlug", props.meta.slug);
provide("toolName", props.meta.name);

/** The shell's own root element, so the Esc shortcut can tell whether focus sits inside it. */
const rootEl = ref<HTMLElement>();

/** Opened by the `?` shortcut; see installToolShortcuts below. */
const shortcutSheetOpen = ref(false);

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

/* ---------------------------------------------------------------- */
/* cross tool carry                                                  */
/* ---------------------------------------------------------------- */

/*
 * FileDrop owns the file half of this: it stores whatever file it receives and
 * offers a matching one from another tool as its own chip. The text half lives
 * here, because only the shell knows what is in the box. Both halves share the
 * one in memory store in src/lib/carry-input.ts, so nothing is persisted.
 */

const carried = ref<CarriedInput | null>(getCarriedInput());
/** Set by the chip's x, so a dismissed offer stays dismissed for this mount. */
const carriedTextDismissed = ref(false);
/** Whether the page was opened on a shared link that already carries an input. */
const fragmentHadInput = ref(false);
let unsubscribeCarried: (() => void) | null = null;

const carriedText = computed(() => {
  if (!hasInput || carriedTextDismissed.value) return null;
  const value = carried.value;
  if (!value || value.kind !== "text" || !value.text) return null;
  if (!shouldOfferCarried(value, props.meta.slug)) return null;
  // Only offered into an empty box, and never over a shared link's own input.
  if (input.value || fileBytes.value || fragmentHadInput.value) return null;
  return { text: value.text, fromName: value.fromName };
});

function useCarriedText(): void {
  const offer = carriedText.value;
  if (!offer) return;
  input.value = offer.text;
}

function dismissCarriedText(): void {
  carriedTextDismissed.value = true;
  clearCarriedInput();
}

/**
 * Hands the text the visitor just ran to the next tool they open.
 *
 * Three things are deliberately not carried: an untouched worked example (the
 * shell's suggestion, not the visitor's state, the same rule syncFragment
 * applies to the URL), a sensitive input (a password or a signing key has no
 * business appearing on another tool's chip), and text that is only the shadow
 * of a loaded file, which FileDrop has already carried as the file itself.
 */
function carryTextInput(): void {
  if (!hasInput || props.meta.sensitiveInput) return;
  if (exampleActive.value || fileBytes.value) return;
  const text = input.value;
  if (!text) return;
  setCarriedInput({
    kind: "text",
    text,
    fromSlug: props.meta.slug,
    fromName: props.meta.name,
    at: Date.now(),
  });
}

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
  carryTextInput();
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

function syncFragment() {
  // An untouched example is the shell's suggestion, not the visitor's state,
  // so it stays out of the URL: a link copied from a fresh page is either
  // clean or exactly what they typed. The first real edit ends that.
  if (exampleActive.value) return;
  writeFragment({
    // File bytes are never shareable state, so they are simply not
    // persisted; neither is a secret input (passwords, signing keys).
    input: hasInput && !fileBytes.value && !props.meta.sensitiveInput ? input.value : undefined,
    // An option flagged `sensitive` holds a password, a shared secret, or a
    // signing key, so it is dropped here rather than stringified: the rest of
    // the options still round-trip through a shared link, and the secret one
    // never reaches the address bar, browser history, or a pasted link. An
    // example is allowed to fill such an option, and this is what keeps that
    // value from being written back out once the example is edited.
    opts: withoutSensitiveOpts(
      props.meta.options,
      Object.fromEntries(Object.entries(opts.value).map(([k, v]) => [k, String(v)])),
    ),
  });
}

function scheduleRun() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    run();
    syncFragment();
  }, 150);
}

/**
 * Runs now instead of after the debounce.
 *
 * The debounce exists to coalesce keystrokes. Loading or dropping a file is
 * one deliberate act with nothing to coalesce, and waiting made the panel
 * contradict itself: the file chip appears immediately while the previous
 * "provide a file" message is still on screen, and because `isHint` reads
 * `fileBytes`, that message turns from a neutral hint into a red error for the
 * length of the debounce. Live QA caught exactly that frame on the WASM
 * inspector's "Try a sample" and read it as the sample never reaching run().
 */
function runNow() {
  clearTimeout(debounce);
  void run();
  syncFragment();
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

/**
 * Copies the current output to the clipboard: the same text OutputView's own
 * copy button would send, built the same way (rowsToText over recordToRows
 * for a Record output, the raw string otherwise). A no-op when there is no
 * output yet.
 */
async function copyOutput(): Promise<void> {
  if (output.value === null) return;
  const text =
    typeof output.value === "string" ? output.value : rowsToText(recordToRows(output.value));
  // Through the shared helper, never navigator.clipboard directly: the
  // keyboard path has to raise the same "Copied" and "Copy failed" toasts the
  // copy buttons do, or a shortcut that silently did nothing is
  // indistinguishable from one that worked.
  await copyText(text, "Output copied");
}

/**
 * The Esc shortcut: clears whatever is currently occupying the input, in the
 * same priority a visitor would expect from the chips shown above the box (a
 * loaded file first, then a worked example, then plain typed text).
 */
function clearInputShortcut(): void {
  if (fileBytes.value) {
    clearFile();
    return;
  }
  if (exampleActive.value) {
    clearExample();
    return;
  }
  if (input.value) input.value = "";
}

let uninstallShortcuts: (() => void) | undefined;
/**
 * Set once the island is gone. onMounted resumes after an await (the tool's
 * logic module is loaded lazily), and without this the tail of it would run on
 * a page the visitor has already navigated away from: it would rewrite that
 * page's fragment and push its input into the cross tool carry store.
 */
let disposed = false;

onMounted(async () => {
  unsubscribeCarried = subscribeCarriedInput((value) => {
    carried.value = value;
  });

  uninstallShortcuts = installToolShortcuts({
    onShowHelp: () => {
      shortcutSheetOpen.value = true;
    },
    onRun: () => {
      run();
    },
    onCopyOutput: () => {
      void copyOutput();
    },
    onClearInput: clearInputShortcut,
    isInsideToolIsland: (e) => rootEl.value?.contains(e.target as Node) ?? false,
    // Not just the shortcut sheet: an open SearchableSelect dropdown (an
    // option picker, the example picker) is also a reka-ui DismissableLayer,
    // and it owns Escape itself (closing the dropdown). Without this check,
    // Escape while a dropdown is open would both close the dropdown AND wipe
    // the tool's input, since this listener sits on document and fires
    // regardless. Every reka-ui layer (Dialog, Combobox/Select, Popover)
    // marks its host with data-dismissable-layer, so one query covers all of
    // them without naming the sheet specifically.
    isDialogOpen: () => document.querySelector("[data-dismissable-layer]") !== null,
  });

  const mod = (await loaders[props.meta.slug]()) as ToolLogic;
  if (disposed) return;
  logic = mod;

  const frag = readFragment();
  if (frag.input !== undefined) input.value = frag.input;
  // Sensitive ids are stripped before coercion, not after: `coerceOpts` only
  // drops ids the tool does not declare, and a sensitive one is declared, so
  // a hand-crafted link would otherwise pre-fill a password box.
  Object.assign(
    opts.value,
    coerceOpts(props.meta.options, withoutSensitiveOpts(props.meta.options, frag.opts)),
  );

  // A shared link always wins over an example, and a shared shorthand has to
  // be visible, so a fragment input opens a collapsed quick-entry box.
  const hasFragmentInput = frag.input !== undefined && frag.input !== "";
  fragmentHadInput.value = hasFragmentInput;
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

onBeforeUnmount(() => {
  disposed = true;
  uninstallShortcuts?.();
  unsubscribeCarried?.();
  unsubscribeCarried = null;
  // A pending debounce outlives the island otherwise, and its run() would push
  // this tool's input into the cross tool carry store after the visitor has
  // already navigated away from it.
  clearTimeout(debounce);
});

function clearFileState() {
  fileBytes.value = null;
  fileName.value = "";
  fileSize.value = 0;
}

/** The x on the file chip: drop the bytes and re-run on the empty string. */
function clearFile() {
  clearFileState();
  runNow();
}

async function readFile(file: File) {
  if (isBinary.value) {
    fileBytes.value = new Uint8Array(await file.arrayBuffer());
    fileName.value = file.name;
    fileSize.value = file.size;
    // Clearing the textarea leaves the bytes intact (see the input watcher).
    input.value = "";
    runNow();
    return;
  }
  clearFileState();
  input.value = await file.text();
}

/**
 * Every file reaches the shell through here now: drop, the picker, a clipboard
 * paste carrying a file, and FileDrop's own cross tool carry chip. FileDrop
 * owns the drag state, the hidden input, the shared paste listener, and the
 * reset that lets the same file be picked twice in a row, so none of that is
 * spelled out here any more. `multiple` is off, so at most one file arrives.
 */
function onFiles(files: File[]) {
  const file = files[0];
  if (file) void readFile(file);
}
</script>

<template>
  <div
    ref="rootEl"
    class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
  >
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

      <!--
        The well is a FileDrop in `bare` mode: it brings the inset surface, the
        drag ring, the hidden picker, the shared clipboard listener, and the
        carried-file chip, and the body below is this shell's own. The focus
        ring sits on the wrapper (DESIGN.md: composite controls move the ring to
        the wrapper) because the thing focus actually lands on is the textarea,
        which keeps its own ring off so exactly one ring ever shows.
        The well is `:interactive="false"`: the body it wraps is a textarea, and
        a role="button" with its own tab stop around a textarea is a mess for a
        screen reader, so the zone drops the role, the tab stop, and the click
        to open. Drop and paste still work, and the "Open file…" button is the
        pointer and keyboard path to the picker.
        Paste is off while a quick-entry box is collapsed: v-show leaves the
        zone mounted and connected, so a file pasted anywhere on the page would
        otherwise load into a well nobody can see.
      -->
      <FileDrop
        v-show="!quickEntry || quickEntryOpen"
        id="tool-input-well"
        bare
        :interactive="false"
        :accept="acceptAttr"
        :paste="!quickEntry || quickEntryOpen"
        class="rounded-[10px] focus-within:ring-3 focus-within:ring-ring/50"
        @files="onFiles"
      >
        <template #default="{ open }">
          <div class="flex flex-wrap items-center justify-between gap-2 px-3 pt-2" @click.stop>
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
              <Button variant="ghost" size="sm" @click="open"> Open file… </Button>
            </div>
          </div>

          <p v-if="quickEntry" class="px-3 pt-2 text-xs text-muted-foreground" @click.stop>
            {{ quickEntry.hint }}
          </p>

          <!--
            The text half of the cross tool carry. FileDrop shows the file half
            itself, under the well; this one sits above the box it fills.
          -->
          <div v-if="carriedText" class="px-3 pt-2" @click.stop>
            <span
              class="inline-flex max-w-full items-center gap-1 rounded-[8px] border bg-card p-1 text-xs shadow-[var(--sh-sm)]"
            >
              <button
                type="button"
                class="min-w-0 truncate rounded-[6px] px-1.5 py-0.5 font-medium transition-colors duration-[120ms] outline-none hover:bg-secondary focus-visible:ring-3 focus-visible:ring-ring/50"
                @click="useCarriedText"
              >
                Use text from {{ carriedText.fromName }}
              </button>
              <button
                type="button"
                aria-label="Dismiss the carried text"
                class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-[120ms] outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                @click="dismissCarriedText"
              >
                <X class="size-3.5" aria-hidden="true" />
              </button>
            </span>
          </div>

          <div v-if="fileBytes" class="px-3 pt-2" @click.stop>
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
          />
        </template>
      </FileDrop>
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

  <ShortcutSheet v-model:open="shortcutSheetOpen" />
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
