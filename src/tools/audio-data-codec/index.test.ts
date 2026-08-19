import { describe, expect, it } from "vitest";
import {
  DTMF_FREQS,
  buildFskFrame,
  crc16Ccitt,
  decodeDtmf,
  decodeFsk,
  decodeMorseFromEnvelope,
  encodeFsk,
  encodeWav,
  envelopeFromSamples,
  morseDurationMs,
  morseSegments,
  morseTiming,
  morseToText,
  normalizeDtmfDigits,
  renderDtmfSamples,
  renderMorseSamples,
  run,
  textToMorse,
} from "./index";
import { ToolError } from "../types";

/** Deterministic noise so the signal-to-noise test never flakes. */
function seededRandom(seed: string): () => number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const DEFAULT_OPTS = { mode: "text-to-morse", wpm: 15, toneHz: 600, baud: 100 };

describe("audio-data-codec morse", () => {
  it("encodes SOS", () => {
    expect(textToMorse("SOS")).toBe("... --- ...");
    expect(textToMorse("sos")).toBe("... --- ...");
  });

  it("round trips a sentence with punctuation and digits", () => {
    const text = "HELLO WORLD, 73! CQ DE K1ABC?";
    expect(morseToText(textToMorse(text))).toBe(text);
  });

  it("sends a prosign as one unbroken run of elements", () => {
    expect(textToMorse("<SOS>")).toBe("...---...");
    expect(morseToText("...---...")).toBe("<SOS>");
  });

  it("prefers the punctuation mark when a prosign shares its pattern", () => {
    expect(textToMorse("<AR>")).toBe(".-.-.");
    expect(morseToText(".-.-.")).toBe("+");
  });

  it("decodes middots, underscores and bars as dots, dashes and word gaps", () => {
    expect(morseToText("··· ___ ···")).toBe("SOS");
    expect(morseToText(".... .. | - .... . .-. .")).toBe("HI THERE");
  });

  it("treats three or more spaces as a word gap when no slash is present", () => {
    expect(morseToText(".... ..   - .... . .-. .")).toBe("HI THERE");
  });

  it("uses PARIS standard timing", () => {
    const timing = morseTiming(20);
    expect(timing.ditMs).toBe(60);
    expect(timing.dahMs).toBe(180);
    expect(timing.charGapMs).toBe(180);
    expect(timing.wordGapMs).toBe(420);
    // PARIS plus its word gap is 50 dit units, so one word takes 60 / wpm seconds.
    const paris = morseDurationMs(textToMorse("PARIS"), timing) + timing.wordGapMs;
    expect(paris).toBeCloseTo(3000, 6);
  });

  it("stretches only the spacing under Farnsworth", () => {
    const timing = morseTiming(20, 10);
    expect(timing.ditMs).toBe(60);
    expect(timing.charGapMs).toBeGreaterThan(180);
    const paris = morseDurationMs(textToMorse("PARIS"), timing) + timing.wordGapMs;
    expect(paris).toBeCloseTo(6000, 6);
  });

  it("ignores a Farnsworth speed above the character speed", () => {
    expect(morseTiming(20, 30).wordGapMs).toBe(morseTiming(20).wordGapMs);
  });

  it("renders exactly as many samples as the timing calls for", () => {
    const timing = morseTiming(15);
    const morse = textToMorse("SOS");
    const samples = renderMorseSamples(morse, { wpm: 15, sampleRate: 8000 });
    expect(samples.length).toBe(Math.round((morseDurationMs(morse, timing) * 8000) / 1000));
    // Ramps mean the first sample is near silence and the middle of a dit is not.
    expect(Math.abs(samples[0])).toBeLessThan(0.05);
    expect(samples.reduce((peak, value) => Math.max(peak, value), 0)).toBeGreaterThan(0.5);
  });

  it("decodes its own rendered audio back to the original text", () => {
    const morse = textToMorse("HELLO WORLD");
    const samples = renderMorseSamples(morse, { wpm: 15, toneHz: 600, sampleRate: 8000 });
    const envelope = envelopeFromSamples(samples, 8000, 600);
    const decoded = decodeMorseFromEnvelope(envelope);
    expect(decoded.text).toBe("HELLO WORLD");
    expect(decoded.wpm).toBeGreaterThan(11);
    expect(decoded.wpm).toBeLessThan(19);
  });

  it("decodes rendered Morse at 44100 with Farnsworth spacing", () => {
    const morse = textToMorse("CQ CQ DE K1ABC K");
    const samples = renderMorseSamples(morse, {
      wpm: 20,
      farnsworthWpm: 8,
      toneHz: 700,
      sampleRate: 44100,
    });
    const decoded = decodeMorseFromEnvelope(envelopeFromSamples(samples, 44100, 700));
    expect(decoded.text).toBe("CQ CQ DE K1ABC K");
  });

  it("decodes an all dahs message using the gaps to find the dit length", () => {
    const timing = morseTiming(15);
    const segments = morseSegments(textToMorse("OTTO"), timing);
    expect(decodeMorseFromEnvelope(segments).text).toBe("OTTO");
  });

  it("returns nothing when the envelope never keys down", () => {
    expect(decodeMorseFromEnvelope([{ on: false, ms: 500 }])).toEqual({
      morse: "",
      text: "",
      ditMs: 0,
      wpm: 0,
    });
    expect(envelopeFromSamples(new Float32Array(8000), 8000, 600)).toEqual([]);
  });

  it("rejects characters with no Morse code", () => {
    expect(() => textToMorse("café")).toThrowError(ToolError);
    try {
      textToMorse("café");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-morse");
      expect((error as ToolError).fix).toMatch(/A to Z/);
    }
  });

  it("rejects unknown prosigns and unknown patterns", () => {
    expect(() => textToMorse("<ZZ>")).toThrowError(/not a prosign/);
    expect(() => morseToText("........-")).toThrowError(/not a pattern/);
    expect(() => morseToText(".-.x")).toThrowError(/dots and dashes/);
  });
});

