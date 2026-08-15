import { ToolError, type ToolLogic } from "../types";

/**
 * MIDI inspector logic.
 *
 * A pure Standard MIDI File (SMF) parser plus a decoder for single live Web MIDI
 * messages. No DOM, no globals, no framework: it takes bytes and returns plain
 * data. The panel owns the file reading and the Web MIDI / Web Audio wiring, and
 * hands every byte it receives back here so the decoding lives in one place
 * (rule 27). `TextDecoder` is a platform primitive available in Node and the
 * browser alike, so it is fair game the same way `crypto` is.
 */

/* ------------------------------------------------------------------ */
/* option shape                                                       */
/* ------------------------------------------------------------------ */

export interface MidiOpts {
  /** Octave label given to MIDI note 60. 4 means note 60 is "C4". */
  middleC: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* result types                                                       */
/* ------------------------------------------------------------------ */

export type MidiDivision =
  | { kind: "ticksPerQuarter"; ticksPerQuarter: number }
  | { kind: "smpte"; framesPerSecond: number; ticksPerFrame: number };

export interface MidiHeader {
  /** 0 single track, 1 several tracks played together, 2 independent patterns. */
  format: number;
  /** Track count declared in the header. */
  trackCount: number;
  division: MidiDivision;
}

/** Every event carries the delta from the previous event and its absolute tick. */
interface EventBase {
  delta: number;
  tick: number;
}

export type ChannelEventKind =
  | "noteOn"
  | "noteOff"
  | "polyAftertouch"
  | "controlChange"
  | "programChange"
  | "channelAftertouch"
  | "pitchBend";

/** A decoded channel voice message, shared by the file parser and the live decoder. */
export type ChannelMessage =
  | { kind: "noteOn"; channel: number; note: number; velocity: number }
  | { kind: "noteOff"; channel: number; note: number; velocity: number }
  | { kind: "polyAftertouch"; channel: number; note: number; pressure: number }
  | { kind: "controlChange"; channel: number; controller: number; value: number }
  | { kind: "programChange"; channel: number; program: number }
  | { kind: "channelAftertouch"; channel: number; pressure: number }
  | { kind: "pitchBend"; channel: number; value: number };

export type MidiEvent = EventBase &
  (
    | ChannelMessage
    | { kind: "tempo"; microsecondsPerQuarter: number; bpm: number }
    | {
        kind: "timeSignature";
        numerator: number;
        denominator: number;
        clocksPerClick: number;
        thirtySecondsPerQuarter: number;
      }
    | { kind: "keySignature"; sharpsFlats: number; minor: boolean; key: string }
    | { kind: "text"; metaType: number; label: string; text: string }
    | { kind: "sequenceNumber"; number: number }
    | { kind: "channelPrefix"; channel: number }
    | { kind: "portPrefix"; port: number }
    | { kind: "sysex"; byteLength: number }
    | { kind: "endOfTrack" }
    | { kind: "unknownMeta"; metaType: number; byteLength: number }
  );

export interface MidiTrack {
  index: number;
  /** From an FF 03 track-name meta event, when present. */
  name?: string;
  events: MidiEvent[];
  /** Absolute tick of the last event in the track. */
  endTick: number;
}

export interface MidiFile {
  header: MidiHeader;
  tracks: MidiTrack[];
}

/* ------------------------------------------------------------------ */
/* variable-length quantity                                           */
/* ------------------------------------------------------------------ */

/**
 * Decode one SMF variable-length quantity starting at `pos`. Each byte carries
 * seven value bits; the top bit means "another byte follows". SMF caps these at
 * four bytes, so anything longer is a corrupt stream rather than a huge number.
 */
export function readVarInt(
  bytes: Uint8Array,
  pos: number,
  end: number = bytes.length,
): { value: number; next: number } {
  let value = 0;
  let i = pos;
  for (let count = 0; count < 4; count++) {
    if (i >= end) {
      throw new ToolError(
        "truncated",
        "A variable length number runs past the end of the data.",
        "The file looks cut off. Re-export or re-download it and try again.",
      );
    }
    const b = bytes[i++] as number;
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return { value, next: i };
  }
  throw new ToolError(
    "bad-vlq",
    "A variable length number is longer than four bytes, which SMF does not allow.",
    "This is not a valid MIDI file, or it is damaged.",
  );
}

/** Encode a number as an SMF variable-length quantity. The inverse of readVarInt. */
export function writeVarInt(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new ToolError("bad-vlq", "Only non-negative integers have a variable length encoding.");
  }
  const out = [value & 0x7f];
  let v = Math.floor(value / 128);
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* names                                                              */
/* ------------------------------------------------------------------ */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Parse the middle-C octave option to a number, defaulting to the C4 = 60 convention. */
export function middleCOctave(opts?: Partial<MidiOpts>): number {
  const n = Number(opts?.middleC);
  return Number.isFinite(n) ? n : 4;
}

/**
 * The name for a MIDI note number, e.g. 60 is "C4" in the default convention.
 * The octave is adjustable because DAWs disagree: some label note 60 as C3.
 */
export function noteName(note: number, middleC = 4): string {
  if (!Number.isFinite(note) || note < 0 || note > 127) return `note ${note}`;
  const name = NOTE_NAMES[note % 12] as string;
  const octave = Math.floor(note / 12) - 5 + middleC;
  return `${name}${octave}`;
}

const MAJOR_SHARP = ["C", "G", "D", "A", "E", "B", "F#", "C#"];
const MAJOR_FLAT = ["C", "F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"];
const MINOR_SHARP = ["A", "E", "B", "F#", "C#", "G#", "D#", "A#"];
const MINOR_FLAT = ["A", "D", "G", "C", "F", "Bb", "Eb", "Ab"];

/** Turn the sharps/flats count and mode of an FF 59 key signature into a key name. */
export function keySignatureName(sharpsFlats: number, minor: boolean): string {
  const n = Math.max(-7, Math.min(7, sharpsFlats | 0));
  const table = minor ? (n >= 0 ? MINOR_SHARP : MINOR_FLAT) : n >= 0 ? MAJOR_SHARP : MAJOR_FLAT;
  const root = table[Math.abs(n)] ?? "?";
  return `${root} ${minor ? "minor" : "major"}`;
}

/** Common continuous-controller names for the frequently used numbers. */
const CONTROLLER_NAMES: Record<number, string> = {
  0: "Bank Select MSB",
  1: "Modulation",
  2: "Breath",
  4: "Foot",
  5: "Portamento Time",
  6: "Data Entry MSB",
  7: "Channel Volume",
  8: "Balance",
  10: "Pan",
  11: "Expression",
  32: "Bank Select LSB",
  64: "Sustain Pedal",
  65: "Portamento",
  66: "Sostenuto",
  67: "Soft Pedal",
  71: "Resonance",
  74: "Cutoff",
  91: "Reverb Depth",
  93: "Chorus Depth",
  120: "All Sound Off",
  121: "Reset All Controllers",
  123: "All Notes Off",
};

export function controllerName(controller: number): string {
  return CONTROLLER_NAMES[controller] ?? `Controller ${controller}`;
}

/**
 * The defined meaning of a controller, or "" for the numbers MIDI leaves free
 * for a device to use however it likes. Unlike `controllerName` this does not
 * invent a fallback, so a caller can tell "this is the volume knob" apart from
 * "this is whatever CC 37 does on your controller".
 */
function definedControllerName(controller: number): string {
  return CONTROLLER_NAMES[controller] ?? "";
}

const TEXT_META_LABELS: Record<number, string> = {
  0x01: "Text",
  0x02: "Copyright",
  0x03: "Track Name",
  0x04: "Instrument Name",
  0x05: "Lyric",
  0x06: "Marker",
  0x07: "Cue Point",
  0x08: "Program Name",
  0x09: "Device Name",
};

/* ------------------------------------------------------------------ */
/* channel message decoding (shared: file + live)                     */
/* ------------------------------------------------------------------ */

/**
 * Decode one channel voice message from its status byte and up to two data
 * bytes. A note-on with velocity 0 is the running-status idiom for a note-off,
 * so it is normalised to `noteOff` here, once, for the parser, the event list
 * and the live synth alike. Returns null for a status byte that is not a
 * channel message (system messages are handled elsewhere).
 */
export function decodeChannelMessage(
  status: number,
  data0: number,
  data1: number,
): ChannelMessage | null {
  const type = status & 0xf0;
  const channel = status & 0x0f;
  switch (type) {
    case 0x80:
      return { kind: "noteOff", channel, note: data0, velocity: data1 };
    case 0x90:
      return data1 === 0
        ? { kind: "noteOff", channel, note: data0, velocity: 0 }
        : { kind: "noteOn", channel, note: data0, velocity: data1 };
    case 0xa0:
      return { kind: "polyAftertouch", channel, note: data0, pressure: data1 };
    case 0xb0:
      return { kind: "controlChange", channel, controller: data0, value: data1 };
    case 0xc0:
      return { kind: "programChange", channel, program: data0 };
    case 0xd0:
      return { kind: "channelAftertouch", channel, pressure: data0 };
    case 0xe0:
      return { kind: "pitchBend", channel, value: ((data1 << 7) | data0) - 8192 };
    default:
      return null;
  }
}

/** How many data bytes a channel status byte is followed by. */
function channelDataLength(status: number): 1 | 2 {
  const type = status & 0xf0;
  return type === 0xc0 || type === 0xd0 ? 1 : 2;
}

/* ------------------------------------------------------------------ */
/* live Web MIDI decoding                                             */
/* ------------------------------------------------------------------ */

export type LiveMessage =
  | ChannelMessage
  | { kind: "sysex"; byteLength: number }
  | { kind: "songPosition"; position: number }
  | { kind: "songSelect"; song: number }
  | { kind: "clock" }
  | { kind: "start" }
  | { kind: "continue" }
  | { kind: "stop" }
  | { kind: "activeSensing" }
  | { kind: "systemReset" }
  | { kind: "tuneRequest" }
  | { kind: "unknown"; status: number };

/**
 * Decode a single raw Web MIDI message (the `data` of a MIDIMessageEvent). Live
 * messages carry no delta time and arrive one at a time, so this shares the
 * channel decoding with the file parser but skips the SMF framing. System
 * real-time bytes (clock, start, stop) never appear in files but do appear on
 * the wire, so they are handled here.
 */
export function decodeLiveMessage(data: Uint8Array): LiveMessage {
  if (data.length === 0) return { kind: "unknown", status: -1 };
  const status = data[0] as number;

  if (status >= 0x80 && status <= 0xef) {
    const message = decodeChannelMessage(status, data[1] ?? 0, data[2] ?? 0);
    if (message) return message;
  }

  switch (status) {
    case 0xf0:
    case 0xf7:
      return { kind: "sysex", byteLength: data.length };
    case 0xf2:
      return { kind: "songPosition", position: ((data[2] ?? 0) << 7) | (data[1] ?? 0) };
    case 0xf3:
      return { kind: "songSelect", song: data[1] ?? 0 };
    case 0xf6:
      return { kind: "tuneRequest" };
    case 0xf8:
      return { kind: "clock" };
    case 0xfa:
      return { kind: "start" };
    case 0xfb:
      return { kind: "continue" };
    case 0xfc:
      return { kind: "stop" };
    case 0xfe:
      return { kind: "activeSensing" };
    case 0xff:
      return { kind: "systemReset" };
    default:
      return { kind: "unknown", status };
  }
}

/* ------------------------------------------------------------------ */
/* live control meters                                                */
/* ------------------------------------------------------------------ */

/**
 * The latest reading of one continuous control the live monitor has seen.
 *
 * A scrolling log answers "what just happened" but not "where is everything
 * sitting right now": a controller sweeping CC 37 buries the fact that CC 59,
 * 60 and 61 are also in play. One meter per control, keyed by channel and
 * number, turns that history into current state.
 *
 * Only controls that carry a level get a meter. Note on and note off are
 * moments rather than positions, and program change picks a patch rather than
 * setting an amount, so none of them belong on a bar.
 */
export interface ControlMeter {
  /** Identity of the control: same channel and number means the same meter. */
  id: string;
  kind: "controlChange" | "polyAftertouch" | "channelAftertouch" | "pitchBend";
  /** 1 based, matching the channel numbering the log prints. */
  channel: number;
  /** Controller or note number, or -1 for a control that has no number. */
  number: number;
  /** Short name for the chip, e.g. "CC 37" or "Pitch bend". */
  label: string;
  /** What the control means, or "" when MIDI leaves that up to the device. */
  detail: string;
  /** The latest raw value, in the units the log prints. */
  value: number;
  min: number;
  max: number;
  /** Where the value sits in its range, 0 at the minimum and 1 at the maximum. */
  level: number;
  /** Where the bar grows from: 0.5 for pitch bend, which is centred at rest. */
  origin: number;
  /** How many messages this control has sent since the log was last cleared. */
  count: number;
}

/**
 * Rank per kind so meters keep a stable order rather than reshuffling per
 * message. The one-per-channel controls come first because a controller with
 * forty CC assignments would otherwise bury the pitch wheel below the fold,
 * and poly aftertouch comes last because it can run to one meter per key.
 */
const METER_KIND_RANK: Record<ControlMeter["kind"], number> = {
  pitchBend: 0,
  channelAftertouch: 1,
  controlChange: 2,
  polyAftertouch: 3,
};

/**
 * The meter a live message updates, or null when the message carries no level.
 * `count` is always 1 here; `applyControlMeter` carries the running total.
 */
export function controlMeterFor(message: LiveMessage, middleC = 4): ControlMeter | null {
  switch (message.kind) {
    case "controlChange":
      return {
        id: `cc:${message.channel}:${message.controller}`,
        kind: "controlChange",
        channel: message.channel + 1,
        number: message.controller,
        label: `CC ${message.controller}`,
        detail: definedControllerName(message.controller),
        value: message.value,
        min: 0,
        max: 127,
        level: message.value / 127,
        origin: 0,
        count: 1,
      };
    case "polyAftertouch":
      return {
        id: `pat:${message.channel}:${message.note}`,
        kind: "polyAftertouch",
        channel: message.channel + 1,
        number: message.note,
        label: noteName(message.note, middleC),
        detail: "Key pressure",
        value: message.pressure,
        min: 0,
        max: 127,
        level: message.pressure / 127,
        origin: 0,
        count: 1,
      };
    case "channelAftertouch":
      return {
        id: `cat:${message.channel}`,
        kind: "channelAftertouch",
        channel: message.channel + 1,
        number: -1,
        label: "Pressure",
        detail: "Channel aftertouch",
        value: message.pressure,
        min: 0,
        max: 127,
        level: message.pressure / 127,
        origin: 0,
        count: 1,
      };
    case "pitchBend":
      return {
        id: `pb:${message.channel}`,
        kind: "pitchBend",
        channel: message.channel + 1,
        number: -1,
        label: "Pitch bend",
        detail: "Centred at rest",
        value: message.value,
        min: -8192,
        max: 8191,
        // The wheel rests at 0 in the middle of a range that is one step wider
        // below than above, so the two halves are scaled separately. Without
        // that, a wheel at rest would read a hair off centre.
        level: message.value < 0 ? 0.5 + message.value / 16384 : 0.5 + message.value / 16382,
        origin: 0.5,
        count: 1,
      };
    default:
      return null;
  }
}

/**
 * Fold one live message into a map of meters keyed by `ControlMeter.id`.
 * Mutates `meters` because this runs once per incoming message on a wire that
 * can carry thousands a second. Returns true when the map changed, so a caller
 * can skip a redraw for messages that carry no level.
 */
export function applyControlMeter(
  meters: Map<string, ControlMeter>,
  message: LiveMessage,
  middleC = 4,
): boolean {
  const next = controlMeterFor(message, middleC);
  if (!next) return false;
  const previous = meters.get(next.id);
  if (previous) next.count = previous.count + 1;
  meters.set(next.id, next);
  return true;
}

/**
 * Meters in reading order: channel first, then kind, then number. Sorting on
 * the way out rather than on insert keeps the order stable as new controls
 * appear, so a chip never jumps because something else moved.
 */
export function sortedControlMeters(meters: Iterable<ControlMeter>): ControlMeter[] {
  return [...meters].sort(
    (a, b) =>
      a.channel - b.channel ||
      METER_KIND_RANK[a.kind] - METER_KIND_RANK[b.kind] ||
      a.number - b.number,
  );
}

/* ------------------------------------------------------------------ */
/* readers                                                            */
/* ------------------------------------------------------------------ */

function u16(bytes: Uint8Array, pos: number): number {
  return ((bytes[pos] as number) << 8) | (bytes[pos + 1] as number);
}

function u32(bytes: Uint8Array, pos: number): number {
  return (
    (bytes[pos] as number) * 0x1000000 +
    ((bytes[pos + 1] as number) << 16) +
    ((bytes[pos + 2] as number) << 8) +
    (bytes[pos + 3] as number)
  );
}

function ascii(bytes: Uint8Array, pos: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[pos + i] ?? 0);
  return out;
}

