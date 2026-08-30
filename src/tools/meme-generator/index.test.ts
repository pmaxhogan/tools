import { describe, expect, it } from "vitest";
import {
  BLANK_SIZES,
  MEME_FONT_STACK,
  MIN_FONT_SIZE,
  approximateMeasure,
  fitText,
  layoutCaption,
  layoutClassic,
  layoutMeme,
  memeFilename,
  readCanvasSize,
  run,
  wrapText,
  type MeasureText,
  type Size,
} from "./index";
import { ToolError } from "../types";

/** A stub measurer: one character is exactly one pixel wide per point of size. */
const measure: MeasureText = (text, fontSize) => text.length * fontSize;

const IMAGE: Size = { width: 1000, height: 1000 };

/* ------------------------------------------------------------------ */
/* wrapping                                                            */
/* ------------------------------------------------------------------ */

describe("wrapText", () => {
  it("breaks a line that does not fit", () => {
    expect(wrapText("aaa bbb ccc", 7, 1, measure)).toEqual(["aaa bbb", "ccc"]);
  });

  it("keeps an author's line break", () => {
    expect(wrapText("one\ntwo", 1000, 1, measure)).toEqual(["one", "two"]);
  });

  it("does not hyphenate a word wider than the line", () => {
    expect(wrapText("antidisestablishmentarianism", 4, 1, measure)).toEqual([
      "antidisestablishmentarianism",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* fitting                                                             */
/* ------------------------------------------------------------------ */

describe("fitText", () => {
  it("keeps the requested size when the text already fits", () => {
    const fitted = fitText("hi", { width: 1000, height: 1000 }, 100, measure);
    expect(fitted.fontSize).toBe(100);
    expect(fitted.lines).toEqual(["hi"]);
    expect(fitted.overflowed).toBe(false);
  });

  it("shrinks until a long caption fits its box", () => {
    const box: Size = { width: 300, height: 120 };
    const fitted = fitText("one two three four five six seven", box, 100, measure);
    expect(fitted.fontSize).toBeLessThan(100);
    expect(fitted.height).toBeLessThanOrEqual(box.height);
    expect(fitted.width).toBeLessThanOrEqual(box.width);
    expect(fitted.overflowed).toBe(false);
  });

  it("stops at the minimum size and says it overflowed", () => {
    const fitted = fitText("wide", { width: 4, height: 4 }, 100, measure);
    expect(fitted.fontSize).toBe(MIN_FONT_SIZE);
    expect(fitted.overflowed).toBe(true);
  });

  it("returns nothing for empty text", () => {
    expect(fitText("   ", { width: 100, height: 100 }, 40, measure).lines).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* classic layout                                                      */
/* ------------------------------------------------------------------ */

describe("layoutClassic", () => {
  it("places a top and a bottom block", () => {
    const blocks = layoutClassic(IMAGE, { topText: "one", bottomText: "two" }, measure);
    expect(blocks.map((b) => b.id)).toEqual(["top", "bottom"]);
    expect(blocks[0]!.y).toBeLessThan(blocks[1]!.y);
    expect(blocks[0]!.x).toBe(500);
  });

  it("skips a block whose text is empty", () => {
    expect(layoutClassic(IMAGE, { topText: "only" }, measure).map((b) => b.id)).toEqual(["top"]);
    expect(layoutClassic(IMAGE, {}, measure)).toEqual([]);
  });

  it("shouts by default and stops when asked", () => {
    expect(layoutClassic(IMAGE, { topText: "quiet" }, measure)[0]!.lines).toEqual(["QUIET"]);
    expect(layoutClassic(IMAGE, { topText: "quiet", uppercase: false }, measure)[0]!.lines).toEqual(
      ["quiet"],
    );
  });

  it("honors dragged positions as percentages", () => {
    const blocks = layoutClassic(IMAGE, { topText: "x", topX: 25, topY: 75 }, measure);
    expect(blocks[0]!.x).toBe(250);
    expect(blocks[0]!.y).toBe(750);
  });

  it("scales the outline with the font size", () => {
    const thick = layoutClassic(IMAGE, { topText: "x", outlinePercent: 20 }, measure)[0]!;
    const thin = layoutClassic(IMAGE, { topText: "x", outlinePercent: 4 }, measure)[0]!;
    expect(thick.outlineWidth).toBeGreaterThan(thin.outlineWidth);
  });

  it("turns the outline off when it is set to an empty string", () => {
    expect(layoutClassic(IMAGE, { topText: "x", outline: "" }, measure)[0]!.outline).toBe("");
  });

  it("throws on a canvas with no size", () => {
    expect(() => layoutClassic({ width: 0, height: 0 }, { topText: "x" }, measure)).toThrow(
      ToolError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* caption layout                                                      */
/* ------------------------------------------------------------------ */

describe("layoutCaption", () => {
  it("makes the canvas taller by the bar and never covers the picture", () => {
    const out = layoutCaption(IMAGE, { captionText: "when the tests pass" }, measure);
    expect(out.barHeight).toBeGreaterThan(0);
    expect(out.canvas.height).toBe(IMAGE.height + out.barHeight);
    expect(out.canvas.width).toBe(IMAGE.width);
    expect(out.block?.y).toBeLessThan(out.barHeight);
  });

  it("grows the bar for a caption that needs more lines", () => {
    const short = layoutCaption(IMAGE, { captionText: "hi" }, measure);
    const long = layoutCaption(
      IMAGE,
      { captionText: "a much longer caption that has to wrap onto several lines to fit" },
      measure,
    );
    expect(long.barHeight).toBeGreaterThan(short.barHeight);
  });

  it("leaves the canvas alone when there is no caption", () => {
    const out = layoutCaption(IMAGE, {}, measure);
    expect(out.barHeight).toBe(0);
    expect(out.block).toBeNull();
    expect(out.canvas).toEqual(IMAGE);
  });

  it("draws the caption without an outline", () => {
    expect(layoutCaption(IMAGE, { captionText: "hi" }, measure).block?.outline).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* layoutMeme                                                          */
/* ------------------------------------------------------------------ */

describe("layoutMeme", () => {
  it("puts the picture at the origin in classic mode", () => {
    const layout = layoutMeme(IMAGE, { topText: "x" }, measure);
    expect(layout.imageAt).toEqual({ x: 0, y: 0, width: 1000, height: 1000 });
    expect(layout.barHeight).toBe(0);
  });

  it("pushes the picture down by the bar in caption mode", () => {
    const layout = layoutMeme(IMAGE, { mode: "caption", captionText: "hello" }, measure);
    expect(layout.imageAt.y).toBe(layout.barHeight);
    expect(layout.canvas.height).toBeGreaterThan(IMAGE.height);
  });
});

describe("memeFilename", () => {
  it("always names a PNG", () => {
    expect(memeFilename("cat.jpg")).toBe("cat-meme.png");
    expect(memeFilename("")).toBe("meme-meme.png");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("readCanvasSize", () => {
  it("reads a shorthand size and a JSON object", () => {
    expect(readCanvasSize("800x600", {})).toEqual({ width: 800, height: 600 });
    expect(readCanvasSize('{"width":10,"height":20}', {})).toEqual({ width: 10, height: 20 });
  });

  it("uses a blank preset instead of the input", () => {
    expect(readCanvasSize("", { blank: "square" })).toEqual(BLANK_SIZES["square"]);
    expect(readCanvasSize("800x600", { blank: "story" })).toEqual(BLANK_SIZES["story"]);
  });

  it("throws on an unknown preset", () => {
    expect(() => readCanvasSize("", { blank: "banner" })).toThrow(/not a blank canvas preset/);
  });

  it("throws on empty input and on nonsense", () => {
    expect(() => readCanvasSize("", {})).toThrow(/No picture loaded/);
    expect(() => readCanvasSize("big", {})).toThrow(ToolError);
    expect(() => readCanvasSize('{"width":0,"height":1}', {})).toThrow(/positive numbers/);
  });
});

describe("run", () => {
  it("reports a classic layout", () => {
    const out = run("1000x1000", { topText: "one does not simply", bottomText: "write a test" });
    expect(out["Mode"]).toBe("Classic top and bottom");
    expect(out["top text"]).toBe("ONE DOES NOT / SIMPLY");
    expect(out["bottom layout"]).toMatch(/lines? at \d+px/);
    expect(out["Font"]).toBe(MEME_FONT_STACK);
  });

  it("reports a caption layout with a taller canvas", () => {
    const out = run("1000x1000", { mode: "caption", captionText: "when it finally works" });
    expect(out["Mode"]).toBe("Caption bar above the picture");
    expect(out["Caption bar"]).toMatch(/^\d+px of #ffffff$/);
    expect(out["Canvas size"]).not.toBe(out["Picture size"]);
  });

  it("works from a blank canvas with no picture at all", () => {
    const out = run("", { blank: "square", topText: "no image needed" });
    expect(out["Picture size"]).toBe("1080 by 1080 pixels");
  });

  it("accepts the size as bytes", () => {
    expect(run(new TextEncoder().encode("640x480"), { topText: "x" })["Picture size"]).toBe(
      "640 by 480 pixels",
    );
  });

  it("throws when there is no text to lay out", () => {
    expect(() => run("1000x1000", {})).toThrow(ToolError);
    expect(() => run("1000x1000", {})).toThrow(/no caption to lay out/);
  });

  it("throws when there is no picture", () => {
    expect(() => run("", { topText: "x" })).toThrow(/No picture loaded/);
  });
});

describe("approximateMeasure", () => {
  it("is narrower than a normal sans, matching a condensed face", () => {
    expect(approximateMeasure("aaaa", 100)).toBeLessThan(4 * 100 * 0.55);
    expect(approximateMeasure("aa", 100)).toBeGreaterThan(approximateMeasure("a", 100));
  });
});
