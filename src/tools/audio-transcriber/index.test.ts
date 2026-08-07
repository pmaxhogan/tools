import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  FALLBACK_CUE_SECONDS,
  extensionFor,
  formatClock,
  formatTimestamp,
  formatTranscript,
  normalizeChunks,
  run,
  toJson,
  toSrt,
  toText,
  toVtt,
  type RawTranscriptChunk,
  type TranscriptChunk,
} from "./index";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function chunk(text: string, start: number | null, end: number | null): TranscriptChunk {
  return { text, start, end };
}

/** Three chunks with clean times, the everyday case. */
const SPEECH: TranscriptChunk[] = [
  chunk("And so my fellow Americans,", 0, 3.5),
  chunk("ask not what your country can do for you,", 3.5, 7.25),
  chunk("ask what you can do for your country.", 7.25, 11),
];

/* ------------------------------------------------------------------ */
/* normalizeChunks                                                     */
/* ------------------------------------------------------------------ */

describe("normalizeChunks", () => {
  it("trims the leading space Whisper puts on every chunk", () => {
    const raw: RawTranscriptChunk[] = [
      { text: " Hello there.", timestamp: [0, 1.5] },
      { text: " General Kenobi.", timestamp: [1.5, 3] },
    ];
    expect(normalizeChunks(raw)).toEqual([
      { text: "Hello there.", start: 0, end: 1.5 },
      { text: "General Kenobi.", start: 1.5, end: 3 },
    ]);
  });

  it("keeps a null end on the final chunk instead of inventing a number", () => {
    const raw: RawTranscriptChunk[] = [
      { text: " First.", timestamp: [0, 2] },
      { text: " Last, cut off.", timestamp: [2, null] },
    ];
    expect(normalizeChunks(raw)).toEqual([
      { text: "First.", start: 0, end: 2 },
      { text: "Last, cut off.", start: 2, end: null },
    ]);
  });

  it("drops chunks with no words left after trimming", () => {
    const raw: RawTranscriptChunk[] = [
      { text: "   ", timestamp: [0, 1] },
      { text: " Real speech.", timestamp: [1, 2] },
      { text: "", timestamp: [2, 3] },
    ];
    expect(normalizeChunks(raw)).toHaveLength(1);
    expect(normalizeChunks(raw)[0]!.text).toBe("Real speech.");
  });

  it("nulls out timestamps that are missing, infinite, or backwards", () => {
    const raw = [
      { text: "a", timestamp: [Number.NaN, 4] },
      { text: "b", timestamp: [4, Number.POSITIVE_INFINITY] },
      { text: "c", timestamp: [10, 6] },
      { text: "d", timestamp: [-3, -1] },
    ] as unknown as RawTranscriptChunk[];
    expect(normalizeChunks(raw)).toEqual([
      { text: "a", start: null, end: 4 },
      { text: "b", start: 4, end: null },
      { text: "c", start: 10, end: null },
      { text: "d", start: 0, end: null },
    ]);
  });

  it("survives a missing or malformed chunk list", () => {
    expect(normalizeChunks(undefined)).toEqual([]);
    expect(normalizeChunks(null)).toEqual([]);
    expect(normalizeChunks([] as RawTranscriptChunk[])).toEqual([]);
    expect(normalizeChunks([{ text: "x" }] as unknown as RawTranscriptChunk[])).toEqual([
      { text: "x", start: null, end: null },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* time formatting                                                     */
/* ------------------------------------------------------------------ */

describe("formatTimestamp", () => {
  it("writes SRT and WebVTT separators", () => {
    expect(formatTimestamp(1.5, "srt")).toBe("00:00:01,500");
    expect(formatTimestamp(1.5, "vtt")).toBe("00:00:01.500");
  });

  it("keeps counting past an hour rather than wrapping", () => {
    expect(formatTimestamp(3600, "srt")).toBe("01:00:00,000");
    expect(formatTimestamp(3661.5, "srt")).toBe("01:01:01,500");
    expect(formatTimestamp(3661.5, "vtt")).toBe("01:01:01.500");
    expect(formatTimestamp(7325.125, "vtt")).toBe("02:02:05.125");
    expect(formatTimestamp(359999.999, "srt")).toBe("99:59:59,999");
  });

  it("floors negatives and non numbers at zero", () => {
    expect(formatTimestamp(-5, "srt")).toBe("00:00:00,000");
    expect(formatTimestamp(Number.NaN, "vtt")).toBe("00:00:00.000");
  });
});

describe("formatClock", () => {
  it("drops the hour field until the recording needs it", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5.9)).toBe("0:05");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(599)).toBe("9:59");
  });

  it("adds the hour field on hour crossing times", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3661)).toBe("1:01:01");
    expect(formatClock(7325)).toBe("2:02:05");
  });
});

