import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import {
  buildCaption,
  buildCrop,
  buildOptimize,
  buildResize,
  buildReverse,
  buildSpeed,
  buildSplit,
  escapeDrawtext,
  isRefusal,
  paletteWrap,
  parseGifInfo,
  readGifInfo,
  run,
  splitFrameName,
  type GifPlan,
  type GifPlanResult,
  type GifRefusal,
} from './index';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function plan(result: GifPlanResult): GifPlan {
  if (isRefusal(result)) throw new Error(`expected a plan, got refusal: ${result.error}`);
  return result;
}

function refusal(result: GifPlanResult): GifRefusal {
  if (!isRefusal(result)) throw new Error('expected a refusal, got a plan');
  return result;
}

/** The value of `-filter_complex` in a planned command. */
function filterOf(result: GifPlanResult): string {
  const args = plan(result).args;
  return args[args.indexOf('-filter_complex') + 1];
}

/**
 * Builds a minimal but structurally real GIF89a: a global colour table, one
 * graphic control extension plus one image descriptor per frame, and a
 * trailer. The pixel data is a stub, which is fine because the reader steps
 * over compressed data rather than decoding it.
 */
function makeGif(options: {
  width: number;
  height: number;
  delaysCs: number[];
}): Uint8Array {
  const bytes: number[] = [];
  for (const code of 'GIF89a') bytes.push(code.charCodeAt(0));
  bytes.push(options.width & 0xff, options.width >> 8);
  bytes.push(options.height & 0xff, options.height >> 8);
  bytes.push(0x80, 0x00, 0x00); // global colour table of 2 entries
  bytes.push(0x00, 0x00, 0x00, 0xff, 0xff, 0xff);

  for (const delay of options.delaysCs) {
    // Graphic control extension
    bytes.push(0x21, 0xf9, 0x04, 0x00, delay & 0xff, delay >> 8, 0x00, 0x00);
    // Image descriptor
    bytes.push(0x2c, 0x00, 0x00, 0x00, 0x00);
    bytes.push(options.width & 0xff, options.width >> 8);
    bytes.push(options.height & 0xff, options.height >> 8);
    bytes.push(0x00); // no local colour table
    bytes.push(0x02); // LZW minimum code size
    bytes.push(0x02, 0x4c, 0x01, 0x00); // one data sub-block, then terminator
  }

  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

const SAMPLE_GIF = makeGif({ width: 4, height: 3, delaysCs: [5, 5] });

/** A log shaped like the one ffmpeg 6 prints for a GIF re-encode. */
const SAMPLE_LOG = [
  "Input #0, gif, from 'in.gif':",
  '  Duration: 00:00:02.40, start: 0.000000, bitrate: 1071 kb/s',
  '  Stream #0:0: Video: gif, bgra, 320x240, 10 fps, 10 tbr, 100 tbn',
  'Stream mapping:',
  '  Stream #0:0 (gif) -> palettegen',
  "Output #0, gif, to 'out.gif':",
  '  Stream #0:0: Video: gif, pal8, 320x240, q=2-31, 200 kb/s, 10 fps, 100 tbn',
  'frame=    8 fps=0.0 q=-0.0 size=       0kB time=00:00:00.80 bitrate=   0.4kbits/s speed=1.6x',
  'frame=   24 fps=0.0 q=-0.0 Lsize=     117kB time=00:00:02.30 bitrate= 416.2kbits/s speed=5.32x',
].join('\n');

/* ------------------------------------------------------------------ */
/* paletteWrap                                                         */
/* ------------------------------------------------------------------ */

describe('paletteWrap', () => {
  it('wraps a filter chain in a single pass palette graph', () => {
    expect(paletteWrap('scale=320:-1')).toBe(
      '[0:v]scale=320:-1,split[pgs][pgu];[pgs]palettegen[pal];[pgu][pal]paletteuse'
    );
  });

  it('handles an empty filter as a pure re-encode', () => {
    expect(paletteWrap('')).toBe(
      '[0:v]split[pgs][pgu];[pgs]palettegen[pal];[pgu][pal]paletteuse'
    );
  });

  it('passes palettegen and paletteuse options through', () => {
    expect(paletteWrap('fps=10', { palettegen: 'max_colors=64', paletteuse: 'dither=none' })).toBe(
      '[0:v]fps=10,split[pgs][pgu];[pgs]palettegen=max_colors=64[pal];[pgu][pal]paletteuse=dither=none'
    );
  });
});

/* ------------------------------------------------------------------ */
/* resize                                                              */
/* ------------------------------------------------------------------ */

describe('buildResize', () => {
  it('scales to a width with lanczos and re-palettizes', () => {
    const result = buildResize({ inputName: 'a.gif', width: 480 });
    expect(plan(result).args).toEqual([
      '-i',
      'a.gif',
      '-filter_complex',
      '[0:v]scale=480:-1:flags=lanczos,split[pgs][pgu];[pgs]palettegen[pal];[pgu][pal]paletteuse',
      '-loop',
      '0',
      'out.gif',
    ]);
    expect(plan(result).outputs).toEqual(['out.gif']);
  });

  it('refuses a width outside the supported range', () => {
    expect(refusal(buildResize({ inputName: 'a.gif', width: 4 })).error).toContain('Width');
    expect(refusal(buildResize({ inputName: 'a.gif', width: 9000 })).error).toContain('Width');
  });

  it('refuses a fractional width', () => {
    expect(refusal(buildResize({ inputName: 'a.gif', width: 320.5 })).fix).toBeTruthy();
  });

  it('refuses when no file has been selected', () => {
    expect(refusal(buildResize({ inputName: '', width: 480 })).error).toContain('No GIF');
  });
});

/* ------------------------------------------------------------------ */
/* crop                                                                */
/* ------------------------------------------------------------------ */

describe('buildCrop', () => {
  it('builds a crop filter in width:height:x:y order', () => {
    expect(filterOf(buildCrop({ inputName: 'a.gif', x: 10, y: 20, w: 100, h: 50 }))).toContain(
      'crop=100:50:10:20'
    );
  });

  it('allows a zero offset', () => {
    expect(filterOf(buildCrop({ inputName: 'a.gif', x: 0, y: 0, w: 8, h: 8 }))).toContain(
      'crop=8:8:0:0'
    );
  });

  it('refuses a zero or negative size', () => {
    expect(refusal(buildCrop({ inputName: 'a.gif', x: 0, y: 0, w: 0, h: 10 })).error).toContain(
      'at least 1 pixel'
    );
  });

  it('refuses a negative offset', () => {
    expect(refusal(buildCrop({ inputName: 'a.gif', x: -1, y: 0, w: 10, h: 10 })).error).toContain(
      'offsets'
    );
  });
});

/* ------------------------------------------------------------------ */
/* optimize                                                            */
/* ------------------------------------------------------------------ */

describe('buildOptimize', () => {
  it('reduces the frame rate and caps the palette', () => {
    const filter = filterOf(buildOptimize({ inputName: 'a.gif', fps: 12, colors: 64 }));
    expect(filter).toContain('fps=12');
    expect(filter).toContain('palettegen=max_colors=64');
    expect(filter).toContain('paletteuse=dither=bayer:bayer_scale=5');
  });

  it('refuses lossy optimization, which ffmpeg cannot do', () => {
    const result = refusal(
      buildOptimize({ inputName: 'a.gif', fps: 12, colors: 64, lossy: true })
    );
    expect(result.error).toContain('not something ffmpeg can do');
    expect(result.fix).toContain('color count');
  });

  it('refuses a frame rate outside the range', () => {
    expect(refusal(buildOptimize({ inputName: 'a.gif', fps: 0, colors: 64 })).error).toContain(
      'Frame rate'
    );
  });

  it('refuses a color count outside the GIF limit', () => {
    expect(refusal(buildOptimize({ inputName: 'a.gif', fps: 12, colors: 300 })).error).toContain(
      'Colors'
    );
  });
});

/* ------------------------------------------------------------------ */
/* reverse and speed                                                   */
/* ------------------------------------------------------------------ */

describe('buildReverse', () => {
  it('reverses and re-palettizes', () => {
    expect(filterOf(buildReverse({ inputName: 'a.gif' }))).toBe(
      '[0:v]reverse,split[pgs][pgu];[pgs]palettegen[pal];[pgu][pal]paletteuse'
    );
  });
});

describe('buildSpeed', () => {
  it('rewrites presentation timestamps', () => {
    expect(filterOf(buildSpeed({ inputName: 'a.gif', factor: 2 }))).toContain('setpts=PTS/2');
  });

  it('keeps a fractional slow down readable', () => {
    expect(filterOf(buildSpeed({ inputName: 'a.gif', factor: 0.25 }))).toContain('setpts=PTS/0.25');
  });

  it('resamples afterwards when a frame rate is given', () => {
    expect(filterOf(buildSpeed({ inputName: 'a.gif', factor: 0.5, fps: 20 }))).toContain(
      'setpts=PTS/0.5,fps=20'
    );
  });

  it('refuses a factor outside 0.25 to 4', () => {
    expect(refusal(buildSpeed({ inputName: 'a.gif', factor: 10 })).error).toContain('Speed');
    expect(refusal(buildSpeed({ inputName: 'a.gif', factor: 0 })).error).toContain('Speed');
  });

  it('refuses an impossible resample rate', () => {
    expect(refusal(buildSpeed({ inputName: 'a.gif', factor: 2, fps: 999 })).error).toContain(
      'Frame rate'
    );
  });
});

/* ------------------------------------------------------------------ */
/* caption                                                             */
/* ------------------------------------------------------------------ */

describe('escapeDrawtext', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeDrawtext('when it works')).toBe('when it works');
  });

  it('double escapes everything both filtergraph passes would eat', () => {
    expect(escapeDrawtext("a:b,c'd\\e[f]")).toBe("a\\\\:b\\,c\\\\\\'d\\\\\\\\e\\[f\\]");
  });

  it('escapes a semicolon so it cannot start a new filter chain', () => {
    expect(escapeDrawtext('one; two')).toBe('one\\; two');
  });
});

