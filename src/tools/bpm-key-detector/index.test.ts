import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  analyzeTrack,
  bpmFromTaps,
  camelotFor,
  camelotNeighbours,
  chromagram,
  describeTempo,
  detectBpm,
  detectKey,
  fft,
  formatKey,
  hannWindow,
  onsetEnvelope,
  openKeyFor,
  parseKey,
  parallelKey,
  pitchClassOfTonic,
  relativeKey,
  run,
  scaleNotes,
} from "./index";

const SAMPLE_RATE = 44100;

/**
 * A metronome click track: a short decaying noise burst on every beat. The
 * noise comes from a fixed seed linear congruential generator so the whole
 * suite is byte for byte deterministic.
 */
function clickTrack(bpm: number, seconds: number, accentEveryOther = false): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  const period = (60 / bpm) * SAMPLE_RATE;
  const burst = Math.round(0.02 * SAMPLE_RATE);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let beat = 0; beat * period < n; beat++) {
    const start = Math.round(beat * period);
    const amplitude = accentEveryOther && beat % 2 === 1 ? 0.35 : 1;
    for (let i = 0; i < burst && start + i < n; i++) {
      out[start + i] = (out[start + i] ?? 0) + noise() * 2 * Math.exp((-i / burst) * 6) * amplitude;
    }
  }
  return out;
}

function midiHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** A chord progression built from pure sines, one chord after another. */
function progression(chords: number[][], chordSeconds: number): Float32Array {
  const perChord = Math.round(chordSeconds * SAMPLE_RATE);
  const fade = Math.round(0.02 * SAMPLE_RATE);
  const out = new Float32Array(perChord * chords.length);
  chords.forEach((chord, index) => {
    const base = index * perChord;
    for (let i = 0; i < perChord; i++) {
      let envelope = 1;
      if (i < fade) envelope = 0.5 * (1 - Math.cos((Math.PI * i) / fade));
      else if (i > perChord - fade)
        envelope = 0.5 * (1 - Math.cos((Math.PI * (perChord - i)) / fade));
      let value = 0;
      for (const note of chord) value += Math.sin((2 * Math.PI * midiHz(note) * i) / SAMPLE_RATE);
      out[base + i] = (value / chord.length) * envelope * 0.8;
    }
  });
  return out;
}

/* C major: C, F, G. A minor: Am, Dm, E. Voiced in the fourth and fifth octaves. */
const C_MAJOR_CHORDS = [
  [60, 64, 67],
  [65, 69, 72],
  [67, 71, 74],
];
const A_MINOR_CHORDS = [
  [69, 72, 76],
  [62, 65, 69],
  [64, 68, 71],
];

describe("fft and windows", () => {
  it("transforms a pure tone into a single pair of bins", () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 8 * i) / n);
    fft(re, im);
    const magnitude = (k: number) => Math.sqrt(re[k]! ** 2 + im[k]! ** 2);
    expect(magnitude(8)).toBeCloseTo(n / 2, 6);
    expect(magnitude(7)).toBeCloseTo(0, 6);
    expect(magnitude(9)).toBeCloseTo(0, 6);
  });

  it("rejects mismatched and non power of two buffers", () => {
    expect(() => fft(new Float64Array(8), new Float64Array(4))).toThrow(ToolError);
    expect(() => fft(new Float64Array(8), new Float64Array(4))).toThrow(/different lengths/);
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/);
  });

  it("builds a symmetric Hann window and rejects a useless length", () => {
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[7]).toBeCloseTo(0, 12);
    expect(w[1]).toBeCloseTo(w[6]!, 12);
    expect(() => hannWindow(1)).toThrow(/at least 2 points/);
  });
});

