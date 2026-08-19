import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  describeSignal,
  encodeWav,
  frequencyToNote,
  noteToFrequency,
  parseFrequency,
  renderSamples,
  run,
  sweepFrequencyAt,
} from "./index";

describe("noteToFrequency", () => {
  it("converts A4 to 440 Hz", () => {
    expect(noteToFrequency("A4")).toBeCloseTo(440, 2);
  });

  it("converts C4 (middle C) to 261.63 Hz", () => {
    expect(noteToFrequency("C4")).toBeCloseTo(261.63, 1);
  });

  it("converts A3 to 220 Hz", () => {
    expect(noteToFrequency("A3")).toBeCloseTo(220, 2);
  });

  it("treats C#3 and Db3 as the same pitch", () => {
    expect(noteToFrequency("C#3")).toBeCloseTo(noteToFrequency("Db3"), 6);
  });

  it("is case insensitive", () => {
    expect(noteToFrequency("a4")).toBeCloseTo(440, 2);
  });

  it("throws bad-frequency for an unrecognized note token", () => {
    expect(() => noteToFrequency("H4")).toThrow(ToolError);
    try {
      noteToFrequency("H4");
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-frequency");
    }
  });

  it("throws bad-frequency for a note outside the 1 to 24000 Hz range", () => {
    expect(() => noteToFrequency("C-10")).toThrow(ToolError);
  });
});

describe("frequencyToNote", () => {
  it("finds A4 with +8 cents for 442 Hz", () => {
    const result = frequencyToNote(442);
    expect(result.note).toBe("A4");
    expect(result.cents).toBe(8);
  });

  it("finds the exact note with 0 cents for 440 Hz", () => {
    const result = frequencyToNote(440);
    expect(result.note).toBe("A4");
    expect(result.cents).toBe(0);
  });

  it("throws bad-frequency for a non-positive frequency", () => {
    expect(() => frequencyToNote(0)).toThrow(ToolError);
  });
});

describe("parseFrequency", () => {
  it("parses a plain number", () => {
    expect(parseFrequency("440")).toBe(440);
  });

  it("parses a number with an hz suffix", () => {
    expect(parseFrequency("440hz")).toBe(440);
  });

  it("parses a number with a khz suffix", () => {
    expect(parseFrequency("1khz")).toBe(1000);
  });

  it("parses a note name", () => {
    expect(parseFrequency("A4")).toBeCloseTo(440, 2);
  });

  it("throws bad-frequency for empty input", () => {
    expect(() => parseFrequency("")).toThrow(ToolError);
  });

  it("throws bad-frequency for garbage input", () => {
    expect(() => parseFrequency("not a frequency")).toThrow(ToolError);
  });
});

describe("sweepFrequencyAt", () => {
  it("starts at f0 and ends at f1 for a linear sweep", () => {
    expect(sweepFrequencyAt(0, 5, 100, 1000, "linear")).toBeCloseTo(100, 6);
    expect(sweepFrequencyAt(5, 5, 100, 1000, "linear")).toBeCloseTo(1000, 6);
  });

  it("starts at f0 and ends at f1 for a log sweep", () => {
    expect(sweepFrequencyAt(0, 5, 100, 1000, "log")).toBeCloseTo(100, 6);
    expect(sweepFrequencyAt(5, 5, 100, 1000, "log")).toBeCloseTo(1000, 6);
  });

  it("hits the geometric mean at the midpoint of a log sweep", () => {
    const mid = sweepFrequencyAt(2.5, 5, 100, 1000, "log");
    expect(mid).toBeCloseTo(Math.sqrt(100 * 1000), 4);
  });

  it("hits the arithmetic mean at the midpoint of a linear sweep", () => {
    const mid = sweepFrequencyAt(2.5, 5, 100, 1000, "linear");
    expect(mid).toBeCloseTo((100 + 1000) / 2, 6);
  });

  it("throws bad-option for a non-positive duration", () => {
    expect(() => sweepFrequencyAt(0, 0, 100, 1000, "linear")).toThrow(ToolError);
  });

  it("throws bad-frequency for a log sweep starting at 0 Hz", () => {
    expect(() => sweepFrequencyAt(0, 5, 0, 1000, "log")).toThrow(ToolError);
  });
});

