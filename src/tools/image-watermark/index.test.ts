import { describe, expect, it } from "vitest";
import {
  ANCHORS,
  MAX_TILES,
  anchorCenter,
  approximateMeasure,
  fontSizeFor,
  marginFor,
  planWatermark,
  readImageSize,
  rotatedBounds,
  run,
  scaleLogo,
  textBox,
  tileCenters,
  watermarkFilename,
  wrapText,
  type Anchor,
  type MeasureText,
  type Size,
} from "./index";
import { ToolError } from "../types";

/** A stub measurer: every character is exactly ten pixels wide at 10px. */
const measure: MeasureText = (text, fontSize) => text.length * fontSize;

const IMAGE: Size = { width: 1000, height: 500 };

/* ------------------------------------------------------------------ */
/* text layout                                                         */
/* ------------------------------------------------------------------ */

describe("fontSizeFor", () => {
  it("scales with the image height", () => {
    expect(fontSizeFor(1000, 6)).toBe(60);
    expect(fontSizeFor(500, 6)).toBe(30);
  });

  it("never returns something too small to see", () => {
    expect(fontSizeFor(40, 0.5)).toBe(8);
  });

  it("clamps a nonsense percentage into range", () => {
    expect(fontSizeFor(1000, 900)).toBe(fontSizeFor(1000, 40));
  });
});

