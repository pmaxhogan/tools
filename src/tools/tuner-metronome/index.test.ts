import { describe, expect, it } from "vitest";
import {
  TIME_SIGNATURES,
  TUNINGS,
  bpmFromTaps,
  centsBetween,
  clickSchedule,
  describeTempo,
  detectPitch,
  frequencyToNote,
  getTimeSignature,
  getTuning,
  nearestString,
  noteToFrequency,
  renderClickSamples,
  rms,
  run,
  tuningAdvice,
} from "./index";
import { ToolError } from "../types";

/** Build a mono sine block, optionally with extra harmonics. */
function sine(hz: number, sampleRate: number, count: number, amplitude = 0.8): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

describe("detectPitch", () => {
  it("finds 440 Hz in a 2048 sample block at 44100", () => {
    const result = detectPitch(sine(440, 44100, 2048), 44100);
    expect(result.frequency).not.toBeNull();
    expect(result.frequency!).toBeGreaterThan(439.5);
    expect(result.frequency!).toBeLessThan(440.5);
    expect(result.clarity).toBeGreaterThan(0.9);
  });

  it("finds a low E2 in a 4096 sample block", () => {
    const result = detectPitch(sine(82.41, 44100, 4096), 44100);
    expect(result.frequency).not.toBeNull();
    expect(Math.abs(result.frequency! - 82.41)).toBeLessThan(0.3);
    expect(result.clarity).toBeGreaterThan(0.9);
  });

  it("returns null for silence", () => {
    const result = detectPitch(new Float32Array(2048), 44100);
    expect(result.frequency).toBeNull();
    expect(result.clarity).toBe(0);
  });

  it("returns null for a block that is only very quiet noise", () => {
    const noise = new Float32Array(2048);
    for (let i = 0; i < noise.length; i++) noise[i] = (i % 7) * 1e-6;
    expect(detectPitch(noise, 44100).frequency).toBeNull();
  });

  it("tracks the fundamental of a harmonic rich tone, not the octave", () => {
    const count = 2048;
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const t = i / 44100;
      samples[i] = 0.6 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 440 * t);
    }
    const result = detectPitch(samples, 44100);
    expect(result.frequency).not.toBeNull();
    expect(Math.abs(result.frequency! - 220)).toBeLessThan(1);
  });

  it("rejects a bad sample rate", () => {
    expect(() => detectPitch(sine(440, 44100, 2048), 0)).toThrowError(ToolError);
  });
});