/** Decode a meta text payload. Latin-1 avoids mojibake on the common ASCII text. */
function decodeText(bytes: Uint8Array, start: number, length: number): string {
  try {
    return new TextDecoder("latin1").decode(bytes.subarray(start, start + length));
  } catch {
    return ascii(bytes, start, length);
  }
}

function truncated(): ToolError {
  return new ToolError(
    "truncated-track",
    "A track event runs past the end of the file.",
    "The file is cut off or damaged. Re-export it from the source and try again.",
  );
}

/* ------------------------------------------------------------------ */
/* the parser                                                         */
/* ------------------------------------------------------------------ */

function parseDivision(raw: number): MidiDivision {
  if (raw & 0x8000) {
    const hi = (raw >> 8) & 0xff;
    const framesPerSecond = 256 - hi; // stored as a negative SMPTE frame rate
    return { kind: "smpte", framesPerSecond, ticksPerFrame: raw & 0xff };
  }
  return { kind: "ticksPerQuarter", ticksPerQuarter: raw & 0x7fff };
}

function parseMeta(
  bytes: Uint8Array,
  pos: number,
  end: number,
  base: EventBase,
): {
  event: MidiEvent;
  next: number;
} {
  if (pos >= end) throw truncated();
  const metaType = bytes[pos++] as number;
  const { value: length, next } = readVarInt(bytes, pos, end);
  pos = next;
  if (pos + length > end) throw truncated();
  const dataStart = pos;
  const d = (i: number): number => bytes[dataStart + i] as number;
  const after = pos + length;

  let event: MidiEvent;
  if (metaType === 0x2f) {
    event = { ...base, kind: "endOfTrack" };
  } else if (metaType === 0x51 && length === 3) {
    const microsecondsPerQuarter = (d(0) << 16) | (d(1) << 8) | d(2);
    const bpm = microsecondsPerQuarter > 0 ? 60000000 / microsecondsPerQuarter : 0;
    event = { ...base, kind: "tempo", microsecondsPerQuarter, bpm };
  } else if (metaType === 0x58 && length >= 4) {
    event = {
      ...base,
      kind: "timeSignature",
      numerator: d(0),
      denominator: 2 ** d(1),
      clocksPerClick: d(2),
      thirtySecondsPerQuarter: d(3),
    };
  } else if (metaType === 0x59 && length >= 2) {
    const sharpsFlats = (d(0) << 24) >> 24; // sign-extend the signed byte
    const minor = d(1) === 1;
    event = {
      ...base,
      kind: "keySignature",
      sharpsFlats,
      minor,
      key: keySignatureName(sharpsFlats, minor),
    };
  } else if (metaType === 0x00) {
    event = { ...base, kind: "sequenceNumber", number: length >= 2 ? (d(0) << 8) | d(1) : 0 };
  } else if (metaType === 0x20 && length >= 1) {
    event = { ...base, kind: "channelPrefix", channel: d(0) };
  } else if (metaType === 0x21 && length >= 1) {
    event = { ...base, kind: "portPrefix", port: d(0) };
  } else if (metaType >= 0x01 && metaType <= 0x09) {
    event = {
      ...base,
      kind: "text",
      metaType,
      label: TEXT_META_LABELS[metaType] ?? "Text",
      text: decodeText(bytes, dataStart, length),
    };
  } else {
    event = { ...base, kind: "unknownMeta", metaType, byteLength: length };
  }

  return { event, next: after };
}

