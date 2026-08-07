import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import {
  applyPixelateRect,
  applySolidRect,
  clampRect,
  normalizeRect,
  run,
  sniffImageFormat,
  suggestExportName,
  type Rect,
} from './index';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Checkerboard of opaque red and opaque blue, one pixel per square, plus a
 * per pixel alpha ramp so alpha changes are visible in the assertions too.
 */
function checkerboard(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dark = (x + y) % 2 === 0;
      data[i] = dark ? 255 : 0;
      data[i + 1] = 0;
      data[i + 2] = dark ? 0 : 255;
      data[i + 3] = 200 + ((x + y) % 4);
    }
  }
  return data;
}

function pixelAt(data: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

function inRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** Every pixel outside `rect` must be byte identical to the untouched source. */
function expectOutsideUntouched(
  data: Uint8ClampedArray,
  pristine: Uint8ClampedArray,
  width: number,
  height: number,
  rect: Rect,
) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inRect(rect, x, y)) continue;
      expect(pixelAt(data, width, x, y)).toEqual(pixelAt(pristine, width, x, y));
    }
  }
}

const W = 8;
const H = 8;

/* ------------------------------------------------------------------ */
/* normalizeRect                                                       */
/* ------------------------------------------------------------------ */

describe('normalizeRect', () => {
  it('sorts a top left to bottom right drag unchanged', () => {
    expect(normalizeRect({ x1: 2, y1: 3, x2: 6, y2: 9 })).toEqual({ x: 2, y: 3, w: 4, h: 6 });
  });

  it('sorts a drag made upward and to the left', () => {
    expect(normalizeRect({ x1: 6, y1: 9, x2: 2, y2: 3 })).toEqual({ x: 2, y: 3, w: 4, h: 6 });
  });

  it('sorts a drag that is negative on one axis only', () => {
    expect(normalizeRect({ x1: 6, y1: 3, x2: 2, y2: 9 })).toEqual({ x: 2, y: 3, w: 4, h: 6 });
  });

  it('clamps a drag that starts outside the image to the image bounds', () => {
    expect(normalizeRect({ x1: -20, y1: -5, x2: 40, y2: 40 }, 16, 10)).toEqual({
      x: 0,
      y: 0,
      w: 16,
      h: 10,
    });
  });

  it('rounds fractional pointer coordinates to whole pixels', () => {
    expect(normalizeRect({ x1: 1.4, y1: 2.6, x2: 5.5, y2: 8.2 })).toEqual({
      x: 1,
      y: 3,
      w: 5,
      h: 5,
    });
  });

  it('returns a zero size rectangle for a click without a drag', () => {
    expect(normalizeRect({ x1: 4, y1: 4, x2: 4, y2: 4 })).toEqual({ x: 4, y: 4, w: 0, h: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* clampRect                                                           */
/* ------------------------------------------------------------------ */

describe('clampRect', () => {
  it('trims a rectangle that hangs off the right and bottom edges', () => {
    expect(clampRect({ x: 6, y: 6, w: 10, h: 10 }, W, H)).toEqual({ x: 6, y: 6, w: 2, h: 2 });
  });

  it('returns null when the rectangle misses the image entirely', () => {
    expect(clampRect({ x: 20, y: 20, w: 4, h: 4 }, W, H)).toBeNull();
  });

  it('returns null for a zero size rectangle', () => {
    expect(clampRect({ x: 2, y: 2, w: 0, h: 5 }, W, H)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* applySolidRect                                                      */
/* ------------------------------------------------------------------ */

describe('applySolidRect', () => {
  it('replaces every pixel in the rectangle with the color and leaves the rest alone', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const rect = { x: 2, y: 1, w: 3, h: 4 };

    const written = applySolidRect(data, W, H, rect, [0, 0, 0]);

    expect(written).toEqual(rect);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        expect(pixelAt(data, W, x, y)).toEqual([0, 0, 0, 255]);
      }
    }
    expectOutsideUntouched(data, pristine, W, H, rect);
  });

  it('destroys the original values rather than covering them', () => {
    const data = checkerboard(W, H);
    applySolidRect(data, W, H, { x: 0, y: 0, w: W, h: H }, [0, 0, 0]);
    // Not one red or blue sample survives anywhere in the buffer.
    expect(Array.from(data).some((v, i) => i % 4 !== 3 && v !== 0)).toBe(false);
  });

  it('writes white when white is chosen and forces alpha opaque', () => {
    const data = checkerboard(W, H);
    // Make the target region fully transparent first.
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) data[(y * W + x) * 4 + 3] = 0;
    }
    applySolidRect(data, W, H, { x: 0, y: 0, w: 2, h: 2 }, [255, 255, 255]);
    expect(pixelAt(data, W, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(data, W, 1, 1)).toEqual([255, 255, 255, 255]);
  });

  it('clamps a rectangle that runs past the edge instead of writing out of bounds', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    applySolidRect(data, W, H, { x: 6, y: 6, w: 100, h: 100 }, [0, 0, 0]);

    expect(pixelAt(data, W, 7, 7)).toEqual([0, 0, 0, 255]);
    expectOutsideUntouched(data, pristine, W, H, { x: 6, y: 6, w: 2, h: 2 });
    expect(data.length).toBe(W * H * 4);
  });

  it('is a no-op for a rectangle entirely outside the image', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    expect(applySolidRect(data, W, H, { x: -50, y: -50, w: 10, h: 10 }, [0, 0, 0])).toBeNull();
    expect(Array.from(data)).toEqual(Array.from(pristine));
  });

  it('defaults to black when no color is passed', () => {
    const data = checkerboard(W, H);
    applySolidRect(data, W, H, { x: 1, y: 1, w: 2, h: 2 });
    expect(pixelAt(data, W, 1, 1)).toEqual([0, 0, 0, 255]);
  });
});

/* ------------------------------------------------------------------ */
/* applyPixelateRect                                                   */
/* ------------------------------------------------------------------ */

describe('applyPixelateRect', () => {
  it('makes each block uniform and leaves the rest of the image alone', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const rect = { x: 0, y: 0, w: 4, h: 4 };

    applyPixelateRect(data, W, H, rect, 2);

    // Each 2x2 block holds one color.
    for (let by = 0; by < 4; by += 2) {
      for (let bx = 0; bx < 4; bx += 2) {
        const first = pixelAt(data, W, bx, by);
        expect(pixelAt(data, W, bx + 1, by)).toEqual(first);
        expect(pixelAt(data, W, bx, by + 1)).toEqual(first);
        expect(pixelAt(data, W, bx + 1, by + 1)).toEqual(first);
      }
    }
    expectOutsideUntouched(data, pristine, W, H, rect);
  });

  it('averages the four channels of a block', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 2, h: 2 }, 2);

    // Source 2x2: two red (255,0,0) and two blue (0,0,255); alphas 200,201,201,202.
    expect(pixelAt(data, W, 0, 0)).toEqual([128, 0, 128, 201]);
  });

  it('clips an edge block to the rectangle instead of sampling past it', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const rect = { x: 0, y: 0, w: 3, h: 3 };

    applyPixelateRect(data, W, H, rect, 2);

    // The trailing column is a 1x2 block, so it keeps its own two pixels averaged.
    const top = pixelAt(pristine, W, 2, 0);
    const bottom = pixelAt(pristine, W, 2, 1);
    const expected = top.map((v, i) => Math.round((v + bottom[i]!) / 2));
    expect(pixelAt(data, W, 2, 0)).toEqual(expected);
    expect(pixelAt(data, W, 2, 1)).toEqual(expected);
    expectOutsideUntouched(data, pristine, W, H, rect);
  });

  it('collapses the whole rectangle to one color when the block is bigger than the rect', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);
    const rect = { x: 1, y: 1, w: 3, h: 3 };

    applyPixelateRect(data, W, H, rect, 64);

    const first = pixelAt(data, W, 1, 1);
    for (let y = 1; y < 4; y++) {
      for (let x = 1; x < 4; x++) expect(pixelAt(data, W, x, y)).toEqual(first);
    }
    expectOutsideUntouched(data, pristine, W, H, rect);
  });

  it('treats a block size below one as a single pixel block, leaving pixels unchanged', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 4, h: 4 }, 0);

    expect(Array.from(data)).toEqual(Array.from(pristine));
  });

  it('clamps a rectangle that runs past the edge', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    const written = applyPixelateRect(data, W, H, { x: 5, y: 5, w: 50, h: 50 }, 4);

    expect(written).toEqual({ x: 5, y: 5, w: 3, h: 3 });
    expectOutsideUntouched(data, pristine, W, H, { x: 5, y: 5, w: 3, h: 3 });
  });

  it('is a no-op for a rectangle entirely outside the image', () => {
    const pristine = checkerboard(W, H);
    const data = new Uint8ClampedArray(pristine);

    expect(applyPixelateRect(data, W, H, { x: 100, y: 0, w: 4, h: 4 }, 4)).toBeNull();
    expect(Array.from(data)).toEqual(Array.from(pristine));
  });
});

