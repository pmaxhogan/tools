<script setup lang="ts">
/**
 * Bespoke panel for the Sudoku Generator and Solver.
 *
 * The pure logic layer (src/tools/sudoku-generator-solver/index.ts) owns
 * every rule of the game: generation with a uniqueness guarantee, solving,
 * conflict detection, and hint explanations. This file owns the DOM: the
 * playable 9x9 grid, keyboard navigation and digit entry, pencil marks, and
 * the print and copy affordances.
 *
 * Two sources feed the board: a puzzle this panel generated (difficulty and
 * seed drive it) or a puzzle pasted in and solved. Whichever is active, the
 * board's givens are read only and every check, hint, and completion test
 * reads the player's own entries in `userGrid`, never the generator's answer
 * key directly.
 *
 * Fragment (rule 6): difficulty and seed always round trip. A pasted puzzle
 * also writes its 81 character line as the main input, the same way the
 * bingo board writes its pasted item list, because a puzzle someone typed in
 * is content worth sharing. The player's own progress, and every pencil
 * mark, is session state and never touches the fragment.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Eraser, Lightbulb, Pencil, Printer, RotateCcw, Shuffle } from "lucide-vue-next";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  DIFFICULTIES,
  clueCount,
  colOf,
  findConflicts,
  formatGrid,
  generatePuzzle,
  nextHint,
  parsePuzzle,
  rowOf,
  seedToNumber,
  solve,
  type Difficulty,
  type Hint,
} from "@/tools/sudoku-generator-solver/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";

const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * Difficulty and seed
 * ------------------------------------------------------------------ */

const difficultyOptions: SegmentedOption[] = DIFFICULTIES.map((d) => ({
  value: d,
  label: d[0]!.toUpperCase() + d.slice(1),
}));

function optionDefault(id: string, fallback: string): string {
  const spec = props.meta.options?.find((o) => o.id === id);
  return spec?.default === undefined ? fallback : String(spec.default);
}

function randomSeedText(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0]!);
}

const difficulty = ref<Difficulty>(optionDefault("difficulty", "medium") as Difficulty);
const seedText = ref(randomSeedText());

/* ------------------------------------------------------------------ *
 * Puzzle state: either generated (difficulty + seed drive it) or pasted
 * (loaded from parsePuzzle + solve). userGrid is the player's own entries,
 * always starting as a copy of the puzzle's givens.
 * ------------------------------------------------------------------ */

type PuzzleSource = "generated" | "pasted";

const puzzleSource = ref<PuzzleSource>("generated");
const puzzle = ref<number[]>([]);
const solution = ref<number[] | null>(null);
const solutionNote = ref<string | null>(null);
const genError = ref<{ message: string; fix?: string } | null>(null);
const pasteText = ref("");
const pasteError = ref<{ message: string; fix?: string } | null>(null);

const userGrid = ref<number[]>([]);
const pencilMarks = ref<number[]>(new Array<number>(81).fill(0));
const selectedIndex = ref<number | null>(null);
const pencilMode = ref(false);
const conflictCells = ref<number[]>([]);
const hint = ref<Hint | null>(null);

const cellRefs = ref<(HTMLButtonElement | null)[]>([]);
function setCellRef(el: Element | null, i: number) {
  cellRefs.value[i] = (el as HTMLButtonElement | null) ?? null;
}

function regenerate() {
  genError.value = null;
  try {
    const made = generatePuzzle({
      difficulty: difficulty.value,
      seed: seedToNumber(seedText.value),
    });
    puzzle.value = made.puzzle;
    solution.value = made.solution;
    solutionNote.value = null;
    userGrid.value = made.puzzle.slice();
  } catch (e) {
    genError.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: "That puzzle could not be generated." };
  }
  resetTransient();
}

function resetTransient() {
  pencilMarks.value = new Array<number>(81).fill(0);
  selectedIndex.value = null;
  conflictCells.value = [];
  hint.value = null;
}

function onDifficultyChange(value: string) {
  difficulty.value = value as Difficulty;
  puzzleSource.value = "generated";
  regenerate();
}

function onSeedChange(value: string) {
  seedText.value = value;
  puzzleSource.value = "generated";
  regenerate();
}

function newRandomPuzzle() {
  seedText.value = randomSeedText();
  puzzleSource.value = "generated";
  regenerate();
}

