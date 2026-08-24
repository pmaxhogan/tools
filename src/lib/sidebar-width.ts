/**
 * Sidebar width preference: the pure math behind the resize handle.
 *
 * The tool sidebar is resizable at xl and up. The chosen width is a preference,
 * never content (rule 7), so it lives in localStorage under `sidebar-width` as
 * a plain rem number and is applied before paint by BaseLayout's applyHtmlState
 * so the column never flashes at the wrong size on load or after a navigation.
 *
 * Everything here is pure and DOM free: the pixel conversion takes the root
 * font size as an argument instead of reading the document, so the range,
 * clamping and rounding rules are unit tested rather than eyeballed in a
 * browser. SidebarNav.vue owns the pointer and keyboard wiring that calls in.
 *
 * The same range and default are duplicated in the inline applyHtmlState script
 * in src/layouts/BaseLayout.astro, which cannot import a module because it has
 * to run before paint. sidebar-width.test.ts guards that copy against drift.
 */

/** localStorage key holding the width preference, in rem. */
export const SIDEBAR_WIDTH_KEY = "sidebar-width";

/** Narrowest useful sidebar: tool names still read without truncating hard. */
export const SIDEBAR_WIDTH_MIN = 14;

/** Widest sidebar: past this the content column starts to feel squeezed. */
export const SIDEBAR_WIDTH_MAX = 28;

/** The shipped default, and the width a double click on the handle restores. */
export const SIDEBAR_WIDTH_DEFAULT = 17;

/** One keyboard step on the handle (ArrowLeft / ArrowRight). */
export const SIDEBAR_WIDTH_STEP = 1;

/**
 * Widths round to hundredths of a rem: fine enough that a drag feels
 * continuous, coarse enough to keep the stored value and the CSS readable.
 */
const PRECISION = 100;

/** Bring any number into the supported range. Junk resolves to the default. */
export function clampSidebarWidth(rem: number): number {
  if (!Number.isFinite(rem)) return SIDEBAR_WIDTH_DEFAULT;
  const bounded = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, rem));
  return Math.round(bounded * PRECISION) / PRECISION;
}

/**
 * Read a stored width. Accepts a bare number or a rem length, since an older
 * build wrote one and a hand-edited value could be either. Returns null when
 * there is nothing usable, so the caller decides what the fallback is.
 */
export function parseSidebarWidth(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim().replace(/rem$/i, "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return clampSidebarWidth(value);
}

/** Move a width by `steps` keyboard steps, clamped to the range. */
export function stepSidebarWidth(rem: number, steps: number): number {
  return clampSidebarWidth(clampSidebarWidth(rem) + steps * SIDEBAR_WIDTH_STEP);
}

/**
 * Width in rem for a drag that put the sidebar's right edge `px` pixels from
 * its left edge. `rootFontSizePx` is the computed font size of the root
 * element, which is what a rem resolves against.
 */
export function sidebarWidthFromPx(px: number, rootFontSizePx: number): number {
  if (!Number.isFinite(rootFontSizePx) || rootFontSizePx <= 0) return SIDEBAR_WIDTH_DEFAULT;
  return clampSidebarWidth(px / rootFontSizePx);
}

/** The CSS length for a width, ready for the `--sidebar-w` custom property. */
export function sidebarWidthCss(rem: number): string {
  return `${clampSidebarWidth(rem)}rem`;
}
