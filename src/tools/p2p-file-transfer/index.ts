import { ToolError, type ToolLogic } from "../types";
import { formatBytes } from "../../lib/format";

/**
 * The protocol core of Local File Drop.
 *
 * The panel owns everything only a browser can hold: the signaling
 * WebSocket, the RTCPeerConnection, the data channel, the files. This module
 * owns everything that has to be agreed on by both ends and by the relay in
 * the worker: the shape of a room code, the exact set of signaling messages
 * the relay will forward, the framing of the transfer protocol on the data
 * channel, the chunk plan, progress math and the security code that lets two
 * people confirm nobody sits between them. Keeping it pure means the sender,
 * the receiver and the relay can never disagree about what a message means,
 * and every rule the relay enforces is unit tested here.
 */

/* ------------------------------------------------------------------ *
 * room codes
 * ------------------------------------------------------------------ */

/**
 * 32 symbols with the look-alikes removed (no 0/O, no 1/I), so a code read
 * out loud or copied off a phone screen survives the trip.
 */
export const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
/** URL slug of the tool, needed to build a join link. */
export const TOOL_PATH = "/p2p-file-transfer";
/** Fragment key that carries the room code in a join link. */
export const ROOM_FRAGMENT_KEY = "room";
/** URL prefix, under the worker's /api, of the signaling room WebSocket. */
export const SIGNAL_PATH_PREFIX = "/api/p2p-file-transfer/room/";

/** Small deterministic PRNG so tests can pin exact codes (authoring rule 2). */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = h >>> 0 || 0x9e3779b9;
  let y = 362436069;
  let z = 521288629;
  let w = 88675123;
  return () => {
    const t = x ^ (x << 11);
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w / 4294967296;
  };
}

/** Generates a fresh room code. With a seed the result is deterministic. */
export function generateRoomCode(seed?: string): string {
  const n = ROOM_ALPHABET.length;
  let out = "";
  if (seed) {
    const rnd = seededRandom(seed);
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_ALPHABET[Math.floor(rnd() * n)];
    return out;
  }
  // 32 symbols divide 256 evenly, so a byte masked to 5 bits has no bias.
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_ALPHABET[bytes[i] & 31];
  return out;
}

/**
 * Turns whatever a person typed or pasted into a canonical room code: a bare
 * code with any spacing or dashes, or a full join link. Throws when it cannot
 * be a code at all, and says why.
 */
export function parseRoomCode(input: string): string {
  let text = input.trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "Enter a room code.",
      "The other device shows a six character code; type it here or open its link.",
    );

  // A pasted join link: take the fragment.
  const hashAt = text.indexOf("#");
  if (hashAt >= 0 && /^[a-z]+:\/\//i.test(text)) {
    const fromLink = roomFromFragment(text.slice(hashAt));
    if (!fromLink) {
      throw new ToolError(
        "no-room-in-link",
        "That link does not contain a room code.",
        `A join link ends in #${ROOM_FRAGMENT_KEY}=CODE. Copy it again from the other device.`,
      );
    }
    text = fromLink;
  }

  const cleaned = text.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length !== ROOM_CODE_LENGTH) {
    throw new ToolError(
      "bad-length",
      `A room code is ${ROOM_CODE_LENGTH} characters, this one is ${cleaned.length}.`,
      "Check the code on the other device and try again.",
    );
  }
  for (const ch of cleaned) {
    if (!ROOM_ALPHABET.includes(ch)) {
      const hint =
        ch === "0" || ch === "O"
          ? "Codes never contain 0 or O; that character is probably a Q or a D."
          : ch === "1" || ch === "I" || ch === "L"
            ? "Codes never contain 1, I or L; that character is probably a J or a T."
            : `Codes only use the letters A to Z (except I and O) and digits 2 to 9.`;
      throw new ToolError("bad-character", `"${ch}" cannot appear in a room code.`, hint);
    }
  }
  return cleaned;
}

/** Fragment (with leading #) that a join link carries. */
export function joinFragment(code: string): string {
  return `#${ROOM_FRAGMENT_KEY}=${code}`;
}

/** Room code held in a fragment string, or null when there is none. */
export function roomFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const raw = params.get(ROOM_FRAGMENT_KEY);
  if (!raw) return null;
  try {
    return parseRoomCode(raw);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * signaling: what the relay accepts and forwards
 * ------------------------------------------------------------------ */

/**
 * The relay forwards SDP and ICE only (PROJECT.md server policy, rule 4).
 * Anything outside this list is dropped on the floor, which is what keeps
 * the signaling room from ever being usable as a general message channel.
 */
export type PeerSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | {
      type: "ice";
      candidate: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
        usernameFragment?: string | null;
      };
    }
  | { type: "bye" };

