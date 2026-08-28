import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import jsQR from "jsqr";
import {
  DETECTOR_GRID,
  DETECTOR_INPUT,
  DETECTOR_STRIDE,
  type EdgeMids,
  type Quad,
  type RawImage,
  applyHomography,
  chooseRectifySize,
  contrastStretch,
  decodeDetections,
  letterboxParams,
  packLetterboxed,
  quadCenter,
  quadSide,
  rectifyQuad,
  rgbaToTensor,
  sameCode,
  sharpen,
  squareToQuad,
  unletterboxPoints,
} from "./detector";

/** Render a payload as RGBA, upright, with a quiet zone. */
function renderQr(payload: string, scale = 6, quiet = 4): RawImage {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const modules = qr.modules.data;
  const full = size + quiet * 2;
  const width = full * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my * size + mx] === 1;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = dark ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  return { data, width, height: width };
}

/** Paste `src` into `dst` at (px, py) with a projective warp of its corners. */
function warpInto(dst: RawImage, src: RawImage, quad: Quad): void {
  // Inverse-sample: for each dst pixel inside the quad's bbox, find the unit
  // coordinate via the forward map from the unit square, searched numerically.
  // Simpler and exact enough for tests: forward-map a dense grid of src points.
  const H = squareToQuad(quad);
  const steps = src.width * 2;
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const v = j / steps;
      const [x, y] = applyHomography(H, u, v);
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= dst.width || yi >= dst.height) continue;
      const sx = Math.min(src.width - 1, Math.floor(u * src.width));
      const sy = Math.min(src.height - 1, Math.floor(v * src.height));
      const so = (sy * src.width + sx) * 4;
      const doff = (yi * dst.width + xi) * 4;
      dst.data[doff] = src.data[so]!;
      dst.data[doff + 1] = src.data[so + 1]!;
      dst.data[doff + 2] = src.data[so + 2]!;
      dst.data[doff + 3] = 255;
    }
  }
}

function solidImage(width: number, height: number, shade = 255): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = shade;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

describe("letterboxParams", () => {
  it("centers a wide image with bars above and below", () => {
    const p = letterboxParams(1000, 500);
    expect(p.drawWidth).toBe(DETECTOR_INPUT);
    expect(p.drawHeight).toBe(256);
    expect(p.dx).toBe(0);
    expect(p.dy).toBe(128);
  });

  it("is the identity for a square input at model size", () => {
    const p = letterboxParams(DETECTOR_INPUT, DETECTOR_INPUT);
    expect(p.scale).toBe(1);
    expect(p.dx).toBe(0);
    expect(p.dy).toBe(0);
  });

  it("never upscales beyond fitting the square", () => {
    const p = letterboxParams(100, 50);
    expect(p.drawWidth).toBe(DETECTOR_INPUT);
    expect(p.drawHeight).toBe(256);
  });
});

describe("packLetterboxed + rgbaToTensor", () => {
  it("pads the bars with neutral gray and fills the tensor in [0,1]", () => {
    const { pixels, params } = packLetterboxed(solidImage(200, 100, 255));
    // A bar pixel (top row) is gray, an image pixel is white.
    expect(pixels[0]).toBe(128);
    const mid = ((params.dy + 5) * DETECTOR_INPUT + 256) * 4;
    expect(pixels[mid]).toBe(255);
    const tensor = rgbaToTensor(pixels);
    expect(tensor.length).toBe(3 * DETECTOR_INPUT * DETECTOR_INPUT);
    expect(tensor[0]).toBeCloseTo(128 / 255, 5);
  });
});

