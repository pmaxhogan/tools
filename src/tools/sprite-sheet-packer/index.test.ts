import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  blitInto,
  extrudeEdges,
  formatPlacements,
  occupiedBox,
  packRects,
  parseSizeLines,
  run,
  toCss,
  toCsv,
  toJsonArray,
  toJsonHash,
  toPhaser3,
  toXml,
  trimTransparent,
  type Box,
  type PackAlgorithm,
  type PackItem,
  type PackResult,
} from "./index";

/* ------------------------------------------------------------------ *
 * fixtures and checkers
 * ------------------------------------------------------------------ */

/** Twenty sprites of five different shapes, the shape of a real small game. */
const SPRITES: PackItem[] = [
  { id: "hero-idle", w: 128, h: 128 },
  { id: "hero-run", w: 128, h: 128 },
  { id: "boss-idle", w: 96, h: 64 },
  { id: "boss-hit", w: 96, h: 64 },
  { id: "boss-dead", w: 96, h: 64 },
  { id: "tile-grass", w: 64, h: 64 },
  { id: "tile-stone", w: 64, h: 64 },
  { id: "tile-water", w: 64, h: 64 },
  { id: "tile-lava", w: 64, h: 64 },
  { id: "item-sword", w: 48, h: 32 },
  { id: "item-shield", w: 48, h: 32 },
  { id: "item-potion", w: 48, h: 32 },
  { id: "item-key", w: 48, h: 32 },
  { id: "item-coin", w: 48, h: 32 },
  { id: "ui-heart", w: 32, h: 24 },
  { id: "ui-star", w: 32, h: 24 },
  { id: "ui-arrow", w: 32, h: 24 },
  { id: "ui-cursor", w: 32, h: 24 },
  { id: "ui-badge", w: 32, h: 24 },
  { id: "ui-slot", w: 32, h: 24 },
];

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Every pair of placements must be disjoint once each footprint is grown by the
 * padding, which is the same statement as "no overlaps and the gap between any
 * two sprites is at least padding".
 */
function findCollision(pack: PackResult, gap: number): string | null {
  const boxes = pack.placements.map((p) => {
    const b = occupiedBox(p);
    return { id: p.id, x: b.x, y: b.y, w: b.w + gap, h: b.h + gap };
  });
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxesOverlap(boxes[i]!, boxes[j]!)) return `${boxes[i]!.id} and ${boxes[j]!.id}`;
    }
  }
  return null;
}

function outOfBin(pack: PackResult): string | null {
  for (const p of pack.placements) {
    const b = occupiedBox(p);
    if (b.x < 0 || b.y < 0 || b.x + b.w > pack.width || b.y + b.h > pack.height) return p.id;
  }
  return null;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** An RGBA buffer of `w` by `h` fully transparent pixels. */
function blank(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4);
}

