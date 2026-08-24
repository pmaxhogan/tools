import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
  parseSidebarWidth,
  sidebarWidthCss,
  sidebarWidthFromPx,
  stepSidebarWidth,
} from "./sidebar-width";

describe("clampSidebarWidth", () => {
  it("passes an in-range width through", () => {
    expect(clampSidebarWidth(20)).toBe(20);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MIN)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(SIDEBAR_WIDTH_MAX)).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("clamps to the range", () => {
    expect(clampSidebarWidth(4)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(999)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(-12)).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("rounds to hundredths so a drag never stores float noise", () => {
    expect(clampSidebarWidth(17.123456)).toBe(17.12);
    expect(clampSidebarWidth(16.999999)).toBe(17);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});

describe("parseSidebarWidth", () => {
  it("reads a bare number and a rem length", () => {
    expect(parseSidebarWidth("21")).toBe(21);
    expect(parseSidebarWidth("21.5rem")).toBe(21.5);
    expect(parseSidebarWidth(" 21.5 rem ")).toBe(21.5);
    expect(parseSidebarWidth("21REM")).toBe(21);
  });

  it("clamps what it reads", () => {
    expect(parseSidebarWidth("400")).toBe(SIDEBAR_WIDTH_MAX);
    expect(parseSidebarWidth("2rem")).toBe(SIDEBAR_WIDTH_MIN);
  });

  it("returns null when there is nothing usable", () => {
    expect(parseSidebarWidth(null)).toBeNull();
    expect(parseSidebarWidth(undefined)).toBeNull();
    expect(parseSidebarWidth("")).toBeNull();
    expect(parseSidebarWidth("   ")).toBeNull();
    expect(parseSidebarWidth("wide")).toBeNull();
    expect(parseSidebarWidth("rem")).toBeNull();
  });
});

describe("stepSidebarWidth", () => {
  it("moves by whole rem steps", () => {
    expect(stepSidebarWidth(17, 1)).toBe(18);
    expect(stepSidebarWidth(17, -1)).toBe(16);
    expect(stepSidebarWidth(17.5, -1)).toBe(16.5);
    expect(stepSidebarWidth(17, 3)).toBe(20);
  });

  it("stops at the ends of the range", () => {
    expect(stepSidebarWidth(SIDEBAR_WIDTH_MIN, -1)).toBe(SIDEBAR_WIDTH_MIN);
    expect(stepSidebarWidth(SIDEBAR_WIDTH_MAX, 1)).toBe(SIDEBAR_WIDTH_MAX);
    expect(stepSidebarWidth(SIDEBAR_WIDTH_MAX - 0.5, 1)).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("starts from the default when the current width is unusable", () => {
    expect(stepSidebarWidth(Number.NaN, 1)).toBe(SIDEBAR_WIDTH_DEFAULT + 1);
  });
});

describe("sidebarWidthFromPx", () => {
  it("converts pixels to rem against the root font size", () => {
    expect(sidebarWidthFromPx(272, 16)).toBe(17);
    expect(sidebarWidthFromPx(340, 20)).toBe(17);
    expect(sidebarWidthFromPx(300, 16)).toBe(18.75);
  });

  it("clamps a drag that runs past either end", () => {
    expect(sidebarWidthFromPx(0, 16)).toBe(SIDEBAR_WIDTH_MIN);
    expect(sidebarWidthFromPx(4000, 16)).toBe(SIDEBAR_WIDTH_MAX);
  });

  it("falls back to the default when the root font size is unusable", () => {
    expect(sidebarWidthFromPx(272, 0)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(sidebarWidthFromPx(272, Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});

describe("sidebarWidthCss", () => {
  it("renders a rem length", () => {
    expect(sidebarWidthCss(17)).toBe("17rem");
    expect(sidebarWidthCss(21.5)).toBe("21.5rem");
    expect(sidebarWidthCss(999)).toBe(`${SIDEBAR_WIDTH_MAX}rem`);
  });
});

/**
 * BaseLayout applies the stored width before paint, from an `is:inline` script
 * that cannot import this module. That copy of the key and the range has to
 * stay in sync, so assert it is still there. Loose on purpose: the check is
 * about the numbers surviving, not about how the script is formatted.
 */
describe("the pre-paint copy in BaseLayout", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../layouts/BaseLayout.astro", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("function applyHtmlState");
  const script = source.slice(start, source.indexOf("applyHtmlState();", start));

  it("was found", () => {
    expect(start).toBeGreaterThan(-1);
    expect(script.length).toBeGreaterThan(0);
  });

  it("uses the same storage key", () => {
    expect(script).toContain(`"${SIDEBAR_WIDTH_KEY}"`);
    expect(script).toContain("--sidebar-w");
  });

  it("uses the same range and default", () => {
    for (const value of [SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_DEFAULT]) {
      expect(script).toMatch(new RegExp(`\\b${value}\\b`));
    }
  });
});
