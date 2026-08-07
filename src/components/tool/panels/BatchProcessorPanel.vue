<script setup lang="ts">
/**
 * Bespoke panel for the Batch Processor.
 *
 * The pure layer in `src/tools/batch-processor` owns the thinking: which
 * files a run covers (`planBatch`), what one transform does to one string
 * (`applyOperation`), and which results are worth writing (`buildWriteOps`).
 * This panel owns everything that needs a real handle: reading each file
 * through FsShell's directory wrapper, decoding it as UTF-8, showing a before
 * and after diff on the first match, and handing the write ops to
 * `applyWrites` so they go through the shared confirm and undo flow.
 *
 * The one safety mechanism that lives here rather than in fs-access is the
 * backup. `planWrites` builds an undo manifest, but a `writeFile` over a file
 * that already exists reverses to nothing: the old bytes were never captured,
 * and the manifest says so in its notes. So whenever a run would overwrite an
 * existing file, this panel reads that file's original bytes first, offers
 * them as a JSON backup download, and refuses to apply anything until the
 * backup has been saved. That backup, not the undo file, is what restores an
 * overwritten file.
 */
import { computed, ref, watch } from "vue";
import { Download, Eye, Play, TriangleAlert } from "lucide-vue-next";
import { diffLines } from "diff";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  bytesToBase64,
  readFileBytes,
  type DirectoryHandleWrapper,
  type ExecuteResult,
  type FsScan,
  type WriteOp,
} from "@/lib/fs-access";
import {
  applyOperation,
  BATCH_OPERATION_LIST,
  BATCH_OPERATIONS,
  buildWriteOps,
  planBatch,
  type BatchFileResult,
  type BatchOperationId,
  type BatchOperationOpts,
  type BatchOutputMode,
  type BatchPlan,
} from "@/tools/batch-processor/index";
import FsShell from "../FsShell.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";

defineProps<{ meta: ToolMeta }>();

/** Ceiling on the originals held in memory for a backup, before it is a problem. */
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
/** How many files are handled between yields, so the progress bar actually moves. */
const YIELD_EVERY = 8;
/** How many diff rows the preview shows before it stops. */
const MAX_DIFF_ROWS = 200;
/** Bytes checked for a NUL, which is the cheapest binary tell there is. */
const BINARY_SNIFF_BYTES = 8192;

type ApplyWrites = (ops: WriteOp[]) => Promise<ExecuteResult | null>;

/* ---------------------------------------------------------------- */
/* settings                                                          */
/* ---------------------------------------------------------------- */

const filter = ref("*");
const filterMode = ref<"glob" | "regex">("glob");
const operation = ref<BatchOperationId>("find-replace");
const output = ref<BatchOutputMode>("subfolder");
const subfolder = ref("processed");
const suffixMarker = ref("processed");

/** find-replace */
const find = ref("");
const replace = ref("");
const useRegex = ref(false);
const caseSensitive = ref(true);
/** case */
const caseMode = ref<"upper" | "lower" | "title" | "sentence">("lower");
/** trim-whitespace */
const trimTrailingSpaces = ref(true);
const finalNewline = ref<"ensure" | "strip" | "keep">("ensure");
const collapseBlankLines = ref(false);
/** line-endings */
const eol = ref<"lf" | "crlf">("lf");
/** encoding-normalize */
const stripInnerBom = ref(false);
/** prefix-suffix */
const prefix = ref("");
const suffix = ref("");
/** sort-lines */
const sortDirection = ref<"asc" | "desc">("asc");
const sortNumeric = ref(false);
const sortCaseSensitive = ref(false);
/** dedupe-lines */
const dedupeCaseSensitive = ref(true);
const dedupeTrim = ref(false);
const keepBlankLines = ref(true);
/** json-format */
const jsonMode = ref<"pretty" | "minify">("pretty");
const jsonIndent = ref<string | number>(2);
/** template-wrap */
const template = ref("---\ntitle: {name}\n---\n\n{content}\n");

const operationOpts = computed<BatchOperationOpts>(() => ({
  find: find.value,
  replace: replace.value,
  regex: useRegex.value,
  caseSensitive: caseSensitive.value,
  caseMode: caseMode.value,
  trimTrailingSpaces: trimTrailingSpaces.value,
  finalNewline: finalNewline.value,
  collapseBlankLines: collapseBlankLines.value,
  eol: eol.value,
  stripInnerBom: stripInnerBom.value,
  prefix: prefix.value,
  suffix: suffix.value,
  sortDirection: sortDirection.value,
  sortNumeric: sortNumeric.value,
  sortCaseSensitive: sortCaseSensitive.value,
  dedupeCaseSensitive: dedupeCaseSensitive.value,
  dedupeTrim: dedupeTrim.value,
  keepBlankLines: keepBlankLines.value,
  jsonMode: jsonMode.value,
  // The number input hands back a string, and the operation floors and clamps it.
  jsonIndent: Number(jsonIndent.value) || 0,
  template: template.value,
}));

const currentSpec = computed(() => BATCH_OPERATIONS[operation.value]);