function loadPastedPuzzle() {
  pasteError.value = null;
  try {
    const grid = parsePuzzle(pasteText.value);
    const result = solve(grid);
    if (result.status === "no-solution") {
      pasteError.value = {
        message:
          "This grid has no solution: no arrangement of digits satisfies every row, column, and box.",
        fix: "Check the givens for a typo. A grid can look legal cell by cell and still be impossible as a whole.",
      };
      return;
    }
    puzzle.value = grid;
    solution.value = result.solution ?? null;
    solutionNote.value =
      result.status === "multiple-solutions"
        ? "At least two solutions exist for this puzzle, so it is under-constrained. One valid answer is used for hints and checking."
        : null;
    userGrid.value = grid.slice();
    puzzleSource.value = "pasted";
    resetTransient();
    pasteText.value = "";
  } catch (e) {
    pasteError.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: "That puzzle could not be read." };
  }
}

/* ------------------------------------------------------------------ *
 * Grid geometry and cell state
 * ------------------------------------------------------------------ */

const CELL_INDICES = Array.from({ length: 81 }, (_, i) => i);

function boxOf(i: number): number {
  return Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3);
}

function isGiven(i: number): boolean {
  return (puzzle.value[i] ?? 0) !== 0;
}

function isPeer(a: number, b: number): boolean {
  return rowOf(a) === rowOf(b) || colOf(a) === colOf(b) || boxOf(a) === boxOf(b);
}

const conflictSet = computed(() => new Set(conflictCells.value));

const isComplete = computed(() => userGrid.value.every((v) => v !== 0));
const isCorrect = computed(() => {
  if (!isComplete.value) return false;
  if (findConflicts(userGrid.value).length > 0) return false;
  if (!solution.value) return true;
  return userGrid.value.every((v, i) => v === solution.value![i]);
});

function cellSurfaceClass(i: number): string {
  return (Math.floor(rowOf(i) / 3) + Math.floor(colOf(i) / 3)) % 2 === 0
    ? "bg-card"
    : "bg-secondary/50";
}

function cellClasses(i: number): string {
  const classes = [cellSurfaceClass(i)];
  const sel = selectedIndex.value;

  if (conflictSet.value.has(i))
    classes.push("ring-1 ring-inset ring-destructive/70 bg-destructive/10");
  else if (hint.value?.index === i)
    classes.push("ring-2 ring-inset ring-[color:var(--brand-hairline)] bg-[var(--accent-soft)]");
  else if (sel === i) classes.push("ring-2 ring-inset ring-ring");
  else if (sel !== null && isPeer(sel, i)) classes.push("bg-[var(--accent-soft)]/40");
  else if (sel !== null && userGrid.value[sel] !== 0 && userGrid.value[i] === userGrid.value[sel])
    classes.push("bg-[var(--accent-soft)]/60");

  return classes.join(" ");
}

function cellTextClass(i: number): string {
  if (conflictSet.value.has(i)) return "text-destructive";
  if (isGiven(i)) return "font-semibold text-foreground";
  return "font-medium text-primary";
}

/* ------------------------------------------------------------------ *
 * Digit entry
 * ------------------------------------------------------------------ */

function setValue(i: number, value: number) {
  if (isGiven(i)) return;
  const next = userGrid.value.slice();
  next[i] = value;
  userGrid.value = next;
  if (value !== 0) {
    const marks = pencilMarks.value.slice();
    marks[i] = 0;
    pencilMarks.value = marks;
  }
  conflictCells.value = [];
  hint.value = null;
}

function togglePencilMark(i: number, digit: number) {
  if (isGiven(i) || userGrid.value[i] !== 0) return;
  const marks = pencilMarks.value.slice();
  marks[i] = (marks[i] ?? 0) ^ (1 << digit);
  pencilMarks.value = marks;
}

function pencilDigits(i: number): number[] {
  const mask = pencilMarks.value[i] ?? 0;
  const out: number[] = [];
  for (let d = 1; d <= 9; d += 1) if (mask & (1 << d)) out.push(d);
  return out;
}

function pressDigit(digit: number) {
  const i = selectedIndex.value;
  if (i === null) return;
  if (pencilMode.value) togglePencilMark(i, digit);
  else setValue(i, digit);
}

function clearSelected() {
  const i = selectedIndex.value;
  if (i === null) return;
  setValue(i, 0);
}

const canEditSelected = computed(
  () => selectedIndex.value !== null && !isGiven(selectedIndex.value),
);

/* ------------------------------------------------------------------ *
 * Selection and keyboard navigation
 * ------------------------------------------------------------------ */

async function selectCell(i: number, focus = true) {
  selectedIndex.value = i;
  if (focus) {
    await nextTick();
    cellRefs.value[i]?.focus();
  }
}

function onCellKeydown(e: KeyboardEvent, i: number) {
  const r = rowOf(i);
  const c = colOf(i);

  if (e.key === "ArrowLeft" && c > 0) {
    e.preventDefault();
    void selectCell(i - 1);
  } else if (e.key === "ArrowRight" && c < 8) {
    e.preventDefault();
    void selectCell(i + 1);
  } else if (e.key === "ArrowUp" && r > 0) {
    e.preventDefault();
    void selectCell(i - 9);
  } else if (e.key === "ArrowDown" && r < 8) {
    e.preventDefault();
    void selectCell(i + 9);
  } else if (/^[1-9]$/.test(e.key)) {
    e.preventDefault();
    pressDigit(Number(e.key));
  } else if (e.key === "0" || e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    clearSelected();
  }
}

