<script setup lang="ts">
/**
 * Bespoke panel for Clipboard Pipelines: a visual chain builder.
 *
 * The generic shell would show one text field holding a chain string like
 * "trim,collapse-whitespace,prefix-lines:%3E%20", which nobody can write from
 * memory. This panel renders the same chain as an ordered list of cards you can
 * add to, reorder, and give arguments, then runs it through the pure
 * `applyChain` on every keystroke so the result is always live.
 *
 * The chain string stays the single source of truth for sharing: it is
 * serialized into the URL fragment under the same `chain` key the tool's meta
 * option uses, so a link opens with the pipeline already built.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowDown, ArrowUp, ClipboardPaste, Link, Trash2, X } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  applyChain,
  findStep,
  parseChain,
  PRESETS,
  STEPS,
  type ChainStep,
} from "@/tools/clipboard-pipelines/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import OutputView from "../OutputView.vue";

const props = defineProps<{ meta: ToolMeta }>();

/**
 * A chain step plus a stable identity. Rows move and repeat, so an index key
 * would let Vue reuse the wrong DOM node (and the wrong focused argument field)
 * after a reorder. The extra field is ignored by `applyChain`, which reads only
 * `id` and `arg`.
 */
interface Row extends ChainStep {
  uid: number;
}

let nextUid = 0;

function toRows(steps: ChainStep[]): Row[] {
  return steps.map((step) => ({ ...step, uid: nextUid++ }));
}

/** The chain the page starts with, taken from the tool's own meta option. */
function defaultChain(): string {
  const spec = props.meta.options?.find((o) => o.id === "chain");
  return typeof spec?.default === "string" ? spec.default : "trim";
}

const text = ref("");
const rows = ref<Row[]>(toRows(parseChain(defaultChain())));
const clipboardHint = ref<string | null>(null);
const linkCopied = ref(false);

/* -------------------------------------------------------------------------- */
/* The chain                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Serialize back to the chain token format `id` or `id:encodedArg`, comma
 * separated. The argument is percent encoded so a comma, a newline, or a
 * trailing space survives the round trip through `parseChain`.
 */
const chainString = computed(() =>
  rows.value
    .map((row) => (row.arg ? `${row.id}:${encodeURIComponent(row.arg)}` : row.id))
    .join(","),
);

/** Catalog as a flat searchable dropdown. Selecting an entry appends a step. */
const addSpec = computed<SelectOptionSpec>(() => ({
  kind: "select",
  id: "clipboard-pipelines-add",
  label: "transform",
  default: "",
  options: STEPS.map((step) => ({
    value: step.id,
    label: step.label,
    synonyms: [step.id, step.id.replace(/-/g, " ")],
  })),
}));

/**
 * The dropdown is a command, not a field: its bound value is a constant that
 * matches no option, so the trigger always reads as a prompt and picking the
 * same transform twice in a row still fires a change.
 */
const ADD_PROMPT = "Add a transform";

const activePresetId = computed(() => {
  const current = chainString.value;
  return (
    PRESETS.find((preset) => {
      const normalized = parseChain(preset.chain)
        .map((step) => (step.arg ? `${step.id}:${encodeURIComponent(step.arg)}` : step.id))
        .join(",");
      return normalized === current;
    })?.id ?? null
  );
});

function addStep(id: string) {
  const def = findStep(id);
  if (!def) return;
  rows.value = [...rows.value, { id, uid: nextUid++, ...(def.hasArg ? { arg: "" } : {}) }];
}

function removeStep(index: number) {
  rows.value = rows.value.filter((_, i) => i !== index);
}

function moveStep(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= rows.value.length) return;
  const next = [...rows.value];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  rows.value = next;
}

function applyPreset(chain: string) {
  rows.value = toRows(parseChain(chain));
}

function clearChain() {
  rows.value = [];
}

/** Label for a row, falling back to the raw id when a shared link names an unknown step. */
function rowLabel(row: Row): string {
  return findStep(row.id)?.label ?? row.id;
}

function rowDescription(row: Row): string {
  return (
    findStep(row.id)?.description ??
    "This transform is not in the catalog. Remove it to run the pipeline."
  );
}

/* -------------------------------------------------------------------------- */
/* Live result                                                                */
/* -------------------------------------------------------------------------- */

interface PanelError {
  message: string;
  fix?: string;
  /** An empty pipeline is the starting state, not a failure, so it reads neutral. */
  hint: boolean;
}

const result = computed<{ output: string | null; error: PanelError | null }>(() => {
  try {
    return { output: applyChain(text.value, rows.value), error: null };
  } catch (e) {
    if (e instanceof ToolError) {
      return {
        output: null,
        error: { message: e.message, fix: e.fix, hint: e.code === "empty-chain" },
      };
    }
    return {
      output: null,
      error: { message: e instanceof Error ? e.message : String(e), hint: false },
    };
  }
});

/* -------------------------------------------------------------------------- */
/* Clipboard and sharing                                                      */
/* -------------------------------------------------------------------------- */

async function pasteFromClipboard() {
  clipboardHint.value = null;
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    clipboardHint.value =
      "This browser will not let a page read the clipboard. Press Ctrl+V in the box above instead.";
    return;
  }
  try {
    text.value = await navigator.clipboard.readText();
  } catch {
    clipboardHint.value = "Clipboard access was blocked. Press Ctrl+V in the box above instead.";
  }
}