describe("onsetEnvelope", () => {
  it("peaks once per click", () => {
    const envelope = onsetEnvelope(clickTrack(120, 4), SAMPLE_RATE);
    expect(envelope.rate).toBeCloseTo(SAMPLE_RATE / 512, 6);
    let above = 0;
    let previous = 0;
    let max = 0;
    for (const v of envelope.values) if (v > max) max = v;
    for (const v of envelope.values) {
      if (v > max * 0.5 && previous <= max * 0.5) above++;
      previous = v;
    }
    // Eight beats in four seconds at 120 bpm, and the first frame has no
    // predecessor to be compared against, so seven or eight peaks is right.
    expect(above).toBeGreaterThanOrEqual(7);
    expect(above).toBeLessThanOrEqual(8);
  });

  it("rejects bad framing settings", () => {
    const audio = clickTrack(120, 1);
    expect(() => onsetEnvelope(audio, SAMPLE_RATE, { frameSize: 1000 })).toThrow(/power of two/);
    expect(() => onsetEnvelope(audio, SAMPLE_RATE, { hop: 0 })).toThrow(/whole number between/);
    expect(() => onsetEnvelope(audio, SAMPLE_RATE, { hop: 4096 })).toThrow(/whole number between/);
    expect(() => onsetEnvelope(audio, SAMPLE_RATE, { smoothing: -1 })).toThrow(/zero or greater/);
  });

  it("rejects empty audio and a bad sample rate", () => {
    expect(() => onsetEnvelope(new Float32Array(0), SAMPLE_RATE)).toThrow(/No audio samples/);
    expect(() => onsetEnvelope(clickTrack(120, 1), 0)).toThrow(/positive number/);
  });
});