describe("describeSignal", () => {
  it("describes a plain tone", () => {
    const result = describeSignal({ kind: "sine", frequency: 440, duration: 3 });
    expect(result.Frequency).toBe("440 Hz");
    expect(result.Note).toContain("A4");
    expect(result["Wavelength in air"]).toContain("m");
    expect(result.Period).toBeTruthy();
    expect(result["Hearing note"]).toContain("normal range");
    expect(result["Volume warning"]).toBeTruthy();
  });

  it("flags a subwoofer range tone", () => {
    const result = describeSignal({ kind: "sine", frequency: 40, duration: 3 });
    expect(result["Hearing note"]).toContain("subwoofer");
  });

  it("flags an infrasound tone", () => {
    const result = describeSignal({ kind: "sine", frequency: 10, duration: 3 });
    expect(result["Hearing note"]).toContain("infrasound");
  });

  it("flags a tone above typical adult hearing", () => {
    const result = describeSignal({ kind: "sine", frequency: 18000, duration: 3 });
    expect(result["Hearing note"]).toContain("cannot hear");
  });

  it("describes noise without a single frequency", () => {
    const result = describeSignal({ kind: "white-noise", frequency: 440, duration: 3 });
    expect(result.Note).toContain("no single pitch");
  });

  it("describes a sweep by its range", () => {
    const result = describeSignal({
      kind: "sweep",
      frequency: 20,
      f1: 20000,
      sweepKind: "log",
      duration: 5,
    });
    expect(result.Frequency).toContain("20 Hz");
    expect(result.Frequency).toContain("20 kHz");
  });
});

describe("renderSamples", () => {
  it("renders a sine wave with peak amplitude close to the requested amplitude", () => {
    const samples = renderSamples({
      kind: "sine",
      frequency: 440,
      duration: 0.05,
      sampleRate: 44100,
      amplitude: 1,
    });
    const max = Math.max(...samples);
    expect(max).toBeGreaterThan(0.99);
    expect(max).toBeLessThanOrEqual(1);
  });

  it("renders a square wave whose samples are always plus or minus the amplitude", () => {
    const amplitude = 0.5;
    const samples = renderSamples({
      kind: "square",
      frequency: 440,
      duration: 0.01,
      sampleRate: 44100,
      amplitude,
    });
    for (const s of samples) {
      expect(Math.abs(s)).toBeCloseTo(amplitude, 6);
    }
  });

  it("produces the expected sample count", () => {
    const samples = renderSamples({
      kind: "sine",
      frequency: 440,
      duration: 1,
      sampleRate: 44100,
      amplitude: 1,
    });
    expect(samples.length).toBe(44100);
  });

  it("renders deterministic white noise for the same seed", () => {
    const a = renderSamples({
      kind: "white-noise",
      frequency: 0,
      duration: 0.01,
      sampleRate: 44100,
      amplitude: 1,
      seed: "test-seed",
    });
    const b = renderSamples({
      kind: "white-noise",
      frequency: 0,
      duration: 0.01,
      sampleRate: 44100,
      amplitude: 1,
      seed: "test-seed",
    });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("renders deterministic pink noise for the same seed", () => {
    const a = renderSamples({
      kind: "pink-noise",
      frequency: 0,
      duration: 0.01,
      sampleRate: 44100,
      amplitude: 1,
      seed: "another-seed",
    });
    const b = renderSamples({
      kind: "pink-noise",
      frequency: 0,
      duration: 0.01,
      sampleRate: 44100,
      amplitude: 1,
      seed: "another-seed",
    });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("renders a sweep that starts near f0 and ends near f1 in frequency content sign", () => {
    const samples = renderSamples({
      kind: "sweep",
      frequency: 100,
      f1: 1000,
      sweepKind: "log",
      duration: 1,
      sampleRate: 44100,
      amplitude: 1,
    });
    expect(samples.length).toBe(44100);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-1);
  });

  it("throws bad-option for a non-positive duration", () => {
    expect(() =>
      renderSamples({ kind: "sine", frequency: 440, duration: 0, sampleRate: 44100, amplitude: 1 }),
    ).toThrow(ToolError);
  });

  it("throws bad-option for amplitude out of range", () => {
    expect(() =>
      renderSamples({
        kind: "sine",
        frequency: 440,
        duration: 1,
        sampleRate: 44100,
        amplitude: 1.5,
      }),
    ).toThrow(ToolError);
  });
});

describe("encodeWav", () => {
  it("writes a valid RIFF/WAVE header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWav(samples, 44100);
    const text = (start: number, len: number) =>
      String.fromCharCode(...wav.slice(start, start + len));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(12, 4)).toBe("fmt ");
    expect(text(36, 4)).toBe("data");
  });

  it("reports the correct fmt chunk size and data length", () => {
    const samples = new Float32Array(10);
    const wav = encodeWav(samples, 44100);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint32(40, true)).toBe(20); // data size: 10 samples * 2 bytes
  });

  it("produces 44 + samples * 2 bytes total for a 1 second 44100 Hz render", () => {
    const samples = renderSamples({
      kind: "sine",
      frequency: 440,
      duration: 1,
      sampleRate: 44100,
      amplitude: 1,
    });
    const wav = encodeWav(samples, 44100);
    expect(wav.length).toBe(44 + 44100 * 2);
  });

  it("throws bad-option for an invalid sample rate", () => {
    expect(() => encodeWav(new Float32Array(1), 0)).toThrow(ToolError);
  });
});