describe('buildCaption', () => {
  it('refuses without a font file, because no usable font ships with the site', () => {
    const result = refusal(
      buildCaption({ inputName: 'a.gif', text: 'hello', position: 'bottom', fontSize: 32 })
    );
    expect(result.error).toContain('font file');
    expect(result.fix).toContain('image editor');
  });

  it('refuses an empty caption', () => {
    const result = refusal(
      buildCaption({
        inputName: 'a.gif',
        text: '   ',
        position: 'bottom',
        fontSize: 32,
        fontFile: 'font.ttf',
      })
    );
    expect(result.error).toContain('empty');
  });

  it('refuses a font size outside the range', () => {
    expect(
      refusal(
        buildCaption({
          inputName: 'a.gif',
          text: 'hi',
          position: 'top',
          fontSize: 400,
          fontFile: 'font.ttf',
        })
      ).error
    ).toContain('Font size');
  });

  it('refuses a font name a filter cannot carry', () => {
    expect(
      refusal(
        buildCaption({
          inputName: 'a.gif',
          text: 'hi',
          position: 'top',
          fontSize: 32,
          fontFile: 'my fonts/geist.ttf',
        })
      ).error
    ).toContain('font file name');
  });

  it('plans a centred bottom caption once a font is available', () => {
    const filter = filterOf(
      buildCaption({
        inputName: 'a.gif',
        text: 'when it: works',
        position: 'bottom',
        fontSize: 32,
        fontFile: 'caption.ttf',
      })
    );
    expect(filter).toContain('drawtext=fontfile=caption.ttf');
    expect(filter).toContain('text=when it\\\\: works');
    expect(filter).toContain('fontcolor=white');
    expect(filter).toContain('borderw=2');
    expect(filter).toContain('expansion=none');
    expect(filter).toContain('x=(w-text_w)/2');
    expect(filter).toContain('y=h-text_h-10');
    expect(filter).toContain('palettegen');
  });

  it('places a top caption near the top edge', () => {
    const filter = filterOf(
      buildCaption({
        inputName: 'a.gif',
        text: 'top',
        position: 'top',
        fontSize: 20,
        fontFile: 'caption.ttf',
      })
    );
    expect(filter).toContain(':y=6,split');
  });
});