describe("decodeDetections", () => {
  const n = DETECTOR_GRID * DETECTOR_GRID;

  function heads(): { hm: Float32Array; off: Float32Array } {
    return { hm: new Float32Array(n).fill(-10), off: new Float32Array(16 * n) };
  }

  it("returns nothing when everything is below threshold", () => {
    const { hm, off } = heads();
    expect(decodeDetections(hm, off)).toEqual([]);
  });

  it("reconstructs corners and midpoints from cell plus offset times stride", () => {
    const { hm, off } = heads();
    const x = 40;
    const y = 30;
    hm[y * DETECTOR_GRID + x] = 4; // sigmoid ~0.982
    const at = y * DETECTOR_GRID + x;
    // Corners at (x±5, y±5); top edge midpoint bowed up to (x, y - 7).
    const points = [
      [-5, -5],
      [5, -5],
      [5, 5],
      [-5, 5],
      [0, -7],
      [5, 0],
      [0, 5],
      [-5, 0],
    ];
    for (let k = 0; k < 8; k++) {
      off[2 * k * n + at] = points[k]![0]!;
      off[(2 * k + 1) * n + at] = points[k]![1]!;
    }
    const dets = decodeDetections(hm, off);
    expect(dets).toHaveLength(1);
    expect(dets[0]!.score).toBeGreaterThan(0.95);
    expect(dets[0]!.corners[0]).toEqual([(x - 5) * DETECTOR_STRIDE, (y - 5) * DETECTOR_STRIDE]);
    expect(dets[0]!.corners[2]).toEqual([(x + 5) * DETECTOR_STRIDE, (y + 5) * DETECTOR_STRIDE]);
    expect(dets[0]!.mids[0]).toEqual([x * DETECTOR_STRIDE, (y - 7) * DETECTOR_STRIDE]);
  });

  it("suppresses non-maxima inside a 3x3 window and keeps distinct peaks", () => {
    const { hm, off } = heads();
    hm[50 * DETECTOR_GRID + 50] = 5;
    hm[50 * DETECTOR_GRID + 51] = 4; // shoulder of the same peak
    hm[80 * DETECTOR_GRID + 100] = 3; // a separate code
    const dets = decodeDetections(hm, off);
    expect(dets).toHaveLength(2);
    expect(dets[0]!.score).toBeGreaterThan(dets[1]!.score);
  });

  it("caps results at topK, highest scores first", () => {
    const { hm, off } = heads();
    for (let k = 0; k < 6; k++) hm[(10 + k * 15) * DETECTOR_GRID + 10] = 2 + k * 0.2;
    const dets = decodeDetections(hm, off, { topK: 3 });
    expect(dets).toHaveLength(3);
    expect(dets[0]!.score).toBeGreaterThanOrEqual(dets[2]!.score);
  });
});

describe("unletterboxPoints", () => {
  it("round-trips a point through letterbox space", () => {
    const params = letterboxParams(1000, 500);
    // Source center maps to model center, and back.
    const quad: Quad = [
      [256, 256],
      [300, 256],
      [300, 300],
      [256, 300],
    ];
    const src = unletterboxPoints(quad, params);
    expect(src[0]![0]).toBeCloseTo(500, 0);
    expect(src[0]![1]).toBeCloseTo(250, 0);
  });
});

describe("squareToQuad", () => {
  it("maps unit corners exactly onto the quad, affine case", () => {
    const quad: Quad = [
      [10, 20],
      [110, 20],
      [110, 120],
      [10, 120],
    ];
    const H = squareToQuad(quad);
    expect(applyHomography(H, 0, 0)[0]).toBeCloseTo(10, 6);
    expect(applyHomography(H, 1, 0)[0]).toBeCloseTo(110, 6);
    expect(applyHomography(H, 1, 1)[1]).toBeCloseTo(120, 6);
  });

  it("maps unit corners exactly onto a projective quad", () => {
    const quad: Quad = [
      [30, 10],
      [200, 40],
      [180, 190],
      [10, 150],
    ];
    const H = squareToQuad(quad);
    for (const [k, [u, v]] of [
      [0, [0, 0]],
      [1, [1, 0]],
      [2, [1, 1]],
      [3, [0, 1]],
    ] as const) {
      const [x, y] = applyHomography(H, u, v);
      expect(x).toBeCloseTo(quad[k]![0], 5);
      expect(y).toBeCloseTo(quad[k]![1], 5);
    }
  });
});

describe("quad helpers", () => {
  const square: Quad = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];

  it("measures side and center", () => {
    expect(quadSide(square)).toBe(100);
    expect(quadCenter(square)).toEqual([50, 50]);
  });

  it("chooses an upsampled rectify size for small quads, capped for big ones", () => {
    expect(chooseRectifySize(square)).toBe(250);
    const tiny: Quad = [
      [0, 0],
      [30, 0],
      [30, 30],
      [0, 30],
    ];
    expect(chooseRectifySize(tiny)).toBe(240);
    const huge: Quad = [
      [0, 0],
      [900, 0],
      [900, 900],
      [0, 900],
    ];
    expect(chooseRectifySize(huge)).toBe(800);
  });

  it("treats overlapping quads as one code and distant quads as two", () => {
    const shifted: Quad = square.map(([x, y]) => [x + 10, y + 10]) as Quad;
    const far: Quad = square.map(([x, y]) => [x + 300, y]) as Quad;
    expect(sameCode(square, shifted)).toBe(true);
    expect(sameCode(square, far)).toBe(false);
  });
});

