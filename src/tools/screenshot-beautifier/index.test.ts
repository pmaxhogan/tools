import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { meta } from "./meta";
import {
  ASPECTS,
  BACKGROUNDS,
  computeLayout,
  contrastingInk,
  FRAME_KINDS,
  gradientCss,
  MAX_CANVAS,
  renderFrameSvg,
  run,
  type Background,
} from "./index";

/** Pull the flat option values out of a select OptionSpec, in declared order. */
function selectValues(id: string): string[] {
  const spec = meta.options?.find((o) => o.id === id);
  if (!spec || spec.kind !== "select" || !spec.options) throw new Error(`no flat select options for "${id}"`);
  return spec.options.map((o) => o.value);
}

/* ------------------------------------------------------------------ */
/* BACKGROUNDS / FRAMES / ASPECTS                                      */
/* ------------------------------------------------------------------ */

describe("BACKGROUNDS", () => {
  it("has unique ids", () => {
    const ids = BACKGROUNDS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has at least twelve presets, each with at least one stop", () => {
    expect(BACKGROUNDS.length).toBeGreaterThanOrEqual(12);
    for (const bg of BACKGROUNDS) {
      expect(bg.stops.length).toBeGreaterThan(0);
    }
  });

  it("includes a transparent and a custom preset", () => {
    expect(BACKGROUNDS.some((b) => b.id === "transparent")).toBe(true);
    expect(BACKGROUNDS.some((b) => b.id === "custom")).toBe(true);
  });
});

describe("FRAME_KINDS", () => {
  it("matches the documented set", () => {
    expect(FRAME_KINDS).toEqual(["none", "mac", "windows", "browser-light", "browser-dark"]);
  });
});

describe("ASPECTS", () => {
  it("has unique ids and includes auto", () => {
    const ids = ASPECTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("auto");
  });
});

/**
 * meta.ts inlines these option lists as literals instead of importing them
 * from index.ts, since meta is loaded eagerly and logic is loaded lazily
 * (see the comment atop meta.ts). These tests are the drift guard: they run
 * in the test file, which is exempt from the "meta never imports logic" rule.
 */
describe("meta option values stay in sync with the logic module", () => {
  it("background select matches BACKGROUNDS ids, in order", () => {
    expect(selectValues("background")).toEqual(BACKGROUNDS.map((b) => b.id));
  });

  it("frame select matches FRAME_KINDS, in order", () => {
    expect(selectValues("frame")).toEqual([...FRAME_KINDS]);
  });

  it("aspect select matches ASPECTS ids, in order", () => {
    expect(selectValues("aspect")).toEqual(ASPECTS.map((a) => a.id));
  });
});

/* ------------------------------------------------------------------ */
/* computeLayout                                                       */
/* ------------------------------------------------------------------ */

