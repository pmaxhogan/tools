import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  DEFAULT_TEXT,
  MAX_CHARACTERS,
  analyzeText,
  compareLayouts,
  heatFill,
  keyDistance,
  keyEffort,
  renderHeatmapSvg,
  run,
} from "./index";
import { LAYOUTS, LAYOUT_IDS, keyForChar, keyId, resolveLayoutId } from "./layouts";

/** Ordinary English prose, the case the ranking claims are about. */
const PARAGRAPH =
  "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.";

describe("keyboard-heatmap layout data", () => {
  it("ships ten layouts on one shared ANSI grid", () => {
    expect(LAYOUT_IDS).toHaveLength(10);
    expect(LAYOUT_IDS).toContain("colemak-dh");
    expect(LAYOUT_IDS).toContain("graphite");

    for (const id of LAYOUT_IDS) {
      const layout = LAYOUTS[id];
      expect(layout, id).toBeDefined();
      expect(layout.keys, id).toHaveLength(46);

      const perRow = [0, 1, 2, 3].map((row) => layout.keys.filter((key) => key.row === row).length);
      expect(perRow, id).toEqual([13, 12, 11, 10]);

      // Ten resting keys would mean the home row flags drifted; there are eight.
      expect(layout.keys.filter((key) => key.resting).length, id).toBe(8);
      expect(layout.keys.filter((key) => key.home).length, id).toBe(11);
      // Two inner index columns per row.
      expect(layout.keys.filter((key) => key.innerIndex).length, id).toBe(8);

      const chars = layout.keys.map((key) => key.char);
      expect(new Set(chars).size, `${id} has a duplicated character`).toBe(chars.length);
      for (const key of layout.keys) {
        expect([...key.char], `${id} key ${keyId(key)}`).toHaveLength(1);
        expect(key.finger, id).toBeGreaterThanOrEqual(0);
        expect(key.finger, id).toBeLessThanOrEqual(7);
        expect(key.hand, id).toBe(key.finger <= 3 ? "left" : "right");
      }
    }
  });

  it("uses the real ANSI row stagger and finger home positions", () => {
    const qwerty = LAYOUTS.qwerty;
    const at = (char: string) => keyForChar(qwerty, char);

    expect(at("1")?.x).toBe(1);
    expect(at("q")?.x).toBe(1.5);
    expect(at("a")?.x).toBe(1.75);
    expect(at("z")?.x).toBe(2.25);

    // The eight resting keys never move, everything else does.
    for (const char of ["a", "s", "d", "f", "j", "k", "l", ";"]) {
      expect(keyDistance(at(char)!), char).toBe(0);
    }
    expect(keyDistance(at("g")!)).toBeCloseTo(1, 10);
    expect(keyDistance(at("h")!)).toBeCloseTo(1, 10);
  });

  it("resolves layout ids through spacing, case and synonyms", () => {
    expect(resolveLayoutId("QWERTY")).toBe("qwerty");
    expect(resolveLayoutId("Colemak DH")).toBe("colemak-dh");
    expect(resolveLayoutId("colemak_dh")).toBe("colemak-dh");
    expect(resolveLayoutId("mod-dh")).toBe("colemak-dh");
    expect(resolveLayoutId("french")).toBe("azerty");
    expect(resolveLayoutId("german")).toBe("qwertz");
    expect(resolveLayoutId("maltron")).toBeUndefined();
  });

  it("scores effort from the documented weights", () => {
    const qwerty = LAYOUTS.qwerty;
    const at = (char: string) => keyForChar(qwerty, char)!;

    expect(keyEffort(at("f"))).toBe(1); // home row index
    expect(keyEffort(at("a"))).toBe(1.5); // home row pinky
    expect(keyEffort(at("g"))).toBe(1.5); // home row inner index column
    expect(keyEffort(at("e"))).toBe(1.5); // top row middle
    expect(keyEffort(at("q"))).toBe(2); // top row pinky
    expect(keyEffort(at("t"))).toBe(2); // top row inner index column
    expect(keyEffort(at("x"))).toBeCloseTo(1.7, 10); // bottom row ring
    expect(keyEffort(at("b"))).toBeCloseTo(2.2, 10); // bottom row inner index column
    expect(keyEffort(at("1"))).toBe(3); // number row pinky
  });
});