describe("audio-data-codec dtmf", () => {
  it("maps every key to its low and high group tone", () => {
    expect(DTMF_FREQS["1"]).toEqual({ low: 697, high: 1209 });
    expect(DTMF_FREQS["0"]).toEqual({ low: 941, high: 1336 });
    expect(DTMF_FREQS["D"]).toEqual({ low: 941, high: 1633 });
    expect(Object.keys(DTMF_FREQS)).toHaveLength(16);
  });

  it("ignores the punctuation people write phone numbers with", () => {
    expect(normalizeDtmfDigits("+1 (800) 555-0100")).toBe("18005550100");
  });

  it("round trips a dial string through audio", () => {
    const samples = renderDtmfSamples("123A#*", { sampleRate: 8000 });
    expect(decodeDtmf(samples, 8000)).toBe("123A#*");
  });

  it("keeps repeated keys apart because of the gap between bursts", () => {
    const samples = renderDtmfSamples("911", { sampleRate: 8000 });
    expect(decodeDtmf(samples, 8000)).toBe("911");
  });

  it("round trips the whole keypad at 44100", () => {
    const samples = renderDtmfSamples("*0#ABCD9876543210", { sampleRate: 44100 });
    expect(decodeDtmf(samples, 44100)).toBe("*0#ABCD9876543210");
  });

  it("round trips shorter bursts", () => {
    const samples = renderDtmfSamples("5551212", { sampleRate: 8000, toneMs: 60, gapMs: 40 });
    expect(decodeDtmf(samples, 8000)).toBe("5551212");
  });

  it("finds nothing in silence", () => {
    expect(decodeDtmf(new Float32Array(8000), 8000)).toBe("");
    expect(decodeDtmf(new Float32Array(0), 8000)).toBe("");
  });

  it("rejects keys that are not on the pad", () => {
    expect(() => normalizeDtmfDigits("55G5")).toThrowError(ToolError);
    try {
      normalizeDtmfDigits("55G5");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-dtmf");
    }
  });
});

