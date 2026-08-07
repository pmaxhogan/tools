import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import {
  applyMatte,
  boxBlurAlpha,
  compositeOnColor,
  normalizeMatte,
  parseHexColor,
  resizeMatteNearest,
  run,
  type BackgroundRemoverOpts,
} from './index';

/** Builds a w by h RGBA buffer where every pixel is the same color. */
function solid(w: number, h: number, r: number, g: number, b: number, a: number) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

/** Reads just the alpha channel out of an RGBA buffer. */
function alphaOf(rgba: Uint8ClampedArray): number[] {
  const out: number[] = [];
  for (let i = 3; i < rgba.length; i += 4) out.push(rgba[i]!);
  return out;
}

const defaults: BackgroundRemoverOpts = {
  output: 'transparent',
  bgColor: '#ffffff',
  featherEdges: true,
};

describe('parseHexColor', () => {
  it('reads the long form with and without the hash', () => {
    expect(parseHexColor('#3366ff')).toEqual({ r: 0x33, g: 0x66, b: 0xff });
    expect(parseHexColor('3366ff')).toEqual({ r: 0x33, g: 0x66, b: 0xff });
  });

  it('expands the short form and ignores case', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor('#AbC')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it('rejects anything that is not a 3 or 6 digit hex color', () => {
    for (const bad of ['red', '#12345', '#gggggg', '', 'rgb(0,0,0)']) {
      expect(() => parseHexColor(bad)).toThrowError(ToolError);
    }
    try {
      parseHexColor('red');
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-color');
    }
  });
});

describe('normalizeMatte', () => {
  it('treats a float matte that stays within 1 as a 0 to 1 matte', () => {
    expect(Array.from(normalizeMatte(new Float32Array([0, 0.25, 1])))).toEqual([0, 0.25, 1]);
  });

  it('divides a byte matte by 255', () => {
    const out = normalizeMatte(new Uint8ClampedArray([0, 255]));
    expect(Array.from(out)).toEqual([0, 1]);
  });

  it('treats a float matte that exceeds 1 as byte scaled', () => {
    const out = normalizeMatte(new Float32Array([0, 255]));
    expect(Array.from(out)).toEqual([0, 1]);
  });

  it('clamps values outside the range', () => {
    const out = normalizeMatte(new Float32Array([-0.5, 0.5]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0.5);
  });
});

describe('applyMatte', () => {
  it('writes a 0 to 1 float matte into the alpha channel', () => {
    const rgba = solid(2, 2, 10, 20, 30, 255);
    applyMatte(rgba, new Float32Array([0, 0.5, 1, 1]), 2, 2);
    expect(alphaOf(rgba)).toEqual([0, 128, 255, 255]);
  });

  it('writes a 0 to 255 byte matte into the alpha channel', () => {
    const rgba = solid(2, 2, 10, 20, 30, 255);
    applyMatte(rgba, new Uint8ClampedArray([0, 128, 255, 255]), 2, 2);
    expect(alphaOf(rgba)).toEqual([0, 128, 255, 255]);
  });

  it('leaves the color channels alone', () => {
    const rgba = solid(2, 1, 10, 20, 30, 255);
    applyMatte(rgba, new Float32Array([0, 0]), 2, 1);
    expect(Array.from(rgba)).toEqual([10, 20, 30, 0, 10, 20, 30, 0]);
  });

  it('rejects a matte that does not match the image size', () => {
    const rgba = solid(2, 2, 0, 0, 0, 255);
    expect(() => applyMatte(rgba, new Float32Array([1, 1]), 2, 2)).toThrowError(ToolError);
  });

  it('rejects a pixel buffer that does not match the image size', () => {
    const rgba = solid(2, 1, 0, 0, 0, 255);
    expect(() => applyMatte(rgba, new Float32Array([1, 1, 1, 1]), 2, 2)).toThrowError(ToolError);
  });

  it('rejects a nonsensical image size', () => {
    const rgba = solid(1, 1, 0, 0, 0, 255);
    try {
      applyMatte(rgba, new Float32Array([1]), 0, 1);
      throw new Error('expected a ToolError');
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-size');
    }
  });
});

describe('resizeMatteNearest', () => {
  it('leaves a matte alone when the size does not change', () => {
    const matte = new Float32Array([1, 2, 3, 4]);
    expect(Array.from(resizeMatteNearest(matte, 2, 2, 2, 2))).toEqual([1, 2, 3, 4]);
  });

  it('doubles every pixel when upscaling by two', () => {
    const matte = new Float32Array([1, 2, 3, 4]);
    expect(Array.from(resizeMatteNearest(matte, 2, 2, 4, 4))).toEqual([
      1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4,
    ]);
  });

  it('samples pixel centres when downscaling', () => {
    // 4 by 4 counting up from 0. Centre sampling picks columns and rows 1 and 3.
    const matte = new Float32Array(16);
    for (let i = 0; i < 16; i += 1) matte[i] = i;
    expect(Array.from(resizeMatteNearest(matte, 4, 4, 2, 2))).toEqual([5, 7, 13, 15]);
  });

  it('accepts a byte matte and keeps its scale', () => {
    const matte = new Uint8ClampedArray([0, 255, 255, 0]);
    expect(Array.from(resizeMatteNearest(matte, 2, 2, 2, 2))).toEqual([0, 255, 255, 0]);
  });

  it('rejects a matte whose length does not match the source size', () => {
    expect(() => resizeMatteNearest(new Float32Array([1, 2]), 2, 2, 4, 4)).toThrowError(ToolError);
  });

  it('rejects a target size of zero', () => {
    expect(() => resizeMatteNearest(new Float32Array([1]), 1, 1, 0, 4)).toThrowError(ToolError);
  });
});

describe('boxBlurAlpha', () => {
  it('is a no-op at radius zero', () => {
    const rgba = solid(3, 1, 0, 0, 0, 200);
    const before = Array.from(rgba);
    boxBlurAlpha(rgba, 3, 1, 0);
    expect(Array.from(rgba)).toEqual(before);
  });

  it('leaves a uniform alpha untouched', () => {
    const rgba = solid(5, 5, 1, 2, 3, 128);
    boxBlurAlpha(rgba, 5, 5, 2);
    expect(alphaOf(rgba).every((a) => a === 128)).toBe(true);
  });

  it('softens a hard edge symmetrically', () => {
    const rgba = solid(6, 1, 0, 0, 0, 0);
    for (let i = 0; i < 3; i += 1) rgba[i * 4 + 3] = 255;
    boxBlurAlpha(rgba, 6, 1, 1);
    // Clamped sampling keeps the flat ends at their original value, and the
    // two pixels straddling the edge land on 2/3 and 1/3 of full opacity.
    expect(alphaOf(rgba)).toEqual([255, 255, 170, 85, 0, 0]);
  });

  it('leaves the color channels alone', () => {
    const rgba = solid(4, 1, 9, 8, 7, 0);
    rgba[3] = 255;
    boxBlurAlpha(rgba, 4, 1, 1);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([9, 8, 7]);
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([9, 8, 7]);
  });

  it('handles a radius wider than the image', () => {
    const rgba = solid(3, 1, 0, 0, 0, 0);
    rgba[3] = 255;
    boxBlurAlpha(rgba, 3, 1, 10);
    // Clamped sampling keeps the window in bounds, so the single opaque pixel
    // spreads across the row and alpha falls off away from it.
    const alpha = alphaOf(rgba);
    expect(alpha[0]!).toBeGreaterThan(alpha[1]!);
    expect(alpha[1]!).toBeGreaterThan(alpha[2]!);
    expect(alpha.every((a) => a > 0 && a < 255)).toBe(true);
  });

  it('rejects a negative radius', () => {
    const rgba = solid(2, 1, 0, 0, 0, 255);
    try {
      boxBlurAlpha(rgba, 2, 1, -1);
      throw new Error('expected a ToolError');
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-radius');
    }
  });

  it('rejects a pixel buffer that does not match the image size', () => {
    expect(() => boxBlurAlpha(solid(2, 1, 0, 0, 0, 255), 4, 1, 1)).toThrowError(ToolError);
  });
});

describe('compositeOnColor', () => {
  it('returns the background where alpha is zero', () => {
    const out = compositeOnColor(solid(1, 1, 200, 100, 50, 0), 1, 1, '#3366ff');
    expect(Array.from(out)).toEqual([0x33, 0x66, 0xff, 255]);
  });

  it('returns the source where alpha is full', () => {
    const out = compositeOnColor(solid(1, 1, 200, 100, 50, 255), 1, 1, '#3366ff');
    expect(Array.from(out)).toEqual([200, 100, 50, 255]);
  });

  it('blends a partly transparent pixel over black', () => {
    // alpha 128/255 = 0.501960..., so each channel keeps just over half itself.
    const out = compositeOnColor(solid(1, 1, 200, 100, 50, 128), 1, 1, '#000000');
    expect(Array.from(out)).toEqual([100, 50, 25, 255]);
  });

  it('blends a 20 percent pixel over white', () => {
    // alpha 51/255 = 0.2 exactly: 200 * 0.2 + 255 * 0.8 = 244.
    const out = compositeOnColor(solid(1, 1, 200, 0, 0, 51), 1, 1, '#fff');
    expect(Array.from(out)).toEqual([244, 204, 204, 255]);
  });

  it('never leaves a transparent pixel behind', () => {
    const rgba = solid(2, 2, 10, 20, 30, 0);
    rgba[3] = 128;
    const out = compositeOnColor(rgba, 2, 2, '#ffffff');
    expect(alphaOf(out).every((a) => a === 255)).toBe(true);
  });

  it('does not modify the buffer it was given', () => {
    const rgba = solid(1, 1, 200, 100, 50, 0);
    compositeOnColor(rgba, 1, 1, '#ffffff');
    expect(Array.from(rgba)).toEqual([200, 100, 50, 0]);
  });

  it('rejects an unusable color', () => {
    expect(() => compositeOnColor(solid(1, 1, 0, 0, 0, 255), 1, 1, 'chartreuse')).toThrowError(
      ToolError,
    );
  });

  it('rejects a pixel buffer that does not match the image size', () => {
    expect(() => compositeOnColor(solid(1, 1, 0, 0, 0, 255), 2, 2, '#ffffff')).toThrowError(
      ToolError,
    );
  });
});

describe('run', () => {
  it('describes a transparent cutout by default', () => {
    const rows = run('', defaults);
    expect(rows.Background).toContain('transparent');
    expect(rows['Feather edges']).toContain('On.');
    expect(rows['Where it runs']).toContain('your files and inputs never leave your device');
    expect(rows.Note).toBeUndefined();
  });

  it('is honest about what the model is good at', () => {
    const rows = run('', defaults);
    expect(rows['Best on']).toContain('people');
    expect(rows.Model).toContain('MODNet');
  });

  it('normalizes a short hex background color', () => {
    const rows = run('', { ...defaults, output: 'color', bgColor: '#abc' });
    expect(rows.Background).toContain('#aabbcc');
  });

  it('reports a white background as a JPEG', () => {
    const rows = run('', { ...defaults, output: 'white' });
    expect(rows.Background).toContain('white');
    expect(rows.Background).toContain('JPEG');
  });

  it('reports feathering when it is turned off', () => {
    const rows = run('', { ...defaults, featherEdges: false });
    expect(rows['Feather edges']).toContain('Off.');
  });

  it('reports the size of dropped image bytes', () => {
    const rows = run(new Uint8Array(2048), defaults);
    expect(rows.Image).toBe('2.0 KB of image data ready for the panel.');
  });

  it('points text input back at the panel', () => {
    const rows = run('hello', defaults);
    expect(rows.Note).toContain('image files');
  });

  it('falls back to a white color when the field is left empty', () => {
    const rows = run('', { ...defaults, output: 'color', bgColor: '' });
    expect(rows.Background).toContain('#ffffff');
  });

  it('rejects an unusable background color', () => {
    try {
      run('', { ...defaults, output: 'color', bgColor: 'periwinkle' });
      throw new Error('expected a ToolError');
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-color');
    }
  });

  it('rejects an unknown background option', () => {
    try {
      run('', { ...defaults, output: 'rainbow' as never });
      throw new Error('expected a ToolError');
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-output');
    }
  });
});