/** Messages the relay itself sends to a socket. */
export type RelaySignal =
  | { type: "joined"; role: "host" | "guest"; peerPresent: boolean }
  | { type: "peer-joined" }
  | { type: "peer-left" }
  | { type: "error"; code: string; message: string };

export type Signal = PeerSignal | RelaySignal;

/** Hard cap on one signaling frame. Real SDP is a few KB; this is generous. */
export const MAX_SIGNAL_BYTES = 16 * 1024;
/** Signaling frames one socket may send in a room's lifetime. */
export const MAX_SIGNALS_PER_PEER = 200;
/** How long a room lives with nobody connected through it, in milliseconds. */
export const ROOM_TTL_MS = 10 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses one raw signaling frame from a peer and returns it only if it is one
 * of the messages the relay is allowed to forward. Everything else throws.
 * The relay calls this before forwarding; the panel calls it on receipt so a
 * hostile peer cannot push it into an unexpected state either.
 */
export function parsePeerSignal(raw: unknown): PeerSignal {
  if (typeof raw !== "string")
    throw new ToolError("binary-signal", "Signaling frames must be text.");
  if (raw.length > MAX_SIGNAL_BYTES)
    throw new ToolError("signal-too-large", "Signaling frame too large.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ToolError("bad-json", "Signaling frame is not JSON.");
  }
  if (!isRecord(value)) throw new ToolError("bad-shape", "Signaling frame must be an object.");
  switch (value.type) {
    case "offer":
    case "answer": {
      if (typeof value.sdp !== "string" || !value.sdp)
        throw new ToolError("bad-sdp", `${value.type} needs an sdp string.`);
      return { type: value.type, sdp: value.sdp };
    }
    case "ice": {
      const c = value.candidate;
      if (!isRecord(c) || typeof c.candidate !== "string")
        throw new ToolError("bad-candidate", "ice needs a candidate object.");
      const out: PeerSignal = { type: "ice", candidate: { candidate: c.candidate } };
      if (typeof c.sdpMid === "string" || c.sdpMid === null) out.candidate.sdpMid = c.sdpMid;
      if (typeof c.sdpMLineIndex === "number" || c.sdpMLineIndex === null)
        out.candidate.sdpMLineIndex = c.sdpMLineIndex;
      if (typeof c.usernameFragment === "string" || c.usernameFragment === null)
        out.candidate.usernameFragment = c.usernameFragment;
      return out;
    }
    case "bye":
      return { type: "bye" };
    default:
      throw new ToolError("unknown-signal", "Unknown signaling message type.");
  }
}

/** Parses a frame that may come from either the relay or the peer. */
export function parseSignal(raw: unknown): Signal {
  if (typeof raw === "string" && raw.length <= MAX_SIGNAL_BYTES) {
    try {
      const value: unknown = JSON.parse(raw);
      if (isRecord(value)) {
        if (value.type === "joined" && (value.role === "host" || value.role === "guest"))
          return { type: "joined", role: value.role, peerPresent: value.peerPresent === true };
        if (value.type === "peer-joined" || value.type === "peer-left") return { type: value.type };
        if (value.type === "error")
          return {
            type: "error",
            code: typeof value.code === "string" ? value.code : "unknown",
            message: typeof value.message === "string" ? value.message : "Signaling error.",
          };
      }
    } catch {
      // Fall through to the peer parser, which produces the precise error.
    }
  }
  return parsePeerSignal(raw);
}

/* ------------------------------------------------------------------ *
 * the data channel protocol
 * ------------------------------------------------------------------ */

export interface FileEntry {
  /** Sender-chosen id, unique within a batch. */
  id: string;
  name: string;
  size: number;
  type: string;
}

/**
 * Text frames on the data channel. Binary frames are always file bytes for
 * the file most recently announced with `file-start`, in order. A batch is
 * offered with `manifest`, the other side answers `accept` or `decline`, and
 * every file is bracketed by `file-start` and `file-end`. `cancel` may come
 * from either side at any time.
 */
