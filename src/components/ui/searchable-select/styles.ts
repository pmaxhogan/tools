/**
 * Shared class strings and indentation helpers for the searchable-select, so
 * the leaf-option rows look identical whether they are rendered flat or inside
 * a hierarchical group. Kept out of the .vue files so both the group renderer
 * and the root component share one source of truth.
 */

/** Base indent (px) for a top-level row, and the step added per nesting level. */
const BASE_INDENT = 8;
const INDENT_STEP = 12;

/** Left padding for a leaf option row at the given group depth. */
export function itemPadding(depth: number): string {
  return `${BASE_INDENT + (depth + 1) * INDENT_STEP}px`;
}

/** Left padding for a group label at the given depth (one step shallower). */
export function labelPadding(depth: number): string {
  return `${BASE_INDENT + depth * INDENT_STEP}px`;
}

/**
 * The option row. Violet active row via `--accent-soft` when the keyboard or
 * pointer highlights it; a subtly stronger fill and medium weight when it is
 * the selected value. Color transitions honor reduced motion.
 */
export const ITEM_CLASS =
  "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 text-sm outline-hidden select-none transition-colors duration-100 " +
  "data-highlighted:bg-[color:var(--accent-soft)] data-highlighted:text-foreground " +
  "data-[state=checked]:font-medium data-[state=checked]:text-foreground " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0";
