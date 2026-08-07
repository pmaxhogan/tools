import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import {
  buildPassArgs,
  formatClock,
  formatCommand,
  formatMegabytes,
  megabytesToBytes,
  normalizeDuration,
  outputNameFor,
  parseDuration,
  planCompression,
  resolveCapMB,
  resolveFps,
  resolveMaxHeight,
  run,
} from './index';

/**
 * Every expectation below is hand computed from the documented budget:
 *
 *   usable  = cap * 0.97 - 4096 bytes
 *   total   = usable * 8 / 1000 / duration          (kbps)
 *   audio   = first of 96, 64, 48 leaving >= 100 kbps for video
 *   video   = floor(total - audio)
 *   size    = (video + audio) * 1000 * duration / 8 (bytes)
 */

describe('planCompression', () => {
  it('plans a 10 MB cap over 60 seconds with audio', () => {
    // usable 9,695,904 B, total 1292.7872 kbps, audio 96, video floor(1196.7872)
    expect(
      planCompression({ targetBytes: 10_000_000, durationSec: 60, hasAudio: true })
    ).toEqual({
      videoKbps: 1196,
      audioKbps: 96,
      estimatedBytes: 9_690_000,
      feasible: true,
    });
  });

  it('plans a 50 MB cap over 10 minutes', () => {
    // usable 48,495,904 B, total 646.612053 kbps, video floor(550.612053)
    expect(
      planCompression({ targetBytes: 50_000_000, durationSec: 600, hasAudio: true })
    ).toEqual({
      videoKbps: 550,
      audioKbps: 96,
      estimatedBytes: 48_450_000,
      feasible: true,
    });
  });

  it('plans a 500 MB cap over 60 minutes', () => {
    // usable 484,995,904 B, total 1077.768675 kbps, video floor(981.768675)
    expect(
      planCompression({ targetBytes: 500_000_000, durationSec: 3600, hasAudio: true })
    ).toEqual({
      videoKbps: 981,
      audioKbps: 96,
      estimatedBytes: 484_650_000,
      feasible: true,
    });
  });

  it('refuses a 10 MB cap over 2 hours instead of producing a smear', () => {
    // total 10.7732 kbps: even the cheapest audio tier costs more than the budget
    const plan = planCompression({
      targetBytes: 10_000_000,
      durationSec: 7200,
      hasAudio: true,
    });
    expect(plan.feasible).toBe(false);
    expect(plan.videoKbps).toBe(0);
    expect(plan.audioKbps).toBe(48);
    expect(plan.estimatedBytes).toBe(43_200_000);
    expect(plan.reason).toContain('100 kbps');
    expect(plan.reason).toContain('2:00:00');
  });

  it('gives the whole budget to the picture when there is no audio', () => {
    // total 1292.7872 kbps, all of it video
    expect(
      planCompression({ targetBytes: 10_000_000, durationSec: 60, hasAudio: false })
    ).toEqual({
      videoKbps: 1292,
      audioKbps: 0,
      estimatedBytes: 9_690_000,
      feasible: true,
    });
  });

  describe('audio step-down thresholds', () => {
    // All four share a 10 MB cap: usable 9,695,904 B, 77,567.232 kbits total.
    const targetBytes = 10_000_000;

    it('keeps 96 kbps while video stays above the floor', () => {
      // 300 s: total 258.55744 kbps, 258.55744 - 96 = 162.55744
      expect(planCompression({ targetBytes, durationSec: 300, hasAudio: true })).toEqual({
        videoKbps: 162,
        audioKbps: 96,
        estimatedBytes: 9_675_000,
        feasible: true,
      });
    });

    it('steps down to 64 kbps when 96 would starve the video', () => {
      // 400 s: total 193.91808 kbps, 193.91808 - 96 = 97.9 (under 100), - 64 = 129.9
      expect(planCompression({ targetBytes, durationSec: 400, hasAudio: true })).toEqual({
        videoKbps: 129,
        audioKbps: 64,
        estimatedBytes: 9_650_000,
        feasible: true,
      });
    });

    it('steps down to 48 kbps at the tightest workable budget', () => {
      // 500 s: total 155.134464 kbps, only 48 leaves 107.134464 for video
      expect(planCompression({ targetBytes, durationSec: 500, hasAudio: true })).toEqual({
        videoKbps: 107,
        audioKbps: 48,
        estimatedBytes: 9_687_500,
        feasible: true,
      });
    });

    it('reports infeasible once even 48 kbps leaves the video under the floor', () => {
      // 600 s: total 129.27872 kbps, 129.27872 - 48 = 81.27872
      const plan = planCompression({ targetBytes, durationSec: 600, hasAudio: true });
      expect(plan).toMatchObject({
        videoKbps: 81,
        audioKbps: 48,
        estimatedBytes: 9_675_000,
        feasible: false,
      });
      expect(plan.reason).toContain('81 kbps');
    });
  });

  it('honors an explicit audio bitrate instead of choosing a tier', () => {
    // total 1292.7872 kbps, video floor(1292.7872 - 128)
    expect(
      planCompression({
        targetBytes: 10_000_000,
        durationSec: 60,
        hasAudio: true,
        audioKbps: 128,
      })
    ).toEqual({
      videoKbps: 1164,
      audioKbps: 128,
      estimatedBytes: 9_690_000,
      feasible: true,
    });
  });

  it('reports rather than throws when the duration is unknown', () => {
    const plan = planCompression({ targetBytes: 10_000_000, durationSec: 0, hasAudio: true });
    expect(plan.feasible).toBe(false);
    expect(plan.reason).toContain('length');
  });

  it('reports rather than throws when the cap is not a positive size', () => {
    const plan = planCompression({ targetBytes: 0, durationSec: 60, hasAudio: true });
    expect(plan.feasible).toBe(false);
    expect(plan.reason).toContain('positive');
  });

  it('refuses a cap smaller than the container overhead it reserves', () => {
    // 4000 * 0.97 = 3880, which is under the 4096 byte floor
    const plan = planCompression({ targetBytes: 4000, durationSec: 10, hasAudio: false });
    expect(plan.feasible).toBe(false);
    expect(plan.reason).toContain('container overhead');
  });
});

