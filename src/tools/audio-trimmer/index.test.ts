import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { buildTrimArgs, parseTimeSpec, run } from "./index";

describe("parseTimeSpec", () => {
  it("parses plain seconds", () => {
    expect(parseTimeSpec("12")).toBe(12);
    expect(parseTimeSpec("12.5")).toBe(12.5);
  });

  it("parses mm:ss", () => {
    expect(parseTimeSpec("1:23")).toBe(83);
    expect(parseTimeSpec("01:23.5")).toBe(83.5);
  });

  it("parses hh:mm:ss.mmm", () => {
    expect(parseTimeSpec("01:23:45.678")).toBeCloseTo(3600 + 23 * 60 + 45.678, 5);
    expect(parseTimeSpec("1:2:3")).toBe(3723);
  });

  it("returns null for empty input", () => {
    expect(parseTimeSpec("")).toBeNull();
    expect(parseTimeSpec("   ")).toBeNull();
  });

  it("returns null for unparseable or out of range input", () => {
    expect(parseTimeSpec("abc")).toBeNull();
    expect(parseTimeSpec("-3")).toBeNull();
    expect(parseTimeSpec("1:60")).toBeNull();
    expect(parseTimeSpec("1:2:3:4")).toBeNull();
    expect(parseTimeSpec("1:2:70")).toBeNull();
  });
});