export type ControlMessage =
  | { type: "hello"; name: string }
  | { type: "manifest"; batch: string; files: FileEntry[] }
  | { type: "accept"; batch: string }
  | { type: "decline"; batch: string }
  | { type: "file-start"; batch: string; id: string }
  | { type: "file-end"; batch: string; id: string }
  | { type: "batch-done"; batch: string }
  | { type: "cancel"; batch: string; reason?: string };

/** Longest text frame we will parse. Manifests list names, so allow room. */
export const MAX_CONTROL_BYTES = 256 * 1024;
/** Files per batch, so a manifest stays a sane size. */
export const MAX_FILES_PER_BATCH = 500;
/** Length cap on a received file name; longer names are trimmed, not refused. */
export const MAX_NAME_LENGTH = 255;

export function encodeControl(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

/**
 * Strips path separators and control characters from a name that came over
 * the wire, so a hostile peer cannot suggest "../../evil" as a filename.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  const trimmed = cleaned.slice(0, MAX_NAME_LENGTH);
  return trimmed || "file";
}

function parseFileEntry(v: unknown): FileEntry {
  if (!isRecord(v)) throw new ToolError("bad-file-entry", "File entry must be an object.");
  if (typeof v.id !== "string" || !v.id)
    throw new ToolError("bad-file-entry", "File entry needs an id.");
  if (typeof v.name !== "string") throw new ToolError("bad-file-entry", "File entry needs a name.");
  if (
    typeof v.size !== "number" ||
    !Number.isFinite(v.size) ||
    v.size < 0 ||
    !Number.isInteger(v.size)
  )
    throw new ToolError("bad-file-entry", "File entry needs a whole number size.");
  return {
    id: v.id,
    name: safeFileName(v.name),
    size: v.size,
    type: typeof v.type === "string" ? v.type : "",
  };
}

export function decodeControl(raw: unknown): ControlMessage {
  if (typeof raw !== "string")
    throw new ToolError("binary-control", "Control frames must be text.");
  if (raw.length > MAX_CONTROL_BYTES)
    throw new ToolError("control-too-large", "Control frame too large.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ToolError("bad-json", "Control frame is not JSON.");
  }
  if (!isRecord(value)) throw new ToolError("bad-shape", "Control frame must be an object.");
  const batch = typeof value.batch === "string" ? value.batch : "";
  const id = typeof value.id === "string" ? value.id : "";
  switch (value.type) {
    case "hello":
      return { type: "hello", name: typeof value.name === "string" ? value.name.slice(0, 64) : "" };
    case "manifest": {
      if (!batch) throw new ToolError("bad-batch", "manifest needs a batch id.");
      if (!Array.isArray(value.files) || value.files.length === 0)
        throw new ToolError("empty-manifest", "manifest lists no files.");
      if (value.files.length > MAX_FILES_PER_BATCH)
        throw new ToolError(
          "too-many-files",
          `A batch may hold at most ${MAX_FILES_PER_BATCH} files.`,
        );
      const files = value.files.map(parseFileEntry);
      const ids = new Set(files.map((f) => f.id));
      if (ids.size !== files.length)
        throw new ToolError("duplicate-file-id", "File ids repeat in manifest.");
      return { type: "manifest", batch, files };
    }
    case "accept":
    case "decline":
    case "batch-done":
      if (!batch) throw new ToolError("bad-batch", `${value.type} needs a batch id.`);
      return { type: value.type, batch };
    case "file-start":
    case "file-end":
      if (!batch || !id)
        throw new ToolError("bad-file-ref", `${value.type} needs batch and file ids.`);
      return { type: value.type, batch, id };
    case "cancel": {
      if (!batch) throw new ToolError("bad-batch", "cancel needs a batch id.");
      const out: ControlMessage = { type: "cancel", batch };
      if (typeof value.reason === "string") out.reason = value.reason.slice(0, 200);
      return out;
    }
    default:
      throw new ToolError("unknown-control", "Unknown control message type.");
  }
}

/* ------------------------------------------------------------------ *
 * chunking, buffering, progress
 * ------------------------------------------------------------------ */

/** Never send less than this per frame; every implementation handles it. */
export const MIN_CHUNK_BYTES = 16 * 1024;
/** Frames larger than this buy nothing and start to hurt on Firefox. */
export const MAX_CHUNK_BYTES = 64 * 1024;
/** Stop feeding the channel above this much unsent data. */
export const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
/** Resume feeding once buffered data drops below this. */
export const BUFFER_LOW_WATER = 1024 * 1024;

/**
 * Chunk size to use given the SCTP maxMessageSize the remote advertised.
 * Undefined or zero means the browser did not say, so stay at the floor.
 */
export function chunkSize(maxMessageSize?: number): number {
  if (!maxMessageSize || !Number.isFinite(maxMessageSize) || maxMessageSize <= 0)
    return MIN_CHUNK_BYTES;
  return Math.max(MIN_CHUNK_BYTES, Math.min(MAX_CHUNK_BYTES, Math.floor(maxMessageSize)));
}

/** Number of frames a file of `size` bytes takes at `chunk` bytes each. */
export function chunkCount(size: number, chunk: number): number {
  if (size <= 0) return 0;
  return Math.ceil(size / chunk);
}

export interface Progress {
  /** 0 to 100, already rounded to one decimal. */
  percent: number;
  bytesPerSecond: number;
  /** Seconds remaining at the current rate, or null when unknowable. */
  etaSeconds: number | null;
  /** "1.2 MB of 40 MB", using the shared byte formatter. */
  label: string;
  /** "3.4 MB/s" or "" before the first byte. */
  rateLabel: string;
  /** "about 12 s left" or "" when unknowable. */
  etaLabel: string;
}

/** Progress of a transfer given bytes done, bytes total and elapsed time. */
export function transferProgress(done: number, total: number, elapsedMs: number): Progress {
  const percent =
    total > 0 ? Math.round(Math.min(1, done / total) * 1000) / 10 : done > 0 ? 100 : 0;
  const bytesPerSecond = elapsedMs > 0 && done > 0 ? (done / elapsedMs) * 1000 : 0;
  const remaining = Math.max(0, total - done);
  const etaSeconds = bytesPerSecond > 0 && total > 0 ? remaining / bytesPerSecond : null;
  return {
    percent,
    bytesPerSecond,
    etaSeconds,
    label: `${formatBytes(done)} of ${formatBytes(total)}`,
    rateLabel: bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : "",
    etaLabel: etaSeconds === null ? "" : `about ${formatEta(etaSeconds)} left`,
  };
}

/** "8 s", "2 min", "1 h 12 min": coarse on purpose, an ETA is a guess. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${Math.max(1, s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

/** Sum of the sizes in a manifest. */
export function batchBytes(files: FileEntry[]): number {
  return files.reduce((n, f) => n + f.size, 0);
}

/* ------------------------------------------------------------------ *
 * the security code
 * ------------------------------------------------------------------ */

/** Pulls every DTLS fingerprint out of an SDP blob, lowercased. */
export function sdpFingerprints(sdp: string): string[] {
  const out: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:\s*(\S+)\s+(\S+)/i.exec(line);
    if (m) out.push(`${m[1].toLowerCase()} ${m[2].toLowerCase()}`);
  }
  return out;
}

