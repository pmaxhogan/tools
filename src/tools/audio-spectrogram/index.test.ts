import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import {
  DB_FLOOR,
  MAGMA_STOPS,
  VIRIDIS_STOPS,
  computeSpectrogram,
  computeSpectrogramColumns,
  computeWaveformPeaks,
  dbToColor,
  fft,
  freqToLabel,
  hannWindow,
  isPowerOfTwo,
  planSpectrogram,
  run,
  secondsToLabel,
  type ColorScheme,
  type SpectrogramOptions,
} from './index';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic 32 bit LCG so the Parseval test never flakes. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function magnitudes(re: Float32Array, im: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < re.length; i++) out.push(Math.hypot(re[i]!, im[i]!));
  return out;
}

/** Index of the largest value in an array. */
function argmax(values: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
  return best;
}

const OPTS = { fftSize: '2048', colors: 'viridis', scale: 'linear', showWaveform: true };

/* ------------------------------------------------------------------ */
/* fft                                                                 */
/* ------------------------------------------------------------------ */

describe('audio-spectrogram: fft', () => {
  it('transforms a length 8 impulse into a flat spectrum', () => {
    // The DFT of delta[n] is 1 in every bin, real, with no imaginary part.
    const re = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const im = new Float32Array(8);
    fft(re, im);
    for (let k = 0; k < 8; k++) {
      expect(re[k]).toBeCloseTo(1, 6);
      expect(im[k]).toBeCloseTo(0, 6);
    }
  });

  it('transforms a length 8 constant into 8 at bin 0 and nothing else', () => {
    const re = new Float32Array(8).fill(1);
    const im = new Float32Array(8);
    fft(re, im);
    expect(re[0]).toBeCloseTo(8, 5);
    expect(im[0]).toBeCloseTo(0, 5);
    for (let k = 1; k < 8; k++) {
      expect(Math.hypot(re[k]!, im[k]!)).toBeLessThan(1e-5);
    }
  });

  it('transforms a length 8 cosine at bin 1 into 4 at bins 1 and 7', () => {
    // cos(2*pi*n/8) = (e^(i2pi n/8) + e^(-i2pi n/8)) / 2, so the N/2 = 4 of
    // each exponential lands in bin 1 and its mirror bin 7, real and positive.
    const re = new Float32Array(8);
    const im = new Float32Array(8);
    for (let n = 0; n < 8; n++) re[n] = Math.cos((2 * Math.PI * n) / 8);
    fft(re, im);
    expect(re[1]).toBeCloseTo(4, 5);
    expect(im[1]).toBeCloseTo(0, 5);
    expect(re[7]).toBeCloseTo(4, 5);
    expect(im[7]).toBeCloseTo(0, 5);
    for (const k of [0, 2, 3, 4, 5, 6]) {
      expect(Math.hypot(re[k]!, im[k]!)).toBeLessThan(1e-5);
    }
  });

  it('puts a DC signal in bin 0 only', () => {
    const n = 1024;
    const re = new Float32Array(n).fill(1);
    const im = new Float32Array(n);
    fft(re, im);
    const mags = magnitudes(re, im);
    expect(mags[0]).toBeCloseTo(n, 2);
    const others = Math.max(...mags.slice(1));
    expect(others / mags[0]!).toBeLessThan(1e-3);
  });

  it('peaks exactly at bin k for a pure sine at bin k of a 1024 point FFT', () => {
    const n = 1024;
    const k = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * k * i) / n);
    fft(re, im);
    const mags = magnitudes(re, im);

    // The peak of the lower half is exactly the bin the sine was built at.
    expect(argmax(mags.slice(0, n / 2))).toBe(k);
    // An unwindowed sine at an exact bin gives N/2 at bin k and at its mirror.
    expect(mags[k]).toBeCloseTo(n / 2, 1);
    expect(mags[n - k]).toBeCloseTo(n / 2, 1);

    // Everything that is not the peak or its mirror is numerical noise.
    const leakage = mags.filter((_, i) => i !== k && i !== n - k);
    expect(Math.max(...leakage) / mags[k]!).toBeLessThan(1e-3);
  });

  it('conserves energy (Parseval) within 1e-3 relative error', () => {
    const n = 1024;
    const rand = lcg(20260807);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    let timeEnergy = 0;
    for (let i = 0; i < n; i++) {
      const v = rand() * 2 - 1;
      re[i] = v;
      timeEnergy += re[i]! * re[i]!;
    }
    fft(re, im);
    let freqEnergy = 0;
    for (let i = 0; i < n; i++) freqEnergy += re[i]! * re[i]! + im[i]! * im[i]!;
    freqEnergy /= n;
    expect(Math.abs(freqEnergy - timeEnergy) / timeEnergy).toBeLessThan(1e-3);
  });

  it('is its own consistency check: two sines add linearly', () => {
    const n = 256;
    const build = (freqs: number[]) => {
      const re = new Float32Array(n);
      const im = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / n);
        re[i] = v;
      }
      fft(re, im);
      return magnitudes(re, im);
    };
    const both = build([10, 40]);
    expect(argmax(both.slice(0, n / 2))).toBe(10);
    expect(both[10]).toBeCloseTo(n / 2, 1);
    expect(both[40]).toBeCloseTo(n / 2, 1);
  });

  it('rejects mismatched buffers and non power of two lengths', () => {
    expect(() => fft(new Float32Array(8), new Float32Array(4))).toThrow(ToolError);
    expect(() => fft(new Float32Array(12), new Float32Array(12))).toThrow(
      /power of two/,
    );
    expect(() => fft(new Float32Array(0), new Float32Array(0))).toThrow(ToolError);
  });

  it('leaves a single sample untouched', () => {
    const re = new Float32Array([0.5]);
    const im = new Float32Array([0]);
    fft(re, im);
    expect(re[0]).toBe(0.5);
    expect(im[0]).toBe(0);
  });
});

