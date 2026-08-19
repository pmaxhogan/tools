import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_META_EVERY,
  FOUNTAIN_CYCLE_FACTOR,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  QR_BYTE_CAPACITY,
  Receiver,
  SIZE_VERSIONS,
  buildFrameBytes,
  createFrameSource,
  crc32,
  decodeFrame,
  encodeFrame,
  encodeFrames,
  estimateTransfer,
  formatDuration,
  fountainIndices,
  frameToQrMatrix,
  fromBase64Url,
  makeTransferId,
  moduleCountForVersion,
  parseFrame,
  planTransfer,
  run,
  solitonDegree,
  toBase64Url,
} from "./index";
import { ToolError } from "../types";

const OPTS = {
  size: "medium",
  ecc: "M",
  mode: "fountain",
  fps: 10,
  fileName: "notes.txt",
  seed: "test-seed",
};

/** Deterministic pseudo random bytes, so every assertion is reproducible. */
function makePayload(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/** The ToolError code a thrown call produced, or "no-error". */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return (e as ToolError).code;
  }
  return "no-error";
}

/** mulberry32, so the test picks its own frame subsets deterministically. */
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: primitives", () => {
  it("round trips arbitrary bytes through base64url", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255, 1000]) {
      const bytes = makePayload(length, length + 7);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect([...fromBase64Url(text)]).toEqual([...bytes]);
    }
  });

  it("rejects text that is not base64url", () => {
    expect(codeOf(() => fromBase64Url("abc$def"))).toBe("bad-frame");
    expect(codeOf(() => fromBase64Url("abcde"))).toBe("bad-frame");
    expect(codeOf(() => fromBase64Url("héllo"))).toBe("bad-frame");
  });

  it("computes the standard IEEE CRC32", () => {
    // "123456789" is the canonical CRC32 check vector.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("derives a repeatable transfer id from a seed and a random one without", () => {
    expect(makeTransferId("abc")).toBe(makeTransferId("abc"));
    expect(makeTransferId("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(makeTransferId("abc")).not.toBe(makeTransferId("xyz"));
    expect(makeTransferId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("keeps soliton degrees inside 1..K, including K = 1", () => {
    expect(solitonDegree(0.5, 1)).toBe(1);
    for (const k of [1, 2, 5, 40, 400]) {
      for (const u of [0, 0.01, 0.25, 0.5, 0.75, 0.999, 1]) {
        const d = solitonDegree(u, k);
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(k);
      }
    }
  });

  it("formats durations without inventing units", () => {
    expect(formatDuration(3.24)).toBe("3.2 s");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(72)).toBe("1 min 12 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(7500)).toBe("2 h 5 min");
    expect(formatDuration(-1)).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: capacity table", () => {
  // The chunk sizing is only correct if the capacity numbers are, so check every
  // one of them against the encoder rather than trusting a table from memory.
  // Lowercase letters are outside the alphanumeric charset, so the encoder is
  // forced into byte mode, which is what these numbers describe.
  for (const [versionKey, levels] of Object.entries(QR_BYTE_CAPACITY)) {
    const version = Number(versionKey);
    for (const [ecc, capacity] of Object.entries(levels)) {
      it(`version ${version} at ${ecc} holds exactly ${capacity} bytes`, () => {
        const level = ecc as "L" | "M";
        expect(() =>
          QRCode.create("a".repeat(capacity), { version, errorCorrectionLevel: level }),
        ).not.toThrow();
        expect(() =>
          QRCode.create("a".repeat(capacity + 1), { version, errorCorrectionLevel: level }),
        ).toThrow();
      });
    }
  }
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: planning", () => {
  it("sizes chunks against the meta header so every frame is uniform", () => {
    const plan = planTransfer(makePayload(5000), OPTS);
    const nameBytes = new TextEncoder().encode("notes.txt").length;
    const capacity = QR_BYTE_CAPACITY[SIZE_VERSIONS.medium].M;
    expect(plan.capacity).toBe(capacity);
    expect(plan.frameBytes).toBe(Math.floor((capacity * 3) / 4));
    expect(plan.chunkSize).toBe(plan.frameBytes - (HEADER_BYTES + 1 + nameBytes));
    expect(plan.totalChunks).toBe(Math.ceil(5000 / plan.chunkSize));
    expect(plan.version).toBe(15);
    expect(plan.moduleCount).toBe(moduleCountForVersion(15));
    expect(plan.metaEvery).toBe(DEFAULT_META_EVERY);
  });

  it("every frame fits the pinned QR version", () => {
    for (const size of ["small", "medium", "large", "max"]) {
      for (const ecc of ["L", "M"]) {
        const source = createFrameSource(makePayload(4000), { ...OPTS, size, ecc });
        for (const i of [0, 1, 2, source.totalChunks - 1, source.totalChunks + 3]) {
          const text = source.nextFrame(i);
          expect(text.length).toBeLessThanOrEqual(source.capacity);
          expect(frameToQrMatrix(text, ecc, source.version).version).toBe(source.version);
        }
      }
    }
  });

  it("quotes a longer cycle for fountain than for sequential", () => {
    const seq = planTransfer(makePayload(5000), { ...OPTS, mode: "sequential" });
    const fountain = planTransfer(makePayload(5000), { ...OPTS, mode: "fountain" });
    expect(seq.framesPerCycle).toBe(seq.totalChunks);
    expect(fountain.framesPerCycle).toBe(fountain.totalChunks * FOUNTAIN_CYCLE_FACTOR);
    expect(FOUNTAIN_CYCLE_FACTOR).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: frame codec", () => {
  it("round trips a frame through encode and decode", () => {
    const data = makePayload(64, 3);
    const text = encodeFrame({
      transferId: "0badf00d",
      mode: "fountain",
      index: 1234,
      totalChunks: 42,
      totalLength: 9999,
      chunkSize: 280,
      fileName: "report.pdf",
      data,
    });
    const frame = decodeFrame(text);
    expect(frame.transferId).toBe("0badf00d");
    expect(frame.mode).toBe("fountain");
    expect(frame.index).toBe(1234);
    expect(frame.totalChunks).toBe(42);
    expect(frame.totalLength).toBe(9999);
    expect(frame.chunkSize).toBe(280);
    expect(frame.fileName).toBe("report.pdf");
    expect([...frame.data]).toEqual([...data]);
    expect(frame.crc).toBe(crc32(data));
  });

  it("omits the file name on non meta frames", () => {
    const source = createFrameSource(makePayload(5000), OPTS);
    expect(decodeFrame(source.nextFrame(0)).fileName).toBe("notes.txt");
    expect(decodeFrame(source.nextFrame(1)).fileName).toBeUndefined();
    expect(decodeFrame(source.nextFrame(DEFAULT_META_EVERY)).fileName).toBe("notes.txt");
  });

  it("rejects a frame whose checksum does not match", () => {
    const source = createFrameSource(makePayload(2000), OPTS);
    const bytes = fromBase64Url(source.nextFrame(1));
    bytes[bytes.length - 1] ^= 0xff;
    expect(codeOf(() => parseFrame(bytes))).toBe("bad-crc");
    expect(codeOf(() => decodeFrame(toBase64Url(bytes)))).toBe("bad-crc");
  });

  it("rejects frames that are short, foreign or truncated", () => {
    expect(codeOf(() => parseFrame(new Uint8Array(4)))).toBe("bad-frame");
    expect(codeOf(() => parseFrame(new Uint8Array(HEADER_BYTES + 4)))).toBe("bad-frame");
    expect(codeOf(() => decodeFrame("https://example.com"))).toBe("bad-frame");

    // A well formed frame whose declared name length runs off the end.
    const good = buildFrameBytes({
      transferId: "00112233",
      mode: "sequential",
      index: 0,
      totalChunks: 1,
      totalLength: 4,
      chunkSize: 4,
      fileName: "a.txt",
      data: makePayload(4, 9),
    });
    const truncated = good.subarray(0, HEADER_BYTES + 3);
    expect(codeOf(() => parseFrame(truncated))).toBe("bad-frame");
  });

  it("refuses a file name too long for the header", () => {
    expect(
      codeOf(() =>
        encodeFrame({
          transferId: "00112233",
          mode: "sequential",
          index: 0,
          totalChunks: 1,
          totalLength: 1,
          chunkSize: 1,
          fileName: "n".repeat(300),
          data: new Uint8Array(1),
        }),
      ),
    ).toBe("bad-option");
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: sequential round trip", () => {
  const payload = makePayload(5000, 11);

  it("rebuilds the payload and the name from a full pass", () => {
    const frames = encodeFrames(payload, { ...OPTS, mode: "sequential" });
    const receiver = new Receiver();
    let last = receiver.status;
    for (const frame of frames) last = receiver.ingest(frame);

    expect(last.done).toBe(true);
    expect(last.progress).toBe(1);
    expect(last.missing).toEqual([]);
    expect(last.file?.name).toBe("notes.txt");
    expect([...(last.file?.bytes ?? [])]).toEqual([...payload]);
  });

  it("does not care about frame order and shrugs off duplicates", () => {
    const frames = encodeFrames(payload, { ...OPTS, mode: "sequential" });
    const shuffled = [...frames].reverse();
    const receiver = new Receiver();

    // Every frame twice, back to front.
    let redundantSeen = 0;
    let last = receiver.status;
    for (const frame of [...shuffled, ...shuffled]) {
      last = receiver.ingest(frame);
      if (last.redundant) redundantSeen++;
    }
    expect(redundantSeen).toBeGreaterThan(0);
    expect(last.done).toBe(true);
    expect([...(last.file?.bytes ?? [])]).toEqual([...payload]);
  });

  it("reports the chunks it is still missing mid transfer", () => {
    const frames = encodeFrames(payload, { ...OPTS, mode: "sequential" });
    const receiver = new Receiver();
    for (const [i, frame] of frames.entries()) if (i % 2 === 0) receiver.ingest(frame);

    const status = receiver.status;
    expect(status.done).toBe(false);
    expect(status.missing).toEqual(
      frames.map((_, i) => i).filter((i) => i % 2 === 1),
    );
    expect(status.progress).toBeGreaterThan(0.4);
    expect(status.progress).toBeLessThan(0.6);
  });

  it("handles a payload that fits in a single chunk", () => {
    const tiny = new TextEncoder().encode("hello air gap");
    const receiver = new Receiver();
    const result = receiver.ingest(
      encodeFrames(tiny, { ...OPTS, mode: "sequential" })[0] as string,
    );
    expect(result.done).toBe(true);
    expect(new TextDecoder().decode(result.file?.bytes)).toBe("hello air gap");
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: fountain mode", () => {
  const payload = makePayload(5000, 23);

  it("derives the same chunk subset on both sides", () => {
    const source = createFrameSource(payload, { ...OPTS, size: "small" });
    for (const i of [0, 3, source.totalChunks, source.totalChunks + 17, 900]) {
      const frame = decodeFrame(source.nextFrame(i));
      const senderSide = fountainIndices(source.transferId, i % 65536, source.totalChunks);
      const receiverSide = fountainIndices(frame.transferId, frame.index, frame.totalChunks);
      expect(receiverSide).toEqual(senderSide);
    }
    // Every cycle opens with a systematic pass: position p carries chunk p.
    expect(fountainIndices("0badf00d", 5, 40)).toEqual([5]);
    expect(fountainIndices("0badf00d", 40 * FOUNTAIN_CYCLE_FACTOR + 5, 40)).toEqual([5]);
    // Positions after that pass are combinations of at least two chunks.
    expect(fountainIndices("0badf00d", 40, 40).length).toBeGreaterThanOrEqual(2);
    expect(fountainIndices("0badf00d", 99, 40).length).toBeGreaterThanOrEqual(2);
  });

  it("decodes from a random 70 percent of one cycle, over many seeds", () => {
    // The interesting property is not that one lucky seed works: it is that a
    // camera dropping three frames in ten finishes inside a single cycle
    // essentially every time. 60 independent runs, none allowed to fail.
    for (let trial = 0; trial < 60; trial++) {
      const frames = encodeFrames(payload, { ...OPTS, size: "small", seed: `run-${trial}` });
      const rng = rngFrom(20260819 + trial * 7919);
      const kept = frames.filter(() => rng() < 0.7);
      expect(kept.length).toBeLessThan(frames.length);

      const receiver = new Receiver();
      let last = receiver.status;
      for (const frame of kept) last = receiver.ingest(frame);

      expect(last.done).toBe(true);
      expect(last.file?.name).toBe("notes.txt");
      expect([...(last.file?.bytes ?? [])]).toEqual([...payload]);
    }
  });

  it("decodes for a receiver that joins in the middle of a cycle", () => {
    const source = createFrameSource(payload, { ...OPTS, size: "small" });
    const start = source.framesPerCycle + Math.floor(source.totalChunks * 1.5);
    const receiver = new Receiver();
    let last = receiver.status;
    for (let i = start; i < start + source.framesPerCycle * 2 && !last.done; i++) {
      last = receiver.ingest(source.nextFrame(i));
    }
    expect(last.done).toBe(true);
    expect([...(last.file?.bytes ?? [])]).toEqual([...payload]);
  });

  it("falls back to a generic name when no meta frame is ever seen, then keeps a late one", () => {
    const source = createFrameSource(payload, { ...OPTS, size: "small" });
    const receiver = new Receiver();
    let last = receiver.status;
    for (let i = 1; i < source.framesPerCycle * 3 && !last.done; i++) {
      const frame = source.nextFrame(i);
      if (decodeFrame(frame).fileName) continue; // drop every frame carrying the name
      last = receiver.ingest(frame);
    }
    expect(last.done).toBe(true);
    expect(last.file?.name).toBe("file.bin");
    expect([...(last.file?.bytes ?? [])]).toEqual([...payload]);

    // A meta frame arriving after the payload is complete still names the file.
    const named = receiver.ingest(source.nextFrame(0));
    expect(named.done).toBe(true);
    expect(named.file?.name).toBe("notes.txt");
  });

  it("works when the whole payload fits in one chunk", () => {
    const tiny = new TextEncoder().encode("one chunk only");
    const source = createFrameSource(tiny, OPTS);
    expect(source.totalChunks).toBe(1);
    const receiver = new Receiver();
    const result = receiver.ingest(source.nextFrame(7));
    expect(result.done).toBe(true);
    expect(new TextDecoder().decode(result.file?.bytes)).toBe("one chunk only");
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: receiver hygiene", () => {
  it("ignores junk without throwing", () => {
    const receiver = new Receiver();
    for (const junk of ["", "https://example.com", "not base64 $$$", "AAAA"]) {
      const result = receiver.ingest(junk);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(result.done).toBe(false);
    }
    expect(receiver.status.total).toBe(0);
  });

  it("locks onto the first transfer and ignores a second one nearby", () => {
    const a = createFrameSource(makePayload(3000, 5), { ...OPTS, seed: "alpha" });
    const b = createFrameSource(makePayload(3000, 6), { ...OPTS, seed: "bravo" });
    expect(a.transferId).not.toBe(b.transferId);

    const receiver = new Receiver();
    receiver.ingest(a.nextFrame(0));
    const foreign = receiver.ingest(b.nextFrame(0));
    expect(foreign.accepted).toBe(false);
    expect(foreign.reason).toMatch(/different transfer/i);
    expect(foreign.transferId).toBe(a.transferId);
  });

  it("rejects a frame whose header contradicts the transfer in progress", () => {
    const source = createFrameSource(makePayload(3000, 8), OPTS);
    const receiver = new Receiver();
    receiver.ingest(source.nextFrame(0));

    const frame = decodeFrame(source.nextFrame(1));
    const forged = encodeFrame({ ...frame, totalLength: frame.totalLength + 1 });
    const result = receiver.ingest(forged);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/does not match/i);
  });

  it("rejects a sequential frame pointing outside the payload", () => {
    const source = createFrameSource(makePayload(3000, 9), { ...OPTS, mode: "sequential" });
    const receiver = new Receiver();
    receiver.ingest(source.nextFrame(0));

    const frame = decodeFrame(source.nextFrame(1));
    const forged = encodeFrame({ ...frame, index: frame.totalChunks + 5 });
    const result = receiver.ingest(forged);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/outside the payload/i);
  });

  it("resets back to an empty state", () => {
    const source = createFrameSource(makePayload(3000, 10), OPTS);
    const receiver = new Receiver();
    receiver.ingest(source.nextFrame(0));
    expect(receiver.status.received).toBe(1);
    receiver.reset();
    expect(receiver.status.received).toBe(0);
    expect(receiver.status.total).toBe(0);
    expect(receiver.done).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: QR matrix", () => {
  it("returns a square matrix whose size matches the version", () => {
    const source = createFrameSource(makePayload(5000, 4), OPTS);
    const matrix = frameToQrMatrix(source.nextFrame(0), "M", source.version);
    expect(matrix.version).toBe(15);
    expect(matrix.size).toBe(moduleCountForVersion(15));
    expect(matrix.data.length).toBe(matrix.size * matrix.size);
    expect([...new Set(matrix.data)].sort()).toEqual([0, 1]);
  });

  it("picks its own version when none is pinned", () => {
    const matrix = frameToQrMatrix("hello", "L");
    expect(matrix.size).toBe(moduleCountForVersion(matrix.version));
  });

  it("errors on an oversized frame and on nothing at all", () => {
    expect(codeOf(() => frameToQrMatrix("a".repeat(4000), "M", 10))).toBe("encode-failed");
    expect(codeOf(() => frameToQrMatrix("", "M"))).toBe("empty-input");
    expect(codeOf(() => frameToQrMatrix("hello", "H"))).toBe("bad-option");
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: estimating", () => {
  it("matches the plan the encoder actually builds", () => {
    const plan = planTransfer(makePayload(5000), OPTS);
    const estimate = estimateTransfer(5000, "medium", 10, "fountain", "M", "notes.txt");
    expect(estimate.chunkSize).toBe(plan.chunkSize);
    expect(estimate.totalChunks).toBe(plan.totalChunks);
    expect(estimate.frames).toBe(plan.framesPerCycle);
    expect(estimate.seconds).toBeCloseTo(plan.framesPerCycle / 10, 6);
    expect(estimate.bytesPerSecond).toBeCloseTo(5000 / estimate.seconds, 6);
  });

  it("goes faster with a bigger code and a higher frame rate", () => {
    const small = estimateTransfer(50000, "small", 10, "sequential");
    const max = estimateTransfer(50000, "max", 10, "sequential");
    expect(max.seconds).toBeLessThan(small.seconds);
    const fast = estimateTransfer(50000, "small", 20, "sequential");
    expect(fast.seconds).toBeCloseTo(small.seconds / 2, 6);
  });

  it("validates its options", () => {
    expect(codeOf(() => estimateTransfer(1000, "huge"))).toBe("bad-option");
    expect(codeOf(() => estimateTransfer(1000, "medium", 99))).toBe("bad-option");
    expect(codeOf(() => estimateTransfer(1000, "medium", 10, "torrent"))).toBe("bad-option");
    expect(codeOf(() => estimateTransfer(1000, "medium", 10, "fountain", "Q"))).toBe("bad-option");
    expect(codeOf(() => estimateTransfer(1000, "small", 10, "fountain", "M", "n".repeat(200)))).toBe(
      "bad-option",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: run", () => {
  it("returns the labelled rows the shell renders", () => {
    const out = run(makePayload(5000, 2), OPTS);
    expect(Object.keys(out)).toEqual([
      "Payload size",
      "File name",
      "Transfer ID",
      "Mode",
      "Chunk size",
      "Chunks",
      "Frames per cycle",
      "Estimated time at 10 fps",
      "QR version",
      "First frame",
      "Note",
    ]);
    expect(out["Payload size"]).toBe("4.9 KB");
    expect(out["File name"]).toBe("notes.txt");
    expect(out["Transfer ID"]).toMatch(/^[0-9a-f]{8}$/);
    expect(out["Mode"]).toMatch(/^Fountain:/);
    expect(out["QR version"]).toContain("Version 15");
    expect(out["Note"]).not.toMatch(/[–—]/);
  });

  it("accepts a pasted string and names it sensibly", () => {
    const out = run("plain text payload", { ...OPTS, fileName: "" });
    expect(out["File name"]).toBe("payload.txt");
    const frame = decodeFrame(out["First frame"] as string);
    expect(frame.fileName).toBe("payload.txt");
    expect(new TextDecoder().decode(frame.data)).toBe("plain text payload");
  });

  it("labels the estimate with the chosen frame rate", () => {
    const out = run(makePayload(5000, 2), { ...OPTS, fps: 15 });
    expect(out["Estimated time at 15 fps"]).toBeTruthy();
  });

  it("is deterministic for a given seed", () => {
    const payload = makePayload(3000, 12);
    expect(run(payload, OPTS)).toEqual(run(payload, OPTS));
  });
});

/* -------------------------------------------------------------------------- */

describe("qr-file-transfer: errors", () => {
  it("empty-input", () => {
    expect(codeOf(() => run(new Uint8Array(0), OPTS))).toBe("empty-input");
    expect(codeOf(() => run("", OPTS))).toBe("empty-input");
  });

  it("too-large", () => {
    const oversize = new Uint8Array(MAX_PAYLOAD_BYTES + 1);
    const code = codeOf(() => run(oversize, OPTS));
    expect(code).toBe("too-large");
    try {
      run(oversize, OPTS);
    } catch (e) {
      expect((e as ToolError).fix).toMatch(/hour|cable/i);
    }
  });

  it("bad-option for every option", () => {
    expect(codeOf(() => run("hi", { ...OPTS, size: "enormous" }))).toBe("bad-option");
    expect(codeOf(() => run("hi", { ...OPTS, ecc: "H" }))).toBe("bad-option");
    expect(codeOf(() => run("hi", { ...OPTS, mode: "torrent" }))).toBe("bad-option");
    expect(codeOf(() => run("hi", { ...OPTS, fps: 2 }))).toBe("bad-option");
    expect(codeOf(() => run("hi", { ...OPTS, fps: 60 }))).toBe("bad-option");
    expect(codeOf(() => run("hi", { ...OPTS, metaEvery: 0 }))).toBe("bad-option");
    expect(codeOf(() => run("hi", { ...OPTS, size: "small", fileName: "n".repeat(200) }))).toBe(
      "bad-option",
    );
  });

  it("accepts the option synonyms", () => {
    expect(run("hi", { ...OPTS, size: "maximum" })["QR version"]).toContain("Version 25");
    expect(run("hi", { ...OPTS, ecc: "l" })["QR version"]).toContain("correction L");
  });
});