describe("audio-data-codec fsk", () => {
  it("computes the standard CRC-16/CCITT-FALSE check value", () => {
    expect(crc16Ccitt(ascii("123456789"))).toBe(0x29b1);
    expect(crc16Ccitt(new Uint8Array(0))).toBe(0xffff);
  });

  it("frames a payload with a preamble, sync word, length and checksum", () => {
    const frame = buildFskFrame(ascii("hi"));
    expect(frame.bits.length).toBe(48 + 16 + (2 + 4) * 10);
    expect(frame.checked[0]).toBe(0);
    expect(frame.checked[1]).toBe(2);
    expect(frame.bits.slice(0, 4)).toEqual([0, 1, 0, 1]);
    expect(frame.bits.slice(48, 64)).toEqual([0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0]);
  });

  it("round trips a 64 byte payload through a clean signal", () => {
    const payload = new Uint8Array(64);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) & 0xff;
    const tone = encodeFsk(payload, { sampleRate: 8000, baud: 100 });
    // Lead in with silence that is not a whole number of analysis steps, so the
    // decoder has to find the frame rather than start on top of it.
    const samples = new Float32Array(4007 + tone.length);
    samples.set(tone, 4007);
    expect(Array.from(decodeFsk(samples, 8000, { baud: 100 }))).toEqual(Array.from(payload));
  });

  it("round trips a 64 byte payload at about 20 dB signal to noise", () => {
    const payload = ascii("The quick brown fox jumps over the lazy dog, 64 bytes worth.....");
    expect(payload.length).toBe(64);
    const tone = encodeFsk(payload, { sampleRate: 8000, baud: 100, amplitude: 0.6 });
    const samples = new Float32Array(4007 + tone.length);
    samples.set(tone, 4007);
    // A 0.6 peak sine carries 0.18 of power; a twentieth of that in amplitude
    // terms is 20 dB down, and uniform noise in [-a, a] has a squared / 3.
    const noiseAmplitude = Math.sqrt(3 * (0.18 / 100));
    const random = seededRandom("audio-data-codec");
    for (let i = 0; i < samples.length; i++) {
      samples[i] += (random() * 2 - 1) * noiseAmplitude;
    }
    expect(new TextDecoder().decode(decodeFsk(samples, 8000, { baud: 100 }))).toBe(
      "The quick brown fox jumps over the lazy dog, 64 bytes worth.....",
    );
  });

  it("round trips at 44100 across the baud range", () => {
    const text = "hello from the other side of the room";
    for (const baud of [50, 100, 300]) {
      const tone = encodeFsk(ascii(text), { sampleRate: 44100, baud });
      const samples = new Float32Array(3333 + tone.length);
      samples.set(tone, 3333);
      expect(new TextDecoder().decode(decodeFsk(samples, 44100, { baud }))).toBe(text);
    }
  });

  it("reports a corrupted payload instead of returning wrong bytes", () => {
    const payload = ascii("AAAAAAAA");
    const samples = encodeFsk(payload, { sampleRate: 8000, baud: 100 });
    // Force all eight data bits of the first payload byte to the mark tone, so
    // the byte arrives as 0xFF and the checksum no longer matches.
    const samplesPerBit = 8000 / 100;
    for (let bit = 85; bit < 93; bit++) {
      const start = Math.round(bit * samplesPerBit);
      const end = Math.round((bit + 1) * samplesPerBit);
      for (let i = start; i < end; i++) {
        samples[i] = 0.6 * Math.sin((2 * Math.PI * 2200 * (i - start)) / 8000);
      }
    }
    expect(() => decodeFsk(samples, 8000, { baud: 100 })).toThrowError(ToolError);
    try {
      decodeFsk(samples, 8000, { baud: 100 });
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-checksum");
    }
  });

  it("reports silence and truncated recordings as no signal", () => {
    try {
      decodeFsk(new Float32Array(16000), 8000, { baud: 100 });
      throw new Error("expected a ToolError");
    } catch (error) {
      expect((error as ToolError).code).toBe("no-signal");
    }
    try {
      decodeFsk(new Float32Array(1200), 8000, { baud: 100 });
      throw new Error("expected a ToolError");
    } catch (error) {
      expect((error as ToolError).code).toBe("no-signal");
    }
  });

  it("reports a frame that stops before the payload ends", () => {
    const tone = encodeFsk(ascii("truncated payload here"), { sampleRate: 8000, baud: 100 });
    const cut = tone.slice(0, Math.floor(tone.length * 0.6));
    try {
      decodeFsk(cut, 8000, { baud: 100 });
      throw new Error("expected a ToolError");
    } catch (error) {
      expect((error as ToolError).code).toBe("no-signal");
    }
  });

  it("refuses a payload that cannot fit in the length field", () => {
    try {
      buildFskFrame(new Uint8Array(70000));
      throw new Error("expected a ToolError");
    } catch (error) {
      expect((error as ToolError).code).toBe("bad-option");
    }
  });
});