describe("wrapText", () => {
  it("breaks a line that does not fit", () => {
    // At fontSize 1 each character is one pixel wide, so 10 pixels is 10 chars.
    expect(wrapText("aaa bbb ccc ddd", 10, 1, measure)).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("keeps a line break the author typed", () => {
    expect(wrapText("one\ntwo", 1000, 1, measure)).toEqual(["one", "two"]);
  });

  it("leaves a single word longer than the line alone", () => {
    expect(wrapText("supercalifragilistic", 5, 1, measure)).toEqual(["supercalifragilistic"]);
  });

  it("keeps an empty paragraph as an empty line", () => {
    expect(wrapText("a\n\nb", 100, 1, measure)).toEqual(["a", "", "b"]);
  });
});

describe("textBox", () => {
  it("measures the widest line and stacks the rest", () => {
    const box = textBox("abc\nabcdef", IMAGE, { fontPercent: 2 }, measure);
    expect(box.fontSize).toBe(10);
    expect(box.lines).toEqual(["abc", "abcdef"]);
    expect(box.width).toBe(60);
    expect(box.height).toBeCloseTo(25, 6);
  });

  it("wraps against the max width percentage", () => {
    const narrow = textBox(
      "aaaa bbbb cccc",
      IMAGE,
      { fontPercent: 2, maxWidthPercent: 5 },
      measure,
    );
    expect(narrow.lines.length).toBeGreaterThan(1);
  });

  it("throws on an image with no size", () => {
    expect(() => textBox("x", { width: 0, height: 0 }, {}, measure)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* placement                                                           */
/* ------------------------------------------------------------------ */

describe("marginFor", () => {
  it("is a percentage of the shorter edge", () => {
    expect(marginFor(IMAGE, 4)).toBe(20);
    expect(marginFor({ width: 500, height: 1000 }, 4)).toBe(20);
  });

  it("clamps out of range percentages", () => {
    expect(marginFor(IMAGE, -5)).toBe(0);
    expect(marginFor(IMAGE, 90)).toBe(marginFor(IMAGE, 25));
  });
});

describe("anchorCenter", () => {
  const box: Size = { width: 200, height: 100 };

  it("puts each corner inside its margin", () => {
    expect(anchorCenter("top-left", IMAGE, box, 20)).toEqual({ x: 120, y: 70 });
    expect(anchorCenter("bottom-right", IMAGE, box, 20)).toEqual({ x: 880, y: 430 });
  });

  it("centers the middle row and column", () => {
    expect(anchorCenter("center", IMAGE, box, 20)).toEqual({ x: 500, y: 250 });
    expect(anchorCenter("top-center", IMAGE, box, 20).x).toBe(500);
    expect(anchorCenter("middle-left", IMAGE, box, 20).y).toBe(250);
  });

  it("centers a box too big for its margins rather than pushing it off the edge", () => {
    const huge: Size = { width: 990, height: 490 };
    expect(anchorCenter("top-left", IMAGE, huge, 20)).toEqual({ x: 500, y: 250 });
  });

  it("keeps every anchor inside the picture", () => {
    for (const anchor of ANCHORS) {
      const center = anchorCenter(anchor as Anchor, IMAGE, box, 20);
      expect(center.x - box.width / 2).toBeGreaterThanOrEqual(0);
      expect(center.x + box.width / 2).toBeLessThanOrEqual(IMAGE.width);
      expect(center.y - box.height / 2).toBeGreaterThanOrEqual(0);
      expect(center.y + box.height / 2).toBeLessThanOrEqual(IMAGE.height);
    }
  });
});

describe("rotatedBounds", () => {
  it("is unchanged at zero degrees", () => {
    expect(rotatedBounds({ width: 200, height: 100 }, 0)).toEqual({ width: 200, height: 100 });
  });

  it("swaps the axes at 90 degrees", () => {
    const bounds = rotatedBounds({ width: 200, height: 100 }, 90);
    expect(bounds.width).toBeCloseTo(100, 6);
    expect(bounds.height).toBeCloseTo(200, 6);
  });

  it("grows on both axes at 45 degrees", () => {
    const bounds = rotatedBounds({ width: 100, height: 100 }, 45);
    expect(bounds.width).toBeCloseTo(141.42, 1);
  });
});

describe("tileCenters", () => {
  const box: Size = { width: 200, height: 100 };

  it("covers the whole picture, starting outside it", () => {
    const centers = tileCenters(IMAGE, box, 0, 0);
    expect(centers.length).toBeGreaterThan(1);
    expect(Math.min(...centers.map((c) => c.x))).toBeLessThanOrEqual(0);
    expect(Math.max(...centers.map((c) => c.x))).toBeGreaterThanOrEqual(IMAGE.width);
    expect(Math.min(...centers.map((c) => c.y))).toBeLessThanOrEqual(0);
    expect(Math.max(...centers.map((c) => c.y))).toBeGreaterThanOrEqual(IMAGE.height);
  });

  it("spaces tiles further apart as the gap grows", () => {
    expect(tileCenters(IMAGE, box, 200, 0).length).toBeLessThan(
      tileCenters(IMAGE, box, 0, 0).length,
    );
  });

  it("uses the rotated bounds, so a turned mark still tiles evenly", () => {
    const straight = tileCenters(IMAGE, box, 0, 0).length;
    const turned = tileCenters(IMAGE, box, 0, 90).length;
    expect(turned).not.toBe(straight);
  });

  it("is symmetric about the center of the picture", () => {
    const centers = tileCenters(IMAGE, box, 0, 0);
    const xs = centers.map((c) => c.x);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(IMAGE.width, 0);
  });

  it("refuses a tiling that would need too many copies", () => {
    expect(() => tileCenters({ width: 8000, height: 8000 }, { width: 9, height: 9 }, 0, 0)).toThrow(
      ToolError,
    );
    expect(() => tileCenters({ width: 8000, height: 8000 }, { width: 9, height: 9 }, 0, 0)).toThrow(
      new RegExp(MAX_TILES.toLocaleString("en-US")),
    );
  });
});

describe("scaleLogo", () => {
  it("scales to a percentage of the image width and keeps the ratio", () => {
    expect(scaleLogo({ width: 400, height: 200 }, IMAGE, 20)).toEqual({ width: 200, height: 100 });
  });

  it("clamps the percentage", () => {
    expect(scaleLogo({ width: 100, height: 100 }, IMAGE, 500).width).toBe(1000);
  });

  it("throws on a logo with no size", () => {
    expect(() => scaleLogo({ width: 0, height: 0 }, IMAGE, 20)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* planWatermark                                                       */
/* ------------------------------------------------------------------ */

describe("planWatermark", () => {
  const box: Size = { width: 200, height: 100 };

  it("places one copy by default, in the bottom right", () => {
    const plan = planWatermark(IMAGE, box, {});
    expect(plan.tiled).toBe(false);
    expect(plan.placements).toHaveLength(1);
    expect(plan.placements[0]).toEqual(anchorCenter("bottom-right", IMAGE, box, plan.margin));
  });

  it("tiles when asked", () => {
    const plan = planWatermark(IMAGE, box, { mode: "tile", tileGapPercent: 0 });
    expect(plan.tiled).toBe(true);
    expect(plan.placements.length).toBeGreaterThan(1);
  });

  it("clamps the rotation and falls back on an unknown anchor", () => {
    const plan = planWatermark(IMAGE, box, { rotation: 900, anchor: "nowhere" as Anchor });
    expect(plan.rotation).toBe(180);
    expect(plan.placements[0]).toEqual(anchorCenter("bottom-right", IMAGE, box, plan.margin));
  });
});

describe("watermarkFilename", () => {
  it("swaps the extension for the chosen format", () => {
    expect(watermarkFilename("photo.png", "image/jpeg")).toBe("photo-watermarked.jpg");
    expect(watermarkFilename("photo.jpg", "image/webp")).toBe("photo-watermarked.webp");
    expect(watermarkFilename("noext", "image/png")).toBe("noext-watermarked.png");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("readImageSize", () => {
  it("reads the shorthand forms", () => {
    expect(readImageSize("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(readImageSize(" 800 by 600 ")).toEqual({ width: 800, height: 600 });
  });

  it("reads a JSON object", () => {
    expect(readImageSize('{"width":640,"height":480}')).toEqual({ width: 640, height: 480 });
  });

  it("throws on empty input and on nonsense", () => {
    expect(() => readImageSize("")).toThrow(/No picture loaded/);
    expect(() => readImageSize("large")).toThrow(ToolError);
    expect(() => readImageSize('{"width":0,"height":0}')).toThrow(/positive numbers/);
  });
});

describe("run", () => {
  it("reports a single text placement", () => {
    const out = run("1000x500", { text: "Sample", anchor: "top-left" });
    expect(out["Image size"]).toBe("1000 by 500 pixels");
    expect(out["Kind"]).toBe("Text watermark");
    expect(out["Text"]).toBe("Sample");
    expect(out["Placement"]).toBe("Single, anchored top left");
    expect(out["First center"]).toMatch(/^\d+, \d+$/);
  });

  it("reports a tiled placement with a last center", () => {
    const out = run("1000x500", { mode: "tile", text: "Sample", tileGapPercent: 50 });
    expect(out["Placement"]).toMatch(/^Tiled, \d+ copies$/);
    expect(out["Last center"]).toBeDefined();
  });

  it("switches to a logo box for an image watermark", () => {
    const out = run("1000x500", { kind: "image", scalePercent: 30 });
    expect(out["Kind"]).toBe("Logo watermark");
    expect(out["Logo box"]).toContain("300 by 300");
  });

  it("uses a default caption when none is given", () => {
    expect(run("1000x500", {})["Text"]).toBe("Watermark");
  });

  it("accepts the size as bytes", () => {
    expect(run(new TextEncoder().encode("640x480"), {})["Image size"]).toBe("640 by 480 pixels");
  });

  it("throws on an empty input", () => {
    expect(() => run("", {})).toThrow(ToolError);
    expect(() => run("   ", {})).toThrow(/No picture loaded/);
  });
});

describe("approximateMeasure", () => {
  it("grows with both the text and the size", () => {
    expect(approximateMeasure("abcd", 100)).toBeGreaterThan(approximateMeasure("ab", 100));
    expect(approximateMeasure("ab", 200)).toBeGreaterThan(approximateMeasure("ab", 100));
  });
});