/* ------------------------------------------------------------------ *
 * Check and hint
 * ------------------------------------------------------------------ */

const checkMessage = ref<{ variant: "error" | "info"; title: string; message: string } | null>(
  null,
);

function runCheck() {
  hint.value = null;
  const conflicts = findConflicts(userGrid.value);
  conflictCells.value = conflicts;
  if (conflicts.length > 0) {
    checkMessage.value = {
      variant: "error",
      title: `${conflicts.length} cell${conflicts.length === 1 ? "" : "s"} conflict`,
      message:
        "A digit repeats in its row, column, or box. Fix the highlighted cells and check again.",
    };
  } else if (isComplete.value) {
    checkMessage.value = isCorrect.value
      ? {
          variant: "info",
          title: "Solved",
          message: "Every cell is filled and matches the answer.",
        }
      : {
          variant: "error",
          title: "Not quite",
          message:
            "Every cell is filled and no rule is broken, but this does not match the answer.",
        };
  } else {
    checkMessage.value = {
      variant: "info",
      title: "No conflicts",
      message: `No rule is broken so far. ${81 - clueCount(userGrid.value)} cells remain.`,
    };
  }
}

function requestHint() {
  conflictCells.value = [];
  checkMessage.value = null;
  hint.value = nextHint(userGrid.value);
}

function applyHint() {
  const h = hint.value;
  if (!h || h.index === undefined || h.value === undefined) return;
  setValue(h.index, h.value);
  hint.value = null;
}

watch(userGrid, () => {
  checkMessage.value = null;
});

/* ------------------------------------------------------------------ *
 * Copy as text and print
 * ------------------------------------------------------------------ */

function currentGridText(): string {
  return formatGrid(userGrid.value, "grid");
}

function printBoard() {
  window.print();
}

/* ------------------------------------------------------------------ *
 * Fragment: difficulty, seed, and a pasted puzzle's text. Never the
 * player's own progress or pencil marks (rule 6).
 * ------------------------------------------------------------------ */

const mounted = ref(false);

watch([difficulty, seedText, puzzleSource, puzzle], () => {
  if (!mounted.value) return;
  const input = puzzleSource.value === "pasted" ? formatGrid(puzzle.value, "line") : undefined;
  writeFragment({ input, opts: { difficulty: difficulty.value, seed: seedText.value } });
});