/**
 * A short code both people can read out to each other. It hashes the DTLS
 * fingerprints from both ends, sorted so each side computes the same string,
 * and renders 8 symbols from the room alphabet in two groups. Because the
 * relay only ever sees the SDP, an attacker who swapped fingerprints in
 * transit would produce two different codes, one on each screen.
 */
export async function securityCode(localSdp: string, remoteSdp: string): Promise<string> {
  const prints = [...sdpFingerprints(localSdp), ...sdpFingerprints(remoteSdp)].sort();
  if (prints.length < 2) {
    throw new ToolError(
      "no-fingerprint",
      "Could not find a DTLS fingerprint on both sides.",
      "The connection is not established yet, or the browser did not include one in its SDP.",
    );
  }
  const data = new TextEncoder().encode(prints.join("\n"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += " ";
    out += ROOM_ALPHABET[digest[i] & 31];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * run(): the text surface
 * ------------------------------------------------------------------ */

export interface DropOptions {
  /** Deterministic code generation for tests. */
  seed?: string;
}

/**
 * The paste surface: given nothing, mints a room; given a code or a join
 * link, normalizes it and shows the link the other device should open. The
 * live panel does the actual moving of files.
 */
export function run(input: string | undefined, opts: DropOptions = {}): Record<string, string> {
  const text = (input ?? "").trim();
  const code = text ? parseRoomCode(text) : generateRoomCode(opts.seed);
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  return {
    "Room code": spaced,
    "Join link": `${TOOL_PATH}${joinFragment(code)}`,
    "How it works":
      "Open the join link on the other device (or type the code there). The two browsers connect directly over WebRTC and files travel between them, never through a server.",
  };
}

export default { run } satisfies ToolLogic<string | undefined, Record<string, string>, DropOptions>;
