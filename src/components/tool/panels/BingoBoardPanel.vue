<script setup lang="ts">
/**
 * Bespoke panel for the bingo board maker.
 *
 * The pure logic layer (src/tools/bingo-card-generator/index.ts) builds the
 * grids from a numeric seed; everything DOM related lives here: the paste box
 * and its live usable-item count, reseeding on demand, drawing the boards as
 * CSS grids, printing just the cards (one per page), and rasterizing a single
 * card to a PNG on a canvas. The pasted list and every option round trip
 * through the URL fragment so a specific set of boards is shareable.
 */
import { computed, onMounted, ref, watch } from "vue";
import { ImageDown, Printer, Shuffle } from "lucide-vue-next";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { cleanItems, generateBoards } from "@/tools/bingo-card-generator/index";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";

const props = defineProps<{ meta: ToolMeta }>();

function optionSpec<T>(id: string): T | undefined {
  return props.meta.options?.find((o) => o.id === id) as T | undefined;
}

function optionDefault(id: string, fallback: string): string {
  const spec = props.meta.options?.find((o) => o.id === id);
  return spec?.default === undefined ? fallback : String(spec.default);
}

const sizeSpec = computed(() => optionSpec<SelectOptionSpec>("size"));

const EXAMPLE_PLACEHOLDER =
  'Paste one item per line, for example:\nCoffee break\nTypo in a deck\nCat on the call\nMuted mic\n"Can everyone see my screen?"\nDouble booked meeting';

/** A cryptographically random uint32, used to pick a fresh seed on reshuffle. */
function randomSeed(): number {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0]!;
}

const itemsText = ref("");
const size = ref(optionDefault("size", "5"));
const freeSpace = ref(props.meta.options?.find((o) => o.id === "freeSpace")?.default !== false);
const freeText = ref(optionDefault("freeText", "FREE"));
const title = ref(optionDefault("title", ""));
const count = ref(Number(optionDefault("count", "4")) || 4);
const seed = ref(randomSeed());
const mounted = ref(false);

const items = computed(() => itemsText.value.split("\n"));
const usableCount = computed(() => cleanItems(items.value).length);
const sizeNumber = computed(() => Number(size.value) || 5);
const hasFreeSpace = computed(() => freeSpace.value && sizeNumber.value % 2 === 1);
const cellsNeeded = computed(
  () => sizeNumber.value * sizeNumber.value - (hasFreeSpace.value ? 1 : 0),
);
const centerIndex = computed(() => {
  const c = Math.floor(sizeNumber.value / 2);
  return c * sizeNumber.value + c;
});

interface GenResult {
  boards: string[][][];
  error: { message: string; fix?: string } | null;
}

const result = computed<GenResult>(() => {
  if (usableCount.value === 0) return { boards: [], error: null };
  try {
    const boards = generateBoards(items.value, {
      size: sizeNumber.value,
      freeSpace: freeSpace.value,
      freeText: freeText.value,
      seed: seed.value,
      count: count.value,
    });
    return { boards, error: null };
  } catch (e) {
    const err =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
    return { boards: [], error: err };
  }
});

function reshuffle() {
  seed.value = randomSeed();
}

function onSizeChange(value: string) {
  size.value = value;
}

/* ---------------------------------------------------------------- */
/* URL fragment: shareable state (rule 6, never localStorage)        */
/* ---------------------------------------------------------------- */

watch([itemsText, size, freeSpace, freeText, title, count, seed], () => {
  if (!mounted.value) return;
  writeFragment({
    input: itemsText.value,
    opts: {
      size: size.value,
      freeSpace: String(freeSpace.value),
      freeText: freeText.value,
      title: title.value,
      count: String(count.value),
      seed: String(seed.value),
    },
  });
});

onMounted(() => {
  const frag = readFragment();
  if (frag.input !== undefined) itemsText.value = frag.input;
  if (frag.opts.size) size.value = frag.opts.size;
  if (frag.opts.freeSpace !== undefined) freeSpace.value = frag.opts.freeSpace === "true";
  if (frag.opts.freeText !== undefined) freeText.value = frag.opts.freeText;
  if (frag.opts.title !== undefined) title.value = frag.opts.title;
  if (frag.opts.count) count.value = Number(frag.opts.count) || count.value;
  if (frag.opts.seed) seed.value = Number(frag.opts.seed) || seed.value;
  mounted.value = true;
});

/* ---------------------------------------------------------------- */
/* print                                                             */
/* ---------------------------------------------------------------- */