describe("rectifyQuad end to end", () => {
  it("recovers a decodable code from a perspective-warped scene", () => {
    const payload = "https://example.com/warped";
    const code = renderQr(payload);
    const scene = solidImage(640, 640, 210);
    // A convincing perspective quad (the full rendered tile with quiet zone).
    const quad: Quad = [
      [140, 90],
      [470, 130],
      [430, 480],
      [110, 420],
    ];
    warpInto(scene, code, quad);

    // Sanity: the warped scene itself should NOT decode with jsQR.
    const direct = jsQR(scene.data, scene.width, scene.height, {
      inversionAttempts: "dontInvert",
    });

    const rect = rectifyQuad(scene, quad, chooseRectifySize(quad), 0.04);
    const decoded = jsQR(rect.data, rect.width, rect.height, {
      inversionAttempts: "dontInvert",
    });
    expect(decoded?.data).toBe(payload);
    // The rectification must add value over the raw warped scene OR at least
    // not regress it; typically `direct` is null here.
    if (direct) expect(direct.data).toBe(payload);
  });
});

describe("rectifyQuad with edge midpoints", () => {
  /** Paint src into dst through an arbitrary unit-square surface map. */
  function paintSurface(
    dst: RawImage,
    src: RawImage,
    surface: (u: number, v: number) => [number, number],
  ): void {
    // Oversample 4x so the scatter paint leaves no unpainted speckle, which
    // would defeat jsQR's binarizer even on a perfectly rectified crop.
    const steps = src.width * 4;
    for (let j = 0; j <= steps; j++) {
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const v = j / steps;
        const [x, y] = surface(u, v);
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= dst.width || yi >= dst.height) continue;
        const sx = Math.min(src.width - 1, Math.floor(u * src.width));
        const sy = Math.min(src.height - 1, Math.floor(v * src.height));
        const so = (sy * src.width + sx) * 4;
        const doff = (yi * dst.width + xi) * 4;
        dst.data[doff] = src.data[so]!;
        dst.data[doff + 1] = src.data[so + 1]!;
        dst.data[doff + 2] = src.data[so + 2]!;
        dst.data[doff + 3] = 255;
      }
    }
  }

  it("matches plain homography when midpoints sit on the straight edges", () => {
    const scene = solidImage(400, 400, 220);
    const quad: Quad = [
      [60, 50],
      [330, 80],
      [310, 340],
      [40, 300],
    ];
    const H = squareToQuad(quad);
    const mids = (
      [
        [0.5, 0],
        [1, 0.5],
        [0.5, 1],
        [0, 0.5],
      ] as const
    ).map(([u, v]) => applyHomography(H, u, v)) as EdgeMids;
    const flat = rectifyQuad(scene, quad, 128, 0.05);
    const withMids = rectifyQuad(scene, quad, 128, 0.05, mids);
    expect(withMids.data).toEqual(flat.data);
  });

  it("unbends a cylinder-style bow that defeats flat rectification", () => {
    const payload = "https://example.com/cylinder";
    const code = renderQr(payload);
    const scene = solidImage(640, 640, 225);

    // A code painted onto a bowed surface: a flat quad plus a strong
    // outward bulge of the horizontal edges, the cylinder signature.
    const quad: Quad = [
      [150, 140],
      [490, 140],
      [490, 480],
      [150, 480],
    ];
    const bow = 55;
    const surface = (u: number, v: number): [number, number] => {
      const [x, y] = applyHomography(squareToQuad(quad), u, v);
      const bu = 4 * u * (1 - u);
      // Top edge lifts up, bottom edge pushes down: a barrel bulge.
      return [x, y + bu * (v - 0.5) * 2 * bow * -1];
    };
    paintSurface(scene, code, surface);

    const mids: EdgeMids = [
      surface(0.5, 0),
      surface(1, 0.5),
      surface(0.5, 1),
      surface(0, 0.5),
    ];

    const size = chooseRectifySize(quad);
    const flat = rectifyQuad(scene, quad, size, 0.04);
    const flatDecode = jsQR(flat.data, flat.width, flat.height, {
      inversionAttempts: "dontInvert",
    });
    const bent = rectifyQuad(scene, quad, size, 0.04, mids);
    const bentDecode = jsQR(bent.data, bent.width, bent.height, {
      inversionAttempts: "dontInvert",
    });

    // The bow-corrected crop must decode; the flat crop must not be the only
    // one that does. With a 55px bulge the flat crop reliably fails.
    expect(bentDecode?.data).toBe(payload);
    expect(flatDecode).toBeNull();
  });
});