describe("computeLayout", () => {
  it("computes exact numbers for a 1200x800 image, padding 64, mac frame", () => {
    const layout = computeLayout({
      imageWidth: 1200,
      imageHeight: 800,
      padding: 64,
      frame: "mac",
      cornerRadius: 12,
      shadow: true,
      aspect: "auto",
      scale: 1,
    });

    expect(layout.titleBarHeight).toBe(28);
    expect(layout.frameRect).toEqual({ x: 64, y: 64, w: 1200, h: 828 });
    expect(layout.canvasWidth).toBe(1328);
    expect(layout.canvasHeight).toBe(956);
    expect(layout.imageX).toBe(64);
    expect(layout.imageY).toBe(92);
    expect(layout.imageWidth).toBe(1200);
    expect(layout.imageHeight).toBe(800);
    expect(layout.padding).toBe(64);
    expect(layout.cornerRadius).toBe(12);
    expect(layout.clamped).toBe(false);
    expect(layout.clampScale).toBe(1);
    expect(layout.appliedScale).toBe(1);
  });

  it("gives the none frame a zero title bar and a frame equal to the image", () => {
    const layout = computeLayout({ imageWidth: 400, imageHeight: 300, padding: 20, frame: "none" });
    expect(layout.titleBarHeight).toBe(0);
    expect(layout.frameRect).toEqual({ x: 20, y: 20, w: 400, h: 300 });
    expect(layout.imageY).toBe(20);
    expect(layout.imageHeight).toBe(300);
  });

  it("forces the canvas to an exact 16:9 ratio and centers the frame", () => {
    const layout = computeLayout({
      imageWidth: 1200,
      imageHeight: 800,
      padding: 40,
      frame: "none",
      aspect: "16:9",
    });

    // The ratio is exactly 16:9, not merely close to it.
    expect(layout.canvasWidth / layout.canvasHeight).toBeCloseTo(16 / 9, 10);
    expect(layout.canvasWidth).toBe(1568);
    expect(layout.canvasHeight).toBe(882);
    // The frame stays centered: equal padding on left/right and top/bottom.
    const leftPad = layout.frameRect.x;
    const rightPad = layout.canvasWidth - (layout.frameRect.x + layout.frameRect.w);
    expect(leftPad).toBe(rightPad);
    const topPad = layout.frameRect.y;
    const bottomPad = layout.canvasHeight - (layout.frameRect.y + layout.frameRect.h);
    expect(topPad).toBe(bottomPad);
  });

  it("forces an exact 1:1 ratio for a wide image", () => {
    const layout = computeLayout({ imageWidth: 1600, imageHeight: 400, padding: 30, frame: "none", aspect: "1:1" });
    expect(layout.canvasWidth).toBe(layout.canvasHeight);
  });

  it("clamps a canvas past 4096px on the longest edge and reports the scale factor", () => {
    const layout = computeLayout({
      imageWidth: 5000,
      imageHeight: 3000,
      padding: 100,
      frame: "none",
      cornerRadius: 0,
      aspect: "auto",
      scale: 1,
    });

    expect(layout.clamped).toBe(true);
    expect(layout.canvasWidth).toBe(MAX_CANVAS);
    expect(layout.canvasHeight).toBeLessThanOrEqual(MAX_CANVAS);
    expect(layout.clampScale).toBeCloseTo(4096 / 5200, 6);
    expect(layout.appliedScale).toBeCloseTo(layout.clampScale, 6);
  });

  it("does not clamp a canvas at or under the limit", () => {
    const layout = computeLayout({ imageWidth: 2000, imageHeight: 1200, padding: 50, frame: "none" });
    expect(layout.clamped).toBe(false);
    expect(layout.clampScale).toBe(1);
  });

  it("applies an export scale before the clamp", () => {
    const layout = computeLayout({ imageWidth: 400, imageHeight: 300, padding: 20, frame: "none", scale: 2 });
    expect(layout.canvasWidth).toBe(880); // (400 + 40) * 2
    expect(layout.canvasHeight).toBe(680); // (300 + 40) * 2
    expect(layout.appliedScale).toBe(2);
  });

  it("clamps padding and corner radius that are out of range, and defaults invalid numbers", () => {
    const layout = computeLayout({
      imageWidth: 100,
      imageHeight: 100,
      padding: Number.NaN,
      cornerRadius: Number.NaN,
    });
    expect(layout.padding).toBe(64);
    expect(layout.cornerRadius).toBe(12);
  });

  it("falls back to the none frame and auto aspect for an unknown value", () => {
    const layout = computeLayout({ imageWidth: 100, imageHeight: 100, frame: "bogus", aspect: "bogus" });
    expect(layout.frame).toBe("none");
    expect(layout.aspect).toBe("auto");
  });
});

/* ------------------------------------------------------------------ */
/* renderFrameSvg                                                      */
/* ------------------------------------------------------------------ */

