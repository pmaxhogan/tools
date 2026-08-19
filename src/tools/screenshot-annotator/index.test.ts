import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  ANNOTATION_KINDS,
  arrowHeadPolygon,
  blurRegionRgba,
  createAnnotation,
  DEFAULT_COLORS,
  freehandPath,
  hitTest,
  moveAnnotation,
  nextCalloutNumber,
  normalizeRect,
  parseDoc,
  pixelateRegionRgba,
  renderSvgOverlay,
  run,
  serializeDoc,
  type Annotation,
  type AnnotationDoc,
  type RectLike,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function doc(items: Annotation[], width = 800, height = 600): AnnotationDoc {
  return { width, height, items };
}

/** A gradient so any averaging operation visibly changes the pixels. */
function gradient(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 37) % 256;
      data[i + 1] = (y * 53) % 256;
      data[i + 2] = (x * y * 11) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

function pixelAt(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

function inRect(rect: RectLike, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** Every pixel outside `rect` must be byte identical between the two buffers. */
function expectOutsideUntouched(
  out: Uint8ClampedArray,
  source: Uint8ClampedArray,
  width: number,
  height: number,
  rect: RectLike,
) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inRect(rect, x, y)) continue;
      expect(pixelAt(out, width, x, y)).toEqual(pixelAt(source, width, x, y));
    }
  }
}

/* ------------------------------------------------------------------ */
/* creation and geometry                                               */
/* ------------------------------------------------------------------ */