function parseTrackEvents(bytes: Uint8Array, start: number, end: number, index: number): MidiTrack {
  const events: MidiEvent[] = [];
  let pos = start;
  let tick = 0;
  let running = 0;
  let name: string | undefined;

  while (pos < end) {
    const { value: delta, next } = readVarInt(bytes, pos, end);
    pos = next;
    tick += delta;
    if (pos >= end) throw truncated();

    let status = bytes[pos] as number;
    if (status < 0x80) {
      if (running === 0) {
        throw new ToolError(
          "bad-running-status",
          "A track uses running status before any status byte was seen.",
          "This is not a valid MIDI file, or the track is damaged.",
        );
      }
      status = running;
    } else {
      pos++;
    }

    const base: EventBase = { delta, tick };

    if (status === 0xff) {
      running = 0;
      const meta = parseMeta(bytes, pos, end, base);
      pos = meta.next;
      if (meta.event.kind === "text" && meta.event.metaType === 0x03 && name === undefined) {
        name = meta.event.text;
      }
      events.push(meta.event);
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      running = 0;
      const { value: length, next: n2 } = readVarInt(bytes, pos, end);
      pos = n2;
      if (pos + length > end) throw truncated();
      pos += length;
      events.push({ ...base, kind: "sysex", byteLength: length });
      continue;
    }

    if (status >= 0x80 && status <= 0xef) {
      running = status;
      const dataLen = channelDataLength(status);
      if (pos + dataLen > end) throw truncated();
      const data0 = bytes[pos++] as number;
      const data1 = dataLen === 2 ? (bytes[pos++] as number) : 0;
      const message = decodeChannelMessage(status, data0, data1);
      if (message) events.push({ ...base, ...message });
      continue;
    }

    // A stray system-common or real-time byte inside a file is malformed; skip it.
    running = 0;
  }

  return { index, name, events, endTick: tick };
}

