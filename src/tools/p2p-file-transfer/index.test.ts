import { describe, expect, it } from "vitest";
import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  MAX_CHUNK_BYTES,
  MAX_CONTROL_BYTES,
  MAX_FILES_PER_BATCH,
  MAX_SIGNAL_BYTES,
  MIN_CHUNK_BYTES,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  batchBytes,
  chunkCount,
  chunkSize,
  decodeControl,
  encodeControl,
  formatEta,
  generateRoomCode,
  joinFragment,
  parsePeerSignal,
  parseRoomCode,
  parseSignal,
  roomFromFragment,
  run,
  safeFileName,
  sdpFingerprints,
  securityCode,
  transferProgress,
} from "./index";
import { ToolError } from "../types";

const CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

describe("room codes", () => {
  it("generates codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) expect(generateRoomCode()).toMatch(CODE_RE);
  });

  it("is deterministic with a seed", () => {
    expect(generateRoomCode("alpha")).toBe(generateRoomCode("alpha"));
    expect(generateRoomCode("alpha")).not.toBe(generateRoomCode("beta"));
    expect(generateRoomCode("alpha")).toMatch(CODE_RE);
  });

  it("parses codes with spacing, dashes and lower case", () => {
    expect(parseRoomCode("abc def")).toBe("ABCDEF");
    expect(parseRoomCode(" abc-def ")).toBe("ABCDEF");
  });

  it("parses a full join link", () => {
    expect(parseRoomCode("https://tools.maxhogan.dev/p2p-file-transfer#room=XYZ234")).toBe(
      "XYZ234",
    );
  });

  it("rejects the empty string, wrong length, and look-alike characters", () => {
    expect(() => parseRoomCode("")).toThrow(ToolError);
    expect(() => parseRoomCode("ABC")).toThrowError(/6 characters/);
    expect(() => parseRoomCode("ABCDE0")).toThrowError(/cannot appear/);
    expect(() => parseRoomCode("ABCDEI")).toThrow(ToolError);
    expect(() => parseRoomCode("https://example.com/#nope=1")).toThrowError(/does not contain/);
  });

  it("round-trips through the fragment", () => {
    const code = generateRoomCode("frag");
    expect(roomFromFragment(joinFragment(code))).toBe(code);
    expect(roomFromFragment("#room=bad")).toBeNull();
    expect(roomFromFragment("")).toBeNull();
  });
});