/* ---------------------------------------------------------------- */
/* searchable-select specs                                           */
/* ---------------------------------------------------------------- */

const filterModeSpec: SelectOptionSpec = {
  kind: "select",
  id: "batch-filter-mode",
  label: "Filter type",
  default: "glob",
  options: [
    {
      value: "glob",
      label: "Glob",
      synonyms: ["wildcard", "star pattern", "glob pattern", "*.md"],
    },
    { value: "regex", label: "Regex", synonyms: ["regular expression", "pattern", "regexp"] },
  ],
};

const OPERATION_SYNONYMS: Record<BatchOperationId, string[]> = {
  "find-replace": ["search replace", "substitute", "regex replace", "swap text"],
  case: ["uppercase", "lowercase", "title case", "capitalization", "capitalisation"],
  "trim-whitespace": ["strip spaces", "trailing whitespace", "clean whitespace", "trim"],
  "line-endings": ["crlf", "lf", "eol", "dos to unix", "unix to dos", "newlines"],
  "encoding-normalize": ["bom", "byte order mark", "utf-8", "encoding"],
  "prefix-suffix": ["header", "footer", "prepend", "append", "banner"],
  "sort-lines": ["order lines", "alphabetize", "alphabetise", "sort"],
  "dedupe-lines": ["deduplicate", "unique lines", "remove duplicates", "distinct"],
  "json-format": ["prettify json", "minify json", "beautify", "format"],
  "template-wrap": ["frontmatter", "wrap", "template", "boilerplate"],
};

/** Built from the static BATCH_OPERATION_LIST, so the order and labels match the
 *  old picker exactly. */
const operationSpec: SelectOptionSpec = {
  kind: "select",
  id: "batch-operation",
  label: "Operation",
  default: "find-replace",
  options: BATCH_OPERATION_LIST.map((s) => ({
    value: s.id,
    label: s.label,
    synonyms: OPERATION_SYNONYMS[s.id],
  })),
};

const caseModeSpec: SelectOptionSpec = {
  kind: "select",
  id: "batch-case-mode",
  label: "Casing",
  default: "lower",
  options: [
    { value: "upper", label: "UPPERCASE", synonyms: ["all caps", "capitals", "uppercase"] },
    { value: "lower", label: "lowercase", synonyms: ["small letters", "lowercase"] },
    { value: "title", label: "Title Case", synonyms: ["capitalize each word", "headline"] },
    {
      value: "sentence",
      label: "Sentence case",
      synonyms: ["capitalize first letter", "sentence"],
    },
  ],
};

const finalNewlineSpec: SelectOptionSpec = {
  kind: "select",
  id: "batch-final-newline",
  label: "Final newline",
  default: "ensure",
  options: [
    {
      value: "ensure",
      label: "End with exactly one newline",
      synonyms: ["add newline", "trailing newline", "one newline"],
    },
    {
      value: "strip",
      label: "No newline at the end",
      synonyms: ["remove newline", "no trailing newline"],
    },
    {
      value: "keep",
      label: "Leave the end alone",
      synonyms: ["unchanged", "do nothing", "leave as is"],
    },
  ],
};

const eolSpec: SelectOptionSpec = {
  kind: "select",
  id: "batch-eol",
  label: "Line ending",
  default: "lf",
  options: [
    {
      value: "lf",
      label: "LF, the Linux and macOS ending",
      synonyms: ["unix", "linux", "macos", "line feed", "newline"],
    },
    {
      value: "crlf",
      label: "CRLF, the Windows ending",
      synonyms: ["windows", "dos", "carriage return", "carriage return line feed"],
    },
  ],
};

const sortDirectionSpec: SelectOptionSpec = {
  kind: "select",
  id: "batch-sort-direction",
  label: "Direction",
  default: "asc",
  options: [
    { value: "asc", label: "A to Z", synonyms: ["ascending", "alphabetical", "a-z", "up"] },
    { value: "desc", label: "Z to A", synonyms: ["descending", "reverse", "z-a", "down"] },
  ],
};

const jsonModeSpec: SelectOptionSpec = {
  kind: "select",
  id: "batch-json-mode",
  label: "Style",
  default: "pretty",
  options: [
    {
      value: "pretty",
      label: "Pretty print",
      synonyms: ["prettify", "beautify", "indent", "format", "expand"],
    },
    { value: "minify", label: "Minify", synonyms: ["compact", "compress", "one line", "shrink"] },
  ],
};

const outputSpec: SelectOptionSpec = {
  kind: "select",
  id: "batch-output",
  label: "Where results go",
  default: "subfolder",
  options: [
    {
      value: "subfolder",
      label: "Into a subfolder, originals untouched",
      synonyms: ["new folder", "separate folder", "safe", "copy"],
    },
    {
      value: "suffix",
      label: "Alongside, as name.processed.ext",
      synonyms: ["suffix", "beside", "same folder", "renamed"],
    },
    {
      value: "in-place",
      label: "In place, overwriting the originals",
      synonyms: ["overwrite", "replace", "in-place", "modify originals"],
    },
  ],
};