/* ------------------------------------------------------------------ */
/* split                                                               */
/* ------------------------------------------------------------------ */

describe('splitFrameName', () => {
  it('matches the zero padding the image2 muxer uses', () => {
    expect(splitFrameName(1)).toBe('out0001.png');
    expect(splitFrameName(42)).toBe('out0042.png');
  });
});

describe('buildSplit', () => {
  it('exports every frame with frame timing passed through', () => {
    const result = plan(buildSplit({ inputName: 'a.gif', everyNth: 1, frames: 3 }));
    expect(result.args).toEqual([
      '-i',
      'a.gif',
      '-vsync',
      '0',
      '-frames:v',
      '3',
      'out%04d.png',
    ]);
    expect(result.outputs).toEqual(['out0001.png', 'out0002.png', 'out0003.png']);
  });

  it('selects every nth frame with an escaped comma inside mod()', () => {
    const result = plan(buildSplit({ inputName: 'a.gif', everyNth: 3, frames: 2 }));
    expect(result.args).toContain('select=not(mod(n\\,3))');
    expect(result.outputs).toHaveLength(2);
  });

  it('refuses more frames than the export cap', () => {
    expect(refusal(buildSplit({ inputName: 'a.gif', everyNth: 1, frames: 500 })).error).toContain(
      'Frames to export'
    );
  });

  it('refuses a frame step outside the range', () => {
    expect(refusal(buildSplit({ inputName: 'a.gif', everyNth: 0, frames: 4 })).error).toContain(
      'Frame step'
    );
  });
});