/**
 * Parse a Standard MIDI File from its bytes. Throws a ToolError with a fix hint
 * on anything that is not a well-formed SMF.
 */
export function parseMidi(bytes: Uint8Array): MidiFile {
  if (bytes.length < 14 || ascii(bytes, 0, 4) !== "MThd") {
    throw new ToolError(
      "not-midi",
      'This is not a Standard MIDI File: it does not begin with the "MThd" header.',
      "Pick a .mid or .midi file. Compressed .kar or .xmf files, and audio like .mp3 or .wav, are not MIDI files and cannot be read here.",
    );
  }

  const headerLength = u32(bytes, 4);
  if (headerLength < 6 || 8 + headerLength > bytes.length) {
    throw truncated();
  }

  const format = u16(bytes, 8);
  const trackCount = u16(bytes, 10);
  const division = parseDivision(u16(bytes, 12));

  const header: MidiHeader = { format, trackCount, division };

  const tracks: MidiTrack[] = [];
  let pos = 8 + headerLength;
  let index = 0;
  while (pos + 8 <= bytes.length && tracks.length < (trackCount || Infinity)) {
    const id = ascii(bytes, pos, 4);
    const length = u32(bytes, pos + 4);
    const chunkStart = pos + 8;
    const chunkEnd = chunkStart + length;
    if (chunkEnd > bytes.length) throw truncated();
    if (id === "MTrk") {
      tracks.push(parseTrackEvents(bytes, chunkStart, chunkEnd, index++));
    }
    // Unknown chunk types are skipped, as the SMF spec instructs.
    pos = chunkEnd;
  }

  return { header, tracks };
}