async function copyLink() {
  // The fragment write is debounced, so flush it before reading the address bar.
  syncFragment(true);
  if (typeof window === "undefined") return;
  try {
    await navigator.clipboard.writeText(window.location.href);
    linkCopied.value = true;
    setTimeout(() => (linkCopied.value = false), 1500);
  } catch {
    clipboardHint.value =
      "Copying was blocked. Copy the address bar by hand to share this pipeline.";
  }
}

/* -------------------------------------------------------------------------- */
/* URL fragment state                                                         */
/* -------------------------------------------------------------------------- */

let fragmentTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced so typing in an argument field does not hammer replaceState. */
function syncFragment(immediate = false) {
  if (typeof window === "undefined") return;
  clearTimeout(fragmentTimer);
  // An empty pipeline writes no key at all, which clears the hash rather than
  // leaving a bare "#chain=" behind.
  const write = () =>
    writeFragment({ opts: chainString.value ? { chain: chainString.value } : {} });
  if (immediate) write();
  else fragmentTimer = setTimeout(write, 250);
}

watch(chainString, () => syncFragment());

onMounted(() => {
  const saved = readFragment().opts.chain;
  if (typeof saved === "string" && saved.trim() !== "") rows.value = toRows(parseChain(saved));
});

onUnmounted(() => clearTimeout(fragmentTimer));
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Input -->
    <section class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)]">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <Label for="pipeline-input" class="text-sm font-medium">Text</Label>
        <Button variant="outline" size="sm" @click="pasteFromClipboard">
          <ClipboardPaste class="size-4" />
          Paste from clipboard
        </Button>
      </div>
      <Textarea
        id="pipeline-input"
        v-model="text"
        class="min-h-32 font-mono"
        placeholder="Paste text here"
      />
      <p v-if="clipboardHint" role="status" class="text-sm text-muted-foreground">
        {{ clipboardHint }}
      </p>
    </section>

    <!-- The pipeline -->
    <section class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)]">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-baseline gap-2">
          <h2 class="text-sm font-medium">Pipeline</h2>
          <span class="text-xs text-muted-foreground">
            {{ rows.length }} {{ rows.length === 1 ? "step" : "steps" }}
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" @click="copyLink">
            <Link class="size-4" />
            {{ linkCopied ? "Link copied" : "Copy pipeline link" }}
          </Button>
          <Button v-if="rows.length" variant="ghost" size="sm" @click="clearChain">
            <Trash2 class="size-4" />
            Clear
          </Button>
        </div>
      </div>

      <!-- Presets -->
      <div class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Presets</span
        >
        <div class="flex flex-wrap gap-2">
          <button
            v-for="preset in PRESETS"
            :key="preset.id"
            type="button"
            class="rounded-[8px] border px-3 py-1.5 text-sm transition-colors"
            :class="
              preset.id === activePresetId
                ? 'border-ring bg-accent'
                : 'bg-secondary hover:bg-accent'
            "
            :aria-pressed="preset.id === activePresetId"
            @click="applyPreset(preset.chain)"
          >
            {{ preset.label }}
          </button>
        </div>
      </div>

      <!-- Steps -->
      <ol v-if="rows.length" class="flex flex-col gap-2">
        <li
          v-for="(row, index) in rows"
          :key="row.uid"
          class="flex flex-col gap-2 rounded-[12px] border bg-background p-3 sm:flex-row sm:items-start sm:gap-3"
        >
          <span
            class="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium tabular-nums"
            aria-hidden="true"
            >{{ index + 1 }}</span
          >

          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium">{{ rowLabel(row) }}</p>
              <p class="text-xs text-muted-foreground">{{ rowDescription(row) }}</p>
            </div>

            <div v-if="findStep(row.id)?.hasArg" class="flex flex-col gap-1.5">
              <Label :for="`pipeline-arg-${row.uid}`" class="text-xs text-muted-foreground">
                {{ findStep(row.id)?.argLabel ?? "Value" }}
              </Label>
              <Input
                :id="`pipeline-arg-${row.uid}`"
                v-model="row.arg"
                class="font-mono sm:max-w-xs"
                :placeholder="findStep(row.id)?.argPlaceholder"
              />
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-1 self-start">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Move step up"
              :disabled="index === 0"
              @click="moveStep(index, -1)"
            >
              <ArrowUp class="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Move step down"
              :disabled="index === rows.length - 1"
              @click="moveStep(index, 1)"
            >
              <ArrowDown class="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove step"
              @click="removeStep(index)"
            >
              <X class="size-4" />
            </Button>
          </div>
        </li>
      </ol>

      <p
        v-else
        class="rounded-[12px] bg-secondary px-3 py-4 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
      >
        No steps yet. Pick a preset above or add a transform below.
      </p>

      <!-- Add a step -->
      <div class="flex max-w-xs flex-col gap-1.5">
        <Label for="pipeline-add" class="text-xs text-muted-foreground">Add step</Label>
        <SearchableSelect
          id="pipeline-add"
          :spec="addSpec"
          :model-value="ADD_PROMPT"
          @update:model-value="addStep"
        />
      </div>
    </section>

    <!-- Result -->
    <div
      v-if="result.error"
      :role="result.error.hint ? 'status' : 'alert'"
      class="rounded-lg border px-3 py-2 text-sm"
      :class="result.error.hint ? 'bg-secondary/60' : 'border-destructive/50 bg-destructive/5'"
    >
      <p
        :class="
          result.error.hint ? 'font-medium text-muted-foreground' : 'font-medium text-destructive'
        "
      >
        {{ result.error.message }}
      </p>
      <p v-if="result.error.fix" class="mt-1 text-muted-foreground">
        {{ result.error.fix }}
      </p>
    </div>

    <OutputView v-if="result.output !== null" :output="result.output" />
  </div>
</template>
