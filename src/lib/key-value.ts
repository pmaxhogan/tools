/**
 * Shared key/value row helpers behind `KeyValueGrid.vue`.
 *
 * This module is pure: no DOM, no globals, no framework. The grid component
 * needs to decide, per row, whether a value is short enough to sit in one
 * column of a multi column layout or long enough that it has to span the whole
 * row. That decision is a plain string predicate, so it lives here where it can
 * be unit tested instead of inside a template expression.
 */

/** One labeled value. `long` overrides the automatic length test either way. */
export interface KeyValueRow {
  /** The label shown above the value. */
  key: string;
  /** The value itself. Always a string: the grid renders text, not markup. */
  value: string;
  /**
   * Force the full width treatment on (`true`) or off (`false`). Left
   * undefined, `isLongValue` decides.
   */
  long?: boolean;
}

/**
 * Values longer than this wrap badly inside a third of a content column, so
 * they span the full row instead. Sixty characters is roughly the point where
 * a monospace value stops fitting on one line in the narrowest column the grid
 * produces, which is also the width a popped out panel gives it.
 */
export const LONG_VALUE_CHARS = 60;

/** True when a value needs the full row rather than a single column. */
export function isLongValue(value: string): boolean {
  return value.length > LONG_VALUE_CHARS || value.includes("\n");
}

/**
 * Turns a plain record into rows, preserving insertion order. Insertion order
 * is the contract: tool logic builds these records in the order it wants them
 * read, so sorting here would quietly reorder every generic tool output.
 */
export function recordToRows(record: Record<string, string>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

/**
 * The "copy everything" payload for a set of rows: one `key: value` line each.
 * Kept next to the rows so the copy all button and the per row buttons can
 * never drift apart.
 */
export function rowsToText(rows: readonly KeyValueRow[]): string {
  return rows.map((row) => `${row.key}: ${row.value}`).join("\n");
}
