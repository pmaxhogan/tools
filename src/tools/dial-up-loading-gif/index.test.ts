import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  addToHistogram,
  buildPalette,
  buildSchedule,
  createHistogram,
  createMapper,
  encodeLoadingGif,
  interlaceOrder,
  makeLoadingGif,
  makeRng,
  prepareFrame,
  quantizeFrame,
  readSettings,
  rowMap,
  run,
  type DialUpSettings,
} from "./index";

/* ------------------------------------------------------------------ *
 * a small GIF reader, written separately from the encoder under test
 * ------------------------------------------------------------------ */

interface DecodedFrame {
  y: number;
  width: number;
  height: number;
  delayCs: number;
  disposal: number;
  transparent: boolean;
  /** The whole canvas after this frame is drawn, as palette indices or -1. */
  canvas: Int16Array;
}

interface DecodedGif {
  width: number;
  height: number;
  palette: Uint8Array;
  loops: boolean;
  frames: DecodedFrame[];
}

function unLzw(minCodeSize: number, data: number[], pixelCount: number): number[] {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let size = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i += 1) dict.push([i]);
    dict.push([], []);
    size = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bits = 0;
  let bitCount = 0;
  let previous: number[] | null = null;
  for (const byte of data) {
    bits |= byte << bitCount;
    bitCount += 8;
    while (bitCount >= size) {
      const code = bits & ((1 << size) - 1);
      bits >>= size;
      bitCount -= size;
      if (code === clear) {
        reset();
        previous = null;
        continue;
      }
      if (code === end) return out;
      let entry: number[];
      if (code < dict.length) {
        entry = dict[code]!;
      } else if (code === dict.length && previous) {
        entry = [...previous, previous[0]!];
      } else {
        throw new Error(`bad LZW code ${code} with ${dict.length} entries`);
      }
      out.push(...entry);
      if (previous && dict.length < 4096) {
        dict.push([...previous, entry[0]!]);
        if (dict.length === 1 << size && size < 12) size += 1;
      }
      previous = entry;
      if (out.length > pixelCount) throw new Error("LZW stream overruns the frame");
    }
  }
  throw new Error("LZW stream ended without an end code");
}

function decodeGif(bytes: Uint8Array): DecodedGif {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  expect(ascii(0, 6)).toBe("GIF89a");
  const word = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  const width = word(6);
  const height = word(8);
  const packed = bytes[10]!;
  expect(packed & 0x80).toBe(0x80);
  const tableSize = 3 << ((packed & 7) + 1);
  const palette = bytes.slice(13, 13 + tableSize);
  let at = 13 + tableSize;

  const frames: DecodedFrame[] = [];
  let loops = false;
  let canvas = new Int16Array(width * height).fill(-1);
  let control = { delayCs: 0, disposal: 0, transparent: false };

  for (;;) {
    const marker = bytes[at++]!;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[at++]!;
      if (label === 0xf9) {
        expect(bytes[at]).toBe(4);
        control = {
          disposal: (bytes[at + 1]! >> 2) & 7,
          transparent: (bytes[at + 1]! & 1) === 1,
          delayCs: word(at + 2),
        };
        expect(bytes[at + 4]).toBe(0);
        at += 6;
      } else {
        if (label === 0xff && ascii(at + 1, at + 12) === "NETSCAPE2.0") loops = true;
        while (bytes[at]! > 0) at += bytes[at]! + 1;
        at += 1;
      }
      continue;
    }
    expect(marker).toBe(0x2c);
    const x = word(at);
    const y = word(at + 2);
    const w = word(at + 4);
    const h = word(at + 6);
    expect(x).toBe(0);
    expect(bytes[at + 8]).toBe(0);
    at += 9;
    const minCodeSize = bytes[at++]!;
    const data: number[] = [];
    while (bytes[at]! > 0) {
      const length = bytes[at]!;
      for (let i = 1; i <= length; i += 1) data.push(bytes[at + i]!);
      at += length + 1;
    }
    at += 1;
    const pixels = unLzw(minCodeSize, data, w * h);
    expect(pixels.length).toBe(w * h);

    const before = canvas;
    canvas = canvas.slice();
    for (let i = 0; i < pixels.length; i += 1) {
      const value = pixels[i]!;
      if (control.transparent && value === 0) continue;
      canvas[y * width + i] = value;
    }
    frames.push({ y, width: w, height: h, ...control, canvas: canvas.slice() });
    if (control.disposal === 2) {
      canvas = before.slice();
      canvas.fill(-1, y * width, (y + h) * width);
    }
  }
  return { width, height, palette, loops, frames };
}

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** An opaque test card with a gradient, so it has many colors. */
function gradient(width: number, height: number, shift = 0): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      out[p] = (x * 255) / Math.max(1, width - 1);
      out[p + 1] = (y * 255) / Math.max(1, height - 1);
      out[p + 2] = (x * 7 + y * 13 + shift) & 255;
      out[p + 3] = 255;
    }
  }
  return out;
}

