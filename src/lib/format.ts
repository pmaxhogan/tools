/**
 * Shared value formatters.
 *
 * This module is pure: no DOM, no globals, no framework. Tool logic under
 * src/tools is allowed to import it (the purity lint restricts vue, components,
 * and astro imports, not @/lib), which is the point. Before it existed,
 * `humanSize` had been copy-pasted into 22 files in five subtly different
 * variants, so the same file reported a different size depending on which tool
 * you happened to open it in.
 */

/** Units above bytes, in ascending order. Index 0 is the first step up. */
const UNITS = ["KB", "MB", "GB", "TB"] as const;

export type ByteUnit = (typeof UNITS)[number];

export interface FormatBytesOptions {
  /**
   * Largest unit to scale up to. Sizes beyond it keep counting in that unit
   * ("2048 TB" rather than "2 PB"). Default "TB".
   */
  maxUnit?: ByteUnit;
  /** Decimal places for scaled values below 10. Default 1, so "4.8 MB". */
  precision?: number;
  /**
   * Decimal places for scaled values of 10 or more. Default 0, so "512 MB":
   * past two significant figures the extra digit is noise in a UI.
   */
  largePrecision?: number;
  /**
   * Round to whole bytes and floor at zero first. Default true. Pass false when
   * formatting a signed delta, where "-2.0 KB" is the meaningful answer.
   */
  clamp?: boolean;
}

/**
 * Bytes as a short human-readable size: "0 B", "999 B", "1.0 KB", "512 MB".
 *
 * Scaling is binary (1024), matching every other size the tools report and the
 * `ls -h` convention users compare against.
 */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
  const { maxUnit = "TB", precision = 1, largePrecision = 0, clamp = true } = options;

  const n = clamp ? Math.max(0, Math.round(bytes)) : bytes;
  if (!Number.isFinite(n)) return `${n} B`;
  if (Math.abs(n) < 1024) return `${n} B`;

  const ceiling = UNITS.indexOf(maxUnit);
  let value = n / 1024;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < ceiling) {
    value /= 1024;
    unit += 1;
  }

  const decimals = Math.abs(value) < 10 ? precision : largePrecision;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

/** An exact byte count with thousands separators: "1,234 bytes". */
export function formatByteCount(bytes: number): string {
  const n = Math.max(0, Math.round(bytes));
  return `${n.toLocaleString("en-US")} ${n === 1 ? "byte" : "bytes"}`;
}
