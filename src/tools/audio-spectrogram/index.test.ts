import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  DB_FLOOR,
  LOG_MIN_HZ,
  MAGMA_STOPS,
  VIRIDIS_STOPS,
  binIndexAt,
  buildColorLut,
  columnIndexAt,
  computeRowBins,
  computeSpectrogram,
  computeSpectrogramColumns,
  computeWaveformPeaks,
  dbToColor,
  describeSampleRate,
  fft,
  fractionAtFreq,
  freqAtFraction,
  freqAxis,
  freqTicks,
  freqToLabel,
  hannWindow,
  isPowerOfTwo,
  paintSpectrogram,
  pickTimeStep,
  planSpectrogram,
  run,
  secondsToLabel,
  sniffAudioFormat,
  sniffSampleRate,
  timeTicks,
  type ColorScheme,
  type FreqAxis,
  type SpectrogramOptions,
} from "./index";

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

const OPTS = { fftSize: "2048", colors: "viridis", scale: "linear", showWaveform: true };

/* ------------------------------------------------------------------ */
/* fft                                                                 */
/* ------------------------------------------------------------------ */

describe("audio-spectrogram: fft", () => {
  it("transforms a length 8 impulse into a flat spectrum", () => {
    // The DFT of delta[n] is 1 in every bin, real, with no imaginary part.
    const re = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const im = new Float32Array(8);
    fft(re, im);
    for (let k = 0; k < 8; k++) {
      expect(re[k]).toBeCloseTo(1, 6);
      expect(im[k]).toBeCloseTo(0, 6);
    }
  });

  it("transforms a length 8 constant into 8 at bin 0 and nothing else", () => {
    const re = new Float32Array(8).fill(1);
    const im = new Float32Array(8);
    fft(re, im);
    expect(re[0]).toBeCloseTo(8, 5);
    expect(im[0]).toBeCloseTo(0, 5);
    for (let k = 1; k < 8; k++) {
      expect(Math.hypot(re[k]!, im[k]!)).toBeLessThan(1e-5);
    }
  });

  it("transforms a length 8 cosine at bin 1 into 4 at bins 1 and 7", () => {
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

  it("puts a DC signal in bin 0 only", () => {
    const n = 1024;
    const re = new Float32Array(n).fill(1);
    const im = new Float32Array(n);
    fft(re, im);
    const mags = magnitudes(re, im);
    expect(mags[0]).toBeCloseTo(n, 2);
    const others = Math.max(...mags.slice(1));
    expect(others / mags[0]!).toBeLessThan(1e-3);
  });

  it("peaks exactly at bin k for a pure sine at bin k of a 1024 point FFT", () => {
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

  it("conserves energy (Parseval) within 1e-3 relative error", () => {
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

  it("is its own consistency check: two sines add linearly", () => {
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

  it("rejects mismatched buffers and non power of two lengths", () => {
    expect(() => fft(new Float32Array(8), new Float32Array(4))).toThrow(ToolError);
    expect(() => fft(new Float32Array(12), new Float32Array(12))).toThrow(/power of two/);
    expect(() => fft(new Float32Array(0), new Float32Array(0))).toThrow(ToolError);
  });

  it("leaves a single sample untouched", () => {
    const re = new Float32Array([0.5]);
    const im = new Float32Array([0]);
    fft(re, im);
    expect(re[0]).toBe(0.5);
    expect(im[0]).toBe(0);
  });
});

describe("audio-spectrogram: isPowerOfTwo", () => {
  it("accepts powers of two and rejects everything else", () => {
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

describe("audio-spectrogram: hannWindow", () => {
  it("is zero at both ends and one in the middle", () => {
    const w = hannWindow(9);
    expect(w[0]).toBe(0);
    expect(w[8]).toBe(0);
    expect(w[4]).toBeCloseTo(1, 6);
  });

  it("is symmetric and stays inside 0 to 1", () => {
    const w = hannWindow(1024);
    expect(w).toHaveLength(1024);
    for (let i = 0; i < 1024; i++) {
      expect(w[i]!).toBeGreaterThanOrEqual(0);
      expect(w[i]!).toBeLessThanOrEqual(1);
      expect(w[i]).toBeCloseTo(w[1023 - i]!, 6);
    }
  });

  it("caches by length and hands back the same array", () => {
    expect(hannWindow(2048)).toBe(hannWindow(2048));
  });

  it("rejects lengths below two points", () => {
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

describe("audio-spectrogram: computeSpectrogram", () => {
  it("tracks a rising sweep with a rising peak bin", () => {
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

  it("floors silence at exactly -100 dB", () => {
    const { columns } = computeSpectrogram(new Float32Array(8192), SPEC);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      for (const value of column) expect(value).toBe(DB_FLOOR);
    }
    expect(DB_FLOOR).toBe(-100);
  });

  it("reads a full scale sine at about 0 dB in the bin it sits in", () => {
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

  it("max-pools long clips down to maxColumns", () => {
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

  it("zero pads a clip shorter than one frame into a single column", () => {
    const { columns, freqBins } = computeSpectrogram(sine(300, 0.05), SPEC);
    expect(columns).toHaveLength(1);
    expect(columns[0]).toHaveLength(freqBins);
  });

  it("computes column slices that match the whole run", () => {
    const samples = chirp(20000, 0.03, 0.15);
    const whole = computeSpectrogram(samples, SPEC).columns;
    const head = computeSpectrogramColumns(samples, SPEC, 0, 5);
    const tail = computeSpectrogramColumns(samples, SPEC, 5, 5);
    expect(Array.from(head[0]!)).toEqual(Array.from(whole[0]!));
    expect(Array.from(tail[0]!)).toEqual(Array.from(whole[5]!));
    // Asking past the end returns nothing rather than throwing.
    expect(computeSpectrogramColumns(samples, SPEC, whole.length, 10)).toEqual([]);
  });

  it("rejects bad settings and empty audio", () => {
    const samples = sine(4096, 0.1);
    expect(() =>
      computeSpectrogram(samples, { fftSize: 1000 as unknown as 1024, hop: 256 }),
    ).toThrow(/power of two/);
    expect(() => computeSpectrogram(samples, { fftSize: 1024, hop: 0 })).toThrow(ToolError);
    expect(() => computeSpectrogram(samples, { fftSize: 1024, hop: 2.5 })).toThrow(/hop/);
    expect(() => computeSpectrogram(samples, { fftSize: 1024, hop: 256, maxColumns: 0 })).toThrow(
      /maxColumns/,
    );
    expect(() => computeSpectrogram(new Float32Array(0), SPEC)).toThrow(/no audio samples/);
    expect(() => computeSpectrogramColumns(samples, SPEC, -1, 4)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* computeWaveformPeaks                                                */
/* ------------------------------------------------------------------ */

describe("audio-spectrogram: computeWaveformPeaks", () => {
  it("splits a known ramp into per bucket minima and maxima", () => {
    const ramp = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const { min, max } = computeWaveformPeaks(ramp, 4);
    expect(Array.from(min)).toEqual([0, 2, 4, 6]);
    expect(Array.from(max)).toEqual([1, 3, 5, 7]);
  });

  it("keeps a single sample spike instead of averaging it away", () => {
    const samples = new Float32Array(1000);
    samples[500] = 0.9;
    samples[501] = -0.8;
    const { min, max } = computeWaveformPeaks(samples, 10);
    expect(max[5]).toBeCloseTo(0.9, 5);
    expect(min[5]).toBeCloseTo(-0.8, 5);
    expect(max[0]).toBe(0);
    expect(min[0]).toBe(0);
  });

  it("handles one bucket and more buckets than samples", () => {
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

  it("rejects empty audio and bad bucket counts", () => {
    expect(() => computeWaveformPeaks(new Float32Array(0), 4)).toThrow(ToolError);
    expect(() => computeWaveformPeaks(Float32Array.from([1]), 0)).toThrow(/bucket count/);
    expect(() => computeWaveformPeaks(Float32Array.from([1]), 2.5)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* dbToColor                                                           */
/* ------------------------------------------------------------------ */

describe("audio-spectrogram: dbToColor", () => {
  it("ramps gray monotonically from black to white", () => {
    let last = -1;
    for (let db = -100; db <= 0; db += 2) {
      const [r, g, b] = dbToColor(db, "gray");
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(dbToColor(-100, "gray")).toEqual([0, 0, 0]);
    expect(dbToColor(0, "gray")).toEqual([255, 255, 255]);
  });

  it("matches the first and last table stops at the endpoints", () => {
    expect(dbToColor(-100, "viridis")).toEqual(VIRIDIS_STOPS[0]);
    expect(dbToColor(0, "viridis")).toEqual(VIRIDIS_STOPS[15]);
    expect(dbToColor(-100, "magma")).toEqual(MAGMA_STOPS[0]);
    expect(dbToColor(0, "magma")).toEqual(MAGMA_STOPS[15]);
  });

  it("lands on an exact stop when the level falls on one", () => {
    // Stop 5 of 16 sits at t = 5/15, which is -100 + 100 * 5/15 dB.
    expect(dbToColor(-100 + (100 * 5) / 15, "viridis")).toEqual(VIRIDIS_STOPS[5]);
    expect(dbToColor(-100 + (100 * 12) / 15, "magma")).toEqual(MAGMA_STOPS[12]);
  });

  it("interpolates between stops", () => {
    const mid = dbToColor(-100 + (100 * 0.5) / 15, "viridis");
    const a = VIRIDIS_STOPS[0]!;
    const b = VIRIDIS_STOPS[1]!;
    expect(mid[0]).toBe(Math.round((a[0] + b[0]) / 2));
    expect(mid[1]).toBe(Math.round((a[1] + b[1]) / 2));
    expect(mid[2]).toBe(Math.round((a[2] + b[2]) / 2));
  });

  it("clamps levels outside the -100 to 0 dB range", () => {
    expect(dbToColor(-500, "gray")).toEqual([0, 0, 0]);
    expect(dbToColor(20, "gray")).toEqual([255, 255, 255]);
    expect(dbToColor(Number.NaN, "viridis")).toEqual(VIRIDIS_STOPS[0]);
  });

  it("rejects an unknown scheme", () => {
    expect(() => dbToColor(-20, "plasma" as ColorScheme)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* frequency axis                                                      */
/* ------------------------------------------------------------------ */

describe("audio-spectrogram: freqAxis", () => {
  it("tops the axis out at Nyquist", () => {
    expect(freqAxis(48000, "linear").nyquist).toBe(24000);
    expect(freqAxis(8000, "log").nyquist).toBe(4000);
  });

  it("starts a log axis at 20 Hz, or lower when Nyquist is low", () => {
    expect(LOG_MIN_HZ).toBe(20);
    expect(freqAxis(48000, "log").bottom).toBe(20);
    expect(freqAxis(8000, "log").bottom).toBe(20);
    // A 100 Hz recording has a 50 Hz Nyquist, so the quarter Nyquist cap wins
    // and the axis still spans two octaves instead of one and a bit.
    expect(freqAxis(100, "log").bottom).toBe(12.5);
  });

  it("starts a linear axis at DC", () => {
    expect(freqAxis(48000, "linear").bottom).toBe(0);
  });
});

describe("audio-spectrogram: freqAtFraction and fractionAtFreq", () => {
  const linear = freqAxis(48000, "linear");
  const log = freqAxis(48000, "log");

  it("reads Nyquist at the top edge and the axis bottom at the bottom", () => {
    expect(freqAtFraction(linear, 0)).toBe(24000);
    expect(freqAtFraction(linear, 1)).toBe(0);
    expect(freqAtFraction(log, 0)).toBeCloseTo(24000, 6);
    expect(freqAtFraction(log, 1)).toBeCloseTo(20, 9);
  });

  it("halves linearly, and takes the geometric mean on a log axis", () => {
    expect(freqAtFraction(linear, 0.5)).toBe(12000);
    // Half way up a log axis is the geometric mean of its two ends, which for
    // 20 Hz to 24 kHz is about 693 Hz rather than 12 kHz.
    expect(freqAtFraction(log, 0.5)).toBeCloseTo(Math.sqrt(20 * 24000), 6);
    expect(freqAtFraction(log, 0.5)).toBeCloseTo(692.82, 2);
  });

  it("gives every octave the same height on a log axis, and does not on a linear one", () => {
    expect(fractionAtFreq(log, 200) - fractionAtFreq(log, 100)).toBeCloseTo(
      fractionAtFreq(log, 800) - fractionAtFreq(log, 400),
      12,
    );
    expect(fractionAtFreq(linear, 200) - fractionAtFreq(linear, 100)).not.toBeCloseTo(
      fractionAtFreq(linear, 800) - fractionAtFreq(linear, 400),
      12,
    );
  });

  it("round trips a frequency through its fraction and back", () => {
    for (const hz of [20, 100, 440, 1000, 12000, 24000]) {
      expect(freqAtFraction(log, fractionAtFreq(log, hz))).toBeCloseTo(hz, 6);
    }
    for (const hz of [0, 440, 12000, 24000]) {
      expect(freqAtFraction(linear, fractionAtFreq(linear, hz))).toBeCloseTo(hz, 6);
    }
  });

  it("clamps at both ends rather than running off the plot", () => {
    expect(freqAtFraction(linear, -1)).toBe(24000);
    expect(freqAtFraction(linear, 2)).toBe(0);
    expect(freqAtFraction(log, -1)).toBeCloseTo(24000, 6);
    expect(freqAtFraction(log, 2)).toBeCloseTo(20, 9);
    expect(fractionAtFreq(linear, -100)).toBe(1);
    expect(fractionAtFreq(linear, 1e9)).toBe(0);
    // Nothing below the log floor has a position, so the floor is the answer.
    expect(fractionAtFreq(log, 0)).toBe(1);
    expect(fractionAtFreq(log, 1e9)).toBe(0);
  });
});

describe("audio-spectrogram: columnIndexAt and binIndexAt", () => {
  const axis = freqAxis(48000, "linear");

  it("spreads the columns across the plot and clamps at both ends", () => {
    expect(columnIndexAt(0, 10)).toBe(0);
    expect(columnIndexAt(0.55, 10)).toBe(5);
    expect(columnIndexAt(0.999, 10)).toBe(9);
    // The right edge is one past the last column, so it reads the last one.
    expect(columnIndexAt(1, 10)).toBe(9);
    expect(columnIndexAt(-0.5, 10)).toBe(0);
  });

  it("maps a frequency onto the bin that holds it", () => {
    // Bin k of a 1024 bin analysis covers k * nyquist / 1024 hertz.
    expect(binIndexAt(axis, (64 * 24000) / 1024, 1024)).toBe(64);
    expect(binIndexAt(axis, 0, 1024)).toBe(0);
    expect(binIndexAt(axis, 24000, 1024)).toBe(1023);
    expect(binIndexAt(axis, 1e9, 1024)).toBe(1023);
    // A frequency below the axis clamps onto the first bin instead of indexing
    // off the front of the array. It rounds to a signed zero on the way, which
    // reads the same slot.
    expect(binIndexAt(axis, -5, 1024)).toBeCloseTo(0, 10);
  });

  it("finds the bin a known tone actually landed in", () => {
    // The same tone as the spectrogram test above: 64 cycles per 1024 samples,
    // which at 48 kHz is 3 kHz. The readout has to name the bin the transform
    // put the peak in, or hovering a bright line reports the wrong level.
    const { columns, freqBins } = computeSpectrogram(sine(8192, 64 / 1024), SPEC);
    const hz = (64 / 1024) * 48000;
    expect(hz).toBe(3000);
    expect(binIndexAt(axis, hz, freqBins)).toBe(argmax(columns[0]!));
  });
});

/* ------------------------------------------------------------------ */
/* axis ticks                                                          */
/* ------------------------------------------------------------------ */

describe("audio-spectrogram: freqTicks", () => {
  it("labels a linear axis on round steps up to Nyquist", () => {
    expect(freqTicks(freqAxis(48000, "linear"), 320)).toEqual([0, 5000, 10000, 15000, 20000]);
    expect(freqTicks(freqAxis(8000, "linear"), 320)).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it("never labels a frequency the file cannot contain", () => {
    for (const rate of [8000, 11025, 16000, 44100, 48000, 96000]) {
      for (const scale of ["linear", "log"] as const) {
        const axis = freqAxis(rate, scale);
        for (const hz of freqTicks(axis, 320)) expect(hz).toBeLessThanOrEqual(axis.nyquist);
      }
    }
  });

  it("keeps at least three labels on a very short plot", () => {
    // The tick budget floors at 3, so a squeezed axis still says what it is.
    expect(freqTicks(freqAxis(48000, "linear"), 20).length).toBeGreaterThanOrEqual(3);
  });

  it("thins a crowded log axis from the top down", () => {
    const axis = freqAxis(48000, "log");
    const ticks = freqTicks(axis, 320);
    expect(ticks).toEqual([20000, 10000, 5000, 3000, 1000, 500, 300, 100, 50, 30]);

    // Descending, because the walk starts at Nyquist and works downward.
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!).toBeLessThan(ticks[i - 1]!);
    // Every label that survived has a line of room under the one above it.
    const ys = ticks.map((hz) => fractionAtFreq(axis, hz) * 320);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(22);
    // 2000 is dropped because 3000 sits 18 pixels above it, while 1000 and the
    // other decade marks survive: on a log axis the gaps grow going down.
    expect(ticks).toContain(3000);
    expect(ticks).not.toContain(2000);
    expect(ticks).toContain(1000);
  });

  it("keeps more of the ladder when the axis spans fewer decades", () => {
    // 4 kHz of Nyquist is a third of the decades of a 48 kHz file, so labels
    // that collided there have room here: both 2000 and 200 survive.
    const ticks = freqTicks(freqAxis(8000, "log"), 320);
    expect(ticks).toEqual([3000, 2000, 1000, 500, 300, 200, 100, 50, 30, 20]);
  });
});

describe("audio-spectrogram: timeTicks", () => {
  it("picks the finest step that fits the tick budget", () => {
    expect(pickTimeStep(10, 5)).toBe(2);
    expect(pickTimeStep(10, 10)).toBe(1);
    expect(pickTimeStep(600, 3)).toBe(300);
    // Past the end of the ladder the coarsest step is all there is.
    expect(pickTimeStep(1e9, 3)).toBe(600);
  });

  it("walks a ten second clip in two second steps", () => {
    const ticks = timeTicks(10, 5);
    expect(ticks.step).toBe(2);
    expect(ticks.decimals).toBe(0);
    expect(ticks.times).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("keeps one decimal once the step drops below a second", () => {
    const ticks = timeTicks(2, 5);
    expect(ticks.step).toBe(0.5);
    expect(ticks.decimals).toBe(1);
    expect(ticks.times).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it("always reaches the end of the clip without passing it", () => {
    for (const duration of [0.3, 0.45, 1, 2.5, 7, 63, 125, 599, 600]) {
      const { times, step } = timeTicks(duration, 6);
      const last = times[times.length - 1]!;
      expect(times[0]).toBe(0);
      expect(duration - last).toBeLessThan(step);
      expect(last).toBeLessThanOrEqual(duration + 1e-6);
    }
  });

  it("draws no axis for a clip with no length", () => {
    expect(timeTicks(0, 5).times).toEqual([]);
    // A non finite duration would otherwise walk the loop forever.
    expect(timeTicks(Number.POSITIVE_INFINITY, 5).times).toEqual([]);
    expect(timeTicks(Number.NaN, 5).times).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* bitmap                                                              */
/* ------------------------------------------------------------------ */

describe("audio-spectrogram: buildColorLut", () => {
  it("holds 256 stops of flat r, g, b bytes", () => {
    expect(buildColorLut("viridis")).toHaveLength(768);
  });

  it("ramps gray straight from 0 to 255", () => {
    // The ramp covers DB_FLOOR to 0 dB in 256 even steps and the gray map is
    // the identity on that fraction, so entry i is exactly i.
    const lut = buildColorLut("gray");
    for (let i = 0; i < 256; i++) {
      expect(lut[i * 3]).toBe(i);
      expect(lut[i * 3 + 1]).toBe(i);
      expect(lut[i * 3 + 2]).toBe(i);
    }
  });

  it("agrees with dbToColor at both ends and on a table stop", () => {
    const lut = buildColorLut("viridis");
    expect([lut[0], lut[1], lut[2]]).toEqual(VIRIDIS_STOPS[0]);
    expect([lut[765], lut[766], lut[767]]).toEqual(VIRIDIS_STOPS[15]);
    // Entry 85 of 255 is a third of the way up, which is table stop 5 of 15.
    expect([lut[255], lut[256], lut[257]]).toEqual(VIRIDIS_STOPS[5]);

    const magma = buildColorLut("magma");
    expect([magma[0], magma[1], magma[2]]).toEqual(MAGMA_STOPS[0]);
    expect([magma[765], magma[766], magma[767]]).toEqual(MAGMA_STOPS[15]);
  });

  it("rejects a scheme it does not know", () => {
    expect(() => buildColorLut("plasma" as ColorScheme)).toThrow(ToolError);
  });
});

describe("audio-spectrogram: computeRowBins", () => {
  it("gives each row one bin when the plot is as tall as the bin count", () => {
    // Row 0 is the top of the plot and holds the highest bin: the picture runs
    // low frequency at the bottom, the way every spectrogram is read.
    const { lo, hi } = computeRowBins(freqAxis(48000, "linear"), 4, 4);
    expect(Array.from(lo)).toEqual([3, 2, 1, 0]);
    expect(Array.from(hi)).toEqual([4, 3, 2, 1]);
  });

  it("folds several bins into a row when the plot is shorter than the analysis", () => {
    const { lo, hi } = computeRowBins(freqAxis(48000, "linear"), 2, 4);
    expect(Array.from(lo)).toEqual([2, 0]);
    expect(Array.from(hi)).toEqual([4, 2]);
  });

  it("covers every bin on a linear axis", () => {
    const bins = 512;
    const { lo, hi } = computeRowBins(freqAxis(48000, "linear"), bins, bins);
    const seen = new Set<number>();
    for (let y = 0; y < bins; y++) for (let k = lo[y]!; k < hi[y]!; k++) seen.add(k);
    expect(seen.size).toBe(bins);
  });

  it("crowds the top of a log axis and never leaves a row empty", () => {
    const bins = 512;
    const height = 320;
    const { lo, hi } = computeRowBins(freqAxis(48000, "log"), height, bins);
    for (let y = 0; y < height; y++) {
      expect(hi[y]!).toBeGreaterThan(lo[y]!);
      expect(lo[y]!).toBeGreaterThanOrEqual(0);
      expect(hi[y]!).toBeLessThanOrEqual(bins);
      // Frequency falls as the row index grows, so the bins do too.
      if (y > 0) expect(lo[y]!).toBeLessThanOrEqual(lo[y - 1]!);
    }
    // The top row of a log plot stacks bins together while the bottom row is
    // narrower than a single bin; a linear plot spreads them evenly instead.
    expect(hi[0]! - lo[0]!).toBeGreaterThan(5 * (hi[height - 1]! - lo[height - 1]!));
    expect(hi[height - 1]! - lo[height - 1]!).toBe(1);
    const flat = computeRowBins(freqAxis(48000, "linear"), height, bins);
    const first = flat.hi[0]! - flat.lo[0]!;
    const last = flat.hi[height - 1]! - flat.lo[height - 1]!;
    expect(Math.abs(first - last)).toBeLessThanOrEqual(1);
  });

  it("rejects a plot with no pixels in it", () => {
    expect(() => computeRowBins(freqAxis(48000, "linear"), 0, 512)).toThrow(ToolError);
    expect(() => computeRowBins(freqAxis(48000, "linear"), 320, 0)).toThrow(ToolError);
    expect(() => computeRowBins(freqAxis(48000, "linear"), 2.5, 512)).toThrow(/whole number/);
  });
});

describe("audio-spectrogram: paintSpectrogram", () => {
  const gray = buildColorLut("gray");

  /** Paint into a fresh buffer with the gray ramp, where level maps to level. */
  function paint(
    columns: Float32Array[],
    width: number,
    height: number,
    axis: FreqAxis = freqAxis(4, "linear"),
  ): Uint8ClampedArray {
    const target = new Uint8ClampedArray(width * height * 4);
    paintSpectrogram(
      { columns, freqBins: columns[0]!.length, width, height, axis, lut: gray },
      target,
    );
    return target;
  }

  /** The RGBA of one pixel. */
  function pixel(target: Uint8ClampedArray, width: number, x: number, y: number): number[] {
    const at = (y * width + x) * 4;
    return [target[at]!, target[at + 1]!, target[at + 2]!, target[at + 3]!];
  }

  it("puts time across and frequency up, with low frequencies at the bottom", () => {
    // Two bins over a 4 Hz rate: bin 0 is DC to 1 Hz, bin 1 is 1 Hz to 2 Hz.
    // The first column is loud in bin 0, the second in bin 1.
    const columns = [Float32Array.from([0, DB_FLOOR]), Float32Array.from([DB_FLOOR, 0])];
    const target = paint(columns, 2, 2);
    expect(pixel(target, 2, 0, 1)).toEqual([255, 255, 255, 255]);
    expect(pixel(target, 2, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(target, 2, 1, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(target, 2, 1, 1)).toEqual([0, 0, 0, 255]);
  });

  it("takes the loudest column in a pixel, not the average or the last one", () => {
    // Four columns into two pixels. Each pixel covers one loud column and one
    // silent one, and the loud one is first in the left pixel and last in the
    // right, so neither averaging (which would paint -70 dB, gray 77) nor
    // simply keeping the last column can pass this.
    const columns = [
      Float32Array.from([-40]),
      Float32Array.from([DB_FLOOR]),
      Float32Array.from([DB_FLOOR]),
      Float32Array.from([-20]),
    ];
    const target = paint(columns, 2, 1, freqAxis(2, "linear"));
    expect(pixel(target, 2, 0, 0)).toEqual([153, 153, 153, 255]);
    expect(pixel(target, 2, 1, 0)).toEqual([204, 204, 204, 255]);
  });

  it("takes the loudest bin in a row rather than the average", () => {
    // One row over four bins, only one of which is loud: a thin line has to
    // survive the squeeze instead of being averaged down to nothing.
    const columns = [Float32Array.from([DB_FLOOR, DB_FLOOR, -10, DB_FLOOR])];
    const target = paint(columns, 1, 1, freqAxis(8, "linear"));
    expect(pixel(target, 1, 0, 0)).toEqual([230, 230, 230, 255]);
  });

  it("repeats a column when the plot is wider than the clip is long", () => {
    const target = paint([Float32Array.from([-50])], 3, 1, freqAxis(2, "linear"));
    for (let x = 0; x < 3; x++) expect(pixel(target, 3, x, 0)).toEqual([128, 128, 128, 255]);
  });

  it("clamps levels outside the ramp instead of wrapping them", () => {
    const columns = [Float32Array.from([-500, 20])];
    const target = paint(columns, 1, 2);
    expect(pixel(target, 1, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(target, 1, 0, 1)).toEqual([0, 0, 0, 255]);
  });

  it("spreads a low tone over more rows on a log axis than on a linear one", () => {
    const column = new Float32Array(512).fill(DB_FLOOR);
    // Bin 1 of a 512 bin analysis at 48 kHz is about 47 to 94 Hz.
    column[1] = -10;
    const height = 64;
    const litRows = (axis: FreqAxis) => {
      const target = paint([column], 1, height, axis);
      let count = 0;
      for (let y = 0; y < height; y++) if (pixel(target, 1, 0, y)[0]! > 0) count += 1;
      return count;
    };
    const linear = litRows(freqAxis(48000, "linear"));
    const log = litRows(freqAxis(48000, "log"));
    expect(linear).toBeGreaterThanOrEqual(1);
    expect(log).toBeGreaterThan(linear);
  });

  it("rejects a buffer, a bin count, or a size that does not match", () => {
    const columns = [Float32Array.from([0, DB_FLOOR])];
    const axis = freqAxis(4, "linear");
    const good = { columns, freqBins: 2, width: 2, height: 2, axis, lut: gray };
    expect(() => paintSpectrogram(good, new Uint8ClampedArray(4))).toThrow(/buffer holds/);
    expect(() => paintSpectrogram({ ...good, width: 0 }, new Uint8ClampedArray(0))).toThrow(
      ToolError,
    );
    expect(() => paintSpectrogram({ ...good, freqBins: 4 }, new Uint8ClampedArray(16))).toThrow(
      /bins were declared/,
    );
    expect(() => paintSpectrogram({ ...good, columns: [] }, new Uint8ClampedArray(16))).toThrow(
      /no spectrogram columns/,
    );
    expect(() =>
      paintSpectrogram({ ...good, lut: new Uint8Array(3) }, new Uint8ClampedArray(16)),
    ).toThrow(/color ramp/);
  });

  it("paints a real analysis with the peak brighter than the noise floor", () => {
    const { columns, freqBins } = computeSpectrogram(sine(8192, 64 / 1024), SPEC);
    const axis = freqAxis(48000, "linear");
    const width = 8;
    const height = freqBins;
    const target = new Uint8ClampedArray(width * height * 4);
    paintSpectrogram({ columns, freqBins, width, height, axis, lut: gray }, target);

    // One row per bin, so the tone's row is the mirror of its bin index.
    const toneRow = height - 1 - 64;
    expect(pixel(target, width, 0, toneRow)[0]).toBeGreaterThan(250);
    expect(pixel(target, width, 0, toneRow - 20)[0]).toBeLessThan(60);
    // Alpha is opaque everywhere, or the canvas would show through.
    for (let i = 3; i < target.length; i += 4) expect(target[i]).toBe(255);
  });
});

/* ------------------------------------------------------------------ */
/* labels                                                              */
/* ------------------------------------------------------------------ */

describe("audio-spectrogram: secondsToLabel", () => {
  it("formats minutes and seconds", () => {
    expect(secondsToLabel(83)).toBe("1:23");
    expect(secondsToLabel(0)).toBe("0:00");
    expect(secondsToLabel(9)).toBe("0:09");
    expect(secondsToLabel(59.9)).toBe("0:59");
    expect(secondsToLabel(600)).toBe("10:00");
  });

  it("adds an hour field past 3600 seconds", () => {
    expect(secondsToLabel(3600)).toBe("1:00:00");
    expect(secondsToLabel(3661)).toBe("1:01:01");
  });

  it("keeps fractions when asked and never rounds up into the next second", () => {
    expect(secondsToLabel(83.25, 1)).toBe("1:23.3");
    expect(secondsToLabel(9.99, 1)).toBe("0:09.0");
    expect(secondsToLabel(1.5, 2)).toBe("0:01.50");
  });

  it("treats negatives and non numbers as zero", () => {
    expect(secondsToLabel(-5)).toBe("0:00");
    expect(secondsToLabel(Number.NaN)).toBe("0:00");
  });
});

describe("audio-spectrogram: freqToLabel", () => {
  it("uses Hz below a kilohertz and kHz above", () => {
    expect(freqToLabel(440)).toBe("440 Hz");
    expect(freqToLabel(0)).toBe("0 Hz");
    expect(freqToLabel(20)).toBe("20 Hz");
    expect(freqToLabel(999)).toBe("999 Hz");
    expect(freqToLabel(4400)).toBe("4.4 kHz");
    expect(freqToLabel(1000)).toBe("1 kHz");
    expect(freqToLabel(10000)).toBe("10 kHz");
    expect(freqToLabel(22050)).toBe("22.1 kHz");
  });

  it("treats negatives and non numbers as zero", () => {
    expect(freqToLabel(-100)).toBe("0 Hz");
    expect(freqToLabel(Number.POSITIVE_INFINITY)).toBe("0 Hz");
  });
});

describe("audio-spectrogram: describeSampleRate", () => {
  it("prints one number when the header and the decoder agree", () => {
    const text = describeSampleRate(44100, 44100);
    expect(text).toMatch(/^44.?100 Hz$/);
    expect(text).not.toContain("resampled");
  });

  it("prints both numbers when the browser resampled the file", () => {
    const text = describeSampleRate(8000, 48000);
    expect(text).toMatch(/^8.?000 Hz source/);
    expect(text).toContain("decoded at");
    expect(text).toMatch(/48.?000 Hz \(browser resampled\)$/);
  });

  it("claims nothing about the file when the header could not be read", () => {
    const text = describeSampleRate(null, 48000);
    expect(text).toMatch(/^decoded at 48.?000 Hz \(browser resampled\)$/);
    expect(text).not.toContain("source");
  });

  it("treats rates that round to the same hertz as agreeing", () => {
    expect(describeSampleRate(44100.4, 44100)).not.toContain("resampled");
    expect(describeSampleRate(44101, 44100)).toContain("resampled");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("audio-spectrogram: run", () => {
  it("reports the analysis settings for a dropped file", () => {
    const rows = run(new Uint8Array(2048), OPTS);
    expect(rows["FFT size"]).toContain("2048 samples per frame");
    expect(rows["FFT size"]).toContain("hop 512");
    expect(rows["Frequency resolution"]).toContain("1024 bins");
    expect(rows["Color scheme"]).toBe("viridis");
    expect(rows["Frequency axis"]).toContain("linear");
    expect(rows.Waveform).toBe("shown above the spectrogram");
    expect(rows.File).toBe("2.0 KB of audio data");
  });

  it("follows the log scale and hidden waveform options", () => {
    const rows = run(new Uint8Array(10), {
      ...OPTS,
      fftSize: "4096",
      colors: "magma",
      scale: "log",
      showWaveform: false,
    });
    expect(rows["Frequency axis"]).toContain("logarithmic");
    expect(rows.Waveform).toBe("hidden");
    expect(rows["Color scheme"]).toBe("magma");
    expect(rows["Frequency resolution"]).toContain("2048 bins");
  });

  it("falls back to 2048 when the FFT size is nonsense", () => {
    const rows = run(new Uint8Array(10), { ...OPTS, fftSize: "huge" });
    expect(rows["FFT size"]).toContain("2048 samples per frame");
  });

  it("rejects empty input", () => {
    expect(() => run(new Uint8Array(0), OPTS)).toThrow(ToolError);
    expect(() => run(new Uint8Array(0), OPTS)).toThrow(/No audio was provided/);
  });

  it("rejects text input", () => {
    expect(() => run("not audio", OPTS)).toThrow(ToolError);
    expect(() => run("not audio", OPTS)).toThrow(/audio bytes/);
  });
});

/* ------------------------------------------------------------------ */
/* sniffSampleRate                                                     */
/* ------------------------------------------------------------------ */

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function le16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}

function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function be16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function join(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

/** A RIFF or IFF chunk body of `size` bytes, padded to an even boundary. */
function filler(size: number): number[] {
  return new Array(size + (size % 2)).fill(0x5a);
}

function wavFmt(rate: number, channels = 1, bits = 16): number[] {
  return [
    ...ascii("fmt "),
    ...le32(16),
    ...le16(1),
    ...le16(channels),
    ...le32(rate),
    ...le32((rate * channels * bits) / 8),
    ...le16((channels * bits) / 8),
    ...le16(bits),
  ];
}

function wav(...chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  return join(ascii("RIFF"), le32(4 + body.length), ascii("WAVE"), body);
}

function flac(rate: number, blockType = 0, channels = 2, bps = 16): Uint8Array {
  const info: number[] = new Array(34).fill(0);
  info[10] = (rate >> 12) & 0xff;
  info[11] = (rate >> 4) & 0xff;
  // The low nibble of the rate shares this byte with the channel count and the
  // bit depth, so the neighbors are filled in to prove the field really is
  // read as 20 bits rather than as two and a half bytes.
  info[12] = ((rate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bps - 1) >> 4) & 1);
  return join(ascii("fLaC"), [blockType & 0x7f, 0x00, 0x00, 0x22], info);
}

function oggPage(payload: number[], segments = 1): Uint8Array {
  const table: number[] = new Array(segments).fill(0);
  table[segments - 1] = Math.min(255, payload.length);
  return join(
    ascii("OggS"),
    [0x00, 0x02],
    new Array(8).fill(0),
    le32(1),
    le32(0),
    le32(0),
    [segments],
    table,
    payload,
  );
}

function vorbisIdent(rate: number, channels = 2): number[] {
  return [
    0x01,
    ...ascii("vorbis"),
    ...le32(0),
    channels,
    ...le32(rate),
    ...le32(0),
    ...le32(0),
    ...le32(0),
    0xb8,
    0x01,
  ];
}

function aiffComm(extended: number[], frames = 1000): number[] {
  return [...ascii("COMM"), ...be32(18), ...be16(1), ...be32(frames), ...be16(16), ...extended];
}

function aiff(formType: string, ...chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  return join(ascii("FORM"), be32(4 + body.length), ascii(formType), body);
}

function id3(size: number, flags = 0): number[] {
  return [
    ...ascii("ID3"),
    0x04,
    0x00,
    flags,
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ];
}

/**
 * Cut a fixture off at every possible length and check the sniffer never reads
 * out of bounds: below `needed` bytes the rate field is incomplete and the
 * answer must be null, and from there on it must be the real rate.
 */
function expectTruncationSafe(full: Uint8Array, needed: number, rate: number): void {
  for (let n = 0; n <= full.length; n++) {
    expect(sniffSampleRate(full.slice(0, n))).toBe(n < needed ? null : rate);
  }
}

describe("audio-spectrogram: sniffSampleRate, WAV", () => {
  it("reads the rate from a plain 8 kHz mono file", () => {
    expect(sniffSampleRate(wav(wavFmt(8000)))).toBe(8000);
  });

  it("reads 44.1 kHz and 96 kHz too", () => {
    expect(sniffSampleRate(wav(wavFmt(44100, 2)))).toBe(44100);
    expect(sniffSampleRate(wav(wavFmt(96000, 2, 24)))).toBe(96000);
  });

  it("walks past a JUNK chunk instead of assuming fmt sits at offset 12", () => {
    const junk = [...ascii("JUNK"), ...le32(28), ...filler(28)];
    expect(sniffSampleRate(wav(junk, wavFmt(11025)))).toBe(11025);
  });

  it("skips the pad byte after an odd sized chunk", () => {
    const odd = [...ascii("LIST"), ...le32(3), ...filler(3)];
    expect(sniffSampleRate(wav(odd, wavFmt(22050)))).toBe(22050);
  });

  it("walks several chunks, odd and even, before fmt", () => {
    const bext = [...ascii("bext"), ...le32(9), ...filler(9)];
    const junk = [...ascii("JUNK"), ...le32(4), ...filler(4)];
    const cue = [...ascii("cue "), ...le32(1), ...filler(1)];
    expect(sniffSampleRate(wav(bext, junk, cue, wavFmt(48000)))).toBe(48000);
  });

  it("returns null when the fmt chunk never arrives", () => {
    const junk = [...ascii("JUNK"), ...le32(20), ...filler(20)];
    expect(sniffSampleRate(wav(junk))).toBeNull();
  });

  it("returns null for a RIFF file that is not WAVE", () => {
    const avi = join(ascii("RIFF"), le32(100), ascii("AVI "), wavFmt(44100));
    expect(sniffSampleRate(avi)).toBeNull();
  });

  it("stays in bounds for the header truncated at every length", () => {
    // 12 bytes of RIFF header, 8 of chunk header, 4 into fmt, then the 4 byte
    // rate itself, so 28 bytes is the shortest file that can answer.
    expectTruncationSafe(wav(wavFmt(44100)), 28, 44100);
  });

  it("returns null when a chunk size runs past the end of the file", () => {
    const lying = [...ascii("JUNK"), ...le32(0x7fffffff)];
    expect(sniffSampleRate(wav(lying, wavFmt(44100)))).toBeNull();
  });

  it("returns null for a zero sample rate", () => {
    expect(sniffSampleRate(wav(wavFmt(0)))).toBeNull();
  });
});

describe("audio-spectrogram: sniffSampleRate, FLAC", () => {
  it("reads the packed 20 bit rate field", () => {
    expect(sniffSampleRate(flac(44100))).toBe(44100);
    expect(sniffSampleRate(flac(48000))).toBe(48000);
    expect(sniffSampleRate(flac(8000))).toBe(8000);
    expect(sniffSampleRate(flac(192000))).toBe(192000);
  });

  it("ignores the channel and bit depth bits sharing the last byte", () => {
    expect(sniffSampleRate(flac(96000, 0, 8, 32))).toBe(96000);
  });

  it("returns null when the first metadata block is not STREAMINFO", () => {
    expect(sniffSampleRate(flac(44100, 4))).toBeNull();
  });

  it("returns null for a zero rate, which FLAC uses to mean unknown", () => {
    expect(sniffSampleRate(flac(0))).toBeNull();
  });

  it("stays in bounds for the header truncated at every length", () => {
    // The 20 bit rate ends inside byte 20, so 21 bytes is the whole field.
    expectTruncationSafe(flac(44100), 21, 44100);
  });
});

describe("audio-spectrogram: sniffSampleRate, Ogg", () => {
  it("reads the rate from a Vorbis identification header", () => {
    expect(sniffSampleRate(oggPage(vorbisIdent(44100)))).toBe(44100);
    expect(sniffSampleRate(oggPage(vorbisIdent(8000, 1)))).toBe(8000);
  });

  it("honors the segment table length instead of a fixed payload offset", () => {
    expect(sniffSampleRate(oggPage(vorbisIdent(32000), 4))).toBe(32000);
    expect(sniffSampleRate(oggPage(vorbisIdent(32000), 17))).toBe(32000);
  });

  it("returns null for Ogg Opus, which always decodes at 48 kHz anyway", () => {
    const opus = [...ascii("OpusHead"), 1, 2, ...le16(312), ...le32(48000), 0, 0, 0];
    expect(sniffSampleRate(oggPage(opus))).toBeNull();
  });

  it("stays in bounds for the header truncated at every length", () => {
    // 27 bytes of page header, 1 of segment table, then 16 into the payload.
    expectTruncationSafe(oggPage(vorbisIdent(44100)), 44, 44100);
  });
});

describe("audio-spectrogram: sniffSampleRate, AIFF", () => {
  // 44100 Hz as an 80 bit extended float: exponent 0x400e, mantissa 0xac44...
  const EXT_44100 = [0x40, 0x0e, 0xac, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const EXT_8000 = [0x40, 0x0b, 0xfa, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const EXT_96000 = [0x40, 0x0f, 0xbb, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

  it("decodes the 80 bit extended sample rate", () => {
    expect(sniffSampleRate(aiff("AIFF", aiffComm(EXT_44100)))).toBe(44100);
    expect(sniffSampleRate(aiff("AIFF", aiffComm(EXT_8000)))).toBe(8000);
    expect(sniffSampleRate(aiff("AIFF", aiffComm(EXT_96000)))).toBe(96000);
  });

  it("accepts the AIFC form type", () => {
    expect(sniffSampleRate(aiff("AIFC", aiffComm(EXT_44100)))).toBe(44100);
  });

  it("walks big endian chunks, including the odd size pad", () => {
    const name = [...ascii("NAME"), ...be32(5), ...filler(5)];
    const anno = [...ascii("ANNO"), ...be32(12), ...filler(12)];
    expect(sniffSampleRate(aiff("AIFF", name, anno, aiffComm(EXT_8000)))).toBe(8000);
  });

  it("returns null for a zero exponent and for a negative rate", () => {
    const zero = [0x00, 0x00, 0xac, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const negative = [0xc0, 0x0e, 0xac, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    expect(sniffSampleRate(aiff("AIFF", aiffComm(zero)))).toBeNull();
    expect(sniffSampleRate(aiff("AIFF", aiffComm(negative)))).toBeNull();
  });

  it("returns null when there is no COMM chunk", () => {
    const ssnd = [...ascii("SSND"), ...be32(8), ...filler(8)];
    expect(sniffSampleRate(aiff("AIFF", ssnd))).toBeNull();
  });

  it("stays in bounds for the header truncated at every length", () => {
    // 12 bytes of FORM header, 8 of chunk header, 8 of COMM fields, 10 of float.
    expectTruncationSafe(aiff("AIFF", aiffComm(EXT_44100)), 38, 44100);
  });
});

describe("audio-spectrogram: sniffSampleRate, MP3", () => {
  it("reads MPEG 1 layer 3 rates from a bare frame header", () => {
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe(44100);
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xfb, 0x94, 0x00]))).toBe(48000);
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xfb, 0x98, 0x00]))).toBe(32000);
  });

  it("reads MPEG 2 and MPEG 2.5 rates", () => {
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xf3, 0x90, 0x00]))).toBe(22050);
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xe3, 0x90, 0x00]))).toBe(11025);
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xe3, 0x98, 0x00]))).toBe(8000);
  });

  it("skips an ID3v2 tag using its synchsafe length", () => {
    // A synchsafe 200 is 0x01 0x48, which a plain 8 bit read would misjudge.
    const file = join(id3(200), new Array(200).fill(0x00), [0xff, 0xfb, 0x90, 0x00]);
    expect(sniffSampleRate(file)).toBe(44100);
  });

  it("accounts for the ten byte ID3 footer when the flag is set", () => {
    const file = join(id3(16, 0x10), new Array(26).fill(0x00), [0xff, 0xe3, 0x98, 0x00]);
    expect(sniffSampleRate(file)).toBe(8000);
  });

  it("skips reserved version and layer bits and keeps scanning", () => {
    // 0xff 0xea has version bits 01 (reserved) and 0xff 0xf9 has layer bits 00.
    const file = join([0xff, 0xea, 0x90, 0x00], [0xff, 0xf9, 0x90, 0x00], [0xff, 0xfb, 0x94, 0x00]);
    expect(sniffSampleRate(file)).toBe(48000);
  });

  it("rejects the reserved rate index and the invalid bitrate index", () => {
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xfb, 0x9c, 0x00]))).toBeNull();
    expect(sniffSampleRate(Uint8Array.from([0xff, 0xfb, 0xf0, 0x00]))).toBeNull();
  });

  it("returns null when an ID3 tag is followed by no frame at all", () => {
    expect(sniffSampleRate(join(id3(8), new Array(8).fill(0x00)))).toBeNull();
  });
});

describe("audio-spectrogram: sniffSampleRate, unknown containers", () => {
  it("returns null for MP4 and M4A", () => {
    const m4a = join(be32(32), ascii("ftypM4A "), le32(0), ascii("M4A mp42isom"));
    expect(sniffSampleRate(m4a)).toBeNull();
  });

  it("returns null for WebM", () => {
    const webm = join([0x1a, 0x45, 0xdf, 0xa3], new Array(40).fill(0x00));
    expect(sniffSampleRate(webm)).toBeNull();
  });

  it("returns null for junk, for text, and for an empty file", () => {
    expect(sniffSampleRate(new Uint8Array(0))).toBeNull();
    expect(sniffSampleRate(Uint8Array.from(ascii("hello world, not audio")))).toBeNull();
    expect(sniffSampleRate(new Uint8Array(64))).toBeNull();
  });

  it("returns null for pseudo random bytes", () => {
    const random = lcg(20260807);
    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
    // Only a sync in the first two bytes would start an MP3 scan at all.
    bytes[0] = 0x00;
    expect(sniffSampleRate(bytes)).toBeNull();
  });
});

describe("audio-spectrogram: sniffAudioFormat", () => {
  const EXT_44100 = [0x40, 0x0e, 0xac, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

  it("names the containers the rate sniffer also reads", () => {
    expect(sniffAudioFormat(wav(wavFmt(44100)))).toBe("WAV");
    expect(sniffAudioFormat(flac(44100))).toBe("FLAC");
    expect(sniffAudioFormat(oggPage(vorbisIdent(44100)))).toBe("Ogg");
    expect(sniffAudioFormat(aiff("AIFF", aiffComm(EXT_44100)))).toBe("AIFF");
    expect(sniffAudioFormat(aiff("AIFC", aiffComm(EXT_44100)))).toBe("AIFF");
    expect(sniffAudioFormat(join(id3(8), new Array(8).fill(0x00), [0xff, 0xfb, 0x90, 0x00]))).toBe(
      "MP3",
    );
  });

  it("names containers whose sample rate it cannot read, which is the point", () => {
    // A decode failure on one of these is a codec problem, and the message has
    // to say so even though the rate sniffer had nothing to offer.
    const m4a = join(be32(32), ascii("ftypM4A "), le32(0), ascii("M4A mp42isom"));
    expect(sniffSampleRate(m4a)).toBeNull();
    expect(sniffAudioFormat(m4a)).toBe("MP4 or M4A");

    const webm = join([0x1a, 0x45, 0xdf, 0xa3], new Array(40).fill(0x00));
    expect(sniffSampleRate(webm)).toBeNull();
    expect(sniffAudioFormat(webm)).toBe("WebM or Matroska");

    expect(sniffAudioFormat(join(ascii("caff"), new Array(16).fill(0x00)))).toBe("CAF");
    expect(sniffAudioFormat(join(ascii("MThd"), new Array(16).fill(0x00)))).toBe("MIDI");
    expect(sniffAudioFormat(join(ascii("wvpk"), new Array(16).fill(0x00)))).toBe("WavPack");
    expect(sniffAudioFormat(join(ascii("MAC "), new Array(16).fill(0x00)))).toBe("APE");
  });

  it("says nothing for bytes that are not audio", () => {
    expect(sniffAudioFormat(new Uint8Array(0))).toBe("");
    expect(sniffAudioFormat(new Uint8Array(64))).toBe("");
    expect(sniffAudioFormat(Uint8Array.from(ascii("hello world, not audio")))).toBe("");
    // RIFF alone is not enough: an AVI is a RIFF file with no audio container.
    expect(sniffAudioFormat(join(ascii("RIFF"), le32(100), ascii("AVI "), wavFmt(44100)))).toBe("");
  });

  it("wants twelve bytes before it will name anything", () => {
    // Every check reads inside the first twelve bytes, so a shorter file is
    // unidentifiable even when the rate sniffer can still answer.
    const frame = [0xff, 0xfb, 0x90, 0x00];
    expect(sniffSampleRate(Uint8Array.from(frame))).toBe(44100);
    expect(sniffAudioFormat(Uint8Array.from(frame))).toBe("");
    expect(sniffAudioFormat(join(frame, new Array(8).fill(0x00)))).toBe("MP3");
    expect(sniffAudioFormat(wav(wavFmt(44100)).slice(0, 11))).toBe("");
  });
});