describe("signaling parser", () => {
  it("accepts offer, answer, ice and bye", () => {
    expect(parsePeerSignal(JSON.stringify({ type: "offer", sdp: "v=0" }))).toEqual({
      type: "offer",
      sdp: "v=0",
    });
    expect(parsePeerSignal(JSON.stringify({ type: "answer", sdp: "v=0" }))).toEqual({
      type: "answer",
      sdp: "v=0",
    });
    const ice = parsePeerSignal(
      JSON.stringify({
        type: "ice",
        candidate: {
          candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host",
          sdpMid: "0",
          sdpMLineIndex: 0,
          extra: "x",
        },
      }),
    );
    expect(ice).toEqual({
      type: "ice",
      candidate: {
        candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    });
    expect(parsePeerSignal('{"type":"bye"}')).toEqual({ type: "bye" });
  });

  it("refuses binary, oversized, non-JSON, unknown and malformed frames", () => {
    expect(() => parsePeerSignal(new ArrayBuffer(4))).toThrowError(/text/);
    expect(() => parsePeerSignal("x".repeat(MAX_SIGNAL_BYTES + 1))).toThrowError(/too large/);
    expect(() => parsePeerSignal("{nope")).toThrowError(/not JSON/);
    expect(() => parsePeerSignal("[]")).toThrowError(/object/);
    expect(() => parsePeerSignal('{"type":"chat","text":"hi"}')).toThrowError(/Unknown/);
    expect(() => parsePeerSignal('{"type":"offer"}')).toThrowError(/sdp/);
    expect(() => parsePeerSignal('{"type":"ice","candidate":"str"}')).toThrowError(/candidate/);
  });

  it("recognises relay messages and falls back to the peer parser", () => {
    expect(parseSignal('{"type":"joined","role":"host","peerPresent":false}')).toEqual({
      type: "joined",
      role: "host",
      peerPresent: false,
    });
    expect(parseSignal('{"type":"peer-left"}')).toEqual({ type: "peer-left" });
    expect(parseSignal('{"type":"error","code":"full"}')).toEqual({
      type: "error",
      code: "full",
      message: "Signaling error.",
    });
    expect(parseSignal('{"type":"bye"}')).toEqual({ type: "bye" });
    expect(() => parseSignal('{"type":"joined","role":"admin"}')).toThrow(ToolError);
  });
});

describe("control frames", () => {
  it("round-trips a manifest and cleans file names", () => {
    const wire = encodeControl({
      type: "manifest",
      batch: "b1",
      files: [{ id: "f1", name: "../../evil\u0000 .txt", size: 12, type: "text/plain" }],
    });
    const back = decodeControl(wire);
    expect(back).toEqual({
      type: "manifest",
      batch: "b1",
      files: [{ id: "f1", name: ".._.._evil .txt", size: 12, type: "text/plain" }],
    });
  });

  it("round-trips the small messages", () => {
    for (const msg of [
      { type: "hello", name: "Max" },
      { type: "accept", batch: "b" },
      { type: "decline", batch: "b" },
      { type: "file-start", batch: "b", id: "f" },
      { type: "file-end", batch: "b", id: "f" },
      { type: "batch-done", batch: "b" },
      { type: "cancel", batch: "b", reason: "changed my mind" },
    ] as const) {
      expect(decodeControl(encodeControl(msg))).toEqual(msg);
    }
  });

  it("rejects bad frames", () => {
    expect(() => decodeControl(new Uint8Array(2))).toThrowError(/text/);
    expect(() => decodeControl("x".repeat(MAX_CONTROL_BYTES + 1))).toThrowError(/too large/);
    expect(() => decodeControl("{")).toThrowError(/JSON/);
    expect(() => decodeControl('{"type":"manifest","batch":"b","files":[]}')).toThrowError(
      /no files/,
    );
    expect(() =>
      decodeControl('{"type":"manifest","files":[{"id":"a","name":"n","size":1}]}'),
    ).toThrowError(/batch/);
    expect(() =>
      decodeControl(
        JSON.stringify({
          type: "manifest",
          batch: "b",
          files: [
            { id: "a", name: "n", size: 1 },
            { id: "a", name: "m", size: 1 },
          ],
        }),
      ),
    ).toThrowError(/repeat/);
    expect(() =>
      decodeControl(
        JSON.stringify({
          type: "manifest",
          batch: "b",
          files: [{ id: "a", name: "n", size: 1.5 }],
        }),
      ),
    ).toThrowError(/whole number/);
    const many = Array.from({ length: MAX_FILES_PER_BATCH + 1 }, (_, i) => ({
      id: String(i),
      name: "n",
      size: 0,
    }));
    expect(() =>
      decodeControl(JSON.stringify({ type: "manifest", batch: "b", files: many })),
    ).toThrowError(/at most/);
    expect(() => decodeControl('{"type":"file-start","batch":"b"}')).toThrowError(/file ids/);
    expect(() => decodeControl('{"type":"whatever"}')).toThrowError(/Unknown/);
  });

  it("never returns an empty or path-like file name", () => {
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("///")).toBe("_");
    expect(safeFileName("a\\b/c")).toBe("a_b_c");
    expect(safeFileName("x".repeat(400))).toHaveLength(255);
  });
});