describe("createAnnotation", () => {
  it("builds a box annotation with defaults", () => {
    const item = createAnnotation("rect", { x: 10, y: 20, w: 100, h: 50 });
    expect(item.kind).toBe("rect");
    expect({ x: item.x, y: item.y, w: item.w, h: item.h }).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(item.color).toBe(DEFAULT_COLORS[0]);
    expect(item.strokeWidth).toBe(4);
    expect(item.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizes a box dragged up and to the left", () => {
    const item = createAnnotation("rect", { x: 120, y: 90, w: -40, h: -30 });
    expect({ x: item.x, y: item.y, w: item.w, h: item.h }).toEqual({ x: 80, y: 60, w: 40, h: 30 });
  });

  it("derives the bounding box of a polyline kind", () => {
    const item = createAnnotation("freehand", {
      points: [
        { x: 30, y: 10 },
        { x: 5, y: 40 },
        { x: 50, y: 25 },
      ],
    });
    expect(item.points).toHaveLength(3);
    expect({ x: item.x, y: item.y, w: item.w, h: item.h }).toEqual({ x: 5, y: 10, w: 45, h: 30 });
  });

  it("gives a zero size callout a badge sized box", () => {
    const item = createAnnotation("callout", { x: 100, y: 100 }, { fontSize: 20 });
    expect(item.w).toBeGreaterThan(0);
    expect(item.h).toBe(item.w);
    // The tap point stays at the center of the badge.
    expect(item.x + item.w / 2).toBe(100);
    expect(item.y + item.h / 2).toBe(100);
  });

  it("gives a bare point text label the pill it will be drawn as", () => {
    const item = createAnnotation("text", { x: 40, y: 40 }, { text: "Click here", fontSize: 20 });
    expect(item.w).toBeGreaterThan(40);
    expect(item.h).toBeGreaterThan(20);
    // The whole visible label is selectable, not just its top left corner.
    expect(hitTest(doc([item]), item.x + item.w / 2, item.y + item.h / 2)).toBe(item);
  });

  it("defaults a highlight to marker yellow", () => {
    const item = createAnnotation("highlight", { x: 0, y: 0, w: 40, h: 10 });
    expect(item.color).toBe("#ffe14d");
  });

  it("rounds pointer floats to two decimals", () => {
    const item = createAnnotation("rect", { x: 10.123456, y: 0, w: 5.987654, h: 1 });
    expect(item.x).toBe(10.12);
    expect(item.w).toBe(5.99);
  });

  it("rejects an unknown kind", () => {
    expect(() => createAnnotation("sparkle", { x: 0, y: 0, w: 1, h: 1 })).toThrow(ToolError);
    try {
      createAnnotation("sparkle", { x: 0, y: 0, w: 1, h: 1 });
    } catch (error) {
      expect((error as ToolError).code).toBe("unknown-kind");
      expect((error as ToolError).fix).toContain("arrow");
    }
  });

  it("rejects a non finite coordinate", () => {
    try {
      createAnnotation("rect", { x: Number.NaN, y: 0, w: 10, h: 10 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("invalid-geometry");
    }
  });

  it("rejects a polyline with fewer than two points", () => {
    try {
      createAnnotation("arrow", { points: [{ x: 1, y: 1 }] });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("invalid-geometry");
    }
  });

  it("rejects a polyline point that is not a finite pair", () => {
    try {
      createAnnotation("line", {
        points: [
          { x: 1, y: 1 },
          { x: Number.POSITIVE_INFINITY, y: 2 },
        ],
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("invalid-geometry");
    }
  });
});

describe("normalizeRect", () => {
  it("leaves a forward box alone", () => {
    expect(normalizeRect({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("sorts a backwards drag", () => {
    expect(normalizeRect({ x: 10, y: 10, w: -6, h: -4 })).toEqual({ x: 4, y: 6, w: 6, h: 4 });
  });

  it("collapses non finite values to zero", () => {
    expect(normalizeRect({ x: Number.NaN, y: 5, w: Number.POSITIVE_INFINITY, h: 2 })).toEqual({
      x: 0,
      y: 5,
      w: 0,
      h: 2,
    });
  });
});

describe("moveAnnotation", () => {
  it("shifts the box and every point without resizing", () => {
    const item = createAnnotation(
      "arrow",
      {
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 20 },
        ],
      },
      { id: "a1" },
    );
    const moved = moveAnnotation(item, 5, -3);
    expect(moved).not.toBe(item);
    expect(moved.points).toEqual([
      { x: 5, y: -3 },
      { x: 15, y: 17 },
    ]);
    expect(moved.w).toBe(item.w);
    expect(moved.h).toBe(item.h);
    expect(item.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 20 },
    ]);
  });
});

describe("nextCalloutNumber", () => {
  it("starts at one on an empty document", () => {
    expect(nextCalloutNumber(doc([]))).toBe(1);
  });

  it("increments past the highest badge in use", () => {
    const items = [
      createAnnotation("callout", { x: 10, y: 10 }, { number: 1 }),
      createAnnotation("rect", { x: 0, y: 0, w: 5, h: 5 }),
      createAnnotation("callout", { x: 50, y: 10 }, { number: 4 }),
    ];
    expect(nextCalloutNumber(doc(items))).toBe(5);
  });

  it("counts the badges the renderer assigns to unnumbered callouts", () => {
    const source = parseDoc(
      '{"width":100,"height":100,"items":[' +
        '{"kind":"callout","x":0,"y":0,"w":20,"h":20},' +
        '{"kind":"callout","x":30,"y":0,"w":20,"h":20}]}',
    );
    const svg = renderSvgOverlay(source);
    expect(svg).toContain(">1</text>");
    expect(svg).toContain(">2</text>");
    // The next badge must not collide with one already on screen.
    expect(nextCalloutNumber(source)).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* serialization                                                       */
/* ------------------------------------------------------------------ */

describe("serializeDoc and parseDoc", () => {
  const source = doc([
    createAnnotation("rect", { x: 4, y: 6, w: 100, h: 40 }, { id: "r1", color: "#0091ff" }),
    createAnnotation(
      "arrow",
      {
        points: [
          { x: 10, y: 10 },
          { x: 90, y: 70 },
        ],
      },
      { id: "a1", strokeWidth: 6 },
    ),
    createAnnotation("text", { x: 20, y: 200 }, { id: "t1", text: "Click here", fontSize: 24 }),
    createAnnotation("callout", { x: 300, y: 120 }, { id: "c1", number: 2 }),
  ]);

  it("round trips without losing anything", () => {
    const json = serializeDoc(source);
    const back = parseDoc(json);
    expect(back).toEqual(source);
    expect(serializeDoc(back)).toBe(json);
  });

  it("emits compact JSON with no whitespace", () => {
    const json = serializeDoc(source);
    expect(json.startsWith('{"width":800,"height":600,"items":[')).toBe(true);
    expect(json).not.toContain("\n");
  });

  it("omits optional fields that are not set", () => {
    const json = serializeDoc(doc([createAnnotation("rect", { x: 0, y: 0, w: 1, h: 1 })]));
    expect(json).not.toContain("points");
    expect(json).not.toContain("number");
    expect(json).not.toContain("fontSize");
  });

  it("fills missing style fields from the supplied defaults", () => {
    const back = parseDoc(
      '{"width":100,"height":100,"items":[{"kind":"rect","x":1,"y":1,"w":2,"h":2}]}',
      {
        color: "#30a46c",
        strokeWidth: 9,
      },
    );
    expect(back.items[0]!.color).toBe("#30a46c");
    expect(back.items[0]!.strokeWidth).toBe(9);
  });

  it("rejects junk that is not JSON", () => {
    try {
      parseDoc("not json at all {");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("bad-doc");
    }
  });

  it("rejects an empty string", () => {
    expect(() => parseDoc("   ")).toThrow(ToolError);
  });

  it("rejects a JSON array", () => {
    try {
      parseDoc("[1,2,3]");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-doc");
    }
  });

  it("rejects a document with no canvas size", () => {
    try {
      parseDoc('{"items":[]}');
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-doc");
      expect((error as ToolError).message).toContain("width");
    }
  });

  it("rejects a non array items field", () => {
    try {
      parseDoc('{"width":10,"height":10,"items":"nope"}');
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-doc");
    }
  });

  it("rejects an item with an unknown kind", () => {
    try {
      parseDoc('{"width":10,"height":10,"items":[{"kind":"sparkle","x":0,"y":0,"w":1,"h":1}]}');
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-doc");
      expect((error as ToolError).message).toContain("sparkle");
    }
  });

  it("rejects an item that is not an object", () => {
    try {
      parseDoc('{"width":10,"height":10,"items":[42]}');
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-doc");
    }
  });

  it("treats a missing items field as an empty document", () => {
    expect(parseDoc('{"width":10,"height":10}').items).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

describe("renderSvgOverlay", () => {
  it("wraps the annotations in a transparent, sized SVG", () => {
    const svg = renderSvgOverlay(doc([]));
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="800" height="600" viewBox="0 0 800 600"');
    // No background rectangle: only the annotations are drawn.
    expect(svg).not.toContain("<rect");
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("draws an arrow as a shaft plus an explicit polygon head", () => {
    const item = createAnnotation(
      "arrow",
      {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
      { id: "a1", color: "#0091ff", strokeWidth: 4 },
    );
    const svg = renderSvgOverlay(doc([item]));
    expect(svg).toContain("<polygon points=");
    expect(svg).toContain('data-kind="arrow-head"');
    expect(svg).not.toContain("<marker");
    expect(svg).not.toContain("marker-end");
    // The shaft stops at the base of the head, not at the tip.
    expect(svg).toContain('x2="87.2"');
  });

  it("draws a rect, an ellipse, and a line", () => {
    const svg = renderSvgOverlay(
      doc([
        createAnnotation("rect", { x: 1, y: 2, w: 30, h: 40 }, { id: "r" }),
        createAnnotation("ellipse", { x: 0, y: 0, w: 20, h: 10 }, { id: "e" }),
        createAnnotation(
          "line",
          {
            points: [
              { x: 0, y: 0 },
              { x: 5, y: 5 },
            ],
          },
          { id: "l" },
        ),
      ]),
    );
    expect(svg).toContain('<rect x="1" y="2" width="30" height="40"');
    expect(svg).toContain('<ellipse cx="10" cy="5" rx="10" ry="5"');
    expect(svg).toContain('data-kind="line"');
  });

  it("draws a highlight as a translucent yellow rect", () => {
    const svg = renderSvgOverlay(
      doc([createAnnotation("highlight", { x: 5, y: 5, w: 60, h: 18 }, { id: "h" })]),
    );
    expect(svg).toContain('fill="#ffe14d"');
    expect(svg).toContain('fill-opacity="0.35"');
    expect(svg).toContain('data-kind="highlight"');
  });

  it("draws text on a soft background pill and escapes the label", () => {
    const svg = renderSvgOverlay(
      doc([
        createAnnotation(
          "text",
          { x: 10, y: 10 },
          { id: "t", text: '5 < 6 & "quoted"', fontSize: 20 },
        ),
      ]),
    );
    expect(svg).toContain('data-kind="text-pill"');
    expect(svg).toContain('fill-opacity="0.72"');
    expect(svg).toContain("5 &lt; 6 &amp; &quot;quoted&quot;");
    expect(svg).not.toContain("< 6");
  });

  it("draws a blur as a hatched placeholder carrying a data attribute", () => {
    const svg = renderSvgOverlay(
      doc([createAnnotation("blur", { x: 0, y: 0, w: 50, h: 20 }, { id: "b" })]),
    );
    expect(svg).toContain('<pattern id="sa-hatch"');
    expect(svg).toContain('fill="url(#sa-hatch)"');
    expect(svg).toContain('data-kind="blur"');
    expect(svg).toContain('data-placeholder="true"');
  });

  it("omits the hatch pattern when nothing is blurred", () => {
    const svg = renderSvgOverlay(
      doc([createAnnotation("rect", { x: 0, y: 0, w: 5, h: 5 }, { id: "r" })]),
    );
    expect(svg).not.toContain("<pattern");
    expect(svg).not.toContain("<defs>");
  });

  it("numbers unnumbered callouts in document order", () => {
    const svg = renderSvgOverlay(
      doc([
        createAnnotation("callout", { x: 10, y: 10 }, { id: "c1" }),
        createAnnotation("callout", { x: 60, y: 10 }, { id: "c2" }),
        createAnnotation("callout", { x: 110, y: 10 }, { id: "c3" }),
      ]),
    );
    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg).toContain(">1</text>");
    expect(svg).toContain(">2</text>");
    expect(svg).toContain(">3</text>");
  });

  it("honors an explicit callout number and continues past it", () => {
    const svg = renderSvgOverlay(
      doc([
        createAnnotation("callout", { x: 10, y: 10 }, { id: "c1", number: 5 }),
        createAnnotation("callout", { x: 60, y: 10 }, { id: "c2" }),
      ]),
    );
    expect(svg).toContain(">5</text>");
    expect(svg).toContain(">6</text>");
    expect(svg).not.toContain(">1</text>");
  });

  it("draws freehand as a smoothed bezier path", () => {
    const svg = renderSvgOverlay(
      doc([
        createAnnotation(
          "freehand",
          {
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 20 },
              { x: 30, y: 10 },
              { x: 50, y: 40 },
            ],
          },
          { id: "f" },
        ),
      ]),
    );
    expect(svg).toContain('<path d="M 0 0');
    expect(svg).toContain(" C ");
    expect(svg).toContain('data-kind="freehand"');
  });

  it("is deterministic for the same document", () => {
    const source = doc([
      createAnnotation("rect", { x: 1, y: 1, w: 10, h: 10 }, { id: "r" }),
      createAnnotation("callout", { x: 40, y: 40 }, { id: "c" }),
      createAnnotation("blur", { x: 5, y: 5, w: 20, h: 20 }, { id: "b" }),
    ]);
    expect(renderSvgOverlay(source)).toBe(renderSvgOverlay(source));
    expect(renderSvgOverlay(source)).toBe(renderSvgOverlay(parseDoc(serializeDoc(source))));
  });

  it("draws every kind without throwing", () => {
    for (const kind of ANNOTATION_KINDS) {
      const geometry =
        kind === "arrow" || kind === "line" || kind === "freehand"
          ? {
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 20 },
              ],
            }
          : { x: 0, y: 0, w: 20, h: 20 };
      const svg = renderSvgOverlay(
        doc([createAnnotation(kind, geometry, { id: kind, text: "x" })]),
      );
      expect(svg.length).toBeGreaterThan(60);
    }
  });
});

describe("arrowHeadPolygon", () => {
  it("returns three vertices and a shortened shaft", () => {
    const geometry = arrowHeadPolygon({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)!;
    expect(geometry.head).toHaveLength(3);
    expect(geometry.head[0]).toEqual({ x: 100, y: 0 });
    expect(geometry.shaftEnd.x).toBeLessThan(100);
  });

  it("returns null for a zero length arrow", () => {
    expect(arrowHeadPolygon({ x: 5, y: 5 }, { x: 5, y: 5 }, 4)).toBeNull();
  });
});

describe("freehandPath", () => {
  it("degrades a two point stroke to a straight segment", () => {
    expect(
      freehandPath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe("M 0 0 L 10 10");
  });

  it("returns an empty string for no points", () => {
    expect(freehandPath([])).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* pixel operations                                                    */
/* ------------------------------------------------------------------ */

describe("blurRegionRgba", () => {
  const width = 12;
  const height = 10;
  const rect: RectLike = { x: 3, y: 2, w: 5, h: 4 };

  it("changes only the region and leaves every other pixel identical", () => {
    const source = gradient(width, height);
    const pristine = new Uint8ClampedArray(source);
    const out = blurRegionRgba(source, width, height, rect, 2);

    // The input buffer is never mutated.
    expect(Array.from(source)).toEqual(Array.from(pristine));
    expect(out).not.toBe(source);
    expectOutsideUntouched(out, pristine, width, height, rect);

    let changed = 0;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (pixelAt(out, width, x, y).join() !== pixelAt(pristine, width, x, y).join()) changed++;
      }
    }
    expect(changed).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const source = gradient(width, height);
    expect(Array.from(blurRegionRgba(source, width, height, rect, 3))).toEqual(
      Array.from(blurRegionRgba(source, width, height, rect, 3)),
    );
  });

  it("leaves a flat colored region exactly as it was", () => {
    const source = new Uint8ClampedArray(width * height * 4).fill(120);
    const out = blurRegionRgba(source, width, height, rect, 3);
    expect(Array.from(out)).toEqual(Array.from(source));
  });

  it("is a no-op when the region falls outside the image", () => {
    const source = gradient(width, height);
    const out = blurRegionRgba(source, width, height, { x: 400, y: 400, w: 10, h: 10 }, 4);
    expect(Array.from(out)).toEqual(Array.from(source));
  });
});

describe("pixelateRegionRgba", () => {
  const width = 12;
  const height = 12;

  it("makes each block uniform and leaves the rest identical", () => {
    const source = gradient(width, height);
    const pristine = new Uint8ClampedArray(source);
    const rect: RectLike = { x: 2, y: 2, w: 8, h: 8 };
    const out = pixelateRegionRgba(source, width, height, rect, 4);

    expect(Array.from(source)).toEqual(Array.from(pristine));
    expectOutsideUntouched(out, pristine, width, height, rect);

    // Two 4x4 blocks per row: every pixel inside a block matches its corner.
    for (const [bx, by] of [
      [2, 2],
      [6, 2],
      [2, 6],
      [6, 6],
    ]) {
      const corner = pixelAt(out, width, bx!, by!);
      for (let y = by!; y < by! + 4; y++) {
        for (let x = bx!; x < bx! + 4; x++) {
          expect(pixelAt(out, width, x, y)).toEqual(corner);
        }
      }
    }
  });

  it("clips an edge block to the selection", () => {
    const source = gradient(width, height);
    const rect: RectLike = { x: 0, y: 0, w: 6, h: 6 };
    const out = pixelateRegionRgba(source, width, height, rect, 4);
    // The 4x4 block and the clipped 2 wide block must differ from each other.
    expect(pixelAt(out, width, 0, 0)).not.toEqual(pixelAt(out, width, 5, 0));
    expectOutsideUntouched(out, source, width, height, rect);
  });
});

/* ------------------------------------------------------------------ */
/* hit testing                                                         */
/* ------------------------------------------------------------------ */

describe("hitTest", () => {
  it("returns the topmost item when two overlap", () => {
    const under = createAnnotation("rect", { x: 0, y: 0, w: 100, h: 100 }, { id: "under" });
    const over = createAnnotation("rect", { x: 20, y: 20, w: 40, h: 40 }, { id: "over" });
    const hit = hitTest(doc([under, over]), 30, 30);
    expect(hit?.id).toBe("over");
    expect(hit).toBe(over);
  });

  it("falls through to the lower item outside the top one", () => {
    const under = createAnnotation("rect", { x: 0, y: 0, w: 100, h: 100 }, { id: "under" });
    const over = createAnnotation("rect", { x: 20, y: 20, w: 10, h: 10 }, { id: "over" });
    expect(hitTest(doc([under, over]), 80, 80)?.id).toBe("under");
  });

  it("returns null when nothing is under the point", () => {
    const item = createAnnotation("rect", { x: 0, y: 0, w: 10, h: 10 }, { id: "r" });
    expect(hitTest(doc([item]), 500, 500)).toBeNull();
    expect(hitTest(doc([]), 1, 1)).toBeNull();
  });

  it("hits a stroke near a line but not far from it", () => {
    const line = createAnnotation(
      "line",
      {
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
      { id: "l", strokeWidth: 4 },
    );
    expect(hitTest(doc([line]), 50, 1)?.id).toBe("l");
    expect(hitTest(doc([line]), 50, 40)).toBeNull();
  });

  it("uses the ellipse outline, not its bounding box", () => {
    const ellipse = createAnnotation("ellipse", { x: 0, y: 0, w: 100, h: 100 }, { id: "e" });
    expect(hitTest(doc([ellipse]), 50, 50)?.id).toBe("e");
    // The corner of the bounding box is outside the circle.
    expect(hitTest(doc([ellipse]), 2, 2)).toBeNull();
  });

  it("ignores a non finite point", () => {
    const item = createAnnotation("rect", { x: 0, y: 0, w: 10, h: 10 }, { id: "r" });
    expect(hitTest(doc([item]), Number.NaN, 5)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("explains the panel and lists the shortcuts when there is no document", () => {
    const out = run("");
    expect(Object.keys(out)).toEqual(["Note", "Shortcuts"]);
    expect(out.Note).toContain("panel");
    expect(out.Shortcuts).toBe(
      "A arrow, R rect, E ellipse, T text, C callout, B blur, H highlight, F freehand, Delete removes selection, Ctrl+Z undo.",
    );
  });

  it("treats whitespace as no document", () => {
    expect(run("  \n ").Shortcuts).toBeDefined();
  });

  it("summarizes a document and returns the overlay", () => {
    const source = doc(
      [
        createAnnotation("rect", { x: 0, y: 0, w: 10, h: 10 }, { id: "r1" }),
        createAnnotation("rect", { x: 20, y: 0, w: 10, h: 10 }, { id: "r2" }),
        createAnnotation("callout", { x: 60, y: 60 }, { id: "c1", number: 3 }),
      ],
      1280,
      720,
    );
    const out = run(serializeDoc(source));
    expect(out.Canvas).toBe("1280 x 720 px");
    expect(out.Annotations).toBe("3");
    expect(out["By kind"]).toBe("rect 2, callout 1");
    expect(out["Next callout number"]).toBe("4");
    expect(out["SVG overlay"]).toContain("<svg xmlns=");
    expect(out["SVG overlay"]).toContain('data-kind="callout"');
  });

  it("reports an empty document honestly", () => {
    const out = run('{"width":100,"height":100,"items":[]}');
    expect(out.Annotations).toBe("0");
    expect(out["By kind"]).toBe("nothing drawn yet");
  });

  it("applies the style options to items that carry none", () => {
    const out = run(
      '{"width":100,"height":100,"items":[{"kind":"rect","x":0,"y":0,"w":9,"h":9}]}',
      {
        color: "#8e4ec6",
        strokeWidth: 8,
      },
    );
    expect(out["SVG overlay"]).toContain('stroke="#8e4ec6"');
    expect(out["SVG overlay"]).toContain('stroke-width="8"');
  });

  it("throws bad-doc on a broken document", () => {
    try {
      run("{ not json");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("bad-doc");
      expect((error as ToolError).fix).toBeTruthy();
    }
  });
});