describe("audio-data-codec wav", () => {
  it("writes a 44 byte 16-bit mono header", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 44100);
    const view = new DataView(wav.buffer);
    const tag = (offset: number) => String.fromCharCode(...wav.slice(offset, offset + 4));
    expect(wav.length).toBe(44 + 8);
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(tag(36)).toBe("data");
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(88200);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it("rejects a nonsense sample rate", () => {
    expect(() => encodeWav(new Float32Array(4), 0)).toThrowError(/Sample rate/);
  });
});

describe("audio-data-codec run", () => {
  it("encodes text to Morse by default", () => {
    const out = run("SOS", DEFAULT_OPTS);
    expect(out.Morse).toBe("... --- ...");
    expect(out.Duration).toContain("15 WPM");
    expect(out.Timing).toContain("dit 80 ms");
    expect(out.Tone).toContain("600 Hz");
  });

  it("decodes Morse to text", () => {
    const out = run("... --- ...", { ...DEFAULT_OPTS, mode: "morse-to-text" });
    expect(out.Text).toBe("SOS");
    expect(out.Morse).toBe("... --- ...");
  });

  it("accepts mode synonyms", () => {
    expect(run(".... ..", { ...DEFAULT_OPTS, mode: "decode-morse" }).Text).toBe("HI");
    expect(run("hi", { ...DEFAULT_OPTS, mode: "MORSE" }).Morse).toBe(".... ..");
  });

  it("lists the tone pair for every DTMF key", () => {
    const out = run("1-800-A", { ...DEFAULT_OPTS, mode: "dtmf" });
    expect(out.Keys).toBe("1800A");
    expect(out["Key 1"]).toBe("697 Hz low group + 1209 Hz high group");
    expect(out["Key A"]).toBe("697 Hz low group + 1633 Hz high group");
    expect(out.Duration).toContain("900 ms");
  });

  it("describes the frame the modem would send", () => {
    const out = run("hello", { ...DEFAULT_OPTS, mode: "fsk-info" });
    expect(out.Payload).toContain("5 bytes");
    expect(out["Total bits"]).toContain(String(48 + 16 + 9 * 10));
    expect(out.Duration).toContain("100 baud");
    expect(out.Checksum).toMatch(/^CRC-16\/CCITT-FALSE 0x[0-9A-F]{4}$/);
  });

  it("counts multibyte characters as the bytes they really are", () => {
    const out = run("é", { ...DEFAULT_OPTS, mode: "fsk-info" });
    expect(out.Payload).toContain("2 bytes");
  });

  it("rejects empty input in every mode", () => {
    for (const mode of ["text-to-morse", "morse-to-text", "dtmf", "fsk-info"]) {
      try {
        run("   ", { ...DEFAULT_OPTS, mode });
        throw new Error(`expected a ToolError for ${mode}`);
      } catch (error) {
        expect((error as ToolError).code).toBe("empty-input");
      }
    }
  });

  it("rejects an unknown mode and out of range numbers", () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as ToolError).code;
      }
      return "no error";
    };
    expect(codeOf(() => run("SOS", { ...DEFAULT_OPTS, mode: "semaphore" }))).toBe("bad-option");
    expect(codeOf(() => run("SOS", { ...DEFAULT_OPTS, wpm: 100 }))).toBe("bad-option");
    expect(codeOf(() => run("SOS", { ...DEFAULT_OPTS, toneHz: 20 }))).toBe("bad-option");
    expect(codeOf(() => run("SOS", { ...DEFAULT_OPTS, baud: 5000 }))).toBe("bad-option");
  });

  it("rejects text with no Morse code and keys that are not on the pad", () => {
    expect(() => run("é", DEFAULT_OPTS)).toThrowError(/no code in the ITU/);
    expect(() => run("55G5", { ...DEFAULT_OPTS, mode: "dtmf" })).toThrowError(/DTMF keypad/);
    expect(() => run("---", { ...DEFAULT_OPTS, mode: "dtmf" })).toThrowError(ToolError);
  });
});
