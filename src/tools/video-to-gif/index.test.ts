import { describe, expect, it } from 'vitest';
import {
  GIF_OUTPUT_NAME,
  buildGifArgs,
  buildGifFilter,
  estimateFrames,
  parseTimeSpec,
  run,
  type GifArgsInput,
} from './index';
import { ToolError } from '../types';

const BASE: GifArgsInput = {
  inputName: 'clip.mp4',
  startSec: null,
  endSec: null,
  fps: 12,
  width: 480,
  paletteMode: 'global',
  dither: 'sierra2_4a',
  loop: true,
};

/** Pulls the filter graph back out of a built argument list. */
function filterOf(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1];
}

function ok(input: Partial<GifArgsInput> = {}) {
  const result = buildGifArgs({ ...BASE, ...input });
  if ('error' in result) throw new Error(`expected args, got error: ${result.error}`);
  return result;
}

describe('parseTimeSpec', () => {
  it('reads plain seconds, whole and fractional', () => {
    expect(parseTimeSpec('12')).toBe(12);
    expect(parseTimeSpec('12.5')).toBe(12.5);
    expect(parseTimeSpec('0')).toBe(0);
    expect(parseTimeSpec('  7  ')).toBe(7);
  });

  it('reads mm:ss and hh:mm:ss with milliseconds', () => {
    expect(parseTimeSpec('1:20')).toBe(80);
    expect(parseTimeSpec('01:20')).toBe(80);
    expect(parseTimeSpec('0:01:20')).toBe(80);
    expect(parseTimeSpec('1:02:03.250')).toBe(3723.25);
    expect(parseTimeSpec('90:00')).toBe(5400);
  });

  it('returns null for empty and malformed input', () => {
    expect(parseTimeSpec('')).toBe(null);
    expect(parseTimeSpec('   ')).toBe(null);
    expect(parseTimeSpec('abc')).toBe(null);
    expect(parseTimeSpec('-5')).toBe(null);
    expect(parseTimeSpec('1:2:3:4')).toBe(null);
    expect(parseTimeSpec('1:75')).toBe(null);
    expect(parseTimeSpec('1.5:30')).toBe(null);
    expect(parseTimeSpec('1:')).toBe(null);
  });
});

describe('estimateFrames', () => {
  it('multiplies the frame rate by the trim window', () => {
    expect(estimateFrames({ fps: 12, startSec: 2, endSec: 12 })).toBe(120);
    expect(estimateFrames({ fps: 15, startSec: null, endSec: 4 })).toBe(60);
  });

  it('falls back to the source duration when no end time is set', () => {
    expect(estimateFrames({ fps: 10, startSec: 5, endSec: null, durationSec: 25 })).toBe(200);
  });

  it('returns null when the window cannot be known or is empty', () => {
    expect(estimateFrames({ fps: 12, startSec: null, endSec: null })).toBe(null);
    expect(estimateFrames({ fps: 12, startSec: 10, endSec: 10 })).toBe(null);
    expect(estimateFrames({ fps: 12, startSec: 30, endSec: null, durationSec: 20 })).toBe(null);
    expect(estimateFrames({ fps: 0, startSec: 0, endSec: 10 })).toBe(null);
  });
});