describe("chunking and progress", () => {
  it("picks a chunk size within the safe band", () => {
    expect(chunkSize(undefined)).toBe(MIN_CHUNK_BYTES);
    expect(chunkSize(0)).toBe(MIN_CHUNK_BYTES);
    expect(chunkSize(1024)).toBe(MIN_CHUNK_BYTES);
    expect(chunkSize(32 * 1024)).toBe(32 * 1024);
    expect(chunkSize(262144)).toBe(MAX_CHUNK_BYTES);
    expect(BUFFER_LOW_WATER).toBeLessThan(BUFFER_HIGH_WATER);
  });

  it("counts chunks including the exact-multiple boundary and zero", () => {
    expect(chunkCount(0, 16)).toBe(0);
    expect(chunkCount(16, 16)).toBe(1);
    expect(chunkCount(17, 16)).toBe(2);
    expect(chunkCount(64 * 1024, MAX_CHUNK_BYTES)).toBe(1);
  });

  it("computes progress and labels", () => {
    const p = transferProgress(512 * 1024, 1024 * 1024, 1000);
    expect(p.percent).toBe(50);
    expect(p.bytesPerSecond).toBe(512 * 1024);
    expect(p.etaSeconds).toBe(1);
    expect(p.label).toBe("512 KB of 1.0 MB");
    expect(p.rateLabel).toBe("512 KB/s");
    expect(p.etaLabel).toBe("about 1 s left");

    const start = transferProgress(0, 1000, 0);
    expect(start.percent).toBe(0);
    expect(start.rateLabel).toBe("");
    expect(start.etaLabel).toBe("");

    const empty = transferProgress(0, 0, 10);
    expect(empty.percent).toBe(0);
  });

  it("formats an ETA coarsely", () => {
    expect(formatEta(0.2)).toBe("1 s");
    expect(formatEta(59)).toBe("59 s");
    expect(formatEta(125)).toBe("2 min");
    expect(formatEta(4380)).toBe("1 h 13 min");
    expect(formatEta(7200)).toBe("2 h");
    expect(formatEta(-1)).toBe("");
  });

  it("sums a batch", () => {
    expect(
      batchBytes([
        { id: "a", name: "a", size: 3, type: "" },
        { id: "b", name: "b", size: 4, type: "" },
      ]),
    ).toBe(7);
    expect(batchBytes([])).toBe(0);
  });
});

const SDP_A =
  "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
const SDP_B = "v=0\r\na=fingerprint:sha-256 DD:EE:FF\r\n";

describe("security code", () => {
  it("extracts fingerprints", () => {
    expect(sdpFingerprints(SDP_A)).toEqual(["sha-256 aa:bb:cc"]);
    expect(sdpFingerprints("v=0")).toEqual([]);
  });

  it("is identical from both ends and changes with either fingerprint", async () => {
    const ab = await securityCode(SDP_A, SDP_B);
    const ba = await securityCode(SDP_B, SDP_A);
    expect(ab).toBe(ba);
    expect(ab).toMatch(new RegExp(`^[${ROOM_ALPHABET}]{4} [${ROOM_ALPHABET}]{4}$`));
    const other = await securityCode(SDP_A, SDP_B.replace("DD", "D1"));
    expect(other).not.toBe(ab);
  });

  it("throws before both fingerprints are known", async () => {
    await expect(securityCode(SDP_A, "v=0")).rejects.toThrow(ToolError);
  });
});

describe("run", () => {
  it("mints a room when given nothing", () => {
    const out = run("", { seed: "pinned" });
    const code = generateRoomCode("pinned");
    expect(out["Room code"]).toBe(`${code.slice(0, 3)} ${code.slice(3)}`);
    expect(out["Join link"]).toBe(`/p2p-file-transfer#room=${code}`);
    expect(run(undefined, { seed: "pinned" })).toEqual(out);
  });

  it("normalises a typed code or pasted link", () => {
    expect(run("abc def")["Join link"]).toBe("/p2p-file-transfer#room=ABCDEF");
    expect(run("https://tools.maxhogan.dev/p2p-file-transfer#room=ABCDEF")["Room code"]).toBe(
      "ABC DEF",
    );
  });

  it("surfaces a ToolError for junk", () => {
    expect(() => run("hello world")).toThrow(ToolError);
  });
});