describe("analyzeText", () => {
  it("pins the finger load of a known phrase on QWERTY", () => {
    const analysis = analyzeText("the quick brown fox", "qwerty");

    expect(analysis.characters).toBe(19);
    expect(analysis.whitespace).toBe(3);
    expect(analysis.skipped).toBe(0);
    expect(analysis.keystrokes).toBe(16);

    // q / w x / e c / t r b f | h u n / i k / o o / nothing
    expect(analysis.fingerCounts).toEqual([1, 2, 2, 4, 3, 2, 2, 0]);
    expect(analysis.fingerPercents).toEqual([6.25, 12.5, 12.5, 25, 18.75, 12.5, 12.5, 0]);
    expect(analysis.handCounts).toEqual({ left: 9, right: 7 });
    expect(analysis.handPercents.left).toBeCloseTo(56.25, 10);
    expect(analysis.handPercents.right).toBeCloseTo(43.75, 10);

    // t e q u i r o w o on top, h k f on home, c b n x on the bottom row.
    // Only k and f are resting keys; h is the inner index stretch.
    expect(analysis.rowCounts).toEqual([0, 9, 3, 4]);
    expect(analysis.homeRowPercent).toBeCloseTo(18.75, 10);
    expect(analysis.restingPercent).toBeCloseTo(12.5, 10);

    // Bigrams stop at every space: th he | qu ui ic ck | br ro ow wn | fo ox
    expect(analysis.bigrams).toBe(12);
    expect(analysis.sameFingerBigrams).toBe(1); // br, both on the left index
    expect(analysis.alternations).toBe(10);
    expect(analysis.inwardRolls).toBe(0);
    expect(analysis.outwardRolls).toBe(1); // ui, right index out to right middle
    expect(analysis.lateralStretches).toBe(4); // t, h, b, n

    expect(analysis.effort).toBeCloseTo(25.8, 10);
    expect(analysis.effortPer100).toBeCloseTo(161.25, 10);
    expect(analysis.distance).toBeCloseTo(15.653088855217, 9);
  });

  it("calls ed a same finger bigram on QWERTY but not on Dvorak", () => {
    const qwerty = analyzeText("ed", "qwerty");
    expect(qwerty.bigrams).toBe(1);
    expect(qwerty.sameFingerBigrams).toBe(1);
    expect(qwerty.sameFingerPercent).toBe(100);

    const dvorak = analyzeText("ed", "dvorak");
    expect(dvorak.bigrams).toBe(1);
    expect(dvorak.sameFingerBigrams).toBe(0);
    expect(dvorak.alternations).toBe(1); // e is left middle, d is right index
  });

  it("reports 100 percent home row for asdf on QWERTY", () => {
    const analysis = analyzeText("asdf", "qwerty");
    expect(analysis.homeRowPercent).toBe(100);
    expect(analysis.restingPercent).toBe(100);
    expect(analysis.rowPercents).toEqual([0, 0, 100, 0]);
  });

  it("skips characters the layout has no key for", () => {
    const analysis = analyzeText("ab\u{1F600}cd中", "qwerty");
    expect(analysis.characters).toBe(6);
    expect(analysis.keystrokes).toBe(4);
    expect(analysis.skipped).toBe(2);
    // The emoji breaks the run, so ab and cd are the only bigrams.
    expect(analysis.bigrams).toBe(2);
  });

  it("treats case and shifted symbols as presses of the same key", () => {
    const upper = analyzeText("THE", "qwerty");
    const lower = analyzeText("the", "qwerty");
    expect(upper.fingerCounts).toEqual(lower.fingerCounts);
    expect(upper.effort).toBeCloseTo(lower.effort, 10);

    // % lives on the 5 key on QWERTY, left index, number row.
    const percent = analyzeText("%", "qwerty");
    expect(percent.keystrokes).toBe(1);
    expect(percent.skipped).toBe(0);
    expect(percent.rowCounts[0]).toBe(1);

    // On AZERTY the digits themselves are the shifted layer.
    const digits = analyzeText("12", "azerty");
    expect(digits.keystrokes).toBe(2);
    expect(digits.skipped).toBe(0);
  });

  it("counts whitespace separately and never as a keystroke", () => {
    const analysis = analyzeText("ab cd\nef\tgh", "qwerty");
    expect(analysis.keystrokes).toBe(8);
    expect(analysis.whitespace).toBe(3);
    expect(analysis.skipped).toBe(0);
    expect(analysis.bigrams).toBe(4);
  });

  it("returns an all zero analysis for empty text without dividing by zero", () => {
    const analysis = analyzeText("", "qwerty");
    expect(analysis.keystrokes).toBe(0);
    expect(analysis.effortPer100).toBe(0);
    expect(analysis.homeRowPercent).toBe(0);
    expect(analysis.sameFingerPercent).toBe(0);
    expect(analysis.topKeys).toEqual([]);
  });

  it("ranks the top keys by press count, longest first", () => {
    const analysis = analyzeText("aaabbc", "qwerty", { topKeys: 2 });
    expect(analysis.topKeys.map((hit) => [hit.char, hit.count])).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
    expect(analysis.hitCounts["2-0"]).toBe(3); // a is home row, column 0
  });
});