describe("renderFrameSvg", () => {
  const baseLayout = computeLayout({ imageWidth: 800, imageHeight: 600, padding: 48, frame: "mac" });

  it("contains a gradient definition for a gradient background", () => {
    const svg = renderFrameSvg(baseLayout, { background: "sunset", frame: "mac" });
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain("<stop");
    expect(svg).toContain('fill="url(#sb-bg)"');
  });

  it("draws no background rect for the transparent preset", () => {
    const svg = renderFrameSvg(baseLayout, { background: "transparent", frame: "mac" });
    expect(svg).not.toContain('data-kind="background"');
  });

  it("draws a solid rect for a solid background", () => {
    const svg = renderFrameSvg(baseLayout, { background: "mono-light", frame: "none" });
    expect(svg).toContain('data-kind="background"');
    expect(svg).toContain('fill="#f5f5f7"');
  });

  it("includes the drop shadow filter with an explicit feGaussianBlur when shadow is set", () => {
    const svg = renderFrameSvg(baseLayout, {
      background: "sunset",
      frame: "mac",
      shadow: { blur: 24, offsetY: 12, opacity: 0.3 },
    });
    expect(svg).toContain("<filter");
    expect(svg).toContain("<feGaussianBlur");
    expect(svg).toContain('data-kind="shadow"');
  });

  it("omits the shadow filter and rect when shadow is not set", () => {
    const svg = renderFrameSvg(baseLayout, { background: "sunset", frame: "mac" });
    expect(svg).not.toContain("<feGaussianBlur");
    expect(svg).not.toContain('data-kind="shadow"');
  });

  it("includes the rounded clip path for the frame slot", () => {
    const svg = renderFrameSvg(baseLayout, { background: "sunset", frame: "mac", cornerRadius: 16 });
    expect(svg).toContain('<clipPath id="sb-frame-clip">');
    expect(svg).toContain('rx="16"');
    expect(svg).toContain('clip-path="url(#sb-frame-clip)"');
  });

  it("includes the screenshot image placeholder", () => {
    const svg = renderFrameSvg(baseLayout, { background: "sunset", frame: "mac" });
    expect(svg).toContain('href="#screenshot"');
    expect(svg).toContain('data-screenshot-slot="true"');
  });

  it("draws exactly three traffic lights for a mac frame", () => {
    const svg = renderFrameSvg(baseLayout, { background: "sunset", frame: "mac" });
    expect(svg.match(/data-kind="traffic-light"/g)).toHaveLength(3);
  });

  it("draws windows controls instead of traffic lights for a windows frame", () => {
    const layout = computeLayout({ imageWidth: 800, imageHeight: 600, padding: 40, frame: "windows" });
    const svg = renderFrameSvg(layout, { background: "sunset", frame: "windows" });
    expect(svg).not.toContain('data-kind="traffic-light"');
    expect(svg).toContain('data-kind="win-minimize"');
    expect(svg).toContain('data-kind="win-maximize"');
    expect(svg).toContain('data-kind="win-close"');
  });

  it("draws a url pill with traffic lights for a browser frame", () => {
    const layout = computeLayout({ imageWidth: 800, imageHeight: 600, padding: 40, frame: "browser-light" });
    const svg = renderFrameSvg(layout, { background: "sunset", frame: "browser-light" });
    expect(svg).toContain('data-kind="url-pill"');
    expect(svg).toContain('data-kind="url-pill-text"');
    expect(svg.match(/data-kind="traffic-light"/g)).toHaveLength(3);
  });

  it("puts the title text inside the url pill for a browser frame", () => {
    const layout = computeLayout({ imageWidth: 800, imageHeight: 600, padding: 40, frame: "browser-dark" });
    const svg = renderFrameSvg(layout, { background: "midnight", frame: "browser-dark", title: "example.com/app" });
    expect(svg).toContain("example.com/app");
    expect(svg).not.toContain('data-kind="window-title"');
  });

  it("draws no chrome at all for the none frame", () => {
    const layout = computeLayout({ imageWidth: 800, imageHeight: 600, padding: 40, frame: "none" });
    const svg = renderFrameSvg(layout, { background: "sunset", frame: "none" });
    expect(svg).not.toContain('data-kind="title-bar"');
    expect(svg).not.toContain('data-kind="traffic-light"');
  });

  it("escapes a title with special characters", () => {
    const layout = computeLayout({ imageWidth: 800, imageHeight: 600, padding: 40, frame: "mac" });
    const svg = renderFrameSvg(layout, { background: "sunset", frame: "mac", title: '<script> & "x"' });
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("includes a watermark when requested and omits it otherwise", () => {
    const withMark = renderFrameSvg(baseLayout, { background: "sunset", frame: "mac", watermark: "example.com" });
    expect(withMark).toContain('data-kind="watermark"');
    expect(withMark).toContain("example.com");

    const withoutMark = renderFrameSvg(baseLayout, { background: "sunset", frame: "mac" });
    expect(withoutMark).not.toContain('data-kind="watermark"');
  });

  it("is deterministic for the same layout and options", () => {
    const a = renderFrameSvg(baseLayout, { background: "aurora", frame: "mac", title: "hello" });
    const b = renderFrameSvg(baseLayout, { background: "aurora", frame: "mac", title: "hello" });
    expect(a).toBe(b);
  });

  it("renders a mesh background with radial blobs", () => {
    const svg = renderFrameSvg(baseLayout, { background: "aurora", frame: "none" });
    expect(svg).toContain("<radialGradient");
    expect(svg).toContain('data-kind="background-blob"');
  });

  it("accepts a raw Background object for a custom color outside the presets", () => {
    const custom: Background = { id: "user-pick", label: "User pick", kind: "solid", stops: ["#123456"] };
    const svg = renderFrameSvg(baseLayout, { background: custom, frame: "none" });
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('data-background="user-pick"');
  });

  it("does not draw a solid black shadow rect on top of the blur", () => {
    const svg = renderFrameSvg(baseLayout, {
      background: "sunset",
      frame: "mac",
      shadow: { blur: 24, offsetY: 12, opacity: 0.3 },
    });
    expect(svg).not.toContain("feMerge");
    expect(svg).not.toContain("SourceGraphic");
  });
});

/* ------------------------------------------------------------------ */
/* gradientCss / contrastingInk                                        */
/* ------------------------------------------------------------------ */

describe("gradientCss", () => {
  it("builds a linear-gradient string for a gradient background", () => {
    const bg = BACKGROUNDS.find((b) => b.id === "ocean")!;
    expect(gradientCss(bg)).toBe(`linear-gradient(135deg, ${bg.stops.join(", ")})`);
  });

  it("returns the plain color for a solid background", () => {
    const bg = BACKGROUNDS.find((b) => b.id === "mono-dark")!;
    expect(gradientCss(bg)).toBe("#111114");
  });

  it("returns transparent for the transparent preset", () => {
    const bg = BACKGROUNDS.find((b) => b.id === "transparent")!;
    expect(gradientCss(bg)).toBe("transparent");
  });

  it("layers radial gradients over a base wash for a mesh background", () => {
    const bg = BACKGROUNDS.find((b) => b.id === "candy")!;
    const css = gradientCss(bg);
    expect(css).toContain("radial-gradient(");
    expect(css).toContain("linear-gradient(");
  });
});

describe("contrastingInk", () => {
  it("picks dark ink for a light background", () => {
    const bg = BACKGROUNDS.find((b) => b.id === "mono-light")!;
    expect(contrastingInk(bg)).toBe("#111");
  });

  it("picks light ink for a dark background", () => {
    const bg = BACKGROUNDS.find((b) => b.id === "mono-dark")!;
    expect(contrastingInk(bg)).toBe("#fff");
  });

  it("falls back to dark ink for an all transparent background", () => {
    const bg: Background = { id: "x", label: "X", kind: "solid", stops: ["transparent"] };
    expect(contrastingInk(bg)).toBe("#111");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("lays out a sample 1280x800 screenshot and notes it when the input is empty", () => {
    const out = run("");
    expect(out.Note).toContain("sample 1280 x 800");
    expect(out.Canvas).toBeDefined();
    expect(out["Decoration SVG"]).toContain("<svg");
  });

  it("treats whitespace as empty input", () => {
    const out = run("   \n  ");
    expect(out.Note).toBeDefined();
  });

  it("lays out the given dimensions from JSON and omits the sample note", () => {
    const out = run(JSON.stringify({ width: 1920, height: 1080 }));
    expect(out.Note).toBeUndefined();
    expect(out["Image size"]).toBe("1920 x 1080 px");
  });

  it("applies the frame, padding, and corner radius options", () => {
    const out = run(JSON.stringify({ width: 1200, height: 800 }), {
      frame: "mac",
      padding: 64,
      cornerRadius: 12,
    });
    expect(out.Frame).toBe("macOS window");
    expect(out.Padding).toBe("64 px");
    expect(out["Corner radius"]).toBe("12 px");
    expect(out.Canvas).toBe("1328 x 956 px");
  });

  it("throws bad-json on invalid JSON", () => {
    try {
      run("{ not json");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("bad-json");
      expect((error as ToolError).fix).toBeTruthy();
    }
  });

  it("throws bad-json when width or height is not a positive number", () => {
    try {
      run(JSON.stringify({ width: -5, height: 100 }));
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-json");
    }
  });

  it("throws bad-json for a JSON array", () => {
    try {
      run("[1,2,3]");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-json");
    }
  });

  it("throws bad-option for an unknown background", () => {
    try {
      run("", { background: "not-a-real-background" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("bad-option");
    }
  });

  it("throws bad-option for an unknown frame", () => {
    try {
      run("", { frame: "not-a-real-frame" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-option");
    }
  });

  it("throws bad-option for an unknown aspect", () => {
    try {
      run("", { aspect: "not-a-real-aspect" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-option");
    }
  });

  it("reports the clamp when the requested dimensions exceed the max canvas", () => {
    const out = run(JSON.stringify({ width: 6000, height: 4000 }), { padding: 200, frame: "none" });
    expect(out.Clamped).toContain("scaled to");
    expect(out.Canvas).toContain(String(MAX_CANVAS));
  });

  it("includes the decoration SVG with the chosen background and frame", () => {
    const out = run("", { background: "ocean", frame: "browser-light", title: "example.com" });
    expect(out["Decoration SVG"]).toContain("<linearGradient");
    expect(out["Decoration SVG"]).toContain('data-kind="url-pill"');
    expect(out["Decoration SVG"]).toContain("example.com");
  });
});