/* ---------------------------------------------------------------- */
/* run state                                                         */
/* ---------------------------------------------------------------- */

interface SkipRow {
  path: string;
  reason: string;
}

interface DiffRow {
  key: string;
  kind: "added" | "removed" | "same" | "gap";
  sign: string;
  text: string;
}

interface Preview {
  path: string;
  rows: DiffRow[];
  identical: boolean;
  skippedReason: string | null;
  truncated: boolean;
}

interface BackupEntry {
  path: string;
  bytes: number;
  base64: string;
}

const scanRef = ref<FsScan | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const preview = ref<Preview | null>(null);
const previewing = ref(false);

const reading = ref(false);
const readDone = ref(0);
const readTotal = ref(0);
const abort = ref(false);

/** 'idle' before a run, 'ready' once the text is transformed and ops exist. */
const stage = ref<"idle" | "ready">("idle");
const pendingOps = ref<WriteOp[]>([]);
const runSkips = ref<SkipRow[]>([]);
const unchangedCount = ref(0);
const backup = ref<BackupEntry[] | null>(null);
const backupSaved = ref(false);
/** How far a stopped run got, so a partial batch never reads as a complete one. */
const stoppedAt = ref<{ done: number; total: number } | null>(null);

/* ---------------------------------------------------------------- */
/* planning                                                          */
/* ---------------------------------------------------------------- */

/** Planning and its failure travel together, so the computed stays side effect free. */
const planState = computed<{ plan: BatchPlan | null; error: string | null }>(() => {
  const scan = scanRef.value;
  if (!scan) return { plan: null, error: null };
  try {
    return {
      plan: planBatch(scan, {
        filter: filter.value,
        filterMode: filterMode.value,
        operation: operation.value,
        operationOpts: operationOpts.value,
        output: output.value,
        subfolder: subfolder.value,
        suffix: suffixMarker.value,
      }),
      error: null,
    };
  } catch (e) {
    return { plan: null, error: e instanceof Error ? e.message : String(e) };
  }
});

const plan = computed(() => planState.value.plan);

/**
 * Settings that are wrong for every file, found before a single one is read:
 * an empty find box, a broken regex, a template with no {content}. The pure
 * layer throws for exactly these, so one probe call is the whole check.
 */
const configError = computed(() => {
  try {
    applyOperation("probe", operation.value, operationOpts.value);
    return null;
  } catch (e) {
    return e instanceof ToolError
      ? `${e.message}${e.fix ? ` ${e.fix}` : ""}`
      : e instanceof Error
        ? e.message
        : String(e);
  }
});

const planError = computed(() => planState.value.error);

const ready = computed(() => !!plan.value?.items.length && !planError.value && !configError.value);

const matchedLine = computed(() => {
  const current = plan.value;
  if (!current) return "Waiting for a folder scan.";
  const parts = [
    `${current.matchedCount.toLocaleString()} file${current.matchedCount === 1 ? "" : "s"} matched`,
  ];
  if (current.skippedCount) parts.push(`${current.skippedCount.toLocaleString()} skipped`);
  if (current.unmatchedCount) parts.push(`${current.unmatchedCount.toLocaleString()} not matched`);
  return `${parts.join(", ")}.`;
});

/** Where the first matched file would end up, shown next to the output picker. */
const outputExample = computed(() => {
  const first = plan.value?.items[0];
  if (!first) return "";
  return output.value === "in-place"
    ? `${first.path} is overwritten in place`
    : `${first.path} becomes ${first.outPath}`;
});

/* ---------------------------------------------------------------- */
/* reading                                                           */
/* ---------------------------------------------------------------- */

/** True when the bytes look like a binary file that slipped past the extension check. */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Decode bytes as UTF-8, keeping a byte order mark rather than swallowing it.
 *
 * `ignoreBOM: true` is the whole point: the default decoder strips a leading
 * U+FEFF, which would mean the strip byte order mark operation never sees one
 * and quietly reports every file as unchanged. `fatal: true` is the other
 * half: a Latin-1 or UTF-16 file fails here and is skipped, instead of being
 * decoded into replacement characters and written back as damage.
 */