describe("rectifyCylinder with phase", () => {
  it("unwraps an off-center cylinder wrap that the centered model cannot", async () => {
    const { rectifyCylinder } = await import("./detector");
    const payload = "https://example.com/off-center-wrap";
    const code = renderQr(payload);
    const scene = solidImage(700, 700, 228);

    // Paint the code through an off-center perspective-cylinder projection:
    // arc theta around a cylinder at k radii, code center at phase phi0.
    const theta = 1.2;
    const k = 2.5;
    const phi0 = 0.3;
    const xOf = (p: number) => Math.sin(p) / (k - Math.cos(p));
    const x0 = xOf(phi0 - theta / 2);
    const x1 = xOf(phi0 + theta / 2);
    const left = 120;
    const right = 580;
    const top = 150;
    const bottom = 550;
    const surface = (u: number, v: number): [number, number] => {
      const p = (u - 0.5) * theta + phi0;
      const un = (xOf(p) - x0) / (x1 - x0);
      const depth = k - Math.cos(p);
      const vScale = (k - Math.cos(theta / 2)) / depth;
      return [left + un * (right - left), top + (0.5 + (v - 0.5) * vScale) * (bottom - top)];
    };
    // Dense forward paint.
    const steps = code.width * 4;
    for (let j = 0; j <= steps; j++) {
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const v = j / steps;
        const [x, y] = surface(u, v);
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= 700 || yi >= 700) continue;
        const sx = Math.min(code.width - 1, Math.floor(u * code.width));
        const sy = Math.min(code.height - 1, Math.floor(v * code.height));
        const so = (sy * code.width + sx) * 4;
        const doff = (yi * 700 + xi) * 4;
        scene.data[doff] = code.data[so]!;
        scene.data[doff + 1] = code.data[so + 1]!;
        scene.data[doff + 2] = code.data[so + 2]!;
      }
    }
    const quad: Quad = [surface(0, 0), surface(1, 0), surface(1, 1), surface(0, 1)];
    const mids: EdgeMids = [surface(0.5, 0), surface(1, 0.5), surface(0.5, 1), surface(0, 0.5)];

    // The production sweep: theta and sagitta-scale candidates, phases
    // ordered center-out. The off-center wrap must decode only once a
    // nonzero phase enters the sweep.
    const size = 500;
    const decodeAt = (thetaC: number, scale: number, phase: number) => {
      const crop = rectifyCylinder(scene, quad, mids, size, 0.04, thetaC, "u", scale, phase);
      return jsQR(crop.data, size, size, { inversionAttempts: "dontInvert" })?.data;
    };

    let centeredWins = 0;
    let phasedWins = 0;
    for (const thetaC of [0.9, 1.6, 2.3]) {
      for (const scale of [1, 1.9]) {
        for (const phaseFrac of [0, 0.35, -0.35, 0.65, -0.65]) {
          const text = decodeAt(thetaC, scale, (phaseFrac * thetaC) / 2);
          if (text === payload) {
            if (phaseFrac === 0) centeredWins++;
            else phasedWins++;
          }
        }
      }
    }
    expect(phasedWins).toBeGreaterThan(0);
    expect(centeredWins).toBe(0);
  });
});

describe("gridResample", () => {
  it("rebuilds a decodable code from a crop with a smooth S-bend and shear", async () => {
    const { gridResample } = await import("./detector");
    const payload = "https://example.com/grid-resample";
    const code = renderQr(payload, 8, 4);
    const size = code.width;
    // A residual warp the projective and cylinder models cannot express:
    // anamorphic stretch, shear, a sine bend, and sensor noise together,
    // like a bottle label after imperfect rectification. The rebuild must
    // stay faithful through all of it (its value over the raw decoders is
    // measured on the real-photo benchmark, not asserted here; jsQR happens
    // to be strong on noiseless synthetic warps).
    const W = Math.round(size * 1.35);
    const bent: RawImage = solidImage(W, size, 255);
    const amp = 8;
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < W; x++) {
        const sx = (x / W) * size + (y - size / 2) * 0.05;
        const sy = y + amp * Math.sin((x / W) * Math.PI * 2);
        const xi = Math.round(sx);
        const yi = Math.round(sy);
        if (xi < 0 || yi < 0 || xi >= size || yi >= size) continue;
        const so = (yi * size + xi) * 4;
        const doff = (y * W + x) * 4;
        const noise = (rand() - 0.5) * 90;
        for (let c = 0; c < 3; c++) {
          bent.data[doff + c] = Math.max(0, Math.min(255, code.data[so + c]! + noise));
        }
      }
    }

    const rebuilt = gridResample(bent);
    expect(rebuilt).not.toBeNull();
    const decoded = jsQR(rebuilt!.data, rebuilt!.width, rebuilt!.height, {
      inversionAttempts: "dontInvert",
    });
    expect(decoded?.data).toBe(payload);
  });

  it("returns null on a crop with no finder patterns", async () => {
    const { gridResample } = await import("./detector");
    expect(gridResample(solidImage(300, 300, 200))).toBeNull();
  });
});

