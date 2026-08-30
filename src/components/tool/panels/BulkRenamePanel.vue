<script setup lang="ts">
/**
 * Bespoke panel for Bulk Rename.
 *
 * FsShell owns everything dangerous: picking the folder, the single scan, the
 * confirm step, the undo manifest and the execution. This panel owns the part
 * a person actually thinks about, which is the pattern and its result. Every
 * option feeds one pure call to `planRenames`, so the table below is exactly
 * what will be written, recomputed on every keystroke.
 *
 * Nothing here reads or writes a file. `applyWrites` is the only door out, and
 * it will not run without the undo manifest existing first.
 */
import { computed, ref } from "vue";
import type { OptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import type { ExecuteResult, FsScan, WriteOp } from "@/lib/fs-access";
import {
  planRenames,
  type BulkRenameOpts,
  type RenamePlan,
  type RenamePreviewRow,
} from "@/tools/bulk-rename/index";
import { Button } from "@/components/ui/button";
import ErrorBanner from "../ErrorBanner.vue";
import FsShell from "../FsShell.vue";
import OptionControl from "../OptionControl.vue";

const props = defineProps<{ meta: ToolMeta }>();

/** Which controls belong to which mode. Everything else is always on show. */
const MODE_OPTIONS: Record<string, string[]> = {
  "find-replace": ["find", "replace", "regex", "caseInsensitive", "includeExt"],
  template: ["template", "seqStart", "seqPad", "includeExt", "sortBy"],
  case: ["caseMode", "includeExt"],
  sequence: ["prefix", "seqStart", "seqPad", "sortBy"],
  clean: ["separator", "lowercase", "includeExt"],
};

const ALWAYS = ["mode", "filterMode"];

/** How many preview rows are drawn. A scan can hold tens of thousands. */
const MAX_ROWS = 200;

const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((option) => [option.id, option.default])),
);

const scan = ref<FsScan | null>(null);
const applying = ref(false);
const result = ref<ExecuteResult | null>(null);
const showUnchanged = ref(false);

const specs = computed(() => props.meta.options ?? []);

const visibleOptions = computed<OptionSpec[]>(() => {
  const mode = String(opts.value.mode ?? "find-replace");
  const wanted = new Set([...ALWAYS, ...(MODE_OPTIONS[mode] ?? [])]);
  if (opts.value.filterMode !== "none") wanted.add("filter");
  return specs.value.filter((option) => wanted.has(option.id));
});

const EMPTY_PLAN: RenamePlan = { ops: [], preview: [], collisions: [] };

/**
 * The whole tool, in one pure call. A bad pattern is an error on the options,
 * not a thrown render, so the panel keeps working while it is being typed.
 */
const planned = computed<{ plan: RenamePlan; error: { message: string; fix?: string } | null }>(
  () => {
    const current = scan.value;
    if (!current) return { plan: EMPTY_PLAN, error: null };
    try {
      // The control values arrive as `unknown` from the schema driven inputs;
      // planRenames coerces and defaults every one of them itself.
      return { plan: planRenames(current, opts.value as Partial<BulkRenameOpts>), error: null };
    } catch (error) {
      return {
        plan: EMPTY_PLAN,
        error:
          error instanceof ToolError
            ? { message: error.message, fix: error.fix }
            : { message: error instanceof Error ? error.message : String(error) },
      };
    }
  },
);

const plan = computed(() => planned.value.plan);
const planError = computed(() => planned.value.error);

/** Rows worth looking at: the ones that move, plus anything with a warning. */
const interestingRows = computed<RenamePreviewRow[]>(() =>
  plan.value.preview.filter((row) => row.to !== row.from || row.warning),
);

const visibleRows = computed(() =>
  (showUnchanged.value ? plan.value.preview : interestingRows.value).slice(0, MAX_ROWS),
);

const hiddenRowCount = computed(() =>
  Math.max(
    0,
    (showUnchanged.value ? plan.value.preview.length : interestingRows.value.length) - MAX_ROWS,
  ),
);

const blockedCount = computed(
  () => plan.value.preview.filter((row) => !row.changed && row.to !== row.from).length,
);

const willChange = computed(() => plan.value.preview.filter((row) => row.changed).length);

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const counts = computed(() => {
  if (!scan.value) return "";
  const parts = [
    plural(plan.value.preview.length, "file", "files"),
    `${willChange.value} will change`,
  ];
  if (blockedCount.value > 0) {
    parts.push(`${blockedCount.value} ${blockedCount.value === 1 ? "name" : "names"} blocked`);
  }
  return `${parts.join(", ")}.`;
});

/**
 * A case only rename runs through a temporary name, so it costs two ops. Worth
 * saying out loud, because the confirm panel counts ops rather than files.
 */
const hasTempSteps = computed(() =>
  plan.value.ops.some((op) => op.op === "rename" && op.to.includes(".renaming-tmp")),
);

const canApply = computed(
  () => plan.value.ops.length > 0 && plan.value.collisions.length === 0 && !applying.value,
);

function onScan(next: FsScan) {
  scan.value = next;
}

/** Files renamed, rather than ops run: a temporary step is not a result. */
function renamedCount(done: WriteOp[]): number {
  return done.filter((op) => !(op.op === "rename" && op.to.includes(".renaming-tmp"))).length;
}

