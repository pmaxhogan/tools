<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { ToolMeta, OptionSpec } from "@/tools/types";
import { getTool, loaders } from "@/tools/registry";
import { readFragment, writeFragment } from "@/lib/fragment";
import {
  runPipeline,
  validatePipeline,
  suggestNext,
  serializePipeline,
  parsePipeline,
  type PipelineStep,
  type PipelineRun,
  type LoadedLogic,
} from "@/tools/pipelines/index";
import { NODES, NODE_BY_SLUG, ROLE_ORDER, type NodeRole } from "@/tools/pipelines/data";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import OutputView from "../OutputView.vue";
import { ArrowDown, ArrowUp, Plus, X, Link as LinkIcon } from "lucide-vue-next";

/**
 * The Composable Pipelines builder.
 *
 * The generic ToolShell runs one tool; this panel runs a chain of them. The
 * engine in src/tools/pipelines/ is pure and injected with loaders, so this
 * file owns only the UI: the step stack, the live run against the real
 * registry, and the shareable link. The whole pipeline round-trips through the
 * URL fragment (rule 6), never localStorage (rule 7), so a link is a runnable
 * chain.
 */
defineProps<{ meta: ToolMeta }>();

const ROLE_LABELS: Record<NodeRole, string> = {
  source: "Sources",
  transform: "Transforms",
  terminal: "Terminals (end the chain)",
};

/* ------------------------------------------------------------------ */
/* state                                                              */
/* ------------------------------------------------------------------ */

const steps = ref<PipelineStep[]>([]);
const inputText = ref("");
const runResult = ref<PipelineRun | null>(null);

/** Real registry wiring for the engine. */
const metaFor = (slug: string): ToolMeta | undefined => getTool(slug);
const loadLogic = async (slug: string): Promise<LoadedLogic> => {
  const loader = loaders[slug];
  if (!loader) throw new Error(`No tool named "${slug}".`);
  return (await loader()) as LoadedLogic;
};

/* ------------------------------------------------------------------ */
/* derived                                                            */
/* ------------------------------------------------------------------ */

const firstNode = computed(() =>
  steps.value[0] ? NODE_BY_SLUG.get(steps.value[0].slug) : undefined,
);
/** The input box shows only when the first step actually consumes text. */
const showInputBox = computed(() => steps.value.length > 0 && firstNode.value?.role !== "source");

const warnings = computed(() =>
  steps.value.length
    ? validatePipeline({ steps: steps.value, input: inputText.value }, metaFor)
    : [],
);
function warningsForStep(index: number): string[] {
  return warnings.value.filter((w) => w.step === index).map((w) => w.message);
}

/** True when the last step ends the chain, so another step could not run. */
const lastEnds = computed(() => {
  const last = steps.value[steps.value.length - 1];
  if (!last) return false;
  return NODE_BY_SLUG.get(last.slug)?.role === "terminal";
});
const addDisabled = computed(() => steps.value.length > 0 && lastEnds.value);

const finalOutput = computed(() => runResult.value?.finalOutput ?? null);

/** Options the picker offers at a given position, grouped for the select. */
interface PickerOption {
  slug: string;
  label: string;
  recommended: boolean;
}
function pickerGroups(index: number): { label: string; options: PickerOption[] }[] {
  const recommended = new Set(
    index > 0 && steps.value[index - 1]
      ? suggestNext(steps.value[index - 1]!.slug, metaFor, NODES)
      : [],
  );
  const groups: { label: string; options: PickerOption[] }[] = [];
  for (const role of ROLE_ORDER) {
    // A source only makes sense as the first step.
    if (role === "source" && index !== 0) continue;
    const options = NODES.filter((n) => n.role === role).map((n) => ({
      slug: n.slug,
      label: n.label,
      recommended: recommended.has(n.slug),
    }));
    if (options.length) groups.push({ label: ROLE_LABELS[role], options });
  }
  return groups;
}

function optionsFor(slug: string): OptionSpec[] {
  return metaFor(slug)?.options ?? [];
}

/** Display value for an option control, coerced to its kind from the stored string. */
function optValue(step: PipelineStep, spec: OptionSpec): unknown {
  const raw = step.opts[spec.id];
  if (raw === undefined) return spec.default;
  if (spec.kind === "number" || spec.kind === "slider") return Number(raw);
  if (spec.kind === "boolean") return raw === "true";
  return raw;
}
function setOpt(index: number, spec: OptionSpec, value: unknown): void {
  const next = [...steps.value];
  const step = { ...next[index]!, opts: { ...next[index]!.opts } };
  step.opts[spec.id] = String(value);
  next[index] = step;
  steps.value = next;
}

/** The result row for a step, if it ran. Steps after an ended one have none. */
function resultFor(index: number) {
  return runResult.value?.steps[index];
}
function isHintError(index: number): boolean {
  return resultFor(index)?.error?.code === "empty-input";
}

