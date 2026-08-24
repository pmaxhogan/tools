<script setup lang="ts">
import { computed } from "vue";
import CopyButton from "./CopyButton.vue";
import { isLongValue, recordToRows, type KeyValueRow } from "@/lib/key-value";

/**
 * The shared labeled value grid. One place to render "here are twelve facts
 * about your file" so that every tool spells it the same way.
 *
 * LAYOUT
 * ------
 * A CSS grid, one column on phones, two at `lg` and three at `xl`. The
 * breakpoints are viewport based on purpose: a panel that has been popped out
 * into its own small window gets that window's viewport, so it collapses to a
 * single readable column without any container query plumbing.
 *
 * HAIRLINES
 * ---------
 * Every cell draws its own right and bottom seam, and the grid pulls itself 1px
 * past the clipping wrapper so the outermost two never show. Each cell owning
 * its seams is what survives a long value taking `col-span-full`: `divide-*` and
 * nth-child rules both assume a fixed number of cells per row, and a
 * gap-plus-background grid paints every empty cell of a ragged last row in the
 * border color. The surface lives on the wrapper so those empty cells match the
 * filled ones exactly; `surface` picks the one that matches the box the grid was
 * dropped into.
 */

const props = withDefaults(
  defineProps<{
    /** Rows to render. Takes precedence over `record` when both are given. */
    rows?: KeyValueRow[];
    /** Convenience input: a plain record, converted in insertion order. */
    record?: Record<string, string>;
    /**
     * Column count. "auto" is the responsive 1/2/3 ladder. A fixed count still
     * collapses to one column on phones so the page never scrolls sideways.
     * Pass it bound (`:columns="2"`), never as a bare attribute.
     */
    columns?: "auto" | 1 | 2 | 3;
    /** Per row copy buttons. */
    copy?: boolean;
    /** Tighter padding and smaller value text, for supporting detail. */
    dense?: boolean;
    /** The surface the cells sit on. Match the box that contains the grid. */
    surface?: "secondary" | "card" | "background";
  }>(),
  // `rows` and `record` default to undefined on purpose: one of the two is
  // always supplied, and an empty array default would make `record` unreachable
  // because `rows ?? ...` would never fall through. Spelled out rather than
  // omitted so vue/require-default-prop can see the intent.
  {
    rows: undefined,
    record: undefined,
    columns: "auto",
    copy: true,
    dense: false,
    surface: "secondary",
  },
);

/**
 * Written out in full so Tailwind's scanner sees every class literally. Keyed
 * by string because a `columns="2"` attribute that forgot its binding arrives
 * as the string "2", and silently falling back to "auto" would be a layout bug
 * nobody notices in review.
 */
const COLUMN_CLASSES: Record<string, string> = {
  auto: "grid-cols-1 lg:grid-cols-2 xl:grid-cols-3",
  "1": "grid-cols-1",
  "2": "grid-cols-1 sm:grid-cols-2",
  "3": "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
};

const SURFACE_CLASSES: Record<string, string> = {
  secondary: "bg-secondary",
  card: "bg-card",
  background: "bg-background",
};

const allRows = computed<KeyValueRow[]>(() => props.rows ?? recordToRows(props.record ?? {}));

const columnClass = computed(() => COLUMN_CLASSES[String(props.columns)] ?? COLUMN_CLASSES.auto);
const surfaceClass = computed(() => SURFACE_CLASSES[props.surface] ?? SURFACE_CLASSES.secondary);
const cellPadClass = computed(() => (props.dense ? "px-2.5 py-1.5" : "px-3 py-2"));
const valueTextClass = computed(() => (props.dense ? "text-xs" : "text-sm"));

/** An explicit `long` on the row wins over the length test in both directions. */
function isLong(row: KeyValueRow): boolean {
  return row.long ?? isLongValue(row.value);
}

/** The copy button is unlabeled, so name the row it belongs to. */
function copyLabel(row: KeyValueRow): string {
  return `Copy ${row.key}`;
}
</script>

<template>
  <div v-if="allRows.length" class="overflow-hidden rounded-[10px]" :class="surfaceClass">
    <dl class="-mr-px -mb-px grid" :class="columnClass">
      <div
        v-for="(row, i) in allRows"
        :key="`${row.key}-${i}`"
        class="min-w-0 border-r border-b border-border/60"
        :class="[cellPadClass, isLong(row) ? 'col-span-full' : '']"
      >
        <dt class="text-xs text-muted-foreground">{{ row.key }}</dt>
        <dd
          class="flex min-w-0 justify-between gap-2"
          :class="isLong(row) ? 'items-start' : 'items-center'"
        >
          <span
            class="min-w-0 flex-1 font-mono break-words whitespace-pre-wrap"
            :class="[valueTextClass, isLong(row) ? 'max-h-40 overflow-y-auto' : '']"
            >{{ row.value }}</span
          >
          <CopyButton v-if="copy" :text="row.value" :aria-label="copyLabel(row)" class="shrink-0" />
        </dd>
      </div>
    </dl>
  </div>
</template>
