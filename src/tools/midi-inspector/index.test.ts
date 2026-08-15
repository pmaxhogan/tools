import { describe, expect, it } from "vitest";
import {
  applyControlMeter,
  controlMeterFor,
  decodeLiveMessage,
  durationSeconds,
  keySignatureName,
  noteCount,
  noteName,
  parseMidi,
  readVarInt,
  run,
  sortedControlMeters,
  writeVarInt,
  type ControlMeter,
  type MidiOpts,
} from "./index";
import { ToolError } from "../types";

const opts: MidiOpts = { middleC: "4" };

/* ------------------------------------------------------------------ */
/* fixture builder                                                    */
/* ------------------------------------------------------------------ */

function chunk(id: string, body: number[]): number[] {
  const len = body.length;
  return [
    ...[...id].map((c) => c.charCodeAt(0)),
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...body,
  ];
}

/**
 * A format-1 file: one tempo/meta track and one note track that deliberately
 * uses running status (a second note-on with no repeated 0x90 status byte) and
 * a two-byte delta time (0x81 0x48 = 200 ticks) so both are under test.
 */
function buildFixture(): Uint8Array {
  const header = [
    0x00,
    0x01, // format 1
    0x00,
    0x02, // two tracks
    0x00,
    0x60, // 96 ticks per quarter
  ];

  const metaTrack = [
    // delta 0, FF 51 03 tempo = 500000 us/quarter = 120 BPM
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    // delta 0, FF 58 04 time signature 3/4
    0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08,
    // delta 0, FF 59 02 key signature: 2 sharps, major -> D major
    0x00, 0xff, 0x59, 0x02, 0x02, 0x00,
    // delta 0, FF 03 track name "Lead"
    0x00, 0xff, 0x03, 0x04, 0x4c, 0x65, 0x61, 0x64,
    // delta 0, end of track
    0x00, 0xff, 0x2f, 0x00,
  ];

  const noteTrack = [
    // delta 0, note on C4 (60) velocity 100 on channel 1
    0x00, 0x90, 0x3c, 0x64,
    // delta 96, note on E4 (64) velocity 80 using RUNNING STATUS (no 0x90 byte)
    0x60, 0x40, 0x50,
    // delta 200 (two-byte VLQ 0x81 0x48), note off C4 via velocity 0, still running status
    0x81, 0x48, 0x3c, 0x00,
    // delta 0, explicit note off E4
    0x00, 0x80, 0x40, 0x40,
    // delta 0, end of track
    0x00, 0xff, 0x2f, 0x00,
  ];

  return Uint8Array.from([
    ...chunk("MThd", header),
    ...chunk("MTrk", metaTrack),
    ...chunk("MTrk", noteTrack),
  ]);
}

const FIXTURE = buildFixture();

/* ------------------------------------------------------------------ */
/* VLQ                                                                 */
/* ------------------------------------------------------------------ */

