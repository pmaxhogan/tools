import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  categoryByLabel,
  categoryBySlug,
  categoryPath,
  categoryRank,
  type ToolCategory,
} from "./categories";

/**
 * The lookups here are what replaced the three alphabetical `localeCompare`
 * sorts in the sidebar, the palette and the homepage grid, so the contract they
 * have to keep is narrow but load bearing: rank is the position in CATEGORIES,
 * an unknown label sorts last instead of throwing, and a path is always
 * `/category/<slug>`.
 */
describe("categoryRank", () => {
  it("ranks labels in declaration order", () => {
    const ranks = CATEGORIES.map((c) => categoryRank(c.label));
    expect(ranks).toEqual(CATEGORIES.map((_, i) => i));
  });

  it("sorts an unknown label last", () => {
    expect(categoryRank("Not A Category")).toBe(CATEGORIES.length);
    expect(categoryRank("Not A Category")).toBeGreaterThan(
      categoryRank(CATEGORIES[CATEGORIES.length - 1]!.label),
    );
  });

  it("orders a shuffled label list back into display order", () => {
    const labels = CATEGORIES.map((c) => c.label);
    const shuffled = [...labels].reverse();
    shuffled.sort((a, b) => categoryRank(a) - categoryRank(b));
    expect(shuffled).toEqual(labels);
  });
});

describe("categoryPath", () => {
  it("builds the route from a category object", () => {
    const text = categoryBySlug("text") as ToolCategory;
    expect(categoryPath(text)).toBe("/category/text");
  });

  it("accepts a display label as well", () => {
    expect(categoryPath("Local AI")).toBe("/category/local-ai");
  });

  it("returns the same path either way for every category", () => {
    for (const c of CATEGORIES) {
      expect(categoryPath(c.label)).toBe(categoryPath(c));
    }
  });
});

describe("category descriptions", () => {
  it("keeps every description short enough to survive both places it is used", () => {
    // A description is the category page's meta description (search results
    // clip it past roughly 160 characters) and the body of its OG card, where
    // src/lib/og.ts renders at 32px with a 140px max height, so a fourth line
    // is cut off mid-sentence. Three lines is about 155 characters.
    const tooLong = CATEGORIES.filter((c) => c.description.length > 155);
    expect(tooLong.map((c) => `${c.slug} (${c.description.length})`)).toEqual([]);
  });

  it("ends each description as a sentence", () => {
    expect(CATEGORIES.filter((c) => !c.description.endsWith(".")).map((c) => c.slug)).toEqual([]);
  });
});

describe("category lookups", () => {
  it("round trips label and slug", () => {
    for (const c of CATEGORIES) {
      expect(categoryByLabel(c.label)).toBe(c);
      expect(categoryBySlug(c.slug)).toBe(c);
    }
  });

  it("returns undefined for a name that is not a category", () => {
    expect(categoryByLabel("text")).toBeUndefined();
    expect(categoryBySlug("Text")).toBeUndefined();
  });
});