/* ------------------------------------------------------------------ */
/* aggregates                                                         */
/* ------------------------------------------------------------------ */

export interface TempoChange {
  tick: number;
  microsecondsPerQuarter: number;
  bpm: number;
}

/** Every tempo change across every track, sorted by absolute tick. */
export function tempoMap(file: MidiFile): TempoChange[] {
  const changes: TempoChange[] = [];
  for (const track of file.tracks) {
    for (const event of track.events) {
      if (event.kind === "tempo") {
        changes.push({
          tick: event.tick,
          microsecondsPerQuarter: event.microsecondsPerQuarter,
          bpm: event.bpm,
        });
      }
    }
  }
  changes.sort((a, b) => a.tick - b.tick);
  return changes;
}

/** The highest absolute tick reached by any track: the length of the piece in ticks. */
export function totalTicks(file: MidiFile): number {
  let max = 0;
  for (const track of file.tracks) max = Math.max(max, track.endTick);
  return max;
}

/**
 * Playback length in seconds. For tick-per-quarter files it walks the merged
 * tempo map (correct for formats 0 and 1; format 2 tracks are independent, so
 * the merged map is an approximation and the panel says so). For SMPTE division
 * the tick rate is fixed, so it is a straight division.
 */
export function durationSeconds(file: MidiFile): number {
  const end = totalTicks(file);
  const { division } = file.header;

  if (division.kind === "smpte") {
    const ticksPerSecond = division.framesPerSecond * division.ticksPerFrame;
    return ticksPerSecond > 0 ? end / ticksPerSecond : 0;
  }

  const tpq = division.ticksPerQuarter;
  if (tpq <= 0) return 0;

  const changes = tempoMap(file);
  let seconds = 0;
  let lastTick = 0;
  let usPerQuarter = 500000; // 120 BPM until the first tempo event
  for (const change of changes) {
    if (change.tick > end) break;
    const spanTicks = change.tick - lastTick;
    if (spanTicks > 0) seconds += (spanTicks / tpq) * (usPerQuarter / 1000000);
    lastTick = change.tick;
    usPerQuarter = change.microsecondsPerQuarter;
  }
  if (end > lastTick) seconds += ((end - lastTick) / tpq) * (usPerQuarter / 1000000);
  return seconds;
}