describe("detectBpm", () => {
  it("finds 120 bpm in a click track", () => {
    const result = detectBpm(clickTrack(120, 10), SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(119.5);
    expect(result.bpm).toBeLessThan(120.5);
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.candidates[0]?.bpm).toBe(result.bpm);
    expect(result.candidates[0]?.score).toBe(1);
  });

  it("finds 93 bpm in a click track", () => {
    const result = detectBpm(clickTrack(93, 10), SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(92.5);
    expect(result.bpm).toBeLessThan(93.5);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("still finds 120 bpm in five seconds", () => {
    expect(detectBpm(clickTrack(120, 5), SAMPLE_RATE).bpm).toBeCloseTo(120, 0);
  });

  it("resolves the octave towards the middle of the range", () => {
    // Every other click is quieter, so the envelope also repeats at 60 bpm.
    // The half tempo shows up as a weaker candidate rather than as the answer.
    const result = detectBpm(clickTrack(120, 10, true), SAMPLE_RATE);
    expect(result.bpm).toBeGreaterThan(119.5);
    expect(result.bpm).toBeLessThan(120.5);
    const half = result.candidates.find((c) => c.bpm < 70);
    expect(half).toBeDefined();
    expect(half!.score).toBeLessThan(0.8);
    // Asked only about slow tempos, the same track reads as its half.
    const slow = detectBpm(clickTrack(120, 10, true), SAMPLE_RATE, { minBpm: 55, maxBpm: 70 });
    expect(slow.bpm).toBeCloseTo(60, 0);
  });

  it("rejects an unusable tempo range", () => {
    const audio = clickTrack(120, 4);
    expect(() => detectBpm(audio, SAMPLE_RATE, { minBpm: 200, maxBpm: 100 })).toThrow(/not usable/);
    expect(() => detectBpm(audio, SAMPLE_RATE, { minBpm: 1, maxBpm: 100 })).toThrow(
      /must sit inside/,
    );
    expect(() => detectBpm(audio, SAMPLE_RATE, { minBpm: 100, maxBpm: 999 })).toThrow(
      /must sit inside/,
    );
  });

  it("says so when the clip is too short to hold two beats", () => {
    expect(() => detectBpm(clickTrack(120, 0.5), SAMPLE_RATE)).toThrow(ToolError);
    expect(() => detectBpm(clickTrack(120, 0.5), SAMPLE_RATE)).toThrow(/seconds of audio/);
  });

  it("says so when there is no beat at all", () => {
    expect(() => detectBpm(new Float32Array(3 * SAMPLE_RATE), SAMPLE_RATE)).toThrow(
      /No repeating beat/,
    );
  });
});

describe("bpmFromTaps", () => {
  it("averages even taps", () => {
    const result = bpmFromTaps([0, 500, 1000, 1500, 2000]);
    expect(result?.bpm).toBe(120);
    expect(result?.taps).toBe(5);
    expect(result?.intervals).toBe(4);
    expect(result?.averageIntervalMs).toBe(500);
    expect(result?.spreadMs).toBe(0);
    expect(result?.confidence).toBe(1);
  });

  it("trims a single late tap instead of following it", () => {
    const result = bpmFromTaps([0, 500, 1000, 3000, 3500, 4000]);
    expect(result?.bpm).toBe(120);
    expect(result?.intervals).toBe(4);
  });

  it("drops jittery taps in confidence but still answers", () => {
    const steady = bpmFromTaps([0, 500, 1000, 1500, 2000])!;
    const sloppy = bpmFromTaps([0, 470, 1010, 1460, 2030])!;
    expect(sloppy.bpm).toBeGreaterThan(115);
    expect(sloppy.bpm).toBeLessThan(125);
    expect(sloppy.confidence).toBeLessThan(steady.confidence);
    expect(sloppy.spreadMs).toBeGreaterThan(0);
  });

  it("only reads the most recent taps", () => {
    const taps = [0, 1000, 2000, 3000, 3500, 4000];
    expect(bpmFromTaps(taps)?.bpm).toBe(60);
    expect(bpmFromTaps(taps, { maxTaps: 4 })?.bpm).toBe(120);
  });

  it("returns null when there is nothing usable", () => {
    expect(bpmFromTaps([])).toBeNull();
    expect(bpmFromTaps([1000])).toBeNull();
    expect(bpmFromTaps([0, 10, 20])).toBeNull();
    expect(bpmFromTaps([Number.NaN, Number.NaN])).toBeNull();
  });

  it("rejects a maxTaps that cannot make an interval", () => {
    expect(() => bpmFromTaps([0, 500], { maxTaps: 1 })).toThrow(/2 or more/);
  });
});

describe("chromagram and detectKey", () => {
  it("hears a C, F, G progression as C major", () => {
    const chroma = chromagram(progression(C_MAJOR_CHORDS, 1.5), SAMPLE_RATE);
    expect(chroma).toHaveLength(12);
    // C and G appear in two of the three chords, so they lead.
    expect(chroma[0]).toBeGreaterThan(0.9);
    expect(chroma[7]).toBeGreaterThan(0.9);
    expect(chroma[1]).toBeLessThan(0.1);

    const key = detectKey(chroma);
    expect(key.key).toBe("C major");
    expect(key.tonic).toBe("C");
    expect(key.mode).toBe("major");
    expect(key.camelot).toBe("8B");
    expect(key.openKey).toBe("1d");
    expect(key.confidence).toBeGreaterThan(0.5);
    expect(key.alternates).toHaveLength(3);
    expect(key.alternates[0]!.score).toBeLessThan(key.score);
  });

  it("hears an Am, Dm, E progression as A minor", () => {
    const key = detectKey(chromagram(progression(A_MINOR_CHORDS, 1.5), SAMPLE_RATE));
    expect(key.key).toBe("A minor");
    expect(key.camelot).toBe("8A");
    expect(key.openKey).toBe("1m");
    expect(key.confidence).toBeGreaterThan(0.5);
  });

  it("rejects silence and a bad frame size", () => {
    expect(() => chromagram(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)).toThrow(/silent/);
    expect(() =>
      chromagram(progression(C_MAJOR_CHORDS, 0.5), SAMPLE_RATE, { frameSize: 3000 }),
    ).toThrow(/power of two/);
    expect(() => chromagram(progression(C_MAJOR_CHORDS, 0.5), SAMPLE_RATE, { hop: 0 })).toThrow(
      /whole number between/,
    );
  });

  it("rejects a chromagram that is not twelve finite values", () => {
    expect(() => detectKey(new Float64Array(11))).toThrow(/has 12 values/);
    const broken = new Float64Array(12);
    broken[3] = Number.NaN;
    expect(() => detectKey(broken)).toThrow(/holds NaN at pitch class 3/);
    expect(() => detectKey(new Float64Array(12).fill(0.4))).toThrow(/equally strong/);
  });
});

describe("analyzeTrack", () => {
  it("returns tempo, key, and chroma together", () => {
    const analysis = analyzeTrack(clickTrack(120, 5), SAMPLE_RATE);
    expect(analysis.tempo.bpm).toBeCloseTo(120, 0);
    expect(analysis.key.key).toMatch(/ (major|minor)$/);
    expect(analysis.chroma).toHaveLength(12);
    expect(analysis.durationSeconds).toBeCloseTo(5, 2);
  });
});

describe("key naming, Camelot, and Open Key", () => {
  it("matches the Camelot wheel", () => {
    expect(camelotFor("C", "major")).toBe("8B");
    expect(camelotFor("A", "minor")).toBe("8A");
    expect(camelotFor("G", "major")).toBe("9B");
    expect(camelotFor("E", "minor")).toBe("9A");
    expect(camelotFor("F", "major")).toBe("7B");
    expect(camelotFor("D", "minor")).toBe("7A");
    expect(camelotFor("B", "major")).toBe("1B");
    expect(camelotFor("G#", "minor")).toBe("1A");
    expect(camelotFor("Ab", "minor")).toBe("1A");
  });

  it("matches the Open Key wheel", () => {
    expect(openKeyFor("C", "major")).toBe("1d");
    expect(openKeyFor("A", "minor")).toBe("1m");
    expect(openKeyFor("G", "major")).toBe("2d");
    expect(openKeyFor("E", "minor")).toBe("2m");
    expect(openKeyFor("F", "major")).toBe("12d");
    expect(openKeyFor("D", "minor")).toBe("12m");
  });

  it("pairs relative and parallel keys", () => {
    expect(relativeKey("C", "major").key).toBe("A minor");
    expect(relativeKey("A", "minor").key).toBe("C major");
    expect(relativeKey("Eb", "major").key).toBe("C minor");
    expect(parallelKey("A", "minor").key).toBe("A major");
    expect(parallelKey("C", "major").key).toBe("C minor");
  });

  it("spells scales with the accidentals of the key signature", () => {
    expect(scaleNotes("E", "major")).toEqual(["E", "F#", "G#", "A", "B", "C#", "D#"]);
    expect(scaleNotes("Eb", "major")).toEqual(["Eb", "F", "G", "Ab", "Bb", "C", "D"]);
    expect(scaleNotes("A", "minor")).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  it("lists the three neighbours on the wheel", () => {
    expect(camelotNeighbours("8A")).toEqual(["7A", "9A", "8B"]);
    expect(camelotNeighbours("1B")).toEqual(["12B", "2B", "1A"]);
    expect(() => camelotNeighbours("nope")).toThrow(/not a Camelot code/);
  });

  it("normalises key spellings", () => {
    expect(formatKey("c#", "minor")).toBe("C# minor");
    expect(formatKey("Db", "minor")).toBe("C# minor");
    expect(formatKey(1, "major")).toBe("Db major");
    expect(pitchClassOfTonic("B#")).toBe(0);
    expect(pitchClassOfTonic("Cb")).toBe(11);
    expect(() => formatKey("C", "dorian")).toThrow(/not a mode/);
    expect(() => pitchClassOfTonic("H")).toThrow(/not a note name/);
  });

  it("parses typed keys and wheel codes", () => {
    expect(parseKey("A minor").key).toBe("A minor");
    expect(parseKey("Am").key).toBe("A minor");
    expect(parseKey("Bbm").key).toBe("Bb minor");
    expect(parseKey("F sharp major").key).toBe("F# major");
    expect(parseKey("E-flat minor").key).toBe("Eb minor");
    expect(parseKey("C").key).toBe("C major");
    expect(parseKey("8A").key).toBe("A minor");
    expect(parseKey("1d").key).toBe("C major");
    expect(parseKey("12m").key).toBe("D minor");
    expect(() => parseKey("")).toThrow(/No key was given/);
    expect(() => parseKey("zzz")).toThrow(/not a key/);
    expect(() => parseKey("C lydian")).toThrow(/not a mode/);
  });
});

describe("describeTempo", () => {
  it("names the usual bands", () => {
    expect(describeTempo(120).marking).toBe("Allegro");
    expect(describeTempo(120).range).toBe("120 to 168 bpm");
    expect(describeTempo(90).marking).toBe("Andante");
    expect(describeTempo(220).marking).toBe("Prestissimo");
    expect(describeTempo(220).range).toBe("200 bpm and above");
    expect(describeTempo(10).range).toBe("under 20 bpm");
  });

  it("rejects a tempo that is not a tempo", () => {
    expect(() => describeTempo(0)).toThrow(/not a tempo/);
    expect(() => describeTempo(Number.NaN)).toThrow(ToolError);
  });
});

describe("run", () => {
  const both = { notation: "both" };

  it("explains the panel when there is no input", () => {
    const out = run("", both);
    expect(out["Analysis"]).toContain("your device");
    expect(out["Camelot"]).toContain("8B");
    expect(out["Open Key"]).toContain("1m");
    expect(out["Privacy"]).toContain("never leave your device");
  });

  it("explains itself when a file is dropped on the generic shell", () => {
    const out = run(new Uint8Array(2048), both);
    expect(out["Status"]).toContain("panel on this page");
    expect(out["File"]).toBe("2.0 KB of audio data");
    expect(out["Camelot"]).toContain("8B");
    expect(run(new Uint8Array(0), both)["Analysis"]).toContain("your device");
  });

  it("reads a list of tap times", () => {
    const out = run("0, 500, 1000, 1500", both);
    expect(out["Tap tempo"]).toBe("120 bpm");
    expect(out["Taps read"]).toBe("4");
    expect(out["Gaps used"]).toBe("3");
    expect(out["Marking"]).toBe("Allegro (120 to 168 bpm)");
    expect(out["Double time"]).toBe("240 bpm");
    expect(run("0 500 1000 1500 2000", both)["Tap tempo"]).toBe("120 bpm");
  });

  it("describes a typed tempo", () => {
    const out = run("128", both);
    expect(out["Tempo"]).toBe("128 bpm");
    expect(out["Marking"]).toBe("Allegro (120 to 168 bpm)");
    expect(out["Beat length"]).toBe("468.75 ms");
    expect(out["Half time"]).toBe("64 bpm");
    expect(out["Double time"]).toBe("256 bpm");
    expect(out["Pitch fader, plus or minus 6 percent"]).toBe("120.32 to 135.68 bpm");
    expect(run("128 bpm", both)["Tempo"]).toBe("128 bpm");
  });

  it("places a typed key on the wheel", () => {
    const out = run("A minor", both);
    expect(out["Key"]).toBe("A minor");
    expect(out["Camelot"]).toBe("8A");
    expect(out["Open Key"]).toBe("1m");
    expect(out["Relative key"]).toBe("C major (8B, 1d)");
    expect(out["Parallel key"]).toBe("A major (11B, 4d)");
    expect(out["Scale notes"]).toBe("A B C D E F G");
    expect(out["Mixes with"]).toContain("D minor (7A, 12m)");
    expect(out["Energy boost"]).toContain("B minor (10A, 3m)");
  });

  it("honours the notation option", () => {
    const camelot = run("A minor", { notation: "camelot" });
    expect(camelot["Camelot"]).toBe("8A");
    expect(camelot["Open Key"]).toBeUndefined();
    expect(camelot["Relative key"]).toBe("C major (8B)");

    const open = run("A minor", { notation: "open-key" });
    expect(open["Open Key"]).toBe("1m");
    expect(open["Camelot"]).toBeUndefined();
    expect(open["Relative key"]).toBe("C major (1d)");

    expect(run("", { notation: "camelot" })["Open Key"]).toBeUndefined();
  });

  it("defaults to both notations when no option is given", () => {
    const out = run("C", {});
    expect(out["Camelot"]).toBe("8B");
    expect(out["Open Key"]).toBe("1d");
  });

  it("rejects bad input and bad options", () => {
    expect(() => run("A minor", { notation: "roman" })).toThrow(/not a notation/);
    expect(() => run("zzz", both)).toThrow(/not a key/);
    expect(() => run("600", both)).toThrow(/outside the 20 to 400/);
    expect(() => run("5", both)).toThrow(/outside the 20 to 400/);
    expect(() => run("0, 5, 10", both)).toThrow(/do not contain a usable beat/);
  });

  it("never uses an em dash or an en dash in its prose", () => {
    const text = [
      ...Object.values(run("", both)),
      ...Object.values(run("128", both)),
      ...Object.values(run("A minor", both)),
      ...Object.values(run("0, 500, 1000", both)),
    ].join(" ");
    expect(text).not.toMatch(/[–—]/);
  });
});