function settings(overrides: Partial<DialUpSettings> = {}): DialUpSettings {
  return { ...readSettings({ seed: "test" }), ...overrides };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/* ------------------------------------------------------------------ *
 * tests
 * ------------------------------------------------------------------ */

describe("makeRng", () => {
  it("is deterministic per seed and differs between seeds", () => {
    const a = makeRng("modem");
    const b = makeRng("modem");
    const c = makeRng("fiber");
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("buildSchedule", () => {
  const base = {
    units: 240,
    duration: 4,
    fps: 12,
    randomness: 60,
    stalls: 2,
    stallLength: 0.5,
    seed: "abc",
  };

  it("is monotone, ends on the last row, and lasts exactly the load time", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const steps = buildSchedule({ ...base, seed });
      expect(steps).toHaveLength(48);
      let previous = 0;
      for (const step of steps) {
        expect(step.revealed).toBeGreaterThanOrEqual(previous);
        expect(step.delayCs).toBeGreaterThanOrEqual(2);
        previous = step.revealed;
      }
      expect(steps.at(-1)!.revealed).toBe(240);
      expect(steps.reduce((sum, s) => sum + s.delayCs, 0)).toBe(400);
    }
  });

  it("is a linear wipe with no randomness and no stalls", () => {
    const steps = buildSchedule({ ...base, randomness: 0, stalls: 0 });
    steps.forEach((step, i) => expect(step.revealed).toBe((i + 1) * 5));
  });

  it("repeats for a seed and changes with it", () => {
    const rows = (seed: string) => buildSchedule({ ...base, seed }).map((s) => s.revealed);
    expect(rows("x")).toEqual(rows("x"));
    expect(rows("x")).not.toEqual(rows("y"));
  });

  /** Lengths of each run of consecutive steps where nothing arrived. */
  function stallRuns(steps: { revealed: number }[]): number[] {
    const runs: number[] = [];
    let run = 0;
    for (let i = 1; i < steps.length; i += 1) {
      if (steps[i]!.revealed === steps[i - 1]!.revealed) {
        run += 1;
      } else if (run > 0) {
        runs.push(run);
        run = 0;
      }
    }
    if (run > 0) runs.push(run);
    return runs;
  }

  it("places the requested stalls, each the requested length", () => {
    // 10 seconds at 10 fps, no randomness: three stalls of exactly one second.
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const steps = buildSchedule({
        units: 1000,
        duration: 10,
        fps: 10,
        randomness: 0,
        stalls: 3,
        stallLength: 1,
        seed,
      });
      const runs = stallRuns(steps);
      // Two stalls may land back to back and read as one longer pause.
      expect(runs.reduce((a, b) => a + b, 0)).toBe(30);
      expect(runs.length).toBeLessThanOrEqual(3);
      for (const run of runs) expect(run % 10).toBe(0);
      // Something arrives on the first step and the last one finishes the picture.
      expect(steps[0]!.revealed).toBeGreaterThan(0);
      expect(steps.at(-1)!.revealed).toBeGreaterThan(steps.at(-2)!.revealed);
    }
  });

  it("longer and more frequent stalls stall for longer", () => {
    const stalledSteps = (stalls: number, stallLength: number) =>
      stallRuns(
        buildSchedule({ ...base, duration: 10, randomness: 0, stalls, stallLength, seed: "s" }),
      ).reduce((a, b) => a + b, 0);
    expect(stalledSteps(0, 1)).toBe(0);
    expect(stalledSteps(2, 0.5)).toBe(12);
    expect(stalledSteps(4, 0.5)).toBe(24);
    expect(stalledSteps(2, 1.5)).toBe(36);
  });

  it("caps stalls at 80 percent of the load and still finishes", () => {
    const steps = buildSchedule({ ...base, stalls: 20, stallLength: 10, seed: "cap" });
    const stalled = stallRuns(steps).reduce((a, b) => a + b, 0);
    expect(stalled).toBeLessThanOrEqual(Math.floor(46 * 0.8));
    expect(stalled).toBeGreaterThan(20);
    expect(steps.at(-1)!.revealed).toBe(240);
  });

  it("carries rounding so odd frame rates still sum to the load time", () => {
    const steps = buildSchedule({ ...base, duration: 2.5, fps: 7 });
    expect(steps.reduce((sum, s) => sum + s.delayCs, 0)).toBe(250);
  });

  it("survives a one row picture and a very short load", () => {
    const steps = buildSchedule({ ...base, units: 1, duration: 0.5, fps: 25 });
    expect(steps.at(-1)!.revealed).toBe(1);
    for (const step of steps) expect(step.delayCs).toBeGreaterThanOrEqual(2);
  });
});

describe("rowMap", () => {
  it("fills from the top", () => {
    expect([...rowMap(5, 2, "top")]).toEqual([0, 1, -1, -1, -1]);
  });

  it("fills from the bottom", () => {
    expect([...rowMap(5, 2, "bottom")]).toEqual([-1, -1, -1, 3, 4]);
  });

  it("stretches interlaced rows over the ones still missing", () => {
    // Two rows of pass one have arrived: rows 0 and 8, each eight tall.
    const map = rowMap(16, 2, "interlaced");
    expect([...map]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 8, 8, 8, 8, 8, 8]);
    // One more row (row 4, pass two) sharpens the top block.
    expect([...rowMap(16, 3, "interlaced")].slice(0, 8)).toEqual([0, 0, 0, 0, 4, 4, 4, 4]);
  });

  it("is the identity once every row has arrived, in every style", () => {
    for (const style of ["top", "bottom", "interlaced"] as const) {
      expect([...rowMap(13, 13, style)]).toEqual([...Array(13).keys()]);
    }
  });

  it("delivers every row exactly once when interlaced", () => {
    expect([...interlaceOrder(13)].sort((a, b) => a - b)).toEqual([...Array(13).keys()]);
    expect([...interlaceOrder(10)]).toEqual([0, 8, 4, 2, 6, 1, 3, 5, 7, 9]);
  });
});

describe("palette and quantizer", () => {
  it("keeps few colors exact and reserves index 0 for the background", () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const hist = createHistogram();
    addToHistogram(hist, rgba);
    const palette = buildPalette(hist, { background: [192, 192, 192] });
    expect(palette.count).toBe(5);
    expect(palette.transparent).toBe(false);
    expect([...palette.rgb.subarray(0, 3)]).toEqual([192, 192, 192]);
    const indices = quantizeFrame(rgba, 2, 2, palette, createMapper(palette), false);
    const colors = [...indices].map((i) => [...palette.rgb.subarray(i * 3, i * 3 + 3)]);
    expect(colors).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ]);
  });

  it("never exceeds 256 entries on a many color picture", () => {
    const rgba = gradient(64, 64);
    const hist = createHistogram();
    addToHistogram(hist, rgba);
    const palette = buildPalette(hist, { background: null });
    expect(palette.count).toBe(256);
    expect(palette.transparent).toBe(true);
    const indices = quantizeFrame(rgba, 64, 64, palette, createMapper(palette), true);
    // Opaque pixels never land on the transparent slot.
    expect(indices.every((i) => i > 0)).toBe(true);
  });

  it("maps clear pixels to index 0 and blends them onto a background", () => {
    const clear = new Uint8Array([10, 20, 30, 0, 200, 100, 50, 255]);
    const hist = createHistogram();
    addToHistogram(hist, clear);
    const palette = buildPalette(hist, { background: null });
    expect(palette.count).toBe(2);
    expect([...quantizeFrame(clear, 2, 1, palette, createMapper(palette), false)]).toEqual([0, 1]);

    const flat = new Uint8Array([10, 20, 30, 0, 200, 100, 50, 255]);
    prepareFrame(flat, [255, 255, 255]);
    expect([...flat]).toEqual([255, 255, 255, 255, 200, 100, 50, 255]);
  });

  it("rejects a buffer that does not match its size", () => {
    const palette = buildPalette(createHistogram(), { background: null });
    expect(() =>
      quantizeFrame(new Uint8Array(7), 2, 1, palette, createMapper(palette), false),
    ).toThrow(ToolError);
    expect(() =>
      quantizeFrame(new Uint8Array(0), 0, 1, palette, createMapper(palette), false),
    ).toThrow(ToolError);
  });
});