describe("compareLayouts", () => {
  it("puts Dvorak and Colemak ahead of QWERTY on ordinary English", () => {
    const table = compareLayouts(PARAGRAPH, LAYOUT_IDS);
    expect(Object.keys(table)).toHaveLength(10);

    expect(table.qwerty.rank).toBeGreaterThan(table.dvorak.rank);
    expect(table.qwerty.rank).toBeGreaterThan(table.colemak.rank);
    expect(table.qwerty.effortPer100).toBeGreaterThan(table.dvorak.effortPer100);
    expect(table.qwerty.effortPer100).toBeGreaterThan(table.colemak.effortPer100);
    expect(table.colemak.homeRowPercent).toBeGreaterThan(table.qwerty.homeRowPercent);

    // Insertion order is the ranking.
    const ranks = Object.values(table).map((row) => row.rank);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("accepts a subset and de-duplicates repeated ids", () => {
    const table = compareLayouts(PARAGRAPH, ["qwerty", "colemak", "qwerty"]);
    expect(Object.keys(table).sort()).toEqual(["colemak", "qwerty"]);
    expect(table.colemak.rank).toBe(1);
  });
});

describe("renderHeatmapSvg", () => {
  it("draws one rect per key and gives the busiest key the strongest fill", () => {
    const analysis = analyzeText("aaab", "qwerty");
    const svg = renderHeatmapSvg("qwerty", analysis.hitCounts);

    expect(svg.match(/<rect/g) ?? []).toHaveLength(LAYOUTS.qwerty.keys.length);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);

    // a was pressed three times, b once, everything else never. The strongest
    // fill has to be on the a rect itself, not merely somewhere in the file.
    expect(svg).toContain(`data-key="2-0" data-char="a" data-count="3"`);
    expect(svg).toMatch(
      new RegExp(`data-key="2-0"[^>]*fill="${heatFill(1).replace(/[()%]/g, "\\$&")}"`),
    );
    expect(svg).toContain(`fill="${heatFill(1)}"`);
    expect(svg).toContain(`fill="${heatFill(0)}"`);
    expect(svg).toContain(`fill="${heatFill(1 / 3)}"`);
    expect(svg).not.toContain("NaN");

    // Key labels are XML escaped, not pasted in raw.
    expect(svg).toContain("&apos;");
  });

  it("also accepts hit counts keyed by character", () => {
    const byChar = renderHeatmapSvg("colemak", { t: 5 });
    expect(byChar).toContain(`data-char="t" data-count="5"`);
    expect(byChar).toContain(`fill="${heatFill(1)}"`);
  });

  it("survives an empty heatmap", () => {
    const svg = renderHeatmapSvg("qwerty", {});
    expect(svg).not.toContain("NaN");
    expect(svg.match(/<rect/g) ?? []).toHaveLength(46);
    expect(svg).toContain(`fill="${heatFill(0)}"`);
  });

  it("is deterministic", () => {
    const counts = analyzeText(PARAGRAPH, "graphite").hitCounts;
    expect(renderHeatmapSvg("graphite", counts)).toBe(renderHeatmapSvg("graphite", counts));
  });
});

describe("run", () => {
  it("returns the analysis rows for a layout", () => {
    const out = run("the quick brown fox", { layout: "qwerty", mode: "analyze" });

    expect(out.Layout).toBe("QWERTY");
    expect(out["Characters analyzed"]).toBe("16 keystrokes from 19 characters");
    expect(out["Finger load"]).toContain("left index 25.0%");
    expect(out["Finger load"]).toContain("right pinky 0.0%");
    expect(out["Hand balance"]).toContain("left 56.3%");
    expect(out["Home row"]).toContain("18.8%");
    expect(out["Same-finger bigrams"]).toContain("1 of 12 bigrams");
    expect(out.Alternation).toContain("10 of 12 bigrams");
    expect(out.Rolls).toContain("0 inward and 1 outward");
    expect(out["Effort per 100"]).toBe("161.3");
    expect(out.Distance).toContain("15.7 key units total");
    expect(out["Top 10 keys"]).toContain("o 2");
    expect(out.Note).toBeUndefined();
  });

  it("falls back to the built-in sample and says so", () => {
    const out = run("", { layout: "qwerty", mode: "analyze" });
    expect(out.Note).toContain("built-in pangram sample");
    expect(out["Characters analyzed"]).toBe(
      `${analyzeText(DEFAULT_TEXT, "qwerty").keystrokes} keystrokes from ${[...DEFAULT_TEXT].length} characters`,
    );
  });

  it("understands layout synonyms", () => {
    expect(run("hello", { layout: "Colemak DH", mode: "analyze" }).Layout).toBe("Colemak-DH");
    expect(run("hello", { layout: "mod-dh", mode: "analyze" }).Layout).toBe("Colemak-DH");
    expect(run("bonjour", { layout: "french", mode: "analyze" }).Layout).toBe("AZERTY (French)");
  });

  it("ranks every layout in compare mode and names a winner", () => {
    const out = run(PARAGRAPH, { layout: "qwerty", mode: "compare" });
    const ranked = Object.keys(out).filter((label) => /^\d+\. /.test(label));

    expect(ranked).toHaveLength(10);
    expect(ranked[0].startsWith("1. ")).toBe(true);
    expect(out.Winner).toContain(ranked[0].replace(/^1\. /, ""));
    expect(out.Winner).toContain("lowest of the 10 layouts compared");
    expect(out["Your layout"]).toContain("QWERTY ranks");
    expect(out[ranked[0]]).toMatch(/^effort [\d.]+ per 100, SFB [\d.]+%, home row [\d.]+%/);
  });

  it("rejects an unknown layout", () => {
    expect(() => run("hi", { layout: "maltron", mode: "analyze" })).toThrowError(ToolError);
    try {
      run("hi", { layout: "maltron", mode: "analyze" });
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-layout");
      expect((error as ToolError).fix).toContain("colemak-dh");
    }
  });

  it("rejects an unknown mode", () => {
    try {
      run("hi", { layout: "qwerty", mode: "sideways" });
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-mode");
      expect((error as ToolError).fix).toBe("Pick analyze or compare.");
    }
  });

  it("rejects text over the 2 MB limit", () => {
    const huge = "a".repeat(MAX_CHARACTERS + 1);
    try {
      run(huge, { layout: "qwerty", mode: "analyze" });
      expect.unreachable();
    } catch (error) {
      expect((error as ToolError).code).toBe("text-too-long");
      expect((error as ToolError).message).toContain(String(MAX_CHARACTERS));
    }
  });

  it("propagates a bad layout out of analyzeText and renderHeatmapSvg too", () => {
    expect(() => analyzeText("hi", "maltron")).toThrowError(/no keyboard layout/);
    expect(() => renderHeatmapSvg("maltron", {})).toThrowError(/no keyboard layout/);
    expect(() => compareLayouts("hi", ["qwerty", "maltron"])).toThrowError(ToolError);
  });
});