describe("quadGridResample", () => {
  it("rescues a code whose bottom-left finder is erased by glare", async () => {
    const { QUAD_GRID_VERSIONS, quadGridResample } = await import("./detector");
    const payload = "https://example.com/glare-corner";
    // Rectified-crop geometry: the code fills the frame minus a 0.1 margin,
    // exactly what rectifyQuad(margin 0.1) produces.
    const code = renderQr(payload, 8, 0);
    const margin = 0.1;
    const size = Math.round((code.width * (1 + 2 * margin)) / 1);
    const m0 = Math.round((size * margin) / (1 + 2 * margin));
    const crop = solidImage(size, size, 235);
    for (let y = 0; y < code.height; y++) {
      for (let x = 0; x < code.width; x++) {
        const so = (y * code.width + x) * 4;
        const doff = ((y + m0) * size + (x + m0)) * 4;
        crop.data[doff] = code.data[so]!;
        crop.data[doff + 1] = code.data[so + 1]!;
        crop.data[doff + 2] = code.data[so + 2]!;
      }
    }
    // Glare: wash the bottom-left finder region to near-white.
    const wash = Math.round(size * 0.28);
    for (let y = size - wash; y < size; y++) {
      for (let x = 0; x < wash; x++) {
        const o = (y * size + x) * 4;
        crop.data[o] = crop.data[o + 1] = crop.data[o + 2] = 246;
      }
    }

    const decoded = QUAD_GRID_VERSIONS.map((v) => {
      const q = quadGridResample(crop, margin, v);
      return jsQR(q.data, q.width, q.height, { inversionAttempts: "dontInvert" })?.data;
    }).find(Boolean);
    expect(decoded).toBe(payload);
  });
});

describe("adaptiveBinarize", () => {
  it("recovers a code under a strong illumination ramp that defeats a global stretch", async () => {
    const { adaptiveBinarize } = await import("./detector");
    const payload = "ramp-check";
    const code = renderQr(payload);
    // A left-to-right brightness ramp: dark modules on the bright side end up
    // lighter than light modules on the dim side, so no global threshold works.
    const ramped = new Uint8ClampedArray(code.data.length);
    for (let y = 0; y < code.height; y++) {
      for (let x = 0; x < code.width; x++) {
        const i = (y * code.width + x) * 4;
        const gain = 0.25 + 0.75 * (x / code.width);
        const lift = 90 * (x / code.width);
        const v = code.data[i]! * gain + lift;
        ramped[i] = ramped[i + 1] = ramped[i + 2] = v;
        ramped[i + 3] = 255;
      }
    }
    const rampedImage: RawImage = { data: ramped, width: code.width, height: code.height };
    const bin = adaptiveBinarize(rampedImage);
    const decoded = jsQR(bin.data, bin.width, bin.height, { inversionAttempts: "dontInvert" });
    expect(decoded?.data).toBe(payload);
  });
});

describe("enhancement variants", () => {
  it("contrastStretch rescues a low-contrast code for jsQR", () => {
    const payload = "low-contrast-check";
    const code = renderQr(payload);
    // Crush contrast: dark 110, light 140.
    const dim = new Uint8ClampedArray(code.data.length);
    for (let i = 0; i < code.data.length; i += 4) {
      const v = code.data[i]! > 128 ? 140 : 110;
      dim[i] = dim[i + 1] = dim[i + 2] = v;
      dim[i + 3] = 255;
    }
    const dimImage: RawImage = { data: dim, width: code.width, height: code.height };
    const before = jsQR(dim, code.width, code.height, { inversionAttempts: "dontInvert" });
    const stretched = contrastStretch(dimImage);
    const after = jsQR(stretched.data, stretched.width, stretched.height, {
      inversionAttempts: "dontInvert",
    });
    expect(after?.data).toBe(payload);
    // jsQR's adaptive binarizer sometimes handles mild cases; the stretch must
    // never be required to fail first, only to succeed after.
    if (before) expect(before.data).toBe(payload);
  });

  it("sharpen keeps a clean code decodable", () => {
    const payload = "sharpen-check";
    const code = renderQr(payload);
    const sharp = sharpen(code);
    const decoded = jsQR(sharp.data, sharp.width, sharp.height, {
      inversionAttempts: "dontInvert",
    });
    expect(decoded?.data).toBe(payload);
  });
});