describe("makeLoadingGif", () => {
  it("writes a still as band updates that add up to the picture", async () => {
    const width = 40;
    const height = 48;
    const s = settings({ dither: false, background: "white", duration: 2, hold: 1.5 });
    const result = await makeLoadingGif({ width, height, frames: [gradient(width, height)] }, s);
    const gif = decodeGif(result.bytes);

    expect(gif.width).toBe(width);
    expect(gif.height).toBe(height);
    expect(gif.loops).toBe(true);
    expect(gif.frames.length).toBe(result.frameCount);
    expect(result.fullFrames).toBe(false);
    // The first frame paints the whole canvas so a loop restarts cleanly.
    expect(gif.frames[0]!.y).toBe(0);
    expect(gif.frames[0]!.height).toBe(height);
    // Later frames are bands, not whole pictures.
    expect(gif.frames.slice(1).every((f) => f.height < height && f.disposal === 1)).toBe(true);
    expect(gif.frames.reduce((sum, f) => sum + f.delayCs, 0)).toBe(350);
    expect(result.totalMs).toBe(3500);

    // The finished canvas is the picture, within the 6 bit palette's rounding.
    const source = gradient(width, height);
    const last = gif.frames.at(-1)!.canvas;
    let worst = 0;
    for (let i = 0; i < width * height; i += 1) {
      const index = last[i]!;
      expect(index).toBeGreaterThanOrEqual(0);
      for (let ch = 0; ch < 3; ch += 1) {
        worst = Math.max(worst, Math.abs(gif.palette[index * 3 + ch]! - source[i * 4 + ch]!));
      }
    }
    expect(worst).toBeLessThan(40);

    // Rows only ever arrive: the count of painted rows never drops.
    let previous = 0;
    for (const frame of gif.frames) {
      let rows = 0;
      for (let y = 0; y < height; y += 1) if (frame.canvas[y * width]! > 0) rows += 1;
      expect(rows).toBeGreaterThanOrEqual(previous);
      previous = rows;
    }
    expect(previous).toBe(height);
  });

  it("is byte for byte reproducible from a seed", async () => {
    const make = (seed: string) =>
      makeLoadingGif({ width: 24, height: 24, frames: [gradient(24, 24)] }, settings({ seed }));
    const a = await make("one");
    const b = await make("one");
    const c = await make("two");
    expect(a.bytes).toEqual(b.bytes);
    expect(a.bytes).not.toEqual(c.bytes);
  });

  it("round trips a picture large enough to reset the LZW table", async () => {
    // Noise is incompressible, so the code table fills and clears many times.
    const width = 128;
    const height = 96;
    const rng = makeRng("noise");
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = rng() * 256;
      rgba[i + 1] = rng() * 256;
      rgba[i + 2] = rng() * 256;
      rgba[i + 3] = 255;
    }
    const s = settings({ dither: false, background: "black", randomness: 0, stalls: 0 });
    const hist = createHistogram();
    addToHistogram(hist, rgba);
    const palette = buildPalette(hist, { background: [0, 0, 0] });
    const indices = quantizeFrame(rgba, width, height, palette, createMapper(palette), false);
    const result = await encodeLoadingGif({
      width,
      height,
      frames: [indices],
      frameDelaysMs: [],
      palette,
      settings: s,
    });
    const gif = decodeGif(result.bytes);
    expect([...gif.frames.at(-1)!.canvas]).toEqual([...indices]);
  });

  it("honors bottom up and interlaced styles", async () => {
    for (const style of ["bottom", "interlaced"] as const) {
      const s = settings({ style, dither: false, background: "gray" });
      const hist = createHistogram();
      const rgba = gradient(20, 33);
      addToHistogram(hist, rgba);
      const palette = buildPalette(hist, { background: [192, 192, 192] });
      const indices = quantizeFrame(rgba, 20, 33, palette, createMapper(palette), false);
      const result = await encodeLoadingGif({
        width: 20,
        height: 33,
        frames: [indices],
        frameDelaysMs: [],
        palette,
        settings: s,
      });
      const gif = decodeGif(result.bytes);
      expect([...gif.frames.at(-1)!.canvas]).toEqual([...indices]);
    }
  });

  it("plays once when looping is off", async () => {
    const result = await makeLoadingGif(
      { width: 8, height: 8, frames: [gradient(8, 8)] },
      settings({ loop: false }),
    );
    expect(decodeGif(result.bytes).loops).toBe(false);
  });

  it("keeps an animated source playing while it loads, then for the hold time", async () => {
    const width = 16;
    const height = 16;
    const frames = [
      gradient(width, height, 0),
      gradient(width, height, 90),
      gradient(width, height, 180),
    ];
    const s = settings({ dither: false, background: "white", duration: 1, hold: 1, fps: 10 });
    const result = await makeLoadingGif(
      { width, height, frames, frameDelaysMs: [100, 100, 100] },
      s,
    );
    const gif = decodeGif(result.bytes);
    expect(result.totalMs).toBe(2000);
    expect(gif.frames.reduce((sum, f) => sum + f.delayCs, 0)).toBe(200);
    // The picture is complete for the last ten steps and still changing.
    const tail = gif.frames.slice(-3).map((f) => [...f.canvas].join(","));
    expect(new Set(tail).size).toBe(3);
  });

  it("falls back to whole frames when transparency moves", async () => {
    // Frame one is opaque on the left, frame two on the right.
    const width = 4;
    const height = 4;
    const left = new Uint8Array(width * height * 4);
    const right = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      const target = i % width < 2 ? left : right;
      target.set([200, 30, 30, 255], i * 4);
    }
    const s = settings({ background: "transparent", duration: 1, hold: 1, fps: 10, stalls: 0 });
    const result = await makeLoadingGif(
      { width, height, frames: [left, right], frameDelaysMs: [100, 100] },
      s,
    );
    expect(result.fullFrames).toBe(true);
    const gif = decodeGif(result.bytes);
    expect(gif.frames.every((f) => f.disposal === 2 && f.height === height)).toBe(true);
    // The last two frames are the two source frames, with clear halves clear.
    const [a, b] = gif.frames.slice(-2).map((f) => [...f.canvas.subarray(0, 4)]);
    expect(new Set([a!.join(), b!.join()])).toEqual(new Set(["1,1,-1,-1", "-1,-1,1,1"]));
  });

  it("refuses an empty source", async () => {
    await expect(
      makeLoadingGif({ width: 4, height: 4, frames: [] }, settings()),
    ).rejects.toMatchObject({
      code: "no-frames",
    });
  });
});