/* ------------------------------------------------------------------ */
/* ordering                                                            */
/* ------------------------------------------------------------------ */

describe('overlapping regions', () => {
  it('applies regions in list order, so a later solid wins over an earlier pixelate', () => {
    const data = checkerboard(W, H);
    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 4, h: 4 }, 2);
    applySolidRect(data, W, H, { x: 2, y: 2, w: 4, h: 4 }, [0, 0, 0]);
    expect(pixelAt(data, W, 3, 3)).toEqual([0, 0, 0, 255]);
  });

  it('applies regions in list order, so a later pixelate averages the earlier solid', () => {
    const data = checkerboard(W, H);
    applySolidRect(data, W, H, { x: 0, y: 0, w: 4, h: 4 }, [255, 255, 255]);
    applyPixelateRect(data, W, H, { x: 0, y: 0, w: 4, h: 4 }, 4);
    expect(pixelAt(data, W, 1, 1)).toEqual([255, 255, 255, 255]);
  });
});

/* ------------------------------------------------------------------ */
/* suggestExportName                                                   */
/* ------------------------------------------------------------------ */

describe('suggestExportName', () => {
  it('adds the redacted suffix and keeps the png extension', () => {
    expect(suggestExportName('shot.png')).toBe('shot-redacted.png');
  });

  it('uses a jpg extension when exporting as JPEG', () => {
    expect(suggestExportName('shot.png', 'jpeg')).toBe('shot-redacted.jpg');
  });

  it('falls back to a generic stem when there is no filename', () => {
    expect(suggestExportName('')).toBe('image-redacted.png');
    expect(suggestExportName('   ')).toBe('image-redacted.png');
  });

  it('does not stack the suffix when re-redacting its own output', () => {
    expect(suggestExportName('shot-redacted.png')).toBe('shot-redacted.png');
  });

  it('keeps dots inside the name and drops any directory part', () => {
    expect(suggestExportName('Screen Shot 2026.08.06.png')).toBe(
      'Screen Shot 2026.08.06-redacted.png',
    );
    expect(suggestExportName('C:\\Users\\me\\shot.jpeg', 'jpeg')).toBe('shot-redacted.jpg');
  });

  it('handles a dotfile style name with no extension', () => {
    expect(suggestExportName('screenshot')).toBe('screenshot-redacted.png');
  });

  it('falls back to png for an unknown format', () => {
    expect(suggestExportName('shot.webp', 'webp')).toBe('shot-redacted.png');
  });
});