function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function setError(e: unknown) {
  if (e instanceof ToolError) error.value = { message: e.message, fix: e.fix };
  else error.value = { message: e instanceof Error ? e.message : String(e) };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/* ---------------------------------------------------------------- */
/* preview                                                           */
/* ---------------------------------------------------------------- */

/** Make trailing spaces, tabs and carriage returns visible in the diff. */
function visualize(line: string): string {
  return line
    .replace(/\r/g, "␍")
    .replace(/[ \t]+$/, (run) => run.replace(/ /g, "·").replace(/\t/g, "→"));
}

function buildDiffRows(before: string, after: string): { rows: DiffRow[]; truncated: boolean } {
  const rows: DiffRow[] = [];
  let key = 0;

  const push = (kind: DiffRow["kind"], sign: string, text: string) => {
    rows.push({ key: `r${key++}`, kind, sign, text });
  };

  for (const part of diffLines(before, after)) {
    const lines = part.value.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const kind: DiffRow["kind"] = part.added ? "added" : part.removed ? "removed" : "same";
    const sign = part.added ? "+" : part.removed ? "-" : " ";

    if (kind === "same" && lines.length > 6) {
      for (const line of lines.slice(0, 3)) push(kind, sign, visualize(line));
      push("gap", " ", `${lines.length - 6} unchanged lines`);
      for (const line of lines.slice(-3)) push(kind, sign, visualize(line));
      continue;
    }
    for (const line of lines) push(kind, sign, visualize(line));
  }

  return { rows: rows.slice(0, MAX_DIFF_ROWS), truncated: rows.length > MAX_DIFF_ROWS };
}

async function runPreview(handle: DirectoryHandleWrapper) {
  const first = plan.value?.items[0];
  if (!first || previewing.value) return;

  previewing.value = true;
  error.value = null;
  preview.value = null;
  try {
    const bytes = await readFileBytes(handle, first.path);
    if (looksBinary(bytes)) {
      preview.value = {
        path: first.path,
        rows: [],
        identical: false,
        skippedReason: "this file holds null bytes, so it is binary and will be skipped",
        truncated: false,
      };
      return;
    }
    const before = decodeText(bytes);
    if (before === null) {
      preview.value = {
        path: first.path,
        rows: [],
        identical: false,
        skippedReason: "this file is not valid UTF-8 text, so it will be skipped",
        truncated: false,
      };
      return;
    }

    const result = applyOperation(before, operation.value, {
      ...operationOpts.value,
      name: first.name,
      path: first.path,
    });

    if (!result.ok) {
      preview.value = {
        path: first.path,
        rows: [],
        identical: false,
        skippedReason: result.reason,
        truncated: false,
      };
      return;
    }

    const { rows, truncated } = buildDiffRows(before, result.text);
    preview.value = {
      path: first.path,
      rows,
      identical: result.text === before,
      skippedReason: null,
      truncated,
    };
  } catch (e) {
    setError(e);
  } finally {
    previewing.value = false;
  }
}

/* ---------------------------------------------------------------- */
/* the run                                                           */
/* ---------------------------------------------------------------- */

function resetRun() {
  stage.value = "idle";
  pendingOps.value = [];
  runSkips.value = [];
  unchangedCount.value = 0;
  backup.value = null;
  backupSaved.value = false;
  stoppedAt.value = null;
}

/**
 * Read every planned file, transform it, and work out the write ops plus the
 * backup. Nothing is written here: this stops at a reviewable state, and the
 * separate apply step is what calls into the shared write flow.
 */
async function runTransform(handle: DirectoryHandleWrapper) {
  const current = plan.value;
  if (!current || reading.value || current.items.length === 0) return;

  resetRun();
  error.value = null;
  reading.value = true;
  abort.value = false;
  readDone.value = 0;
  readTotal.value = current.items.length;

  const existing = new Set((scanRef.value?.entries ?? []).map((entry) => entry.path));
  const results: BatchFileResult[] = [];
  const skips: SkipRow[] = [];
  const backupEntries: BackupEntry[] = [];
  const backedUp = new Set<string>();
  let backupBytes = 0;
  let unchanged = 0;
  let stopped: { done: number; total: number } | null = null;

  const capture = (path: string, bytes: Uint8Array) => {
    if (backedUp.has(path)) return;
    backupBytes += bytes.byteLength;
    if (backupBytes > MAX_BACKUP_BYTES) {
      throw new ToolError(
        "backup-too-large",
        `Backing up the originals would need more than ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB of memory, which is more than this page should hold.`,
        "Narrow the filter so fewer files are covered, or switch the output to a subfolder so your originals are never overwritten and no backup is needed.",
      );
    }
    backedUp.add(path);
    backupEntries.push({ path, bytes: bytes.byteLength, base64: bytesToBase64(bytes) });
  };

  try {
    for (const [index, item] of current.items.entries()) {
      if (abort.value) {
        stopped = { done: index, total: current.items.length };
        break;
      }

      const bytes = await readFileBytes(handle, item.path);

      if (looksBinary(bytes)) {
        skips.push({
          path: item.path,
          reason: "holds null bytes, so it is binary rather than text",
        });
      } else {
        const before = decodeText(bytes);
        if (before === null) {
          skips.push({
            path: item.path,
            reason: "not valid UTF-8 text, so editing it would corrupt the characters",
          });
        } else {
          const result = applyOperation(before, current.operation, {
            ...operationOpts.value,
            name: item.name,
            path: item.path,
          });
          if (!result.ok) {
            skips.push({ path: item.path, reason: result.reason });
          } else if (result.text === before && item.outPath === item.path) {
            // In place and identical: writing it would move the modified time
            // for nothing, so this file is left exactly as it is.
            unchanged += 1;
          } else {
            // In place: the bytes just read are the ones about to be replaced,
            // so this is the only moment they can be captured for the backup.
            if (item.outPath === item.path) capture(item.path, bytes);
            results.push({ outPath: item.outPath, newText: result.text, changed: true });
          }
        }
      }

      readDone.value = index + 1;
      if ((index + 1) % YIELD_EVERY === 0) await yieldToBrowser();
    }

    const ops = buildWriteOps(results);

    // A run that writes alongside or into a subfolder can still land on a file
    // that is already there, from an earlier run with different settings. Those
    // originals were never read above, so read them now: an overwrite is an
    // overwrite whichever mode produced it.
    for (const op of ops) {
      if (op.op !== "writeFile") continue;
      if (!existing.has(op.path) || backedUp.has(op.path)) continue;
      capture(op.path, await readFileBytes(handle, op.path));
    }

    pendingOps.value = ops;
    runSkips.value = skips;
    unchangedCount.value = unchanged;
    backup.value = backupEntries.length ? backupEntries : null;
    backupSaved.value = false;
    stoppedAt.value = stopped;
    stage.value = "ready";
  } catch (e) {
    setError(e);
    resetRun();
  } finally {
    reading.value = false;
  }
}

const overwriteCount = computed(() => backup.value?.length ?? 0);
const canApply = computed(
  () => pendingOps.value.length > 0 && (overwriteCount.value === 0 || backupSaved.value),
);

const runSummary = computed(() => {
  if (stage.value !== "ready") return "";
  const parts = [
    `${pendingOps.value.length.toLocaleString()} file${pendingOps.value.length === 1 ? "" : "s"} to write`,
  ];
  if (unchangedCount.value) {
    parts.push(`${unchangedCount.value.toLocaleString()} already in shape, so left alone`);
  }
  if (runSkips.value.length) {
    parts.push(`${runSkips.value.length.toLocaleString()} skipped`);
  }
  const halted = stoppedAt.value;
  // A batch that was stopped part way must never read like a finished one.
  const lead = halted
    ? `Stopped after ${halted.done.toLocaleString()} of ${halted.total.toLocaleString()} files: `
    : "";
  return `${lead}${parts.join(", ")}.`;
});

/* ---------------------------------------------------------------- */
/* backup                                                            */
/* ---------------------------------------------------------------- */

function downloadBackup(rootName: string) {
  const entries = backup.value;
  if (!entries) return;

  const payload = {
    version: 1,
    tool: "batch-processor",
    root: rootName,
    createdAt: new Date().toISOString(),
    note: "Original contents of every file this batch is about to overwrite, base64 encoded. Decode a file entry and write it back over the same path to restore it. The folder undo file cannot do this, because it never held the old bytes.",
    files: entries,
  };

  const slug =
    rootName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "folder";
  const day = new Date().toISOString().slice(0, 10);

  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `batch-backup-${slug}-${day}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  backupSaved.value = true;
}

/* ---------------------------------------------------------------- */
/* applying                                                          */
/* ---------------------------------------------------------------- */

async function applyNow(applyWrites: ApplyWrites) {
  if (!canApply.value) return;
  const ops = pendingOps.value;
  // FsShell owns the rest: it shows the change list, waits for a confirm,
  // offers its undo file, executes, then rescans. The rescan comes back
  // through onScan, which clears this run so nothing stale is left on screen.
  await applyWrites(ops);
}

/* ---------------------------------------------------------------- */
/* invalidation                                                      */
/* ---------------------------------------------------------------- */

/** Every setting that changes what a run would do. */
const settingsKey = computed(() =>
  JSON.stringify([
    filter.value,
    filterMode.value,
    operation.value,
    output.value,
    subfolder.value,
    suffixMarker.value,
    operationOpts.value,
  ]),
);

// A preview or a prepared run from the old settings would be a lie, so both go
// the moment anything changes rather than sitting there looking current.
watch(settingsKey, () => {
  preview.value = null;
  if (stage.value === "ready") resetRun();
});

function onScan(next: FsScan) {
  scanRef.value = next;
  preview.value = null;
  resetRun();
  error.value = null;
}
</script>

<template>
  <FsShell :meta="meta" mode="readwrite" @scan="onScan">
    <template #empty>
      <p class="text-sm text-muted-foreground">
        Choose a folder to run one text transform over many files at once. Filter the files you
        mean, preview the change on the first match, then apply it. Text files only for now: images,
        archives and other binary formats are skipped and listed rather than damaged.
      </p>
    </template>

    <template #controls="{ handle, busy, applyWrites }">
      <div class="flex flex-col gap-4">
        <!-- Which files -->
        <div class="flex flex-col gap-2">
          <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-filter" class="text-xs text-muted-foreground"
                >Files to include</Label
              >
              <Input
                id="batch-filter"
                v-model="filter"
                class="h-8 font-mono"
                :placeholder="
                  filterMode === 'glob' ? '*.md, docs/**/*.txt, !draft-*.md' : '\\.(md|txt)$'
                "
              />
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-filter-mode" class="text-xs text-muted-foreground"
                >Filter type</Label
              >
              <SearchableSelect
                id="batch-filter-mode"
                v-model="filterMode"
                :spec="filterModeSpec"
              />
            </div>
          </div>
          <p role="status" class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ matchedLine }}
          </p>
          <p v-if="plan?.skipped.length" class="text-xs text-muted-foreground">
            Skipped:
            {{
              plan.skipped
                .slice(0, 3)
                .map((s) => `${s.path} (${s.reason})`)
                .join("; ")
            }}<span v-if="plan.skipped.length > 3">, and {{ plan.skipped.length - 3 }} more</span>.
          </p>
          <p v-if="planError" role="alert" class="text-xs text-destructive">
            {{ planError }}
          </p>
        </div>

        <!-- What to do -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label for="batch-operation" class="text-xs text-muted-foreground">Operation</Label>
            <SearchableSelect id="batch-operation" v-model="operation" :spec="operationSpec" />
            <p class="text-xs text-muted-foreground">
              {{ currentSpec.description }}
            </p>
            <p v-if="configError" role="alert" class="text-xs text-destructive">
              {{ configError }}
            </p>
          </div>

          <!-- find and replace -->
          <div v-if="operation === 'find-replace'" class="flex flex-col gap-3">
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="flex min-w-0 flex-col gap-1.5">
                <Label for="batch-find" class="text-xs text-muted-foreground">Find</Label>
                <Input
                  id="batch-find"
                  v-model="find"
                  class="h-8 font-mono"
                  placeholder="old text"
                />
              </div>
              <div class="flex min-w-0 flex-col gap-1.5">
                <Label for="batch-replace" class="text-xs text-muted-foreground"
                  >Replace with</Label
                >
                <Input
                  id="batch-replace"
                  v-model="replace"
                  class="h-8 font-mono"
                  placeholder="new text"
                />
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-4">
              <div class="flex items-center gap-2">
                <Switch id="batch-regex" v-model="useRegex" />
                <Label for="batch-regex" class="cursor-pointer text-xs text-muted-foreground"
                  >Regular expression ($1 works in the replacement)</Label
                >
              </div>
              <div class="flex items-center gap-2">
                <Switch id="batch-case-sensitive" v-model="caseSensitive" />
                <Label
                  for="batch-case-sensitive"
                  class="cursor-pointer text-xs text-muted-foreground"
                  >Match case</Label
                >
              </div>
            </div>
          </div>

          <!-- case -->
          <div v-else-if="operation === 'case'" class="flex min-w-0 flex-col gap-1.5 sm:max-w-xs">
            <Label for="batch-case-mode" class="text-xs text-muted-foreground">Casing</Label>
            <SearchableSelect id="batch-case-mode" v-model="caseMode" :spec="caseModeSpec" />
          </div>

          <!-- trim whitespace -->
          <div v-else-if="operation === 'trim-whitespace'" class="flex flex-col gap-3">
            <div class="flex min-w-0 flex-col gap-1.5 sm:max-w-xs">
              <Label for="batch-final-newline" class="text-xs text-muted-foreground"
                >Final newline</Label
              >
              <SearchableSelect
                id="batch-final-newline"
                v-model="finalNewline"
                :spec="finalNewlineSpec"
              />
            </div>
            <div class="flex flex-wrap items-center gap-4">
              <div class="flex items-center gap-2">
                <Switch id="batch-trim-trailing" v-model="trimTrailingSpaces" />
                <Label
                  for="batch-trim-trailing"
                  class="cursor-pointer text-xs text-muted-foreground"
                  >Strip trailing spaces and tabs</Label
                >
              </div>
              <div class="flex items-center gap-2">
                <Switch id="batch-collapse-blank" v-model="collapseBlankLines" />
                <Label
                  for="batch-collapse-blank"
                  class="cursor-pointer text-xs text-muted-foreground"
                  >Collapse runs of blank lines</Label
                >
              </div>
            </div>
          </div>

          <!-- line endings -->
          <div
            v-else-if="operation === 'line-endings'"
            class="flex min-w-0 flex-col gap-1.5 sm:max-w-xs"
          >
            <Label for="batch-eol" class="text-xs text-muted-foreground">Line ending</Label>
            <SearchableSelect id="batch-eol" v-model="eol" :spec="eolSpec" />
          </div>

          <!-- encoding -->
          <div v-else-if="operation === 'encoding-normalize'" class="flex items-center gap-2">
            <Switch id="batch-inner-bom" v-model="stripInnerBom" />
            <Label for="batch-inner-bom" class="cursor-pointer text-xs text-muted-foreground"
              >Also remove byte order marks found in the middle of a file</Label
            >
          </div>

          <!-- prefix and suffix -->
          <div v-else-if="operation === 'prefix-suffix'" class="grid gap-3 sm:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-prefix" class="text-xs text-muted-foreground"
                >Header, added above every file</Label
              >
              <Textarea
                id="batch-prefix"
                v-model="prefix"
                rows="3"
                class="font-mono text-sm"
                placeholder="// Copyright 2026"
              />
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-suffix" class="text-xs text-muted-foreground"
                >Footer, added below every file</Label
              >
              <Textarea
                id="batch-suffix"
                v-model="suffix"
                rows="3"
                class="font-mono text-sm"
                placeholder="// end of file"
              />
            </div>
          </div>

          <!-- sort -->
          <div v-else-if="operation === 'sort-lines'" class="flex flex-col gap-3">
            <div class="flex min-w-0 flex-col gap-1.5 sm:max-w-xs">
              <Label for="batch-sort-direction" class="text-xs text-muted-foreground"
                >Direction</Label
              >
              <SearchableSelect
                id="batch-sort-direction"
                v-model="sortDirection"
                :spec="sortDirectionSpec"
              />
            </div>
            <div class="flex flex-wrap items-center gap-4">
              <div class="flex items-center gap-2">
                <Switch id="batch-sort-numeric" v-model="sortNumeric" />
                <Label for="batch-sort-numeric" class="cursor-pointer text-xs text-muted-foreground"
                  >Numeric, so file10 lands after file9</Label
                >
              </div>
              <div class="flex items-center gap-2">
                <Switch id="batch-sort-case" v-model="sortCaseSensitive" />
                <Label for="batch-sort-case" class="cursor-pointer text-xs text-muted-foreground"
                  >Case sensitive</Label
                >
              </div>
            </div>
          </div>

          <!-- dedupe -->
          <div v-else-if="operation === 'dedupe-lines'" class="flex flex-wrap items-center gap-4">
            <div class="flex items-center gap-2">
              <Switch id="batch-dedupe-case" v-model="dedupeCaseSensitive" />
              <Label for="batch-dedupe-case" class="cursor-pointer text-xs text-muted-foreground"
                >Case sensitive</Label
              >
            </div>
            <div class="flex items-center gap-2">
              <Switch id="batch-dedupe-trim" v-model="dedupeTrim" />
              <Label for="batch-dedupe-trim" class="cursor-pointer text-xs text-muted-foreground"
                >Ignore surrounding spaces when comparing</Label
              >
            </div>
            <div class="flex items-center gap-2">
              <Switch id="batch-dedupe-blank" v-model="keepBlankLines" />
              <Label for="batch-dedupe-blank" class="cursor-pointer text-xs text-muted-foreground"
                >Keep blank lines</Label
              >
            </div>
          </div>

          <!-- json -->
          <div v-else-if="operation === 'json-format'" class="grid gap-3 sm:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-json-mode" class="text-xs text-muted-foreground">Style</Label>
              <SearchableSelect id="batch-json-mode" v-model="jsonMode" :spec="jsonModeSpec" />
            </div>
            <div v-if="jsonMode === 'pretty'" class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-json-indent" class="text-xs text-muted-foreground">Indent</Label>
              <Input
                id="batch-json-indent"
                v-model="jsonIndent"
                type="number"
                min="0"
                max="8"
                class="h-8"
              />
            </div>
          </div>

          <!-- template -->
          <div v-else-if="operation === 'template-wrap'" class="flex min-w-0 flex-col gap-1.5">
            <Label for="batch-template" class="text-xs text-muted-foreground"
              >Template, using {content}, {name} and {path}</Label
            >
            <Textarea id="batch-template" v-model="template" rows="5" class="font-mono text-sm" />
          </div>
        </div>

        <!-- Where results go -->
        <div class="flex flex-col gap-3">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-output" class="text-xs text-muted-foreground"
                >Where results go</Label
              >
              <SearchableSelect id="batch-output" v-model="output" :spec="outputSpec" />
            </div>
            <div v-if="output === 'subfolder'" class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-subfolder" class="text-xs text-muted-foreground"
                >Subfolder name</Label
              >
              <Input
                id="batch-subfolder"
                v-model="subfolder"
                class="h-8 font-mono"
                placeholder="processed"
              />
            </div>
            <div v-else-if="output === 'suffix'" class="flex min-w-0 flex-col gap-1.5">
              <Label for="batch-suffix-marker" class="text-xs text-muted-foreground"
                >Marker inserted before the extension</Label
              >
              <Input
                id="batch-suffix-marker"
                v-model="suffixMarker"
                class="h-8 font-mono"
                placeholder="processed"
              />
            </div>
          </div>

          <p v-if="outputExample" class="font-mono text-xs text-muted-foreground">
            {{ outputExample }}
          </p>

          <!-- The loud one -->
          <div
            v-if="output === 'in-place'"
            role="alert"
            class="flex gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
          >
            <TriangleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p class="font-medium text-destructive">In place overwrites your original files.</p>
              <p class="mt-1 text-muted-foreground">
                The undo file that comes with every write batch lists the changes, but it cannot
                bring back the contents of a file that was overwritten, because it never held the
                old bytes. This tool makes its own backup instead: before anything is written it
                reads the originals, and it will not let you apply the batch until you have saved
                that backup file. If you would rather not depend on a backup at all, switch the
                output to a subfolder or to name.processed.ext, and your originals stay exactly as
                they are.
              </p>
            </div>
          </div>
        </div>

        <!-- Preview and run -->
        <div class="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="!ready || previewing || reading || busy"
            @click="runPreview(handle)"
          >
            <Eye class="size-3.5" />
            {{ previewing ? "Reading the first file…" : "Preview the first match" }}
          </Button>
          <Button
            size="sm"
            :disabled="!ready || reading || busy || stage === 'ready'"
            @click="runTransform(handle)"
          >
            <Play class="size-3.5" />
            Process {{ (plan?.matchedCount ?? 0).toLocaleString() }} file{{
              plan?.matchedCount === 1 ? "" : "s"
            }}
          </Button>
          <Button v-if="reading" variant="outline" size="sm" @click="abort = true"> Stop </Button>
        </div>

        <!-- Preview -->
        <div
          v-if="preview"
          class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Preview: {{ preview.path }}
          </p>
          <p v-if="preview.skippedReason" class="text-sm text-muted-foreground">
            This file would be skipped: {{ preview.skippedReason }}.
          </p>
          <p v-else-if="preview.identical" class="text-sm text-muted-foreground">
            This transform changes nothing in this file, so it would not be written. Files that come
            out identical are never rewritten.
          </p>
          <template v-else>
            <div class="max-h-72 overflow-auto rounded-[8px] bg-background p-2">
              <span
                v-for="row in preview.rows"
                :key="row.key"
                class="block font-mono text-xs whitespace-pre"
                :class="{
                  'text-muted-foreground': row.kind === 'same',
                  'text-destructive': row.kind === 'removed',
                  'text-primary': row.kind === 'added',
                  'italic text-muted-foreground/70': row.kind === 'gap',
                }"
                >{{ row.kind === "gap" ? `    ${row.text}` : `${row.sign} ${row.text}` }}</span
              >
            </div>
            <p class="text-xs text-muted-foreground">
              Removed lines are marked with a minus, added lines with a plus. A middle dot stands
              for a trailing space, an arrow for a trailing tab, and ␍ for a carriage return.
              <span v-if="preview.truncated"
                >Only the first {{ MAX_DIFF_ROWS }} lines are shown.</span
              >
            </p>
          </template>
        </div>

        <!-- Reading progress -->
        <div v-if="reading" class="flex flex-col gap-2">
          <div
            class="h-2 overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            :aria-valuenow="readTotal ? Math.round((readDone / readTotal) * 100) : 0"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Reading and transforming files"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              :style="{ width: `${readTotal ? (readDone / readTotal) * 100 : 0}%` }"
            />
          </div>
          <p class="font-mono text-xs text-muted-foreground tabular-nums">
            Reading and transforming {{ readDone.toLocaleString() }} of
            {{ readTotal.toLocaleString() }}
          </p>
        </div>

        <!-- Ready to apply -->
        <div
          v-if="stage === 'ready'"
          class="flex flex-col gap-3 rounded-[10px] border border-[var(--input)] bg-secondary p-3"
        >
          <p class="text-sm font-medium">
            {{ runSummary }}
          </p>

          <div v-if="runSkips.length" class="flex flex-col gap-1">
            <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Skipped files
            </p>
            <ul class="list-disc pl-4 text-xs text-muted-foreground">
              <li v-for="skip in runSkips.slice(0, 10)" :key="skip.path">
                <span class="font-mono">{{ skip.path }}</span
                >: {{ skip.reason }}
              </li>
            </ul>
            <p v-if="runSkips.length > 10" class="text-xs text-muted-foreground">
              and {{ runSkips.length - 10 }} more.
            </p>
          </div>

          <div
            v-if="overwriteCount"
            class="flex flex-col gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2"
          >
            <p class="text-sm font-medium text-destructive">
              {{ overwriteCount }} existing file{{ overwriteCount === 1 ? "" : "s" }} will be
              overwritten.
            </p>
            <p class="text-xs text-muted-foreground">
              Save the backup first. It holds the current contents of every one of those files, and
              it is the only thing that can put them back: the folder undo file lists the changes
              but cannot restore overwritten contents. The backup is built here in the tab and
              downloaded to your device.
            </p>
            <Button
              class="self-start"
              variant="outline"
              size="sm"
              @click="downloadBackup(handle.name)"
            >
              <Download class="size-3.5" />
              {{ backupSaved ? "Download the backup again" : "Download backup of originals" }}
            </Button>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <Button size="sm" :disabled="!canApply || busy" @click="applyNow(applyWrites)">
              Apply {{ pendingOps.length }} write{{ pendingOps.length === 1 ? "" : "s" }}
            </Button>
            <Button variant="ghost" size="sm" :disabled="busy" @click="resetRun">
              Start over
            </Button>
          </div>
          <p v-if="overwriteCount && !backupSaved" class="text-xs text-muted-foreground">
            Apply stays switched off until the backup has been downloaded.
          </p>
          <p v-else-if="!pendingOps.length" class="text-xs text-muted-foreground">
            Nothing to write: every matched file already came out exactly as the transform would
            leave it, or was skipped.
          </p>
          <p v-else class="text-xs text-muted-foreground">
            You still get the full list of changes to review and confirm before anything is written.
          </p>
        </div>

        <div
          v-if="error"
          role="alert"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">
            {{ error.message }}
          </p>
          <p v-if="error.fix" class="mt-1 text-muted-foreground">
            {{ error.fix }}
          </p>
        </div>
      </div>
    </template>
  </FsShell>
</template>