describe("readSettings", () => {
  it("fills defaults and keeps a given seed", () => {
    const s = readSettings({ seed: "keep" });
    expect(s).toMatchObject({
      style: "top",
      duration: 4,
      randomness: 60,
      stalls: 2,
      stallLength: 0.6,
      hold: 2,
      fps: 12,
      background: "transparent",
      dither: true,
      loop: true,
      seed: "keep",
    });
    expect(readSettings({}).seed).not.toBe("");
  });

  it("rejects unknown styles, backgrounds and out of range numbers", () => {
    expect(() => readSettings({ style: "sideways" })).toThrow(ToolError);
    expect(() => readSettings({ background: "plaid" })).toThrow(ToolError);
    expect(() => readSettings({ duration: 0 })).toThrow(ToolError);
    expect(() => readSettings({ fps: 400 })).toThrow(ToolError);
  });
});

describe("run", () => {
  const payload = JSON.stringify({ width: 12, height: 10, rgbaBase64: toBase64(gradient(12, 10)) });

  it("builds a GIF from a pixel payload", async () => {
    const rows = await run(payload, { seed: "run", duration: 1, hold: 0.5 });
    expect(rows["Output size"]).toBe("12 by 10 pixels");
    expect(rows["Loop length"]).toBe("1.5 s");
    expect(rows.Seed).toBe("run");
    const url = rows["GIF data URL"]!;
    expect(url.startsWith("data:image/gif;base64,R0lGODlh")).toBe(true);
    const bytes = new Uint8Array(Buffer.from(url.split(",")[1]!, "base64"));
    expect(decodeGif(bytes).frames.length).toBe(Number(rows.Frames));
    // Bytes in work the same as text in.
    const again = await run(new TextEncoder().encode(payload), {
      seed: "run",
      duration: 1,
      hold: 0.5,
    });
    expect(again["GIF data URL"]).toBe(url);
  });

  it("points an empty or non pixel input at the panel", async () => {
    await expect(run("")).rejects.toMatchObject({ code: "use-panel" });
    await expect(run("not json")).rejects.toMatchObject({ code: "use-panel" });
    await expect(run("[1,2]")).rejects.toMatchObject({ code: "use-panel" });
    await expect(run('{"width":2,"height":2}')).rejects.toMatchObject({ code: "use-panel" });
    await expect(run('{"width":0,"height":2,"rgbaBase64":"AAAA"}')).rejects.toMatchObject({
      code: "use-panel",
    });
    await expect(run('{"width":1,"height":1,"rgbaBase64":"!!"}')).rejects.toMatchObject({
      code: "use-panel",
    });
  });

  it("rejects a buffer of the wrong length, an oversized one, and bad options", async () => {
    await expect(run('{"width":2,"height":2,"rgbaBase64":"AAAA"}')).rejects.toMatchObject({
      code: "invalid-size",
    });
    await expect(run('{"width":4000,"height":4000,"rgbaBase64":"AAAA"}')).rejects.toMatchObject({
      code: "too-large",
    });
    await expect(run(payload, { stalls: 500 })).rejects.toMatchObject({ code: "invalid-option" });
  });
});