describe("midi-inspector VLQ", () => {
  it("round trips a range of values through write then read", () => {
    for (const value of [0, 1, 127, 128, 200, 8192, 16383, 0x0fffffff]) {
      const encoded = Uint8Array.from(writeVarInt(value));
      const { value: decoded, next } = readVarInt(encoded, 0);
      expect(decoded).toBe(value);
      expect(next).toBe(encoded.length);
    }
  });

  it("encodes 200 as the two-byte sequence 0x81 0x48", () => {
    expect(writeVarInt(200)).toEqual([0x81, 0x48]);
    expect(readVarInt(Uint8Array.from([0x81, 0x48]), 0).value).toBe(200);
  });

  it("throws when a VLQ runs past the end", () => {
    expect(() => readVarInt(Uint8Array.from([0x81]), 0)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* header                                                              */
/* ------------------------------------------------------------------ */

describe("midi-inspector header", () => {
  it("decodes format, track count and division", () => {
    const file = parseMidi(FIXTURE);
    expect(file.header.format).toBe(1);
    expect(file.header.trackCount).toBe(2);
    expect(file.header.division).toEqual({ kind: "ticksPerQuarter", ticksPerQuarter: 96 });
    expect(file.tracks).toHaveLength(2);
  });

  it("reads an SMPTE division", () => {
    // 0xE7 0x28 = -25 fps, 40 ticks per frame.
    const header = [0x00, 0x00, 0x00, 0x01, 0xe7, 0x28];
    const bytes = Uint8Array.from([
      ...chunk("MThd", header),
      ...chunk("MTrk", [0x00, 0xff, 0x2f, 0x00]),
    ]);
    expect(parseMidi(bytes).header.division).toEqual({
      kind: "smpte",
      framesPerSecond: 25,
      ticksPerFrame: 40,
    });
  });
});

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

describe("midi-inspector events", () => {
  const file = parseMidi(FIXTURE);
  const meta = file.tracks[0]!;
  const notes = file.tracks[1]!;

  it("decodes a tempo event and derives BPM", () => {
    const tempo = meta.events.find((e) => e.kind === "tempo");
    expect(tempo).toMatchObject({ kind: "tempo", microsecondsPerQuarter: 500000, bpm: 120 });
  });

  it("decodes the time and key signatures and the track name", () => {
    expect(meta.events.find((e) => e.kind === "timeSignature")).toMatchObject({
      numerator: 3,
      denominator: 4,
    });
    expect(meta.events.find((e) => e.kind === "keySignature")).toMatchObject({
      sharpsFlats: 2,
      minor: false,
      key: "D major",
    });
    expect(meta.name).toBe("Lead");
  });

  it("decodes a note-on with pitch, velocity, channel and absolute tick", () => {
    const noteOn = notes.events[0]!;
    expect(noteOn).toMatchObject({ kind: "noteOn", note: 60, velocity: 100, channel: 0, tick: 0 });
  });

  it("applies running status for the second note-on", () => {
    // Second event reuses the 0x90 status byte and lands at tick 96.
    expect(notes.events[1]).toMatchObject({
      kind: "noteOn",
      note: 64,
      velocity: 80,
      channel: 0,
      tick: 96,
    });
  });

  it("normalises a running-status note-on velocity 0 to note-off at the two-byte delta", () => {
    const off = notes.events[2]!;
    expect(off).toMatchObject({ kind: "noteOff", note: 60, velocity: 0, tick: 296 });
  });

  it("counts only sounding notes", () => {
    // Two note-ons with velocity > 0; the velocity-0 note-on does not count.
    expect(noteCount(file)).toBe(2);
  });

  it("computes duration from the tempo and total ticks", () => {
    // Last event at tick 296, 96 ticks per quarter, 120 BPM (0.5 s per quarter).
    expect(durationSeconds(file)).toBeCloseTo((296 / 96) * 0.5, 6);
  });
});

/* ------------------------------------------------------------------ */
/* names                                                               */
/* ------------------------------------------------------------------ */

describe("midi-inspector names", () => {
  it("names notes with the C4 = 60 default and the shifted convention", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(69)).toBe("A4");
    expect(noteName(0)).toBe("C-1");
    expect(noteName(60, 3)).toBe("C3");
  });

  it("names key signatures for both modes and directions", () => {
    expect(keySignatureName(0, false)).toBe("C major");
    expect(keySignatureName(2, false)).toBe("D major");
    expect(keySignatureName(-3, false)).toBe("Eb major");
    expect(keySignatureName(0, true)).toBe("A minor");
  });
});

/* ------------------------------------------------------------------ */
/* live decoder                                                        */
/* ------------------------------------------------------------------ */

describe("midi-inspector decodeLiveMessage", () => {
  it("decodes a raw note-on", () => {
    expect(decodeLiveMessage(Uint8Array.from([0x91, 0x3e, 0x5a]))).toEqual({
      kind: "noteOn",
      channel: 1,
      note: 62,
      velocity: 90,
    });
  });

  it("treats a note-on velocity 0 as a note-off", () => {
    expect(decodeLiveMessage(Uint8Array.from([0x90, 0x3c, 0x00]))).toMatchObject({
      kind: "noteOff",
      note: 60,
      velocity: 0,
    });
  });

  it("decodes control change and pitch bend", () => {
    expect(decodeLiveMessage(Uint8Array.from([0xb0, 0x07, 0x64]))).toEqual({
      kind: "controlChange",
      channel: 0,
      controller: 7,
      value: 100,
    });
    // Centre pitch bend is 0x2000 -> value 0.
    expect(decodeLiveMessage(Uint8Array.from([0xe0, 0x00, 0x40]))).toEqual({
      kind: "pitchBend",
      channel: 0,
      value: 0,
    });
  });

  it("decodes a real-time clock byte that never appears in files", () => {
    expect(decodeLiveMessage(Uint8Array.from([0xf8]))).toEqual({ kind: "clock" });
  });
});

/* ------------------------------------------------------------------ */
/* run() and error branches                                            */
/* ------------------------------------------------------------------ */

describe("midi-inspector run", () => {
  it("produces a readable summary record", () => {
    const out = run(FIXTURE, opts);
    expect(out.Format).toContain("1");
    expect(out.Tracks).toBe("2");
    expect(out.Division).toContain("96 ticks per quarter");
    expect(out.Tempo).toContain("120 BPM");
    expect(out["Time signature"]).toBe("3/4");
    expect(out["Key signature"]).toBe("D major");
    expect(out.Notes).toBe("2");
    expect(out["Track names"]).toContain("Lead");
  });

  it("throws empty-input for an empty string", () => {
    try {
      run("", opts);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws text-input for pasted text", () => {
    try {
      run("not a midi file", opts);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("text-input");
    }
  });

  it("throws not-midi for bytes without the MThd header", () => {
    try {
      run(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), opts);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-midi");
    }
  });

  it("throws on a truncated track chunk", () => {
    // Header promises a 20-byte track but the bytes stop early.
    const bytes = Uint8Array.from([
      ...chunk("MThd", [0x00, 0x00, 0x00, 0x01, 0x00, 0x60]),
      ...[..."MTrk"].map((c) => c.charCodeAt(0)),
      0x00,
      0x00,
      0x00,
      0x14, // length 20
      0x00,
      0x90, // then nothing
    ]);
    expect(() => parseMidi(bytes)).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* live control meters                                                */
/* ------------------------------------------------------------------ */

/** A raw control change on the wire: status 0xB0 | channel. */
function cc(channel: number, controller: number, value: number) {
  return decodeLiveMessage(Uint8Array.from([0xb0 | channel, controller, value]));
}

describe("control meters", () => {
  it("gives a control change a meter keyed by channel and controller", () => {
    const meter = controlMeterFor(cc(0, 37, 69));
    expect(meter).toMatchObject({
      id: "cc:0:37",
      kind: "controlChange",
      channel: 1,
      number: 37,
      label: "CC 37",
      value: 69,
      min: 0,
      max: 127,
      origin: 0,
      count: 1,
    });
    expect(meter?.level).toBeCloseTo(69 / 127, 10);
  });

  it("keeps the same controller on different channels apart", () => {
    expect(controlMeterFor(cc(0, 37, 1))?.id).toBe("cc:0:37");
    expect(controlMeterFor(cc(4, 37, 1))?.id).toBe("cc:4:37");
  });

  it("names the controller where MIDI defines one, and stays quiet where it does not", () => {
    expect(controlMeterFor(cc(0, 7, 100))?.detail).toBe("Channel Volume");
    expect(controlMeterFor(cc(0, 37, 100))?.detail).toBe("");
  });

  it("centres pitch bend and scales each half to its own end", () => {
    const rest = controlMeterFor(decodeLiveMessage(Uint8Array.from([0xe0, 0x00, 0x40])));
    expect(rest?.value).toBe(0);
    expect(rest?.level).toBeCloseTo(0.5, 10);
    expect(rest?.origin).toBe(0.5);

    const down = controlMeterFor(decodeLiveMessage(Uint8Array.from([0xe0, 0x00, 0x00])));
    expect(down?.value).toBe(-8192);
    expect(down?.level).toBeCloseTo(0, 10);

    const up = controlMeterFor(decodeLiveMessage(Uint8Array.from([0xe0, 0x7f, 0x7f])));
    expect(up?.value).toBe(8191);
    expect(up?.level).toBeCloseTo(1, 10);
  });

  it("meters both flavours of aftertouch", () => {
    const poly = controlMeterFor(decodeLiveMessage(Uint8Array.from([0xa0, 60, 64])));
    expect(poly).toMatchObject({ id: "pat:0:60", kind: "polyAftertouch", label: "C4", value: 64 });

    const channel = controlMeterFor(decodeLiveMessage(Uint8Array.from([0xd0, 90])));
    expect(channel).toMatchObject({ id: "cat:0", kind: "channelAftertouch", value: 90 });
  });

  it("respects the middle-C convention in poly aftertouch labels", () => {
    expect(controlMeterFor(decodeLiveMessage(Uint8Array.from([0xa0, 60, 1])), 3)?.label).toBe("C3");
  });

  it("gives no meter to messages that carry no level", () => {
    // Notes are moments, program change picks a patch, clock is a tick.
    expect(controlMeterFor(decodeLiveMessage(Uint8Array.from([0x90, 60, 100])))).toBeNull();
    expect(controlMeterFor(decodeLiveMessage(Uint8Array.from([0x80, 60, 0])))).toBeNull();
    expect(controlMeterFor(decodeLiveMessage(Uint8Array.from([0xc0, 5])))).toBeNull();
    expect(controlMeterFor(decodeLiveMessage(Uint8Array.from([0xf8])))).toBeNull();
  });

  it("keeps one meter per control and counts the messages", () => {
    const meters = new Map<string, ControlMeter>();
    expect(applyControlMeter(meters, cc(0, 37, 69))).toBe(true);
    expect(applyControlMeter(meters, cc(0, 37, 90))).toBe(true);
    expect(applyControlMeter(meters, cc(0, 60, 127))).toBe(true);

    expect(meters.size).toBe(2);
    expect(meters.get("cc:0:37")).toMatchObject({ value: 90, count: 2 });
    expect(meters.get("cc:0:60")).toMatchObject({ value: 127, count: 1 });
  });

  it("reports no change for a message with no level", () => {
    const meters = new Map<string, ControlMeter>();
    expect(applyControlMeter(meters, decodeLiveMessage(Uint8Array.from([0xf8])))).toBe(false);
    expect(meters.size).toBe(0);
  });

  it("orders meters by channel, then kind, then number", () => {
    const meters = new Map<string, ControlMeter>();
    // The order the sample log saw them: 61, 60, 59, then 37.
    for (const controller of [61, 60, 59, 37]) applyControlMeter(meters, cc(0, controller, 64));
    applyControlMeter(meters, decodeLiveMessage(Uint8Array.from([0xe0, 0x00, 0x40])));
    applyControlMeter(meters, cc(1, 7, 100));

    // Pitch bend leads its channel, then the CC bank in numeric order.
    expect(sortedControlMeters(meters.values()).map((m) => m.id)).toEqual([
      "pb:0",
      "cc:0:37",
      "cc:0:59",
      "cc:0:60",
      "cc:0:61",
      "cc:1:7",
    ]);
  });
});