describe("buildTrimArgs", () => {
  it("plain trim with stream copy (same format, no filters)", () => {
    const result = buildTrimArgs({
      inputName: "input.mp3",
      startSec: 5,
      endSec: 15,
      durationSec: null,
      fadeInSec: 0,
      fadeOutSec: 0,
      normalize: false,
      format: "same",
    });
    expect(result).toEqual({
      args: ["-ss", "5", "-t", "10", "-i", "input.mp3", "-vn", "-c:a", "copy", "trimmed.mp3"],
      outputs: ["trimmed.mp3"],
    });
  });

  it("trim with fades, re-encoded to mp3", () => {
    const result = buildTrimArgs({
      inputName: "input.mp3",
      startSec: 2,
      endSec: 12,
      durationSec: null,
      fadeInSec: 1,
      fadeOutSec: 2,
      normalize: false,
      format: "mp3",
    });
    expect(result).toEqual({
      args: [
        "-ss",
        "2",
        "-t",
        "10",
        "-i",
        "input.mp3",
        "-vn",
        "-af",
        "afade=t=in:st=0:d=1,afade=t=out:st=8:d=2",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        "trimmed.mp3",
      ],
      outputs: ["trimmed.mp3"],
    });
  });

  it("normalizes a full clip to wav", () => {
    const result = buildTrimArgs({
      inputName: "input.wav",
      startSec: null,
      endSec: null,
      durationSec: null,
      fadeInSec: 0,
      fadeOutSec: 0,
      normalize: true,
      format: "wav",
    });
    expect(result).toEqual({
      args: [
        "-i",
        "input.wav",
        "-vn",
        "-af",
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-c:a",
        "pcm_s16le",
        "trimmed.wav",
      ],
      outputs: ["trimmed.wav"],
    });
  });

  it("errors when stream copy is requested with filters active", () => {
    const result = buildTrimArgs({
      inputName: "input.mp3",
      startSec: null,
      endSec: null,
      durationSec: null,
      fadeInSec: 0,
      fadeOutSec: 0,
      normalize: true,
      format: "same",
    });
    expect(result).toEqual({
      error: "Stream copy cannot apply fades or normalization.",
      fix: "Choose an output format other than Same, or turn off fades and normalization.",
      code: "copy-with-filters",
    });
  });

  it("errors when fade out is requested without a known end time", () => {
    const result = buildTrimArgs({
      inputName: "input.mp3",
      startSec: 0,
      endSec: null,
      durationSec: null,
      fadeInSec: 0,
      fadeOutSec: 3,
      normalize: false,
      format: "mp3",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.code).toBe("fadeout-needs-end");
  });

  it("falls back to the probed duration for a fade out with no explicit end", () => {
    const result = buildTrimArgs({
      inputName: "input.mp3",
      startSec: 0,
      endSec: null,
      durationSec: 20,
      fadeInSec: 0,
      fadeOutSec: 3,
      normalize: false,
      format: "mp3",
    });
    expect("args" in result).toBe(true);
    if ("args" in result) {
      expect(result.args).toContain("-t");
      expect(result.args.join(" ")).toContain("afade=t=out:st=17:d=3");
    }
  });

  it("errors when the end time is not after the start time", () => {
    const result = buildTrimArgs({
      inputName: "input.mp3",
      startSec: 10,
      endSec: 10,
      durationSec: null,
      fadeInSec: 0,
      fadeOutSec: 0,
      normalize: false,
      format: "mp3",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.code).toBe("invalid-range");
  });

  it("errors when the fades are longer than the trimmed clip", () => {
    const result = buildTrimArgs({
      inputName: "input.mp3",
      startSec: 0,
      endSec: 4,
      durationSec: null,
      fadeInSec: 2,
      fadeOutSec: 3,
      normalize: false,
      format: "mp3",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.code).toBe("fades-too-long");
  });

  it("errors on stream copy when the source has no file extension", () => {
    const result = buildTrimArgs({
      inputName: "input",
      startSec: null,
      endSec: null,
      durationSec: null,
      fadeInSec: 0,
      fadeOutSec: 0,
      normalize: false,
      format: "same",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.code).toBe("copy-unknown-extension");
  });

  it("picks the aac codec for m4a and libvorbis for ogg", () => {
    const m4a = buildTrimArgs({
      inputName: "input.mp3",
      startSec: null,
      endSec: null,
      durationSec: null,
      fadeInSec: 0,
      fadeOutSec: 0,
      normalize: false,
      format: "m4a",
    });
    const ogg = buildTrimArgs({
      inputName: "input.mp3",
      startSec: null,
      endSec: null,
      durationSec: null,
      fadeInSec: 0,
      fadeOutSec: 0,
      normalize: false,
      format: "ogg",
    });
    expect("args" in m4a && m4a.args).toEqual([
      "-i",
      "input.mp3",
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "trimmed.m4a",
    ]);
    expect("args" in ogg && ogg.args).toEqual([
      "-i",
      "input.mp3",
      "-vn",
      "-c:a",
      "libvorbis",
      "-q:a",
      "5",
      "trimmed.ogg",
    ]);
  });
});

describe("run", () => {
  it("plans a command from the option values", () => {
    const result = run("", {
      start: "5",
      end: "15",
      fadeIn: 0,
      fadeOut: 0,
      normalize: false,
      format: "mp3",
    });
    expect(result.Command).toContain("ffmpeg -ss 5 -t 10 -i input.mp3");
    expect(result["Output file"]).toBe("trimmed.mp3");
  });

  it("is tolerant of empty input", () => {
    expect(() =>
      run("", { start: "", end: "", fadeIn: 0, fadeOut: 0, normalize: false, format: "same" }),
    ).not.toThrow();
    expect(() =>
      run(new Uint8Array(), {
        start: "",
        end: "",
        fadeIn: 0,
        fadeOut: 0,
        normalize: false,
        format: "same",
      }),
    ).not.toThrow();
  });

  it("throws a ToolError for an unparseable time", () => {
    expect(() =>
      run("", {
        start: "not a time",
        end: "",
        fadeIn: 0,
        fadeOut: 0,
        normalize: false,
        format: "mp3",
      }),
    ).toThrow(ToolError);
  });

  it("throws a ToolError when the option combination is invalid", () => {
    expect(() =>
      run("", { start: "", end: "", fadeIn: 0, fadeOut: 0, normalize: true, format: "same" }),
    ).toThrow(ToolError);
  });
});