/* ------------------------------------------------------------------ */
/* toText                                                              */
/* ------------------------------------------------------------------ */

describe("toText", () => {
  it("runs chunks together into one paragraph when they are continuous", () => {
    expect(toText(SPEECH, { timestamps: false })).toBe(
      "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
    );
  });

  it("starts a new paragraph after a silence", () => {
    const withPause = [
      chunk("First thought.", 0, 2),
      chunk("Still the same thought.", 2.2, 4),
      chunk("New topic after a long pause.", 12, 14),
    ];
    expect(toText(withPause, { timestamps: false })).toBe(
      "First thought. Still the same thought.\n\nNew topic after a long pause.",
    );
  });

  it("labels every line with its span when timestamps are on", () => {
    expect(toText(SPEECH, { timestamps: true })).toBe(
      [
        "[0:00 - 0:03] And so my fellow Americans,",
        "[0:03 - 0:07] ask not what your country can do for you,",
        "[0:07 - 0:11] ask what you can do for your country.",
      ].join("\n"),
    );
  });

  it("shows the hour field on a long recording", () => {
    const late = [chunk("Nearly done now.", 3661, 3663.5)];
    expect(toText(late, { timestamps: true })).toBe("[1:01:01 - 1:01:03] Nearly done now.");
  });

  it("gives a chunk with no end the fallback span", () => {
    const tail = [chunk("Cut off mid sentence", 10, null)];
    expect(toText(tail, { timestamps: true })).toBe(
      `[0:10 - 0:${10 + FALLBACK_CUE_SECONDS}] Cut off mid sentence`,
    );
  });

  it("returns an empty string for an empty transcript", () => {
    expect(toText([], { timestamps: true })).toBe("");
    expect(toText([], { timestamps: false })).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* toSrt and toVtt                                                     */
/* ------------------------------------------------------------------ */

describe("toSrt", () => {
  it("numbers cues from one and separates them with a blank line", () => {
    expect(toSrt(SPEECH)).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:03,500",
        "And so my fellow Americans,",
        "",
        "2",
        "00:00:03,500 --> 00:00:07,250",
        "ask not what your country can do for you,",
        "",
        "3",
        "00:00:07,250 --> 00:00:11,000",
        "ask what you can do for your country.",
        "",
      ].join("\n"),
    );
  });

  it("extends a null end by the fallback so the cue is still valid", () => {
    expect(toSrt([chunk("The end.", 90, null)])).toBe(
      "1\n00:01:30,000 --> 00:01:32,000\nThe end.\n",
    );
  });

  it("writes hour crossing cues without wrapping", () => {
    expect(toSrt([chunk("Late.", 3599.5, 3601.25)])).toBe(
      "1\n00:59:59,500 --> 01:00:01,250\nLate.\n",
    );
  });

  it("returns an empty string for an empty transcript", () => {
    expect(toSrt([])).toBe("");
  });
});

describe("toVtt", () => {
  it("writes the WEBVTT header and dotted milliseconds", () => {
    expect(toVtt(SPEECH.slice(0, 2))).toBe(
      [
        "WEBVTT",
        "",
        "00:00:00.000 --> 00:00:03.500",
        "And so my fellow Americans,",
        "",
        "00:00:03.500 --> 00:00:07.250",
        "ask not what your country can do for you,",
        "",
      ].join("\n"),
    );
  });

  it("extends a null end the same way SRT does", () => {
    expect(toVtt([chunk("The end.", 7200, null)])).toBe(
      "WEBVTT\n\n02:00:00.000 --> 02:00:02.000\nThe end.\n",
    );
  });

  it("still emits a valid header for an empty transcript", () => {
    expect(toVtt([])).toBe("WEBVTT\n");
  });
});

/* ------------------------------------------------------------------ */
/* toJson                                                              */
/* ------------------------------------------------------------------ */

describe("toJson", () => {
  it("carries the joined text plus every timed chunk", () => {
    const parsed = JSON.parse(toJson(SPEECH));
    expect(parsed.text).toBe(
      "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
    );
    expect(parsed.chunks).toHaveLength(3);
    expect(parsed.chunks[0]).toEqual({
      text: "And so my fellow Americans,",
      start: 0,
      end: 3.5,
    });
  });

  it("keeps a null end as null rather than filling it in", () => {
    const parsed = JSON.parse(toJson([chunk("Cut off", 4, null)]));
    expect(parsed.chunks[0].end).toBeNull();
  });

  it("is pretty printed", () => {
    expect(toJson(SPEECH)).toContain('\n  "chunks": [');
  });
});

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

describe("formatTranscript", () => {
  it("routes each format to its formatter", () => {
    expect(formatTranscript(SPEECH, { format: "srt" })).toBe(toSrt(SPEECH));
    expect(formatTranscript(SPEECH, { format: "vtt" })).toBe(toVtt(SPEECH));
    expect(formatTranscript(SPEECH, { format: "json" })).toBe(toJson(SPEECH));
    expect(formatTranscript(SPEECH, { format: "text", timestamps: false })).toBe(
      toText(SPEECH, { timestamps: false }),
    );
  });

  it("falls back to timestamped text for a missing or unknown format", () => {
    expect(formatTranscript(SPEECH, {})).toBe(toText(SPEECH, { timestamps: true }));
    expect(formatTranscript(SPEECH, { format: "nonsense" })).toBe(
      toText(SPEECH, { timestamps: true }),
    );
  });
});

describe("extensionFor", () => {
  it("maps every format to its file extension", () => {
    expect(extensionFor("srt")).toBe("srt");
    expect(extensionFor("vtt")).toBe("vtt");
    expect(extensionFor("json")).toBe("json");
    expect(extensionFor("text")).toBe("txt");
    expect(extensionFor(undefined)).toBe("txt");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("describes what the panel will do for dropped audio", () => {
    const result = run(new Uint8Array(2048), { model: "whisper-tiny", format: "srt" });
    expect(result.File).toBe("2.0 KB of audio data");
    expect(result.Model).toContain("43 MB");
    expect(result.Output).toContain("SRT");
    expect(result.Privacy).toContain("your files and inputs never leave your device");
  });

  it("names the larger model and the forced language when they are chosen", () => {
    const result = run(new Uint8Array(10), {
      model: "whisper-base",
      language: "de",
      format: "json",
    });
    expect(result.Model).toContain("78 MB");
    expect(result.Language).toContain("de");
    expect(result.Output).toContain("JSON");
  });

  it("says timestamps are off when they are", () => {
    const result = run(new Uint8Array(10), { format: "text", timestamps: false });
    expect(result.Output).toContain("no timestamps");
  });

  it("asks for a file when it is handed text", () => {
    const result = run("please transcribe this", {});
    expect(result.Status).toContain("give it a file");
  });

  it("throws a ToolError on empty input", () => {
    expect(() => run("", {})).toThrow(ToolError);
    expect(() => run(new Uint8Array(0), {})).toThrow(ToolError);
    try {
      run("", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toContain("Drop an audio or video file");
    }
  });
});