describe("rms", () => {
  it("measures a full scale sine at about 0.707", () => {
    expect(rms(sine(440, 44100, 4410, 1))).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it("is 0 for silence and for an empty block", () => {
    expect(rms(new Float32Array(64))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe("notes and cents", () => {
  it("reads 442 Hz as A4 about 7.85 cents sharp", () => {
    const note = frequencyToNote(442);
    expect(note.name).toBe("A");
    expect(note.octave).toBe(4);
    expect(note.midi).toBe(69);
    expect(note.cents).toBeCloseTo(7.85, 2);
    expect(note.targetHz).toBeCloseTo(440, 6);
  });

  it("round trips note names through frequencies", () => {
    expect(noteToFrequency("A4")).toBeCloseTo(440, 9);
    expect(noteToFrequency("E2")).toBeCloseTo(82.4069, 3);
    expect(noteToFrequency("C#3")).toBeCloseTo(noteToFrequency("Db3"), 9);
    const note = frequencyToNote(noteToFrequency("G3"));
    expect(`${note.name}${note.octave}`).toBe("G3");
  });

  it("follows a shifted A4 reference", () => {
    expect(noteToFrequency("A4", 415)).toBeCloseTo(415, 9);
    const shifted = frequencyToNote(440, 415);
    expect(`${shifted.name}${shifted.octave}`).toBe("A#4");
    expect(shifted.cents).toBeCloseTo(1200 * Math.log2(440 / 415) - 100, 6);
  });

  it("measures cents between two frequencies", () => {
    expect(centsBetween(880, 440)).toBeCloseTo(1200, 9);
    expect(centsBetween(440, 440)).toBe(0);
  });

  it("rejects nonsense note names and frequencies", () => {
    expect(() => noteToFrequency("H9")).toThrowError(ToolError);
    expect(() => frequencyToNote(0)).toThrowError(ToolError);
    expect(() => centsBetween(440, 0)).toThrowError(ToolError);
  });
});

describe("tunings", () => {
  it("ships every instrument the panel offers", () => {
    const ids = TUNINGS.map((t) => t.id);
    expect(ids).toContain("chromatic");
    expect(ids).toContain("guitar-standard");
    expect(ids).toContain("guitar-drop-d");
    expect(ids).toContain("bass-4");
    expect(ids).toContain("ukulele");
    expect(ids).toContain("violin");
    expect(ids).toContain("cello");
    expect(ids).toContain("mandolin");
    expect(ids).toContain("banjo-open-g");
    expect(ids).toContain("guitar-7-string");
    expect(getTuning("guitar-standard").strings.map((s) => s.note)).toEqual([
      "E2",
      "A2",
      "D3",
      "G3",
      "B3",
      "E4",
    ]);
  });

  it("matches 83 Hz to the low E string, 12 cents sharp", () => {
    const match = nearestString(83, "guitar-standard");
    expect(match.note).toBe("E2");
    expect(match.index).toBe(0);
    expect(Math.round(match.cents)).toBe(12);
    expect(match.advice).toBe("Slightly sharp");
  });

  it("snaps to the nearest note in chromatic mode", () => {
    const match = nearestString(261.63, "chromatic");
    expect(match.note).toBe("C4");
    expect(Math.abs(match.cents)).toBeLessThan(1);
  });

  it("rejects an unknown tuning id", () => {
    expect(() => getTuning("theremin")).toThrowError(ToolError);
    expect(() => nearestString(440, "theremin")).toThrowError(/not a tuning/);
  });

  it("gives directional advice", () => {
    expect(tuningAdvice(0)).toBe("In tune");
    expect(tuningAdvice(-4)).toBe("In tune");
    expect(tuningAdvice(-10)).toBe("Slightly flat");
    expect(tuningAdvice(30)).toBe("Sharp: loosen the string");
    expect(tuningAdvice(-30)).toBe("Flat: tighten the string");
    expect(tuningAdvice(200)).toMatch(/semitone/);
  });
});

describe("metronome scheduling", () => {
  it("places 120 bpm 4/4 beats half a second apart", () => {
    const events = clickSchedule(120, 4, 1, 0, 4);
    expect(events.map((e) => e.time)).toEqual([0, 0.5, 1, 1.5]);
    expect(events.map((e) => e.beat)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.isDownbeat)).toEqual([true, false, false, false]);
    expect(events.every((e) => e.isSubdivision === false)).toBe(true);
  });

  it("offsets from the audio clock and wraps to the next bar", () => {
    const events = clickSchedule(60, 3, 1, 10, 4);
    expect(events.map((e) => e.time)).toEqual([10, 11, 12, 13]);
    expect(events.map((e) => e.beat)).toEqual([1, 2, 3, 1]);
    expect(events[3]!.isDownbeat).toBe(true);
  });

  it("interleaves subdivisions between the beats", () => {
    const events = clickSchedule(120, 4, 2, 0, 4);
    expect(events.map((e) => e.time)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(events.map((e) => e.isSubdivision)).toEqual([false, true, false, true]);
    expect(events.map((e) => e.beat)).toEqual([1, 1, 2, 2]);
  });

  it("rejects out of range arguments", () => {
    expect(() => clickSchedule(5, 4, 1, 0, 4)).toThrowError(ToolError);
    expect(() => clickSchedule(120, 0, 1, 0, 4)).toThrowError(ToolError);
    expect(() => clickSchedule(120, 4, 0, 0, 4)).toThrowError(ToolError);
    expect(() => clickSchedule(120, 4, 1, -1, 4)).toThrowError(ToolError);
    expect(() => clickSchedule(120, 4, 1, 0, 99999)).toThrowError(ToolError);
  });

  it("knows the time signatures the panel offers", () => {
    expect(TIME_SIGNATURES.map((t) => t.id)).toEqual(["4/4", "3/4", "2/4", "6/8", "5/4", "7/8"]);
    expect(getTimeSignature("6/8").beatsPerBar).toBe(6);
    expect(getTimeSignature("6/8").beatUnit).toBe(8);
    expect(() => getTimeSignature("9/16")).toThrowError(ToolError);
  });
});

describe("tap tempo", () => {
  it("averages evenly spaced taps", () => {
    expect(bpmFromTaps([0, 500, 1000, 1500])!).toBeCloseTo(120, 6);
  });

  it("trims a single late tap", () => {
    const bpm = bpmFromTaps([0, 500, 1000, 1500, 2000, 2500, 3400, 3900])!;
    expect(bpm).toBeCloseTo(120, 3);
  });

  it("ignores gaps outside the tempo range", () => {
    expect(bpmFromTaps([0, 60000, 60500, 61000])!).toBeCloseTo(120, 6);
    expect(bpmFromTaps([0, 60000])).toBeNull();
  });

  it("needs at least two taps", () => {
    expect(bpmFromTaps([])).toBeNull();
    expect(bpmFromTaps([1000])).toBeNull();
  });
});

describe("describeTempo", () => {
  it("calls 120 bpm Allegro", () => {
    const tempo = describeTempo(120);
    expect(tempo.marking).toBe("Allegro");
    expect(tempo.range).toBe("120 to 168 bpm");
  });

  it("covers the slow and the fast ends", () => {
    expect(describeTempo(50).marking).toBe("Largo");
    expect(describeTempo(90).marking).toBe("Andante");
    expect(describeTempo(112).marking).toBe("Moderato");
    expect(describeTempo(300).marking).toBe("Prestissimo");
    expect(describeTempo(300).range).toBe("200 bpm and above");
  });

  it("rejects a tempo of zero", () => {
    expect(() => describeTempo(0)).toThrowError(ToolError);
  });
});

describe("renderClickSamples", () => {
  it("renders the requested length and decays to silence", () => {
    const samples = renderClickSamples(44100, { durationMs: 40 });
    expect(samples.length).toBe(Math.round((44100 * 40) / 1000));
    expect(samples[0]).toBe(0);
    const head = Math.max(...Array.from(samples.slice(0, 200), Math.abs));
    const tail = Math.max(...Array.from(samples.slice(-200), Math.abs));
    expect(head).toBeGreaterThan(0.1);
    expect(tail).toBeLessThan(head / 10);
  });

  it("makes the accent louder than the plain click", () => {
    const plain = Math.max(...Array.from(renderClickSamples(44100), Math.abs));
    const accent = Math.max(...Array.from(renderClickSamples(44100, { accent: true }), Math.abs));
    expect(accent).toBeGreaterThan(plain);
    expect(accent).toBeLessThanOrEqual(1);
  });

  it("rejects impossible click settings", () => {
    expect(() => renderClickSamples(0)).toThrowError(ToolError);
    expect(() => renderClickSamples(44100, { durationMs: 0 })).toThrowError(ToolError);
    expect(() => renderClickSamples(44100, { frequency: 1 })).toThrowError(ToolError);
  });
});

describe("run", () => {
  const base = { a4: 440, tuning: "guitar-standard", timeSignature: "4/4" };

  it("explains the panel when the input is empty", () => {
    const out = run("", base);
    expect(out.Tuner).toMatch(/microphone/);
    expect(out.Metronome).toMatch(/audio clock/);
    expect(out["A4 reference"]).toBe("440 Hz");
    expect(out.Tuning).toMatch(/E2 A2 D3 G3 B3 E4/);
  });

  it("reads a typed frequency as a note", () => {
    const out = run("440.5", base);
    expect(out.Frequency).toBe("440.5 Hz");
    expect(out["Nearest note"]).toMatch(/^A4 at 440 Hz$/);
    expect(out["Cents off"]).toBe("+1.97 cents");
    expect(out["MIDI note"]).toBe("69");
  });

  it("matches a typed frequency to the nearest guitar string", () => {
    const out = run("83", base);
    expect(out["Nearest string"]).toMatch(/6th \(low E\), E2/);
    expect(out["Tuning check"]).toBe("Slightly sharp");
  });

  it("reads a note name", () => {
    const out = run("E2", base);
    expect(out.Frequency).toBe("82.407 Hz");
    expect(out["Tuning check"]).toBe("In tune");
  });

  it("reads a tempo and describes it", () => {
    const out = run("120 bpm", base);
    expect(out.Tempo).toBe("120 bpm");
    expect(out.Marking).toBe("Allegro (120 to 168 bpm)");
    expect(out["Milliseconds per beat"]).toBe("500 ms");
    expect(out["Seconds per bar"]).toBe("2 s");
  });

  it("uses the selected time signature for bar math", () => {
    const out = run("120 bpm", { ...base, timeSignature: "3/4" });
    expect(out["Time signature"]).toMatch(/3 beats per bar/);
    expect(out["Seconds per bar"]).toBe("1.5 s");
  });

  it("respects a shifted A4 reference", () => {
    const out = run("415", { ...base, a4: 415 });
    expect(out["Nearest note"]).toMatch(/^A4 /);
    expect(out["Cents off"]).toBe("0.00 cents");
  });

  it("rejects input that is neither a frequency nor a tempo", () => {
    expect(() => run("banana", base)).toThrowError(ToolError);
    try {
      run("banana", base);
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-input");
      expect((error as ToolError).fix).toMatch(/120 bpm/);
    }
  });

  it("rejects out of range frequencies and tempos", () => {
    expect(() => run("99999", base)).toThrowError(/outside/);
    expect(() => run("900 bpm", base)).toThrowError(/outside/);
  });

  it("rejects bad options", () => {
    expect(() => run("440", { ...base, a4: 100 })).toThrowError(ToolError);
    expect(() => run("440", { ...base, tuning: "sitar" })).toThrowError(ToolError);
    expect(() => run("440", { ...base, timeSignature: "11/16" })).toThrowError(ToolError);
    try {
      run("440", { ...base, a4: 500 });
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-option");
    }
  });
});