/* ------------------------------------------------------------------ */
/* sniffImageFormat                                                    */
/* ------------------------------------------------------------------ */

describe('sniffImageFormat', () => {
  it('names the common containers from their magic bytes', () => {
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe('PNG');
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('JPEG');
    expect(sniffImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('GIF');
    expect(sniffImageFormat(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('BMP');
  });

  it('reports unknown for bytes it does not recognize', () => {
    expect(sniffImageFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe('run', () => {
  it('reports what was loaded and how to drive the panel', () => {
    const png = new Uint8Array(2048);
    png.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10], 0);

    const rows = run(png, {});

    expect(rows.Loaded).toBe('PNG image, 2.0 KB.');
    expect(rows.Mode).toContain('Solid fill, black');
    expect(rows['How to use']).toContain('drag a rectangle');
    expect(rows.Privacy).toContain('your files and inputs never leave your device');
  });

  it('warns that pixelate is the weaker choice when pixelate is selected', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const rows = run(jpeg, { mode: 'pixelate', blockSize: 20 });
    expect(rows.Mode).toContain('20 px blocks');
    expect(rows.Mode).toContain('solid fill is the safer choice');
  });

  it('explains that the export is re-encoded and carries no metadata', () => {
    const rows = run(new Uint8Array([0x42, 0x4d, 1, 2]), { format: 'jpeg' });
    expect(rows.Export).toContain('re-encoded from the canvas');
    expect(rows.Export).toContain('screenshot-redacted.jpg');
  });

  it('tells a text paste that this tool wants an image', () => {
    const rows = run('hello', {});
    expect(rows.Input).toContain('This tool redacts images');
    expect(rows['Why solid']).toContain('Solid fill is the default');
  });

  it('handles an empty string as no image loaded yet', () => {
    const rows = run('', {});
    expect(rows.Input).toBe('No image loaded yet.');
  });

  it('throws a ToolError for an empty file', () => {
    expect(() => run(new Uint8Array(0), {})).toThrow(ToolError);
    try {
      run(new Uint8Array(0), {});
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-file');
      expect((e as ToolError).fix).toContain('screenshot');
    }
  });
});