function setPixel(
  buf: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
  r: number,
  g = r,
  b = r,
  a = 255,
): void {
  const i = (y * w + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

function redAt(buf: Uint8ClampedArray, w: number, x: number, y: number): number {
  return buf[(y * w + x) * 4]!;
}

function alphaAt(buf: Uint8ClampedArray, w: number, x: number, y: number): number {
  return buf[(y * w + x) * 4 + 3]!;
}

/**
 * The ToolError code a call throws, or "no-error" when it returns. Asserting on
 * this instead of a bare try/catch means a branch that stops throwing fails the
 * test rather than passing vacuously.
 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ToolError ? err.code : `not-a-tool-error:${String(err)}`;
  }
  return "no-error";
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * packRects
 * ------------------------------------------------------------------ */

describe("packRects", () => {
  it("packs twenty varied sprites into 512 by 512 with no overlaps and good efficiency", () => {
    const pack = packRects(SPRITES, { maxWidth: 512, maxHeight: 512, padding: 2 });

    expect(pack.unplaced).toEqual([]);
    expect(pack.placements).toHaveLength(20);
    expect(pack.width).toBeLessThanOrEqual(512);
    expect(pack.height).toBeLessThanOrEqual(512);
    expect(outOfBin(pack)).toBeNull();
    expect(findCollision(pack, 0)).toBeNull();
    expect(pack.efficiency).toBeGreaterThan(0.6);
    expect(pack.efficiency).toBeLessThanOrEqual(1);
  });

  it("keeps at least the requested padding between every pair of sprites", () => {
    for (const padding of [0, 2, 8]) {
      const pack = packRects(SPRITES, { maxWidth: 1024, maxHeight: 1024, padding });
      expect(pack.padding).toBe(padding);
      expect(findCollision(pack, padding)).toBeNull();
    }
  });

  it("returns power of two sides when asked", () => {
    const pack = packRects(SPRITES, { maxWidth: 2048, maxHeight: 2048, powerOfTwo: true });
    expect(pack.unplaced).toEqual([]);
    expect(isPowerOfTwo(pack.width)).toBe(true);
    expect(isPowerOfTwo(pack.height)).toBe(true);
    expect(outOfBin(pack)).toBeNull();
  });

  it("never exceeds a power of two ceiling that is not itself a power of two", () => {
    const pack = packRects(SPRITES, { maxWidth: 1000, maxHeight: 1000, powerOfTwo: true });
    expect(pack.width).toBeLessThanOrEqual(512);
    expect(pack.height).toBeLessThanOrEqual(512);
    expect(isPowerOfTwo(pack.width)).toBe(true);
  });

  it("reports sprites that cannot fit instead of dropping them", () => {
    const pack = packRects(
      [
        { id: "sky", w: 4000, h: 4000 },
        { id: "small-a", w: 32, h: 32 },
        { id: "small-b", w: 32, h: 32 },
      ],
      { maxWidth: 512, maxHeight: 512 },
    );
    expect(pack.unplaced).toEqual(["sky"]);
    expect(pack.placements.map((p) => p.id).sort()).toEqual(["small-a", "small-b"]);
    expect(pack.width).toBeLessThanOrEqual(512);
  });

  it("produces a valid layout for every algorithm", () => {
    const algorithms: PackAlgorithm[] = ["maxrects", "guillotine", "shelf"];
    for (const algorithm of algorithms) {
      const pack = packRects(SPRITES, {
        maxWidth: 1024,
        maxHeight: 1024,
        padding: 2,
        algorithm,
      });
      expect(pack.algorithm).toBe(algorithm);
      expect(pack.unplaced).toEqual([]);
      expect(pack.placements).toHaveLength(20);
      expect(outOfBin(pack)).toBeNull();
      expect(findCollision(pack, 2)).toBeNull();
      expect(pack.efficiency).toBeGreaterThan(0);
    }
  });

  it("packs tighter with MaxRects than with the shelf packer", () => {
    const opts = { maxWidth: 1024, maxHeight: 1024, padding: 2 } as const;
    const best = packRects(SPRITES, { ...opts, algorithm: "maxrects" });
    const shelf = packRects(SPRITES, { ...opts, algorithm: "shelf" });
    expect(best.efficiency).toBeGreaterThanOrEqual(shelf.efficiency);
  });

  it("rotates sprites only when rotation is allowed, and keeps unrotated sizes", () => {
    const tall: PackItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `col-${i}`,
      w: 16,
      h: 96,
    }));
    const flat = packRects(tall, { maxWidth: 256, maxHeight: 256, padding: 0 });
    expect(flat.placements.every((p) => !p.rotated)).toBe(true);

    const turned = packRects(tall, {
      maxWidth: 256,
      maxHeight: 256,
      padding: 0,
      allowRotate: true,
      algorithm: "shelf",
    });
    expect(turned.placements.some((p) => p.rotated)).toBe(true);
    for (const p of turned.placements) {
      expect(p.w).toBe(16);
      expect(p.h).toBe(96);
      if (p.rotated) expect(occupiedBox(p)).toMatchObject({ w: 96, h: 16 });
    }
    expect(findCollision(turned, 0)).toBeNull();
  });

  it("is deterministic and independent of input order", () => {
    const shuffled = [...SPRITES].reverse();
    const a = packRects(SPRITES, { maxWidth: 512, maxHeight: 512 });
    const b = packRects(shuffled, { maxWidth: 512, maxHeight: 512 });
    const c = packRects(SPRITES, { maxWidth: 512, maxHeight: 512 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it("packs a single sprite into exactly its own size", () => {
    const pack = packRects([{ id: "only", w: 40, h: 24 }], { padding: 0 });
    expect(pack.width).toBe(40);
    expect(pack.height).toBe(24);
    expect(pack.efficiency).toBeCloseTo(1, 10);
    expect(pack.placements[0]).toEqual({ id: "only", x: 0, y: 0, w: 40, h: 24, rotated: false });
  });

  it("rejects bad input", () => {
    expect(() => packRects([])).toThrowError(ToolError);
    expect(() => packRects([])).toThrowError(/no sprites/i);
    expect(codeOf(() => packRects([]))).toBe("no-items");
    expect(codeOf(() => packRects("nope" as unknown as PackItem[]))).toBe("no-items");
    expect(codeOf(() => packRects([42 as unknown as PackItem]))).toBe("invalid-item");
    expect(codeOf(() => packRects([{ id: "  ", w: 4, h: 4 }]))).toBe("invalid-item");
    expect(codeOf(() => packRects([{ id: "a", w: 0, h: 4 }]))).toBe("invalid-size");
    expect(codeOf(() => packRects([{ id: "a", w: 4.5, h: 4 }]))).toBe("invalid-size");
    expect(codeOf(() => packRects([{ id: "a", w: 999999, h: 4 }]))).toBe("invalid-size");
    expect(
      codeOf(() =>
        packRects([
          { id: "a", w: 4, h: 4 },
          { id: "a", w: 8, h: 8 },
        ]),
      ),
    ).toBe("duplicate-id");
    expect(codeOf(() => packRects(SPRITES, { padding: -1 }))).toBe("invalid-padding");
    expect(codeOf(() => packRects(SPRITES, { padding: 1.5 }))).toBe("invalid-padding");
    expect(codeOf(() => packRects(SPRITES, { maxWidth: 0 }))).toBe("invalid-max-size");
    expect(codeOf(() => packRects(SPRITES, { maxHeight: 99999999 }))).toBe("invalid-max-size");
    expect(
      codeOf(() => packRects(SPRITES, { algorithm: "skyline" as unknown as PackAlgorithm })),
    ).toBe("invalid-algorithm");
  });
});

/* ------------------------------------------------------------------ *
 * pixel helpers
 * ------------------------------------------------------------------ */

describe("trimTransparent", () => {
  it("finds the opaque bounds inside a transparent border", () => {
    const w = 8;
    const h = 6;
    const buf = blank(w, h);
    for (let y = 1; y < 3; y += 1) {
      for (let x = 2; x < 5; x += 1) setPixel(buf, w, x, y, 200);
    }
    expect(trimTransparent(buf, w, h)).toEqual({ x: 2, y: 1, w: 3, h: 2, empty: false });
  });

  it("ignores faint pixels above the threshold only", () => {
    const w = 4;
    const h = 4;
    const buf = blank(w, h);
    setPixel(buf, w, 1, 1, 255, 255, 255, 10);
    setPixel(buf, w, 2, 2, 255, 255, 255, 255);
    expect(trimTransparent(buf, w, h, 0)).toEqual({ x: 1, y: 1, w: 2, h: 2, empty: false });
    expect(trimTransparent(buf, w, h, 32)).toEqual({ x: 2, y: 2, w: 1, h: 1, empty: false });
  });

  it("reports an empty box for a fully transparent image", () => {
    expect(trimTransparent(blank(5, 5), 5, 5)).toEqual({ x: 0, y: 0, w: 0, h: 0, empty: true });
  });

  it("rejects a buffer that does not match the size", () => {
    expect(() => trimTransparent(blank(4, 4), 5, 5)).toThrowError(ToolError);
    expect(codeOf(() => trimTransparent(blank(4, 4), 5, 5))).toBe("size-mismatch");
    expect(codeOf(() => trimTransparent(blank(4, 4), 0, 4))).toBe("invalid-size");
    expect(codeOf(() => trimTransparent(blank(4, 4), 4, 4, 900))).toBe("invalid-threshold");
    expect(codeOf(() => trimTransparent(blank(4, 4), 4, 4, -1))).toBe("invalid-threshold");
  });
});

describe("blitInto", () => {
  /** A 2 wide by 3 tall sprite whose red channel is 1 to 6, row major. */
  function sprite(): Uint8ClampedArray {
    const buf = blank(2, 3);
    let n = 1;
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        setPixel(buf, 2, x, y, n);
        n += 1;
      }
    }
    return buf;
  }

  it("copies a sprite unrotated at the given offset", () => {
    const atlas = blank(4, 4);
    blitInto(atlas, 4, sprite(), 2, 3, 1, 1);
    expect(redAt(atlas, 4, 1, 1)).toBe(1);
    expect(redAt(atlas, 4, 2, 1)).toBe(2);
    expect(redAt(atlas, 4, 1, 2)).toBe(3);
    expect(redAt(atlas, 4, 2, 2)).toBe(4);
    expect(redAt(atlas, 4, 1, 3)).toBe(5);
    expect(redAt(atlas, 4, 2, 3)).toBe(6);
    // Nothing outside the destination box was touched.
    expect(alphaAt(atlas, 4, 0, 0)).toBe(0);
    expect(alphaAt(atlas, 4, 3, 3)).toBe(0);
  });

  it("turns a sprite 90 degrees clockwise when rotated", () => {
    const atlas = blank(3, 2);
    blitInto(atlas, 3, sprite(), 2, 3, 0, 0, true);
    // 1 2 / 3 4 / 5 6 rotated clockwise is 5 3 1 / 6 4 2.
    expect([0, 1, 2].map((x) => redAt(atlas, 3, x, 0))).toEqual([5, 3, 1]);
    expect([0, 1, 2].map((x) => redAt(atlas, 3, x, 1))).toEqual([6, 4, 2]);
  });

  it("agrees with the box packRects reported", () => {
    const pack = packRects([{ id: "s", w: 2, h: 3 }], { padding: 0 });
    const box = occupiedBox(pack.placements[0]!);
    const atlas = blank(pack.width, pack.height);
    expect(() =>
      blitInto(atlas, pack.width, sprite(), 2, 3, box.x, box.y, pack.placements[0]!.rotated),
    ).not.toThrow();
  });

  it("rejects an atlas, a sprite, or a position it cannot honor", () => {
    expect(codeOf(() => blitInto(new Uint8ClampedArray(10), 4, sprite(), 2, 3, 0, 0))).toBe(
      "size-mismatch",
    );
    expect(codeOf(() => blitInto(blank(4, 4), 4, blank(2, 2), 2, 3, 0, 0))).toBe("size-mismatch");
    expect(codeOf(() => blitInto(blank(4, 4), 4, sprite(), 2, 3, 0.5, 0))).toBe("invalid-position");
    expect(codeOf(() => blitInto(blank(4, 4), 4, sprite(), 2, 3, 3, 3))).toBe("out-of-bounds");
    expect(codeOf(() => blitInto(blank(4, 4), 4, sprite(), 2, 3, -1, 0))).toBe("out-of-bounds");
  });
});

describe("extrudeEdges", () => {
  it("bleeds the border pixels into the gutter", () => {
    const atlas = blank(4, 4);
    for (let y = 1; y < 3; y += 1) {
      for (let x = 1; x < 3; x += 1) setPixel(atlas, 4, x, y, 10 * x + y);
    }
    extrudeEdges(atlas, 4, { x: 1, y: 1, w: 2, h: 2 }, 1);
    // The corner copies the nearest corner pixel, the sides copy their row or column.
    expect(redAt(atlas, 4, 0, 0)).toBe(redAt(atlas, 4, 1, 1));
    expect(redAt(atlas, 4, 3, 3)).toBe(redAt(atlas, 4, 2, 2));
    expect(redAt(atlas, 4, 0, 2)).toBe(redAt(atlas, 4, 1, 2));
    expect(redAt(atlas, 4, 2, 3)).toBe(redAt(atlas, 4, 2, 2));
    expect(alphaAt(atlas, 4, 0, 0)).toBe(255);
  });

  it("is a no op for an empty box or a zero extrude", () => {
    const atlas = blank(4, 4);
    setPixel(atlas, 4, 1, 1, 99);
    extrudeEdges(atlas, 4, { x: 1, y: 1, w: 0, h: 0 }, 2);
    extrudeEdges(atlas, 4, { x: 1, y: 1, w: 1, h: 1 }, 0);
    expect(alphaAt(atlas, 4, 0, 0)).toBe(0);
  });

  it("rejects a bad atlas or a bad extrude", () => {
    expect(
      codeOf(() => extrudeEdges(new Uint8ClampedArray(9), 4, { x: 0, y: 0, w: 1, h: 1 }, 1)),
    ).toBe("size-mismatch");
    expect(codeOf(() => extrudeEdges(blank(4, 4), 4, { x: 0, y: 0, w: 1, h: 1 }, -2))).toBe(
      "invalid-extrude",
    );
    expect(codeOf(() => extrudeEdges(blank(4, 4), 4, { x: 0, y: 0, w: 1, h: 1 }, 1.5))).toBe(
      "invalid-extrude",
    );
  });
});

/* ------------------------------------------------------------------ *
 * exporters
 * ------------------------------------------------------------------ */

describe("exporters", () => {
  const pack = packRects(SPRITES, { maxWidth: 512, maxHeight: 512, padding: 2 });

  it("writes a TexturePacker JSON hash keyed by sprite name", () => {
    const parsed = JSON.parse(toJsonHash(pack, { imageName: "atlas.png" })) as {
      frames: Record<string, Record<string, unknown>>;
      meta: Record<string, unknown>;
    };
    expect(Object.keys(parsed.frames).sort()).toEqual(SPRITES.map((s) => s.id).sort());
    const hero = parsed.frames["hero-idle"]!;
    expect(hero.frame).toMatchObject({ w: 128, h: 128 });
    expect(hero.rotated).toBe(false);
    expect(hero.trimmed).toBe(false);
    expect(hero.spriteSourceSize).toEqual({ x: 0, y: 0, w: 128, h: 128 });
    expect(hero.sourceSize).toEqual({ w: 128, h: 128 });
    expect(parsed.meta.image).toBe("atlas.png");
    expect(parsed.meta.size).toEqual({ w: pack.width, h: pack.height });
    expect(parsed.meta.scale).toBe("1");
  });

  it("records trimmed frames with their original size and offset", () => {
    const text = toJsonHash(pack, {
      frames: { "ui-heart": { sourceW: 40, sourceH: 40, offsetX: 4, offsetY: 8 } },
    });
    const parsed = JSON.parse(text) as { frames: Record<string, Record<string, unknown>> };
    expect(parsed.frames["ui-heart"]!.trimmed).toBe(true);
    expect(parsed.frames["ui-heart"]!.spriteSourceSize).toEqual({ x: 4, y: 8, w: 32, h: 24 });
    expect(parsed.frames["ui-heart"]!.sourceSize).toEqual({ w: 40, h: 40 });
    expect(parsed.frames["ui-star"]!.trimmed).toBe(false);
  });

  it("writes the Phaser 3 output identically to the JSON hash", () => {
    expect(toPhaser3(pack)).toBe(toJsonHash(pack));
  });

  it("writes an ordered JSON array with a filename on each frame", () => {
    const parsed = JSON.parse(toJsonArray(pack)) as {
      frames: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };
    expect(Array.isArray(parsed.frames)).toBe(true);
    expect(parsed.frames).toHaveLength(pack.placements.length);
    expect(parsed.frames.map((f) => f.filename)).toEqual(pack.placements.map((p) => p.id));
    expect(parsed.frames[0]!.frame).toBeDefined();
  });

  it("writes one CSS rule per sprite plus the shared rule", () => {
    const css = toCss(pack, { imageName: "atlas.png", classPrefix: "sprite" });
    expect(css).toContain('background-image: url("atlas.png");');
    const rules = css.match(/^\.sprite-/gm) ?? [];
    expect(rules).toHaveLength(pack.placements.length);
    expect(css).toContain(".sprite-hero-idle {");
    expect(css.match(/^\.sprite \{/gm) ?? []).toHaveLength(1);
  });

  it("strips file extensions and honors a custom class prefix", () => {
    const small = packRects([{ id: "Hero Idle.png", w: 8, h: 8 }], { padding: 0 });
    const css = toCss(small, { classPrefix: "icon" });
    expect(css).toContain(".icon-hero-idle {");
    expect(css).toContain("width: 8px;");
    expect(css).toContain("background-position: -0px -0px;");
  });

  it("writes one Starling SubTexture per sprite", () => {
    const xml = toXml(pack, { imageName: "atlas.png" });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<TextureAtlas imagePath="atlas.png"');
    expect(xml.match(/<SubTexture /g) ?? []).toHaveLength(pack.placements.length);
    expect(xml.trimEnd().endsWith("</TextureAtlas>")).toBe(true);
  });

  it("writes the trim offsets as negative frameX and frameY", () => {
    const xml = toXml(pack, {
      frames: { "ui-heart": { sourceW: 40, sourceH: 40, offsetX: 4, offsetY: 8 } },
    });
    expect(xml).toContain('frameX="-4" frameY="-8" frameWidth="40" frameHeight="40"');
  });

  it("escapes XML and quotes CSV", () => {
    const odd = packRects(
      [
        { id: 'a&b<c>"d"', w: 8, h: 8 },
        { id: "comma, name", w: 8, h: 8 },
      ],
      { padding: 0 },
    );
    expect(toXml(odd)).toContain('name="a&amp;b&lt;c&gt;&quot;d&quot;"');
    expect(toCsv(odd)).toContain('"comma, name"');
  });

  it("writes a CSV header plus one row per sprite", () => {
    const lines = toCsv(pack).trimEnd().split("\n");
    expect(lines[0]).toBe("name,x,y,w,h,rotated,trimmed,sourceW,sourceH,offsetX,offsetY");
    expect(lines).toHaveLength(pack.placements.length + 1);
    expect(lines[1]!.split(",")).toHaveLength(11);
  });

  it("renders one placement per line for the report", () => {
    const text = formatPlacements(pack);
    expect(text.split("\n")).toHaveLength(pack.placements.length);
    expect(text).toContain("hero-idle");
  });
});

/* ------------------------------------------------------------------ *
 * parseSizeLines
 * ------------------------------------------------------------------ */

describe("parseSizeLines", () => {
  it("reads name and size from each line", () => {
    expect(parseSizeLines("hero 32x48\n# a comment\nboss, 64 x 64\n\ntile: 16*16")).toEqual([
      { id: "hero", w: 32, h: 48 },
      { id: "boss", w: 64, h: 64 },
      { id: "tile", w: 16, h: 16 },
    ]);
  });

  it("names a bare size automatically", () => {
    expect(parseSizeLines("32x32\n48x48")).toEqual([
      { id: "sprite-1", w: 32, h: 32 },
      { id: "sprite-2", w: 48, h: 48 },
    ]);
  });

  it("keeps digits that belong to the name", () => {
    expect(parseSizeLines("icon-64x64.png 64x64")).toEqual([
      { id: "icon-64x64.png", w: 64, h: 64 },
    ]);
  });

  it("stops on a line it cannot read inside a good list", () => {
    expect(() => parseSizeLines("hero 32x32\nthis is not a size")).toThrowError(ToolError);
    expect(codeOf(() => parseSizeLines("hero 32x32\nthis is not a size"))).toBe("bad-line");
  });

  it("points at the panel when nothing is readable", () => {
    expect(codeOf(() => parseSizeLines("just some prose about sprites"))).toBe("use-panel");
    expect(codeOf(() => parseSizeLines("# only comments\n"))).toBe("use-panel");
  });
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

describe("run", () => {
  it("packs a list of name and size lines", () => {
    const out = run("hero 32x48\nboss 64x64\ncoin 16x16");
    expect(out["Atlas size"]).toMatch(/^\d+ by \d+ pixels$/);
    expect(out.Packed).toBe("3 of 3 sprites");
    expect(out.Unplaced).toBe("None. Every sprite fits.");
    expect(out.Algorithm).toContain("MaxRects");
    expect(out.Padding).toBe("2 pixels between sprites");
    expect(out.Placements!.split("\n")).toHaveLength(3);
    const parsed = JSON.parse(out["JSON hash output"]!) as { frames: Record<string, unknown> };
    expect(Object.keys(parsed.frames).sort()).toEqual(["boss", "coin", "hero"]);
  });

  it("packs a JSON items payload and honors every option", () => {
    const payload = JSON.stringify({
      items: [
        { id: "a", w: 40, h: 40 },
        { id: "b", w: 40, h: 40 },
      ],
    });
    const out = run(payload, {
      maxSize: 512,
      padding: 4,
      powerOfTwo: true,
      allowRotate: true,
      algorithm: "shelf",
      format: "csv",
      trim: false,
    });
    expect(out.Algorithm).toContain("Shelf");
    expect(out.Padding).toBe("4 pixels between sprites");
    expect(out["Trim transparent edges"]).toContain("Off.");
    expect(out["Atlas size"]).toMatch(/^(1|2|4|8|16|32|64|128|256|512) by/);
    expect(out["CSV output"]!.startsWith("name,x,y,w,h,")).toBe(true);
  });

  it("accepts a bare JSON array of items", () => {
    const out = run('[{"id":"one","w":8,"h":8}]');
    expect(out.Packed).toBe("1 of 1 sprites");
  });

  it("accepts UTF-8 bytes from a dropped text file", () => {
    const bytes = new TextEncoder().encode("hero 32x32\nboss 32x32");
    const out = run(bytes);
    expect(out.Packed).toBe("2 of 2 sprites");
  });

  it("names sprites that did not fit", () => {
    const out = run("sky 4000x4000\nsmall 16x16", { maxSize: 256 });
    expect(out.Packed).toBe("1 of 2 sprites");
    expect(out.Unplaced).toContain("sky");
  });

  it("switches the export format", () => {
    expect(run("a 8x8", { format: "css" })["CSS output"]).toContain(".sprite-a {");
    expect(run("a 8x8", { format: "xml" })["XML output"]).toContain("<SubTexture ");
    expect(run("a 8x8", { format: "json-array" })["JSON array output"]).toContain('"filename"');
    expect(run("a 8x8", { format: "phaser" })["JSON hash output"]).toContain('"frames"');
  });

  it("throws for an empty input", () => {
    expect(() => run("")).toThrowError(ToolError);
    expect(codeOf(() => run(""))).toBe("empty-input");
    expect(codeOf(() => run("   \n  "))).toBe("empty-input");
    expect(codeOf(() => run(new Uint8Array(0)))).toBe("empty-input");
  });

  it("points at the panel for a dropped image", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(codeOf(() => run(png))).toBe("use-panel");
    expect(messageOf(() => run(png))).toContain("PNG");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]);
    expect(codeOf(() => run(jpeg))).toBe("use-panel");
    expect(messageOf(() => run(jpeg))).toContain("JPEG");
  });

  it("reports every other bad input with its own code", () => {
    expect(codeOf(() => run("hello there, this is prose"))).toBe("use-panel");
    expect(codeOf(() => run('{"items": '))).toBe("invalid-json");
    expect(codeOf(() => run('{"sprites": []}'))).toBe("use-panel");
    expect(codeOf(() => run("a 8x8", { algorithm: "skyline" }))).toBe("invalid-algorithm");
    expect(codeOf(() => run("a 8x8", { format: "yaml" }))).toBe("invalid-format");
    expect(codeOf(() => run("a 8x8", { maxSize: 4 }))).toBe("invalid-max-size");
    expect(codeOf(() => run("a 8x8", { padding: -3 }))).toBe("invalid-padding");
    expect(codeOf(() => run('{"items": [{"id": "a", "w": -1, "h": 4}]}'))).toBe("invalid-size");
    expect(codeOf(() => run('{"items": []}'))).toBe("no-items");
    expect(codeOf(() => run("hero 32x32\nnot a size"))).toBe("bad-line");
  });
});