onMounted(() => {
  const frag = readFragment();
  if (frag.opts.difficulty && (DIFFICULTIES as readonly string[]).includes(frag.opts.difficulty)) {
    difficulty.value = frag.opts.difficulty as Difficulty;
  }
  if (frag.opts.seed) seedText.value = frag.opts.seed;

  if (frag.input && frag.input.trim()) {
    pasteText.value = frag.input;
    loadPastedPuzzle();
  } else {
    regenerate();
  }

  mounted.value = true;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="no-print flex flex-wrap items-end justify-between gap-4">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Difficulty
        </span>
        <Segmented
          :model-value="difficulty"
          :options="difficultyOptions"
          label="Difficulty"
          size="sm"
          @update:model-value="onDifficultyChange"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="sudoku-seed" class="text-xs text-muted-foreground">Seed</Label>
        <Input
          id="sudoku-seed"
          :model-value="seedText"
          spellcheck="false"
          class="h-8 w-36 font-mono text-xs"
          @update:model-value="(v) => onSeedChange(String(v))"
        />
      </div>

      <Button size="sm" @click="newRandomPuzzle">
        <Shuffle class="size-3.5" aria-hidden="true" />
        New puzzle
      </Button>
    </div>

    <ErrorBanner v-if="genError" :message="genError.message" :hint="genError.fix" />

    <p v-if="solutionNote" class="no-print text-xs text-muted-foreground">{{ solutionNote }}</p>

    <!-- Board -->
    <div class="flex flex-col items-center gap-3">
      <div
        class="sudoku-print-area grid aspect-square w-full max-w-[420px] grid-cols-9 gap-px overflow-hidden rounded-[10px] border border-border shadow-[var(--sh-inset)]"
      >
        <button
          v-for="i in CELL_INDICES"
          :key="i"
          :ref="(el) => setCellRef(el as Element | null, i)"
          type="button"
          class="relative flex items-center justify-center border border-border/60 text-lg outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring"
          :class="cellClasses(i)"
          :tabindex="selectedIndex === i || (selectedIndex === null && i === 0) ? 0 : -1"
          :aria-label="`Row ${rowOf(i) + 1}, column ${colOf(i) + 1}${userGrid[i] ? `, ${userGrid[i]}` : ', empty'}${isGiven(i) ? ', given' : ''}`"
          @click="selectCell(i, false)"
          @keydown="onCellKeydown($event, i)"
        >
          <span v-if="userGrid[i]" :class="cellTextClass(i)">{{ userGrid[i] }}</span>
          <div
            v-else-if="pencilDigits(i).length"
            class="grid grid-cols-3 grid-rows-3 place-items-center gap-0 text-[9px] leading-none text-muted-foreground"
          >
            <span v-for="d in 9" :key="d" class="flex size-full items-center justify-center">
              {{ pencilDigits(i).includes(d) ? d : "" }}
            </span>
          </div>
        </button>
      </div>

      <!-- Digit palette: keeps the board playable without a physical keyboard -->
      <div class="no-print flex flex-wrap items-center justify-center gap-1.5">
        <Button
          v-for="d in 9"
          :key="d"
          variant="outline"
          size="sm"
          class="size-8 p-0 font-mono"
          :disabled="!canEditSelected"
          @click="pressDigit(d)"
        >
          {{ d }}
        </Button>
        <Button variant="outline" size="sm" :disabled="!canEditSelected" @click="clearSelected">
          <Eraser class="size-3.5" aria-hidden="true" />
          Clear
        </Button>
        <div class="ml-2 flex items-center gap-1.5">
          <Switch id="sudoku-pencil" v-model="pencilMode" size="sm" />
          <Label for="sudoku-pencil" class="flex cursor-pointer items-center gap-1 text-xs">
            <Pencil class="size-3.5" aria-hidden="true" />
            Pencil marks
          </Label>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="no-print flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" @click="runCheck">Check</Button>
      <Button variant="outline" size="sm" @click="requestHint">
        <Lightbulb class="size-3.5" aria-hidden="true" />
        Hint
      </Button>
      <Button variant="ghost" size="sm" @click="regenerate">
        <RotateCcw class="size-3.5" aria-hidden="true" />
        Restart this puzzle
      </Button>
      <Button variant="ghost" size="sm" @click="printBoard">
        <Printer class="size-3.5" aria-hidden="true" />
        Print
      </Button>
      <CopyButton :get-text="currentGridText" label="Copy as text" />
    </div>

    <ErrorBanner
      v-if="checkMessage"
      :variant="checkMessage.variant"
      :title="checkMessage.title"
      :message="checkMessage.message"
    />

    <ErrorBanner
      v-if="hint"
      :variant="hint.kind === 'solved' || hint.kind === 'none' ? 'info' : 'info'"
      :title="
        hint.kind === 'naked-single'
          ? 'Naked single'
          : hint.kind === 'hidden-single'
            ? 'Hidden single'
            : hint.kind === 'solved'
              ? 'Solved'
              : 'No single step found'
      "
      :message="hint.explanation"
    >
      <Button v-if="hint.index !== undefined" size="sm" @click="applyHint">Apply this step</Button>
    </ErrorBanner>

    <!-- Paste a puzzle -->
    <details class="no-print rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
      <summary class="cursor-pointer text-xs font-semibold text-muted-foreground uppercase">
        Paste a puzzle to solve
      </summary>
      <div class="mt-2 flex flex-col gap-2">
        <Textarea
          v-model="pasteText"
          rows="4"
          spellcheck="false"
          placeholder="Paste 81 characters, or 9 lines of 9 cells, using 0 or a period for blanks"
          class="resize-y rounded-[10px] font-mono text-sm shadow-[var(--sh-inset)]"
        />
        <div class="flex items-center gap-2">
          <Button size="sm" :disabled="!pasteText.trim()" @click="loadPastedPuzzle">
            Load puzzle
          </Button>
          <span class="text-xs text-muted-foreground">Replaces the board above.</span>
        </div>
        <ErrorBanner v-if="pasteError" :message="pasteError.message" :hint="pasteError.fix" />
      </div>
    </details>
  </div>
</template>

<style>
/* Print isolation, matching the bingo board's pattern: only the grid reaches
   paper. Global on purpose (scoped styles cannot reach the header, sidebar,
   or footer), but this only ever loads on the sudoku page since panels are
   lazy loaded per tool. */
@media print {
  body * {
    visibility: hidden;
  }
  .sudoku-print-area,
  .sudoku-print-area * {
    visibility: visible;
  }
  .sudoku-print-area {
    position: absolute;
    inset: 0;
    margin: auto;
  }
  .no-print {
    display: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sudoku-print-area * {
    transition: none !important;
    animation: none !important;
  }
}
</style>