describe('audio-spectrogram: isPowerOfTwo', () => {
  it('accepts powers of two and rejects everything else', () => {
    expect(isPowerOfTwo(1)).toBe(true);
    expect(isPowerOfTwo(4096)).toBe(true);
    expect(isPowerOfTwo(0)).toBe(false);
    expect(isPowerOfTwo(-8)).toBe(false);
    expect(isPowerOfTwo(1000)).toBe(false);
    expect(isPowerOfTwo(2.5)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* hannWindow                                                          */
/* ------------------------------------------------------------------ */

describe('audio-spectrogram: hannWindow', () => {
  it('is zero at both ends and one in the middle', () => {
    const w = hannWindow(9);
    expect(w[0]).toBe(0);
    expect(w[8]).toBe(0);
    expect(w[4]).toBeCloseTo(1, 6);
  });

  it('is symmetric and stays inside 0 to 1', () => {
    const w = hannWindow(1024);
    expect(w).toHaveLength(1024);
    for (let i = 0; i < 1024; i++) {
      expect(w[i]!).toBeGreaterThanOrEqual(0);
      expect(w[i]!).toBeLessThanOrEqual(1);
      expect(w[i]).toBeCloseTo(w[1023 - i]!, 6);
    }
  });

  it('caches by length and hands back the same array', () => {
    expect(hannWindow(2048)).toBe(hannWindow(2048));
  });

  it('rejects lengths below two points', () => {
    expect(() => hannWindow(1)).toThrow(ToolError);
    expect(() => hannWindow(2.5)).toThrow(/at least 2 points/);
  });
});

/* ------------------------------------------------------------------ */
/* computeSpectrogram                                                  */
/* ------------------------------------------------------------------ */

const SPEC: SpectrogramOptions = { fftSize: 1024, hop: 256, maxColumns: 4000 };

/** Linear chirp whose normalized frequency rises from f0 to f1 cycles/sample. */
function chirp(length: number, f0: number, f1: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const phase = 2 * Math.PI * (f0 * i + ((f1 - f0) * i * i) / (2 * length));
    out[i] = Math.sin(phase);
  }
  return out;
}

function sine(length: number, cyclesPerSample: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin(2 * Math.PI * cyclesPerSample * i);
  return out;
}

describe('audio-spectrogram: computeSpectrogram', () => {
  it('tracks a rising sweep with a rising peak bin', () => {
    const samples = chirp(40000, 0.02, 0.2);
    const { columns, freqBins } = computeSpectrogram(samples, SPEC);
    expect(freqBins).toBe(512);
    expect(columns.length).toBeGreaterThan(100);

    const peaks = columns.map((c) => argmax(c));
    // Sampled coarsely the sweep is strictly rising: ten hops move the tone by
    // roughly eleven bins, far more than the leakage around the peak.
    for (let i = 10; i < peaks.length; i += 10) {
      expect(peaks[i]!).toBeGreaterThan(peaks[i - 10]!);
    }
    // At full resolution the peak never walks backwards by more than a bin.
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i]!).toBeGreaterThanOrEqual(peaks[i - 1]! - 1);
    }
    expect(peaks[peaks.length - 1]!).toBeGreaterThan(peaks[0]! + 100);
  });

  it('floors silence at exactly -100 dB', () => {
    const { columns } = computeSpectrogram(new Float32Array(8192), SPEC);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      for (const value of column) expect(value).toBe(DB_FLOOR);
    }
    expect(DB_FLOOR).toBe(-100);
  });

  it('reads a full scale sine at about 0 dB in the bin it sits in', () => {
    // 64 cycles per 1024 samples puts the tone exactly on bin 64.
    const samples = sine(8192, 64 / 1024);
    const { columns } = computeSpectrogram(samples, SPEC);
    const first = columns[0]!;
    expect(argmax(first)).toBe(64);
    expect(first[64]!).toBeGreaterThan(-0.5);
    expect(first[64]!).toBeLessThan(0.5);
    // Well away from the tone the frame is essentially empty.
    expect(first[300]!).toBeLessThan(-80);
  });

  it('max-pools long clips down to maxColumns', () => {
    const samples = chirp(400000, 0.02, 0.2);
    const plan = planSpectrogram(samples.length, { fftSize: 1024, hop: 256, maxColumns: 200 });
    expect(plan.frameCount).toBeGreaterThan(1500);
    expect(plan.group).toBeGreaterThan(1);
    expect(plan.columnCount).toBeLessThanOrEqual(200);

    const { columns } = computeSpectrogram(samples, {
      fftSize: 1024,
      hop: 256,
      maxColumns: 200,
    });
    expect(columns).toHaveLength(plan.columnCount);

    // Pooling takes the loudest frame in each group, so a pooled column is
    // never quieter than the unpooled columns it covers.
    const unpooled = computeSpectrogram(samples, {
      fftSize: 1024,
      hop: 256,
      maxColumns: 100000,
    }).columns;
    for (let g = 0; g < plan.group; g++) {
      const frame = unpooled[g];
      if (!frame) continue;
      for (let k = 0; k < plan.freqBins; k++) {
        expect(columns[0]![k]!).toBeGreaterThanOrEqual(frame[k]! - 1e-4);
      }
    }
  });

  it('zero pads a clip shorter than one frame into a single column', () => {
    const { columns, freqBins } = computeSpectrogram(sine(300, 0.05), SPEC);
    expect(columns).toHaveLength(1);
    expect(columns[0]).toHaveLength(freqBins);
  });

  it('computes column slices that match the whole run', () => {
    const samples = chirp(20000, 0.03, 0.15);
    const whole = computeSpectrogram(samples, SPEC).columns;
    const head = computeSpectrogramColumns(samples, SPEC, 0, 5);
    const tail = computeSpectrogramColumns(samples, SPEC, 5, 5);
    expect(Array.from(head[0]!)).toEqual(Array.from(whole[0]!));
    expect(Array.from(tail[0]!)).toEqual(Array.from(whole[5]!));
    // Asking past the end returns nothing rather than throwing.
    expect(computeSpectrogramColumns(samples, SPEC, whole.length, 10)).toEqual([]);
  });

  it('rejects bad settings and empty audio', () => {
    const samples = sine(4096, 0.1);
    expect(() =>
      computeSpectrogram(samples, { fftSize: 1000 as unknown as 1024, hop: 256 }),
    ).toThrow(/power of two/);
    expect(() => computeSpectrogram(samples, { fftSize: 1024, hop: 0 })).toThrow(ToolError);
    expect(() => computeSpectrogram(samples, { fftSize: 1024, hop: 2.5 })).toThrow(/hop/);
    expect(() =>
      computeSpectrogram(samples, { fftSize: 1024, hop: 256, maxColumns: 0 }),
    ).toThrow(/maxColumns/);
    expect(() => computeSpectrogram(new Float32Array(0), SPEC)).toThrow(/no audio samples/);
    expect(() => computeSpectrogramColumns(samples, SPEC, -1, 4)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* computeWaveformPeaks                                                */
/* ------------------------------------------------------------------ */

describe('audio-spectrogram: computeWaveformPeaks', () => {
  it('splits a known ramp into per bucket minima and maxima', () => {
    const ramp = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const { min, max } = computeWaveformPeaks(ramp, 4);
    expect(Array.from(min)).toEqual([0, 2, 4, 6]);
    expect(Array.from(max)).toEqual([1, 3, 5, 7]);
  });

  it('keeps a single sample spike instead of averaging it away', () => {
    const samples = new Float32Array(1000);
    samples[500] = 0.9;
    samples[501] = -0.8;
    const { min, max } = computeWaveformPeaks(samples, 10);
    expect(max[5]).toBeCloseTo(0.9, 5);
    expect(min[5]).toBeCloseTo(-0.8, 5);
    expect(max[0]).toBe(0);
    expect(min[0]).toBe(0);
  });

  it('handles one bucket and more buckets than samples', () => {
    const samples = Float32Array.from([-0.5, 0.25, 1]);
    const single = computeWaveformPeaks(samples, 1);
    expect(single.min[0]).toBeCloseTo(-0.5, 6);
    expect(single.max[0]).toBe(1);

    const wide = computeWaveformPeaks(samples, 6);
    expect(wide.min).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(Number.isFinite(wide.min[i]!)).toBe(true);
      expect(Number.isFinite(wide.max[i]!)).toBe(true);
    }
  });

  it('rejects empty audio and bad bucket counts', () => {
    expect(() => computeWaveformPeaks(new Float32Array(0), 4)).toThrow(ToolError);
    expect(() => computeWaveformPeaks(Float32Array.from([1]), 0)).toThrow(/bucket count/);
    expect(() => computeWaveformPeaks(Float32Array.from([1]), 2.5)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* dbToColor                                                           */
/* ------------------------------------------------------------------ */

describe('audio-spectrogram: dbToColor', () => {
  it('ramps gray monotonically from black to white', () => {
    let last = -1;
    for (let db = -100; db <= 0; db += 2) {
      const [r, g, b] = dbToColor(db, 'gray');
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(dbToColor(-100, 'gray')).toEqual([0, 0, 0]);
    expect(dbToColor(0, 'gray')).toEqual([255, 255, 255]);
  });

  it('matches the first and last table stops at the endpoints', () => {
    expect(dbToColor(-100, 'viridis')).toEqual(VIRIDIS_STOPS[0]);
    expect(dbToColor(0, 'viridis')).toEqual(VIRIDIS_STOPS[15]);
    expect(dbToColor(-100, 'magma')).toEqual(MAGMA_STOPS[0]);
    expect(dbToColor(0, 'magma')).toEqual(MAGMA_STOPS[15]);
  });

  it('lands on an exact stop when the level falls on one', () => {
    // Stop 5 of 16 sits at t = 5/15, which is -100 + 100 * 5/15 dB.
    expect(dbToColor(-100 + (100 * 5) / 15, 'viridis')).toEqual(VIRIDIS_STOPS[5]);
    expect(dbToColor(-100 + (100 * 12) / 15, 'magma')).toEqual(MAGMA_STOPS[12]);
  });

  it('interpolates between stops', () => {
    const mid = dbToColor(-100 + (100 * 0.5) / 15, 'viridis');
    const a = VIRIDIS_STOPS[0]!;
    const b = VIRIDIS_STOPS[1]!;
    expect(mid[0]).toBe(Math.round((a[0] + b[0]) / 2));
    expect(mid[1]).toBe(Math.round((a[1] + b[1]) / 2));
    expect(mid[2]).toBe(Math.round((a[2] + b[2]) / 2));
  });

  it('clamps levels outside the -100 to 0 dB range', () => {
    expect(dbToColor(-500, 'gray')).toEqual([0, 0, 0]);
    expect(dbToColor(20, 'gray')).toEqual([255, 255, 255]);
    expect(dbToColor(Number.NaN, 'viridis')).toEqual(VIRIDIS_STOPS[0]);
  });

  it('rejects an unknown scheme', () => {
    expect(() => dbToColor(-20, 'plasma' as ColorScheme)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* labels                                                              */
/* ------------------------------------------------------------------ */

describe('audio-spectrogram: secondsToLabel', () => {
  it('formats minutes and seconds', () => {
    expect(secondsToLabel(83)).toBe('1:23');
    expect(secondsToLabel(0)).toBe('0:00');
    expect(secondsToLabel(9)).toBe('0:09');
    expect(secondsToLabel(59.9)).toBe('0:59');
    expect(secondsToLabel(600)).toBe('10:00');
  });

  it('adds an hour field past 3600 seconds', () => {
    expect(secondsToLabel(3600)).toBe('1:00:00');
    expect(secondsToLabel(3661)).toBe('1:01:01');
  });

  it('keeps fractions when asked and never rounds up into the next second', () => {
    expect(secondsToLabel(83.25, 1)).toBe('1:23.3');
    expect(secondsToLabel(9.99, 1)).toBe('0:09.0');
    expect(secondsToLabel(1.5, 2)).toBe('0:01.50');
  });

  it('treats negatives and non numbers as zero', () => {
    expect(secondsToLabel(-5)).toBe('0:00');
    expect(secondsToLabel(Number.NaN)).toBe('0:00');
  });
});

describe('audio-spectrogram: freqToLabel', () => {
  it('uses Hz below a kilohertz and kHz above', () => {
    expect(freqToLabel(440)).toBe('440 Hz');
    expect(freqToLabel(0)).toBe('0 Hz');
    expect(freqToLabel(20)).toBe('20 Hz');
    expect(freqToLabel(999)).toBe('999 Hz');
    expect(freqToLabel(4400)).toBe('4.4 kHz');
    expect(freqToLabel(1000)).toBe('1 kHz');
    expect(freqToLabel(10000)).toBe('10 kHz');
    expect(freqToLabel(22050)).toBe('22.1 kHz');
  });

  it('treats negatives and non numbers as zero', () => {
    expect(freqToLabel(-100)).toBe('0 Hz');
    expect(freqToLabel(Number.POSITIVE_INFINITY)).toBe('0 Hz');
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe('audio-spectrogram: run', () => {
  it('reports the analysis settings for a dropped file', () => {
    const rows = run(new Uint8Array(2048), OPTS);
    expect(rows['FFT size']).toContain('2048 samples per frame');
    expect(rows['FFT size']).toContain('hop 512');
    expect(rows['Frequency resolution']).toContain('1024 bins');
    expect(rows['Color scheme']).toBe('viridis');
    expect(rows['Frequency axis']).toContain('linear');
    expect(rows.Waveform).toBe('shown above the spectrogram');
    expect(rows.File).toBe('2.0 KB of audio data');
  });

  it('follows the log scale and hidden waveform options', () => {
    const rows = run(new Uint8Array(10), {
      ...OPTS,
      fftSize: '4096',
      colors: 'magma',
      scale: 'log',
      showWaveform: false,
    });
    expect(rows['Frequency axis']).toContain('logarithmic');
    expect(rows.Waveform).toBe('hidden');
    expect(rows['Color scheme']).toBe('magma');
    expect(rows['Frequency resolution']).toContain('2048 bins');
  });

  it('falls back to 2048 when the FFT size is nonsense', () => {
    const rows = run(new Uint8Array(10), { ...OPTS, fftSize: 'huge' });
    expect(rows['FFT size']).toContain('2048 samples per frame');
  });

  it('rejects empty input', () => {
    expect(() => run(new Uint8Array(0), OPTS)).toThrow(ToolError);
    expect(() => run(new Uint8Array(0), OPTS)).toThrow(/No audio was provided/);
  });

  it('rejects text input', () => {
    expect(() => run('not audio', OPTS)).toThrow(ToolError);
    expect(() => run('not audio', OPTS)).toThrow(/audio bytes/);
  });
});