/* ------------------------------------------------------------------ */
/* reading a GIF                                                       */
/* ------------------------------------------------------------------ */

describe('readGifInfo', () => {
  it('reads size, frame count and timing from the byte stream', () => {
    expect(readGifInfo(SAMPLE_GIF)).toEqual({
      width: 4,
      height: 3,
      frames: 2,
      durationMs: 100,
      fps: 20,
    });
  });

  it('clamps a zero delay the way browsers do', () => {
    const gif = makeGif({ width: 2, height: 2, delaysCs: [0, 0] });
    expect(readGifInfo(gif)?.durationMs).toBe(200);
  });

  it('reports a single frame GIF without a frame rate', () => {
    const gif = makeGif({ width: 16, height: 9, delaysCs: [10] });
    expect(readGifInfo(gif)).toMatchObject({ width: 16, height: 9, frames: 1, fps: null });
  });

  it('returns null for bytes that are not a GIF', () => {
    expect(readGifInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      null
    );
    expect(readGifInfo(new Uint8Array([0x47, 0x49, 0x46]))).toBe(null);
  });

  it('returns null when the file has a header but no frames', () => {
    const headerOnly = SAMPLE_GIF.slice(0, 13);
    expect(readGifInfo(headerOnly)).toBe(null);
  });
});

describe('parseGifInfo', () => {
  it('reads size, rate and the final frame count from an ffmpeg log', () => {
    expect(parseGifInfo(SAMPLE_LOG)).toEqual({
      width: 320,
      height: 240,
      fps: 10,
      frames: 24,
    });
  });

  it('reports a null frame count when the log never reached the summary', () => {
    const probe = [
      "Input #0, gif, from 'in.gif':",
      '  Stream #0:0: Video: gif, bgra, 48x48, 25 fps, 25 tbr, 100 tbn',
    ].join('\n');
    expect(parseGifInfo(probe)).toEqual({ width: 48, height: 48, fps: 25, frames: null });
  });

  it('returns null when the log has no video stream', () => {
    expect(parseGifInfo('Input #0, mp3, from a.mp3:\n  Stream #0:0: Audio: mp3')).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe('run', () => {
  it('reports the planned command and what the file contains', () => {
    const result = run(SAMPLE_GIF, { operation: 'resize', width: 320 });
    expect(result.Operation).toBe('Resize');
    expect(result.Source).toBe('4 x 3 px, 2 frames, 0.10 s, 20 fps average');
    expect(result.Command).toContain('ffmpeg -i in.gif -filter_complex');
    expect(result.Command).toContain('scale=320:-1:flags=lanczos');
    expect(result['Output files']).toBe('out.gif');
    expect(result.Note).toContain('aspect ratio');
  });

  it('lists every declared frame for a split', () => {
    const result = run(SAMPLE_GIF, { operation: 'split', everyNth: 2, frames: 2 });
    expect(result['Output files']).toBe('out0001.png, out0002.png');
  });

  it('says so when the bytes are not a GIF', () => {
    const notGif = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(run(notGif, { operation: 'reverse' }).Source).toBe('Not a readable GIF file.');
  });

  it('throws on an empty input', () => {
    expect(() => run('', {})).toThrow(ToolError);
    try {
      run('', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });

  it('throws when given text instead of a file', () => {
    try {
      run('a gif please', {});
      throw new Error('expected a ToolError');
    } catch (e) {
      expect((e as ToolError).code).toBe('not-a-gif');
    }
  });

  it('turns a refused plan into a ToolError with a fix', () => {
    try {
      run(SAMPLE_GIF, { operation: 'caption', text: 'hello' });
      throw new Error('expected a ToolError');
    } catch (e) {
      expect((e as ToolError).code).toBe('cannot-plan');
      expect((e as ToolError).message).toContain('font file');
      expect((e as ToolError).fix).toBeTruthy();
    }
  });

  it('rejects an operation it does not know', () => {
    expect(() => run(SAMPLE_GIF, { operation: 'melt' as never })).toThrow(ToolError);
  });
});
