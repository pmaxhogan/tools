import { describe, expect, it } from "vitest";
import { ADDED_DATES } from "@/tools/added-dates";
import { NEW_BADGE_MAX, NEW_TOOL_DAYS, addedDate, isNewTool, newBadgeSlugs } from "./tool-dates";

const DATES = {
  fresh: "2026-08-20",
  older: "2026-06-01",
  edge: "2026-08-01",
  broken: "not a date",
  future: "2027-01-01",
};

/** 2026-08-30T00:00:00Z, the reference "now" for the cases below. */
const NOW = Date.parse("2026-08-30");

describe("addedDate", () => {
  it("returns the stored date", () => {
    expect(addedDate("fresh", DATES)).toBe("2026-08-20");
  });

  it("returns undefined for a tool the snapshot does not have", () => {
    expect(addedDate("nope", DATES)).toBeUndefined();
  });
});

describe("isNewTool", () => {
  it("is true inside the window", () => {
    expect(isNewTool("fresh", NOW, 30, DATES)).toBe(true);
  });

  it("is false outside the window", () => {
    expect(isNewTool("older", NOW, 30, DATES)).toBe(false);
  });

  it("treats the window as exclusive at exactly `days` old", () => {
    // 2026-08-01 is 29 days before 2026-08-30, so it is still in a 30 day
    // window and out of a 29 day one.
    expect(isNewTool("edge", NOW, 30, DATES)).toBe(true);
    expect(isNewTool("edge", NOW, 29, DATES)).toBe(false);
  });

  it("accepts a Date as well as epoch milliseconds", () => {
    expect(isNewTool("fresh", new Date(NOW), 30, DATES)).toBe(true);
  });

  it("is false for a slug the snapshot does not have", () => {
    expect(isNewTool("nope", NOW, 30, DATES)).toBe(false);
  });

  it("is false for an unparsable date rather than throwing", () => {
    expect(isNewTool("broken", NOW, 30, DATES)).toBe(false);
  });

  it("is false for a date in the future, which means a bad snapshot", () => {
    expect(isNewTool("future", NOW, 30, DATES)).toBe(false);
  });

  it("is false for a non-positive window", () => {
    expect(isNewTool("fresh", NOW, 0, DATES)).toBe(false);
    expect(isNewTool("fresh", NOW, -5, DATES)).toBe(false);
  });

  it("is false for an invalid `now`", () => {
    expect(isNewTool("fresh", new Date("nope"), 30, DATES)).toBe(false);
  });

  it("defaults to the 30 day window", () => {
    expect(NEW_TOOL_DAYS).toBe(30);
    expect(isNewTool("fresh", NOW, undefined, DATES)).toBe(true);
    expect(isNewTool("older", NOW, undefined, DATES)).toBe(false);
  });
});

describe("newBadgeSlugs", () => {
  const many = {
    a: "2026-08-20",
    b: "2026-01-01",
    c: "2026-01-02",
    d: "2026-01-03",
  };

  it("returns only the new slugs", () => {
    expect([...newBadgeSlugs(["a", "b", "c", "d"], NOW, 30, many)]).toEqual(["a"]);
  });

  it("handles an empty list", () => {
    expect(newBadgeSlugs([], NOW, 30, many).size).toBe(0);
  });

  it("ignores slugs the snapshot does not have", () => {
    expect(newBadgeSlugs(["a", "ghost", "b", "c"], NOW, 30, many).size).toBe(1);
  });

  it("takes the newest days first", () => {
    const batches = {
      new1: "2026-08-25",
      new2: "2026-08-25",
      old1: "2026-08-10",
      old2: "2026-08-10",
    };
    const out = newBadgeSlugs(["old1", "new1", "old2", "new2"], NOW, 30, batches, 2);
    expect([...out].sort()).toEqual(["new1", "new2"]);
  });

  it("stops before a day that would overflow the cap, rather than splitting it", () => {
    const batches = { a: "2026-08-25", b: "2026-08-20", c: "2026-08-20", d: "2026-08-20" };
    // The newest day is one tool; the next day is three, which would take the
    // total to four, so that whole day is left out.
    expect([...newBadgeSlugs(["a", "b", "c", "d"], NOW, 30, batches, 3)]).toEqual(["a"]);
  });

  it("badges the newest day in full even when it alone is over the cap", () => {
    const batches = { a: "2026-08-25", b: "2026-08-25", c: "2026-08-25" };
    expect(newBadgeSlugs(["a", "b", "c"], NOW, 30, batches, 2).size).toBe(3);
  });

  it("returns nothing for a non-positive cap", () => {
    expect(newBadgeSlugs(["a"], NOW, 30, many, 0).size).toBe(0);
  });

  it("defaults to the documented cap", () => {
    expect(NEW_BADGE_MAX).toBe(12);
  });
});

describe("the badge on the real registry", () => {
  it("lands on a useful handful, never on the whole grid", () => {
    const slugs = Object.keys(ADDED_DATES);
    const newest = Object.values(ADDED_DATES).sort().reverse()[0];
    // A day or two after the newest tool landed, the badge is on that batch
    // and on nothing else.
    const soonAfter = Date.parse(newest) + 2 * 86_400_000;
    const badged = newBadgeSlugs(slugs, soonAfter);
    expect(badged.size).toBeGreaterThan(0);
    expect(badged.size).toBeLessThan(slugs.length / 2);
    for (const slug of badged) expect(ADDED_DATES[slug]).toBe(newest);
  });
});

describe("the committed snapshot", () => {
  it("holds a plain YYYY-MM-DD date for every entry", () => {
    const entries = Object.entries(ADDED_DATES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [slug, date] of entries) {
      expect(date, slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(date)), slug).toBe(false);
    }
  });
});