const resultLine = computed(() => {
  const last = result.value;
  if (!last) return "";
  const renamed = plural(renamedCount(last.done), "file renamed", "files renamed");
  const failed = last.failed.length
    ? `, ${plural(last.failed.length, "change skipped", "changes skipped")}`
    : "";
  return `${renamed}${failed}.`;
});

async function apply(
  applyWrites: (ops: WriteOp[]) => Promise<ExecuteResult | null>,
): Promise<void> {
  if (!canApply.value) return;
  applying.value = true;
  result.value = null;
  try {
    result.value = await applyWrites(plan.value.ops);
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <FsShell :meta="meta" mode="readwrite" @scan="onScan">
    <template #empty>
      <p class="text-sm text-muted-foreground">
        Choose a folder and every file in it appears below with the name it would get. Nothing is
        written until you press Apply renames, check the list, and confirm.
      </p>
    </template>

    <template #controls="{ applyWrites }">
      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <OptionControl
            v-for="spec in visibleOptions"
            :key="spec.id"
            v-model="opts[spec.id]"
            :spec="spec"
          />
        </div>

        <p v-if="opts.mode === 'template'" class="text-xs text-muted-foreground">
          Tokens: <code>{name}</code> the name without its extension, <code>{ext}</code> the
          extension, <code>{n}</code> a running number, <code>{counter}</code> a number that
          restarts for each extension, <code>{parent}</code> the containing folder,
          <code>{date}</code> the date the file was last changed.
        </p>
        <p
          v-else-if="opts.mode === 'find-replace' && opts.regex"
          class="text-xs text-muted-foreground"
        >
          Capture groups work in the replacement: find <code>(\d{4})-(\d{2})</code> and replace with
          <code>$2-$1</code> to swap a year and a month around.
        </p>

        <!-- Bad pattern: an error on the field, not a broken panel -->
        <ErrorBanner v-if="planError" :message="planError.message" :hint="planError.fix" />

        <!-- Collisions: said plainly, before anything is written -->
        <ErrorBanner
          v-if="plan.collisions.length"
          :message="`${plural(plan.collisions.length, 'name clash', 'name clashes')} to fix first.`"
        >
          <ul class="list-disc pl-4 text-xs break-words text-muted-foreground">
            <li v-for="(collision, i) in plan.collisions.slice(0, 5)" :key="i">
              {{ collision }}
            </li>
          </ul>
          <p v-if="plan.collisions.length > 5" class="mt-1 text-xs text-muted-foreground">
            and {{ plural(plan.collisions.length - 5, "more", "more") }}.
          </p>
        </ErrorBanner>

        <!-- Preview -->
        <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Preview
            </span>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-muted-foreground tabular-nums">{{ counts }}</span>
              <Button variant="ghost" size="sm" @click="showUnchanged = !showUnchanged">
                {{ showUnchanged ? "Hide unchanged" : "Show unchanged" }}
              </Button>
            </div>
          </div>

          <div v-if="visibleRows.length" class="max-h-96 overflow-auto rounded-[8px] bg-background">
            <table class="w-full border-collapse text-left font-mono text-xs">
              <thead class="sticky top-0 bg-background">
                <tr class="text-muted-foreground">
                  <th scope="col" class="px-2 py-1.5 font-medium">Now</th>
                  <th scope="col" class="px-2 py-1.5 font-medium">After</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in visibleRows"
                  :key="row.from"
                  class="border-t border-[var(--input)] align-top"
                >
                  <td class="px-2 py-1.5 break-all text-muted-foreground">
                    {{ row.from }}
                  </td>
                  <td class="px-2 py-1.5 break-all">
                    <span
                      :class="row.changed ? 'font-medium text-foreground' : 'text-muted-foreground'"
                    >
                      {{ row.to === row.from ? "unchanged" : row.to }}
                    </span>
                    <span
                      v-if="row.warning"
                      class="mt-0.5 block font-sans text-[11px] text-destructive"
                    >
                      {{ row.warning }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p v-else class="text-sm text-muted-foreground">
            Nothing changes with these settings yet. Set a pattern above and the table fills in.
          </p>

          <p v-if="hiddenRowCount" class="text-xs text-muted-foreground">
            and {{ plural(hiddenRowCount, "more row", "more rows") }} not drawn here. They are all
            included in the plan, and the confirm step lists the full count.
          </p>
        </div>

        <!-- Apply -->
        <div class="flex flex-wrap items-center gap-3">
          <Button :disabled="!canApply" @click="apply(applyWrites)"> Apply renames </Button>
          <span v-if="plan.collisions.length" class="text-xs text-muted-foreground">
            Fix the clashes above to switch this on.
          </span>
          <span v-else-if="plan.ops.length" class="text-xs text-muted-foreground">
            {{ plural(willChange, "file", "files") }} will be renamed, and an undo file is offered
            before anything is written.
          </span>
        </div>

        <p v-if="hasTempSteps" class="text-xs text-muted-foreground">
          Some of these only change capitalization. Windows and macOS treat those as the same name,
          so each one runs through a temporary name and counts as two changes in the confirm step.
        </p>

        <p v-if="resultLine" role="status" class="text-sm font-medium">
          {{ resultLine }}
        </p>
      </div>
    </template>
  </FsShell>
</template>