/* ------------------------------------------------------------------ */
/* mutations                                                          */
/* ------------------------------------------------------------------ */

function defaultSlugFor(index: number): string {
  if (index === 0) return "json-formatter";
  const rec = suggestNext(steps.value[index - 1]!.slug, metaFor, NODES);
  return rec[0] ?? NODES.find((n) => n.role === "transform")!.slug;
}
function addStep(): void {
  if (addDisabled.value) return;
  steps.value = [...steps.value, { slug: defaultSlugFor(steps.value.length), opts: {} }];
}
function setSlug(index: number, slug: string): void {
  const next = [...steps.value];
  next[index] = { slug, opts: {} };
  steps.value = next;
}
function removeStep(index: number): void {
  steps.value = steps.value.filter((_, i) => i !== index);
}
function moveStep(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= steps.value.length) return;
  const next = [...steps.value];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  steps.value = next;
}
function clearPipeline(): void {
  steps.value = [];
  inputText.value = "";
}

/* ------------------------------------------------------------------ */
/* examples                                                           */
/* ------------------------------------------------------------------ */

interface Example {
  title: string;
  note: string;
  input: string;
  steps: PipelineStep[];
}
const EXAMPLES: Example[] = [
  {
    title: "Messy JSON to TypeScript",
    note: "json-formatter then json-to-typescript",
    input: '{"id":7,"name":"Ada","tags":["a","b"],"active":true}',
    steps: [
      { slug: "json-formatter", opts: {} },
      { slug: "json-to-typescript", opts: {} },
    ],
  },
  {
    title: "Base64 to readable",
    note: "decode-anything unwraps encodings",
    input: "eyJoZWxsbyI6IndvcmxkIn0=",
    steps: [{ slug: "decode-anything", opts: {} }],
  },
];
function loadExample(example: Example): void {
  inputText.value = example.input;
  steps.value = example.steps.map((s) => ({ slug: s.slug, opts: { ...s.opts } }));
}

/* ------------------------------------------------------------------ */
/* run + fragment                                                     */
/* ------------------------------------------------------------------ */

let debounce: ReturnType<typeof setTimeout> | undefined;
/** Guards against a slow earlier run overwriting a newer one. */
let runToken = 0;

/** Serialize only non-default options, to keep the link short. */
function cleanedSteps(): PipelineStep[] {
  return steps.value.map((step) => {
    const specs = optionsFor(step.slug);
    const opts: Record<string, string> = {};
    for (const [key, value] of Object.entries(step.opts)) {
      const spec = specs.find((s) => s.id === key);
      if (spec && String(spec.default) === value) continue;
      opts[key] = value;
    }
    return { slug: step.slug, opts };
  });
}

async function runNow(): Promise<void> {
  if (steps.value.length === 0) {
    runResult.value = null;
    return;
  }
  const token = ++runToken;
  const def = {
    steps: steps.value.map((s) => ({ slug: s.slug, opts: { ...s.opts } })),
    input: inputText.value,
  };
  const result = await runPipeline(def, { loadLogic, metaFor });
  if (token === runToken) runResult.value = result;
}

function persistFragment(): void {
  writeFragment({
    input: showInputBox.value ? inputText.value : undefined,
    opts: steps.value.length ? { p: serializePipeline({ steps: cleanedSteps() }) } : {},
  });
}

function scheduleRun(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    void runNow();
    persistFragment();
  }, 200);
}

watch([steps, inputText], scheduleRun, { deep: true });

/** CopyButton asks for the link at click time, after the fragment is written. */
function pipelineLink(): string {
  persistFragment();
  return window.location.href;
}