describe("run", () => {
  it("defaults to 440 Hz sine when input is empty", () => {
    const result = run("", { wave: "sine", duration: 3, volume: 50, endFrequency: 20000, sweepKind: "log" });
    expect(result.Frequency).toBe("440 Hz");
    expect(result.Playback).toBeTruthy();
    expect(result.WAV).toBeTruthy();
  });

  it("accepts a note name as input", () => {
    const result = run("A4", { wave: "sine", duration: 3, volume: 50, endFrequency: 20000, sweepKind: "log" });
    expect(result.Frequency).toBe("440 Hz");
  });

  it("describes a sweep using the input as the start frequency", () => {
    const result = run("20", {
      wave: "sweep",
      duration: 5,
      volume: 50,
      endFrequency: 20000,
      sweepKind: "log",
    });
    expect(result.Frequency).toContain("20 Hz");
    expect(result.Frequency).toContain("20 kHz");
  });

  it("throws bad-frequency for an out of range input", () => {
    expect(() =>
      run("30000", { wave: "sine", duration: 3, volume: 50, endFrequency: 20000, sweepKind: "log" }),
    ).toThrow(ToolError);
  });

  it("throws bad-option for an unknown waveform", () => {
    expect(() =>
      run("440", { wave: "hexagon", duration: 3, volume: 50, endFrequency: 20000, sweepKind: "log" }),
    ).toThrow(ToolError);
  });

  it("throws bad-option for a duration out of range", () => {
    expect(() =>
      run("440", { wave: "sine", duration: 100, volume: 50, endFrequency: 20000, sweepKind: "log" }),
    ).toThrow(ToolError);
  });

  it("throws bad-option for a volume out of range", () => {
    expect(() =>
      run("440", { wave: "sine", duration: 3, volume: 150, endFrequency: 20000, sweepKind: "log" }),
    ).toThrow(ToolError);
  });

  it("throws bad-option for an unknown sweep kind", () => {
    expect(() =>
      run("440", {
        wave: "sweep",
        duration: 3,
        volume: 50,
        endFrequency: 20000,
        sweepKind: "triangle",
      }),
    ).toThrow(ToolError);
  });

  it("throws bad-frequency for an out of range end frequency", () => {
    expect(() =>
      run("440", {
        wave: "sweep",
        duration: 3,
        volume: 50,
        endFrequency: 30000,
        sweepKind: "log",
      }),
    ).toThrow(ToolError);
  });
});