describe('buildGifFilter', () => {
  it('builds the global palette graph with stats_mode=full and no new flag', () => {
    expect(
      buildGifFilter({ fps: 12, width: 480, paletteMode: 'global', dither: 'sierra2_4a' })
    ).toBe(
      '[0:v] fps=12,scale=480:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=full [p];' +
        '[b][p] paletteuse=dither=sierra2_4a'
    );
  });

  it('pairs the per frame palette with stats_mode=single and new=1', () => {
    expect(
      buildGifFilter({ fps: 15, width: 640, paletteMode: 'perframe', dither: 'sierra2_4a' })
    ).toBe(
      '[0:v] fps=15,scale=640:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=single [p];' +
        '[b][p] paletteuse=dither=sierra2_4a:new=1'
    );
  });

  it('adds bayer_scale=3 for bayer, in both palette modes', () => {
    expect(buildGifFilter({ fps: 12, width: 480, paletteMode: 'global', dither: 'bayer' })).toBe(
      '[0:v] fps=12,scale=480:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=full [p];' +
        '[b][p] paletteuse=dither=bayer:bayer_scale=3'
    );
    expect(buildGifFilter({ fps: 12, width: 480, paletteMode: 'perframe', dither: 'bayer' })).toBe(
      '[0:v] fps=12,scale=480:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=single [p];' +
        '[b][p] paletteuse=dither=bayer:bayer_scale=3:new=1'
    );
  });

  it('writes dither=none when dithering is turned off', () => {
    expect(buildGifFilter({ fps: 8, width: 320, paletteMode: 'global', dither: 'none' })).toBe(
      '[0:v] fps=8,scale=320:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=full [p];' +
        '[b][p] paletteuse=dither=none'
    );
  });

  it('keeps a fractional frame rate intact', () => {
    expect(
      buildGifFilter({ fps: 12.5, width: 480, paletteMode: 'global', dither: 'none' })
    ).toContain('fps=12.5,');
  });
});

describe('buildGifArgs', () => {
  it('builds the whole command with no trim', () => {
    expect(ok().args).toEqual([
      '-i',
      'clip.mp4',
      '-filter_complex',
      '[0:v] fps=12,scale=480:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=full [p];' +
        '[b][p] paletteuse=dither=sierra2_4a',
      '-loop',
      '0',
      'output.gif',
    ]);
    expect(ok().outputs).toEqual([GIF_OUTPUT_NAME]);
  });

  it('puts -ss and -to before -i so the seek happens on the input', () => {
    const args = ok({ startSec: 3.5, endSec: 10 }).args;
    expect(args.slice(0, 6)).toEqual(['-ss', '3.5', '-to', '10', '-i', 'clip.mp4']);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args.indexOf('-to')).toBeLessThan(args.indexOf('-i'));
  });

  it('omits the seek flags that were left empty', () => {
    expect(ok({ startSec: 2, endSec: null }).args).not.toContain('-to');
    expect(ok({ startSec: null, endSec: 2 }).args).not.toContain('-ss');
  });

  it('maps loop true to 0 and loop false to -1', () => {
    const looping = ok().args;
    expect(looping[looping.indexOf('-loop') + 1]).toBe('0');
    const once = ok({ loop: false }).args;
    expect(once[once.indexOf('-loop') + 1]).toBe('-1');
  });

  it('carries the per frame palette pairing through to the built args', () => {
    expect(filterOf(ok({ paletteMode: 'perframe', dither: 'bayer' }).args)).toBe(
      '[0:v] fps=12,scale=480:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=single [p];' +
        '[b][p] paletteuse=dither=bayer:bayer_scale=3:new=1'
    );
  });

  it('rounds a fractional width to whole pixels', () => {
    expect(filterOf(ok({ width: 480.6 }).args)).toContain('scale=481:-1:');
  });

  it('refuses an end time that is not after the start time', () => {
    const same = buildGifArgs({ ...BASE, startSec: 5, endSec: 5 });
    expect('error' in same && same.error).toMatch(/after the start time/);
    const backwards = buildGifArgs({ ...BASE, startSec: 5, endSec: 4 });
    expect('error' in backwards && backwards.error).toMatch(/after the start time/);
    // An end time on its own still has to be greater than the implied zero start.
    const zero = buildGifArgs({ ...BASE, startSec: null, endSec: 0 });
    expect('error' in zero).toBe(true);
  });

  it('refuses a negative start, a missing input, and out of range numbers', () => {
    expect('error' in buildGifArgs({ ...BASE, startSec: -1 })).toBe(true);
    expect('error' in buildGifArgs({ ...BASE, inputName: '  ' })).toBe(true);
    expect('error' in buildGifArgs({ ...BASE, fps: 0 })).toBe(true);
    expect('error' in buildGifArgs({ ...BASE, fps: 60 })).toBe(true);
    expect('error' in buildGifArgs({ ...BASE, fps: Number.NaN })).toBe(true);
    expect('error' in buildGifArgs({ ...BASE, width: 32 })).toBe(true);
    expect('error' in buildGifArgs({ ...BASE, width: 4000 })).toBe(true);
  });

  it('gives every refusal a fix hint', () => {
    for (const bad of [
      buildGifArgs({ ...BASE, inputName: '' }),
      buildGifArgs({ ...BASE, fps: 0 }),
      buildGifArgs({ ...BASE, width: 1 }),
      buildGifArgs({ ...BASE, startSec: -2 }),
      buildGifArgs({ ...BASE, startSec: 5, endSec: 1 }),
    ]) {
      expect('error' in bad && typeof bad.fix).toBe('string');
    }
  });
});