describe('buildPassArgs', () => {
  const base = { inputName: 'clip.mp4', videoKbps: 1196, audioKbps: 96 };

  it('builds a pass 1 analysis run that mixes nothing', () => {
    expect(buildPassArgs(1, base)).toEqual([
      '-y',
      '-i',
      'clip.mp4',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      '1196k',
      '-pass',
      '1',
      '-an',
      '-f',
      'null',
      '-',
    ]);
  });

  it('builds a pass 2 encode with AAC audio and a faststart header', () => {
    expect(buildPassArgs(2, { ...base, outputName: 'clip-10mb.mp4' })).toEqual([
      '-y',
      '-i',
      'clip.mp4',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      '1196k',
      '-pass',
      '2',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      'clip-10mb.mp4',
    ]);
  });

  it('drops the audio encoder entirely at 0 kbps', () => {
    expect(buildPassArgs(2, { ...base, audioKbps: 0 })).toEqual([
      '-y',
      '-i',
      'clip.mp4',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      '1196k',
      '-pass',
      '2',
      '-an',
      '-movflags',
      '+faststart',
      'output.mp4',
    ]);
  });

  it('carries the same scale filter and frame rate through both passes', () => {
    const opts = { ...base, maxHeight: 720, fps: 30, outputName: 'clip-10mb.mp4' };
    expect(buildPassArgs(1, opts)).toEqual([
      '-y',
      '-i',
      'clip.mp4',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      '1196k',
      '-vf',
      'scale=-2:min(720\\,ih)',
      '-r',
      '30',
      '-pass',
      '1',
      '-an',
      '-f',
      'null',
      '-',
    ]);
    expect(buildPassArgs(2, opts)).toEqual([
      '-y',
      '-i',
      'clip.mp4',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      '1196k',
      '-vf',
      'scale=-2:min(720\\,ih)',
      '-r',
      '30',
      '-pass',
      '2',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      'clip-10mb.mp4',
    ]);
  });

  it('treats a zero height or zero fps as "keep the source"', () => {
    const args = buildPassArgs(2, { ...base, maxHeight: 0, fps: 0 });
    expect(args).not.toContain('-vf');
    expect(args).not.toContain('-r');
  });

  it('rejects a missing input name', () => {
    expect(() => buildPassArgs(1, { ...base, inputName: '' })).toThrow(ToolError);
    try {
      buildPassArgs(1, { ...base, inputName: '' });
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });

  it('rejects a video bitrate that cannot be encoded', () => {
    try {
      buildPassArgs(2, { ...base, videoKbps: 0 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('invalid-bitrate');
    }
  });
});

describe('formatCommand', () => {
  it('renders a runnable command and quotes the filter graph', () => {
    expect(
      formatCommand(buildPassArgs(2, { inputName: 'clip.mp4', videoKbps: 800, audioKbps: 64 }))
    ).toBe(
      'ffmpeg -y -i clip.mp4 -c:v libx264 -preset veryfast -b:v 800k -pass 2 -c:a aac -b:a 64k -movflags +faststart output.mp4'
    );
    expect(formatCommand(['-vf', 'scale=-2:min(720\\,ih)'])).toBe(
      "ffmpeg -vf 'scale=-2:min(720\\,ih)'"
    );
  });
});

describe('parseDuration', () => {
  it('reads a duration out of an ffmpeg probe line', () => {
    expect(parseDuration('  Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s')).toBe(
      83.45
    );
  });

  it('reads hours', () => {
    expect(parseDuration('Duration: 01:02:03.00')).toBe(3723);
  });

  it('takes the first duration in a multi line log', () => {
    const log = [
      'Input #0, mov,mp4,m4a, from "clip.mp4":',
      '  Duration: 00:00:30.05, start: 0.000000, bitrate: 5000 kb/s',
      '  Stream #0:0: Video: h264',
      '  Duration: 00:99:99.99',
    ].join('\n');
    expect(parseDuration(log)).toBe(30.05);
  });

  it('returns null for an unknown duration', () => {
    expect(parseDuration('  Duration: N/A, bitrate: N/A')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('Duration: 00:00:00.00')).toBeNull();
  });
});

describe('normalizeDuration', () => {
  it('accepts a finite positive length from a video element', () => {
    expect(normalizeDuration(90.5)).toBe(90.5);
    expect(normalizeDuration(1.234567)).toBe(1.235);
  });

  it('rejects the values a browser reports before or without metadata', () => {
    expect(normalizeDuration(Number.NaN)).toBeNull();
    expect(normalizeDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeDuration(0)).toBeNull();
    expect(normalizeDuration(-5)).toBeNull();
  });
});

describe('option resolution', () => {
  it('falls back to the 10 MB preset', () => {
    expect(resolveCapMB({})).toBe(10);
    expect(resolveCapMB({ cap: '50' })).toBe(50);
    expect(resolveCapMB({ cap: '500', customMB: '' })).toBe(500);
  });

  it('lets a custom size override the preset', () => {
    expect(resolveCapMB({ cap: '10', customMB: '25' })).toBe(25);
    expect(resolveCapMB({ cap: '10', customMB: ' 7.5 ' })).toBe(7.5);
  });

  it('rejects a custom size that is not a positive number', () => {
    expect(() => resolveCapMB({ customMB: 'abc' })).toThrow(ToolError);
    expect(() => resolveCapMB({ customMB: '0' })).toThrow(/not a size in megabytes/);
    expect(() => resolveCapMB({ customMB: '-4' })).toThrow(ToolError);
  });

  it('rejects a custom size past the supported ceiling', () => {
    try {
      resolveCapMB({ customMB: '5000' });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-cap');
      expect((e as ToolError).fix).toContain('2000');
    }
  });

  it('reads the height cap and the frame rate cap', () => {
    expect(resolveMaxHeight({})).toBeNull();
    expect(resolveMaxHeight({ maxHeight: '0' })).toBeNull();
    expect(resolveMaxHeight({ maxHeight: '720' })).toBe(720);
    expect(resolveMaxHeight({ maxHeight: 1080 })).toBe(1080);
    expect(resolveFps({})).toBeNull();
    expect(resolveFps({ keepFps: true })).toBeNull();
    expect(resolveFps({ keepFps: false })).toBe(30);
  });
});

describe('naming and formatting helpers', () => {
  it('names the output after the input and the cap', () => {
    expect(outputNameFor('My Clip.mov', 10)).toBe('My-Clip-10mb.mp4');
    expect(outputNameFor('noextension', 50)).toBe('noextension-50mb.mp4');
    expect(outputNameFor('###.webm', 25)).toBe('video-25mb.mp4');
  });

  it('formats sizes and clock times', () => {
    expect(formatMegabytes(9_690_000)).toBe('9.69 MB');
    expect(megabytesToBytes(7.5)).toBe(7_500_000);
    expect(formatClock(60)).toBe('1:00');
    expect(formatClock(83.45)).toBe('1:23');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(Number.NaN)).toBe('unknown');
  });
});

describe('run', () => {
  it('plans a clip described as JSON', () => {
    expect(run('{"targetMB": 10, "durationSec": 60, "hasAudio": true}')).toEqual({
      'Size cap': '10.00 MB (10,000,000 bytes)',
      'Clip length': '1:00 (60 s)',
      'Video bitrate': '1196 kbps',
      'Audio bitrate': '96 kbps AAC',
      'Estimated stream size': '9.69 MB',
      'Reserved for the container': '0.30 MB',
      'Fits the cap': 'Yes, about 0.31 MB to spare',
      'ffmpeg pass 1':
        'ffmpeg -y -i input.mp4 -c:v libx264 -preset veryfast -b:v 1196k -pass 1 -an -f null -',
      'ffmpeg pass 2':
        'ffmpeg -y -i input.mp4 -c:v libx264 -preset veryfast -b:v 1196k -pass 2 -c:a aac -b:a 96k -movflags +faststart input-10mb.mp4',
    });
  });

  it('takes the cap and the encoding limits from the options', () => {
    const report = run('{"durationSec": 600}', {
      cap: '50',
      maxHeight: '720',
      keepFps: false,
    });
    expect(report['Size cap']).toBe('50.00 MB (50,000,000 bytes)');
    expect(report['Video bitrate']).toBe('550 kbps');
    expect(report['ffmpeg pass 2']).toContain("-vf 'scale=-2:min(720\\,ih)' -r 30");
  });

  it('says so plainly when the cap cannot hold the clip', () => {
    const report = run('{"targetMB": 10, "durationSec": 7200, "hasAudio": true}');
    expect(report['Fits the cap']).toMatch(/^No\./);
    expect(report['ffmpeg pass 2']).toBeUndefined();
  });

  it('plans a silent clip when the request says there is no audio', () => {
    const report = run('{"targetMB": 10, "durationSec": 60, "hasAudio": false}');
    expect(report['Audio bitrate']).toBe('none, silent output');
    expect(report['Video bitrate']).toBe('1292 kbps');
    expect(report['ffmpeg pass 2']).toContain('-an -movflags +faststart');
  });

  it('points video bytes at the panel instead of trying to encode them here', () => {
    try {
      run(new Uint8Array([0, 0, 0, 24]));
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('needs-panel');
    }
  });

  it('asks for a description when the input is empty', () => {
    try {
      run('   ');
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });

  it('rejects input that is not JSON', () => {
    try {
      run('10 MB please');
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-json');
    }
  });

  it('rejects JSON that is not an object', () => {
    try {
      run('[10, 60]');
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-plan');
    }
  });

  it('rejects a request with no usable clip length', () => {
    try {
      run('{"targetMB": 10}');
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-plan');
    }
  });

  it('surfaces an unusable custom cap from the options', () => {
    try {
      run('{"durationSec": 60}', { customMB: 'huge' });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-cap');
    }
  });
});