onMounted(() => {
  const frag = readFragment();
  if (frag.opts.p) {
    steps.value = parsePipeline(frag.opts.p);
    if (frag.input !== undefined) inputText.value = frag.input;
    void runNow();
  }
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Empty state -->
    <div v-if="steps.length === 0" class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <p class="text-sm text-muted-foreground">
          Chain the pure text tools on this site into one flow. Each step feeds its output into the
          next, every stage runs live, and the whole chain lives in the page link so you can share
          it. Start from an example, or add your first step.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="example in EXAMPLES"
          :key="example.title"
          type="button"
          class="flex flex-col items-start gap-0.5 rounded-[10px] border bg-secondary px-3 py-2 text-left shadow-[var(--sh-inset)] transition-colors outline-none hover:bg-secondary/70 focus-visible:ring-3 focus-visible:ring-ring/50"
          @click="loadExample(example)"
        >
          <span class="text-sm font-medium">{{ example.title }}</span>
          <span class="text-xs text-muted-foreground">{{ example.note }}</span>
        </button>
      </div>
      <Button class="self-start" @click="addStep">
        <Plus class="size-4" />
        Add the first step
      </Button>
    </div>

    <!-- Builder -->
    <template v-else>
      <!-- Initial input -->
      <div
        v-if="showInputBox"
        class="flex flex-col gap-1.5 rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      >
        <div class="px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >Input</span
          >
        </div>
        <Textarea
          v-model="inputText"
          spellcheck="false"
          placeholder="Paste the text the first step should work on…"
          class="max-h-64 min-h-24 overflow-y-auto border-0 bg-transparent font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>

      <!-- Steps -->
      <div
        v-for="(step, index) in steps"
        :key="index"
        class="flex flex-col gap-3 rounded-[12px] border bg-secondary/40 p-4"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Step {{ index + 1 }}
          </span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              aria-label="Move step up"
              :disabled="index === 0"
              class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
              @click="moveStep(index, -1)"
            >
              <ArrowUp class="size-4" />
            </button>
            <button
              type="button"
              aria-label="Move step down"
              :disabled="index === steps.length - 1"
              class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
              @click="moveStep(index, 1)"
            >
              <ArrowDown class="size-4" />
            </button>
            <button
              type="button"
              aria-label="Remove step"
              class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="removeStep(index)"
            >
              <X class="size-4" />
            </button>
          </div>
        </div>

        <!-- Tool picker -->
        <div class="flex flex-col gap-1.5">
          <Label :for="`pipeline-step-${index}`" class="text-xs text-muted-foreground">Tool</Label>
          <select
            :id="`pipeline-step-${index}`"
            :value="step.slug"
            class="h-9 w-full rounded-md border bg-card px-3 text-sm shadow-[var(--sh-inset)] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            @change="setSlug(index, ($event.target as HTMLSelectElement).value)"
          >
            <optgroup v-for="group in pickerGroups(index)" :key="group.label" :label="group.label">
              <option v-for="opt in group.options" :key="opt.slug" :value="opt.slug">
                {{ opt.recommended ? "★ " : "" }}{{ opt.label
                }}{{ opt.recommended ? " (recommended)" : "" }}
              </option>
            </optgroup>
          </select>
          <p v-if="metaFor(step.slug)" class="text-xs text-muted-foreground">
            {{ metaFor(step.slug)!.description }}
          </p>
        </div>

        <!-- Step options -->
        <div
          v-if="optionsFor(step.slug).length"
          class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        >
          <OptionControl
            v-for="spec in optionsFor(step.slug)"
            :key="spec.id"
            :spec="spec"
            :model-value="optValue(step, spec)"
            @update:model-value="setOpt(index, spec, $event)"
          />
        </div>

        <!-- Warnings -->
        <ErrorBanner
          v-for="(message, wi) in warningsForStep(index)"
          :key="wi"
          :message="message"
          variant="info"
        />

        <!-- Step output or error -->
        <template v-if="resultFor(index)">
          <ErrorBanner
            v-if="resultFor(index)!.error"
            :message="resultFor(index)!.error!.message"
            :hint="resultFor(index)!.error!.fix"
            :variant="isHintError(index) ? 'info' : 'error'"
          />
          <OutputView
            v-else-if="resultFor(index)!.output !== undefined"
            :output="resultFor(index)!.output!"
          />
        </template>
        <p v-else class="text-xs text-muted-foreground italic">
          Not run: an earlier step ended the chain.
        </p>
      </div>

      <!-- Add step -->
      <div class="flex flex-col gap-1.5">
        <Button variant="secondary" class="self-start" :disabled="addDisabled" @click="addStep">
          <Plus class="size-4" />
          Add step
        </Button>
        <p v-if="addDisabled" class="text-xs text-muted-foreground">
          The last step produces labeled results, which end the chain, so no step can follow it.
        </p>
      </div>

      <!-- Final output + share -->
      <div class="flex flex-col gap-3 border-t pt-4">
        <div class="flex flex-wrap items-center gap-2">
          <CopyButton
            :get-text="pipelineLink"
            :icon="LinkIcon"
            label="Copy pipeline link"
            variant="default"
            size="default"
          />
          <Button variant="ghost" @click="clearPipeline"> Clear </Button>
        </div>

        <div v-if="finalOutput !== null" class="flex flex-col gap-1.5">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Final output
          </span>
          <OutputView :output="finalOutput" />
        </div>
      </div>

      <!-- Honest notes -->
      <details class="rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
        <summary class="cursor-pointer text-sm font-medium">What can and cannot be chained</summary>
        <div class="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Only the pure text tools can be chained: each one hands plain text to the next. Tools
            for media, files, and hardware run on their own pages and are not pipeline steps.
          </p>
          <p>
            A step that produces labeled results, like a hash or a parsed URL, ends the chain,
            because those rows cannot be fed into another tool as text.
          </p>
          <p>
            The link carries the whole chain and your starting text, except inputs over 2000
            characters, which are left out to keep the link usable, so paste those in again.
          </p>
          <p>Everything runs in this tab: your files and inputs never leave your device.</p>
        </div>
      </details>
    </template>
  </div>
</template>