describe('run', () => {
  it('plans a command from an empty input without throwing', () => {
    const out = run('', {});
    expect(out['ffmpeg command']).toContain('-filter_complex');
    expect(out['Filter graph']).toBe(
      '[0:v] fps=12,scale=480:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=full [p];' +
        '[b][p] paletteuse=dither=sierra2_4a'
    );
    expect(out.Trim).toMatch(/Whole clip/);
    expect(out.Loop).toContain('-loop 0');
  });

  it('quotes the filter graph in the copyable command', () => {
    expect(run('', {})['ffmpeg command']).toContain('"[0:v] fps=12');
  });

  it('honours option values and reports the trim window and frame count', () => {
    const out = run('', {
      start: '0:02',
      end: '0:12',
      fps: 20,
      width: 640,
      palette: 'perframe',
      dither: 'bayer',
      loop: false,
    });
    expect(out['ffmpeg command']).toContain('-ss 2 -to 12');
    expect(out['Filter graph']).toContain('stats_mode=single');
    expect(out['Filter graph']).toContain('paletteuse=dither=bayer:bayer_scale=3:new=1');
    expect(out.Trim).toBe('From 0:02 to 0:12.');
    expect(out.Frames).toContain('About 200');
    expect(out.Loop).toContain('-loop -1');
  });

  it('warns when the trim window would produce a very large GIF', () => {
    const out = run('', { start: '0', end: '2:00', fps: 25 });
    expect(out.Frames).toContain('3,000');
    expect(out.Frames).toMatch(/over 600/);
  });

  it('merges a pasted JSON settings object over the option values', () => {
    const out = run('{"fps": 8, "width": 320, "dither": "none"}', {});
    expect(out['Filter graph']).toBe(
      '[0:v] fps=8,scale=320:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=full [p];' +
        '[b][p] paletteuse=dither=none'
    );
  });

  it('notes unusable text instead of failing on it', () => {
    expect(run('hello there', {}).Note).toMatch(/not a JSON settings object/);
    expect(run('{oops', {}).Note).toMatch(/did not parse/);
    expect(run('[1,2,3]', {}).Note).toMatch(/not an object/);
  });

  it('reports the byte count when it is handed video bytes', () => {
    const out = run(new Uint8Array(2048), {});
    expect(out.Input).toContain('2,048 bytes');
    expect(out['ffmpeg command']).toContain('ffmpeg');
  });

  it('throws a ToolError for a timestamp it cannot read', () => {
    expect(() => run('', { start: 'later' })).toThrow(ToolError);
    expect(() => run('', { end: '99:99' })).toThrow(ToolError);
    try {
      run('', { start: 'later' });
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-start-time');
      expect((e as ToolError).fix).toContain('mm:ss');
    }
  });

  it('throws a ToolError when the trim window is backwards', () => {
    expect(() => run('', { start: '0:10', end: '0:05' })).toThrow(ToolError);
    try {
      run('', { start: '0:10', end: '0:05' });
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-settings');
    }
  });

  it('falls back to defaults for unknown enum and non numeric values', () => {
    const out = run('', { palette: 'wat', dither: 'wat', fps: 'wat' as unknown as number });
    expect(out['Filter graph']).toBe(
      '[0:v] fps=12,scale=480:-1:flags=lanczos,split [a][b];' +
        '[a] palettegen=stats_mode=full [p];' +
        '[b][p] paletteuse=dither=sierra2_4a'
    );
  });
});