function printBoards() {
  window.print();
}

/* ---------------------------------------------------------------- */
/* PNG export: drawn straight from the grid data, not a DOM snapshot */
/* ---------------------------------------------------------------- */

const CELL_SIZE = 130;
const PADDING = 28;
const TITLE_HEIGHT = 64;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#000000";
}

/** Greedy word wrap: splits text into as few lines as fit the cell width. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = words[0]!;
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

function renderCardCanvas(
  grid: string[][],
  cardTitle: string,
  cardIsFree: boolean,
): HTMLCanvasElement {
  const n = grid.length;
  const titleBlock = cardTitle ? TITLE_HEIGHT : 0;
  const canvas = document.createElement("canvas");
  canvas.width = n * CELL_SIZE + PADDING * 2;
  canvas.height = n * CELL_SIZE + PADDING * 2 + titleBlock;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new ToolError(
      "no-canvas",
      "This browser refused to hand back a 2D drawing context.",
      "Try again in another browser, or use Print instead.",
    );

  const cardColor = cssVar("--card") || "#ffffff";
  const borderColor = cssVar("--border") || "#e7e2da";
  const textColor = cssVar("--card-foreground") || "#1b1917";
  const freeFill = cssVar("--accent-soft") || "#efebfe";
  const primaryColor = cssVar("--primary") || "#5b4bd6";

  ctx.fillStyle = cardColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (cardTitle) {
    ctx.fillStyle = textColor;
    ctx.font = "600 26px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cardTitle, canvas.width / 2, titleBlock / 2 + 8, canvas.width - PADDING * 2);
  }

  const gridTop = PADDING + titleBlock;
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      const x = PADDING + col * CELL_SIZE;
      const y = gridTop + row * CELL_SIZE;
      const isCenter = cardIsFree && row === Math.floor(n / 2) && col === Math.floor(n / 2);

      ctx.fillStyle = isCenter ? freeFill : cardColor;
      ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
      ctx.strokeStyle = isCenter ? primaryColor : borderColor;
      ctx.lineWidth = isCenter ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);

      const cell = grid[row]![col]!;
      ctx.fillStyle = textColor;
      ctx.font = isCenter ? "700 15px system-ui, sans-serif" : "500 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const innerWidth = CELL_SIZE - 16;
      let lines = wrapLines(ctx, cell, innerWidth);
      // Shrink the font until the wrapped text fits inside the cell height.
      let fontSize = isCenter ? 15 : 14;
      while (lines.length * (fontSize + 4) > CELL_SIZE - 12 && fontSize > 9) {
        fontSize -= 1;
        ctx.font = `${isCenter ? 700 : 500} ${fontSize}px system-ui, sans-serif`;
        lines = wrapLines(ctx, cell, innerWidth);
      }
      const lineHeight = fontSize + 4;
      const startY = y + CELL_SIZE / 2 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, i) => {
        ctx.fillText(line, x + CELL_SIZE / 2, startY + i * lineHeight, innerWidth);
      });
    }
  }

  return canvas;
}

function slugFileName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "bingo-card";
}

async function exportCardPng(index: number) {
  const grid = result.value.boards[index];
  if (!grid) return;
  const cardTitle =
    result.value.boards.length > 1 && title.value.trim()
      ? `${title.value.trim()} - Card ${index + 1}`
      : title.value.trim();
  const canvas = renderCardCanvas(grid, cardTitle, hasFreeSpace.value);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugFileName(title.value || "bingo-card")}-${index + 1}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="no-print flex flex-col gap-1.5">
      <Label for="bingo-items" class="text-xs text-muted-foreground">Items, one per line</Label>
      <Textarea
        id="bingo-items"
        v-model="itemsText"
        :placeholder="EXAMPLE_PLACEHOLDER"
        rows="8"
        spellcheck="false"
        class="min-h-40 resize-y rounded-[10px] font-mono text-sm shadow-[var(--sh-inset)] motion-reduce:transition-none"
      />
      <p class="font-mono text-xs text-muted-foreground tabular-nums">
        {{ usableCount }} usable item{{ usableCount === 1 ? "" : "s" }}
        <span v-if="usableCount > 0"> · needs {{ cellsNeeded }} per board</span>
      </p>
    </div>

    <div class="no-print grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="bingo-size" class="text-xs text-muted-foreground">Board size</Label>
        <SearchableSelect
          v-if="sizeSpec"
          id="bingo-size"
          :spec="sizeSpec"
          :model-value="size"
          @update:model-value="onSizeChange"
        />
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="bingo-free" class="w-fit cursor-pointer text-xs text-muted-foreground"
          >Free space</Label
        >
        <div class="flex h-8 items-center">
          <Switch
            id="bingo-free"
            :model-value="freeSpace"
            :disabled="sizeNumber % 2 === 0"
            @update:model-value="(v) => (freeSpace = Boolean(v))"
          />
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="bingo-free-text" class="text-xs text-muted-foreground">Free space text</Label>
        <Input id="bingo-free-text" v-model="freeText" placeholder="FREE" class="h-8" />
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="bingo-count" class="text-xs text-muted-foreground">Number of cards</Label>
        <Input
          id="bingo-count"
          type="number"
          :model-value="count"
          min="1"
          max="50"
          class="h-8"
          @update:model-value="(v) => (count = Number(v) || 1)"
        />
      </div>

      <div class="flex min-w-0 flex-col gap-1.5">
        <Label for="bingo-title" class="text-xs text-muted-foreground">Board title</Label>
        <Input id="bingo-title" v-model="title" placeholder="e.g. Office Party Bingo" class="h-8" />
      </div>
    </div>

    <div class="no-print flex flex-wrap items-center gap-2">
      <Button size="sm" @click="reshuffle">
        <Shuffle class="size-3.5" />
        Shuffle
      </Button>
      <Button v-if="result.boards.length" variant="outline" size="sm" @click="printBoards">
        <Printer class="size-3.5" />
        Print {{ result.boards.length > 1 ? "all cards" : "card" }}
      </Button>
    </div>

    <div
      v-if="usableCount === 0"
      class="rounded-[10px] bg-secondary px-3 py-6 text-center shadow-[var(--sh-inset)]"
    >
      <p class="text-sm text-muted-foreground">
        Paste a list of items above, one per line, and a board fills in here. Your files and inputs
        never leave your device.
      </p>
    </div>

    <div
      v-else-if="result.error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ result.error.message }}
      </p>
      <p v-if="result.error.fix" class="mt-1 text-muted-foreground">
        {{ result.error.fix }}
      </p>
    </div>

    <div v-else class="bingo-print-area flex flex-col gap-6">
      <div
        v-for="(grid, index) in result.boards"
        :key="index"
        class="bingo-card-page flex flex-col gap-2"
      >
        <div class="no-print flex items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {{ result.boards.length > 1 ? `Card ${index + 1}` : "Board" }}
          </span>
          <Button variant="ghost" size="sm" @click="exportCardPng(index)">
            <ImageDown class="size-3.5" />
            Export PNG
          </Button>
        </div>

        <div class="flex flex-col gap-2 rounded-[14px] bg-secondary p-4 shadow-[var(--sh-inset)]">
          <p v-if="title" class="text-center text-base font-semibold">
            {{ title }}{{ result.boards.length > 1 ? ` · Card ${index + 1}` : "" }}
          </p>
          <div
            class="grid gap-1.5"
            :style="{ gridTemplateColumns: `repeat(${sizeNumber}, minmax(0, 1fr))` }"
          >
            <div
              v-for="(cell, i) in grid.flat()"
              :key="i"
              class="flex aspect-square items-center justify-center rounded-[8px] border border-border bg-card p-1.5 text-center text-[11px] break-words hyphens-auto sm:text-xs"
              :class="
                hasFreeSpace && i === centerIndex
                  ? 'border-[color:var(--brand-hairline)] bg-[var(--accent-soft)] font-semibold'
                  : ''
              "
            >
              {{ cell }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* Print isolation: only the generated cards should reach paper, one card per
   page. Scoped styles cannot reach outside this component (header, sidebar,
   footer), so this block is intentionally global but only ever loads on the
   bingo board page, since panels are lazy-loaded per tool. */
@media print {
  body * {
    visibility: hidden;
  }
  .bingo-print-area,
  .bingo-print-area * {
    visibility: visible;
  }
  .bingo-print-area {
    position: absolute;
    inset: 0;
    padding: 0;
    margin: 0;
  }
  .bingo-card-page {
    page-break-after: always;
    break-after: page;
  }
  .bingo-card-page:last-child {
    page-break-after: auto;
    break-after: auto;
  }
  .no-print {
    display: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bingo-print-area * {
    transition: none !important;
    animation: none !important;
  }
}
</style>