/** Count of sounding notes: note-on events with a non-zero velocity. */
export function noteCount(file: MidiFile): number {
  let count = 0;
  for (const track of file.tracks) {
    for (const event of track.events) {
      if (event.kind === "noteOn") count++;
    }
  }
  return count;
}

export function formatDivision(division: MidiDivision): string {
  return division.kind === "ticksPerQuarter"
    ? `${division.ticksPerQuarter} ticks per quarter note`
    : `SMPTE ${division.framesPerSecond} fps, ${division.ticksPerFrame} ticks per frame`;
}

const FORMAT_LABELS: Record<number, string> = {
  0: "single track",
  1: "multi track, one timeline",
  2: "multi track, independent patterns",
};

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* the generic shell surface                                          */
/* ------------------------------------------------------------------ */

/**
 * The pure text summary used by the generic shell and the curl surface. The
 * bespoke panel imports the parser and helpers directly for its richer view.
 */
export function run(input: Uint8Array | string, opts: MidiOpts): Record<string, string> {
  if (typeof input === "string") {
    if (input.trim() === "") {
      throw new ToolError(
        "empty-input",
        "No MIDI file loaded yet.",
        "Drop a .mid or .midi file onto the panel above, or pick one with the file button.",
      );
    }
    throw new ToolError(
      "text-input",
      "A MIDI file is binary, so pasted text cannot be inspected.",
      "Drop the .mid or .midi file itself onto the panel above instead of pasting its contents.",
    );
  }

  const file = parseMidi(input);
  const middleC = middleCOctave(opts);

  const notes = noteCount(file);
  const firstTempo = tempoMap(file)[0];
  let timeSig: string | undefined;
  let keySig: string | undefined;
  for (const track of file.tracks) {
    for (const event of track.events) {
      if (!timeSig && event.kind === "timeSignature") {
        timeSig = `${event.numerator}/${event.denominator}`;
      }
      if (!keySig && event.kind === "keySignature") keySig = event.key;
    }
  }

  const out: Record<string, string> = {
    Format: `${file.header.format} (${FORMAT_LABELS[file.header.format] ?? "unknown"})`,
    Tracks: `${file.tracks.length}${
      file.tracks.length === file.header.trackCount
        ? ""
        : ` (header declares ${file.header.trackCount})`
    }`,
    Division: formatDivision(file.header.division),
    Notes: String(notes),
    Duration: formatDuration(durationSeconds(file)),
  };

  out.Tempo = firstTempo
    ? `${Math.round(firstTempo.bpm)} BPM (${firstTempo.microsecondsPerQuarter} usec per quarter)`
    : "not set (defaults to 120 BPM)";
  if (timeSig) out["Time signature"] = timeSig;
  if (keySig) out["Key signature"] = keySig;

  const named = file.tracks.filter((t) => t.name);
  if (named.length > 0) {
    out["Track names"] = named.map((t) => `${t.index + 1}. ${t.name}`).join("\n");
  }

  // A short, scannable sample of the first track's events, using the note names.
  const firstWithEvents = file.tracks.find((t) => t.events.length > 0);
  if (firstWithEvents) {
    const lines = firstWithEvents.events.slice(0, 12).map((event) => {
      const at = `t${event.tick}`;
      switch (event.kind) {
        case "noteOn":
          return `${at}  note on   ${noteName(event.note, middleC)} vel ${event.velocity} ch ${event.channel + 1}`;
        case "noteOff":
          return `${at}  note off  ${noteName(event.note, middleC)} ch ${event.channel + 1}`;
        case "controlChange":
          return `${at}  cc        ${controllerName(event.controller)} = ${event.value} ch ${event.channel + 1}`;
        case "programChange":
          return `${at}  program   ${event.program} ch ${event.channel + 1}`;
        case "pitchBend":
          return `${at}  pitchbend ${event.value} ch ${event.channel + 1}`;
        case "tempo":
          return `${at}  tempo     ${Math.round(event.bpm)} BPM`;
        case "timeSignature":
          return `${at}  timesig   ${event.numerator}/${event.denominator}`;
        case "keySignature":
          return `${at}  keysig    ${event.key}`;
        case "text":
          return `${at}  ${event.label.toLowerCase()}: ${event.text}`;
        case "endOfTrack":
          return `${at}  end of track`;
        default:
          return `${at}  ${event.kind}`;
      }
    });
    if (firstWithEvents.events.length > 12) {
      lines.push(`... ${firstWithEvents.events.length - 12} more events in this track`);
    }
    out["First track events"] = lines.join("\n");
  }

  return out;
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, MidiOpts>;
