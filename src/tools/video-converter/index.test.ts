import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  DEFAULT_INPUT_NAME,
  FORMATS,
  TARGET_IDS,
  buildConvertArgs,
  describeQuality,
  formatCommand,
  looksLikeAudio,
  outputNameFor,
  run,
} from "./index";

describe("buildConvertArgs: video targets", () => {
  it("builds a balanced mp4 command with faststart", () => {
    expect(buildConvertArgs({ inputName: "holiday.mov", target: "mp4" })).toEqual({
      args: [
        "-i",
        "holiday.mov",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-sn",
        "-movflags",
        "+faststart",
        "holiday.mp4",
      ],
      outputs: ["holiday.mp4"],
    });
  });

  it("uses -an instead of an audio codec when the audio is stripped", () => {
    const { args } = buildConvertArgs({
      inputName: "holiday.mov",
      target: "mp4",
      quality: "high",
      stripAudio: true,
    });
    expect(args).toEqual([
      "-i",
      "holiday.mov",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-sn",
      "-movflags",
      "+faststart",
      "holiday.mp4",
    ]);
  });

  it("builds a small webm with VP8 and Vorbis", () => {
    expect(buildConvertArgs({ inputName: "clip.mp4", target: "webm", quality: "small" })).toEqual({
      args: [
        "-i",
        "clip.mp4",
        "-c:v",
        "libvpx",
        "-crf",
        "33",
        "-b:v",
        "500k",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-c:a",
        "libvorbis",
        "-q:a",
        "2",
        "-sn",
        "clip.webm",
      ],
      outputs: ["clip.webm"],
    });
  });

  it("remuxes to mkv by copying the streams, whatever the quality tier says", () => {
    const balanced = buildConvertArgs({ inputName: "clip.mp4", target: "mkv" });
    const high = buildConvertArgs({ inputName: "clip.mp4", target: "mkv", quality: "high" });
    expect(balanced.args).toEqual(["-i", "clip.mp4", "-c", "copy", "clip.mkv"]);
    expect(high.args).toEqual(balanced.args);
    expect(
      buildConvertArgs({ inputName: "clip.mp4", target: "mkv", stripAudio: true }).args,
    ).toEqual(["-i", "clip.mp4", "-c", "copy", "-an", "clip.mkv"]);
  });

  it("builds a one pass palette gif that never upscales the source", () => {
    expect(buildConvertArgs({ inputName: "clip.mp4", target: "gif", quality: "small" })).toEqual({
      args: [
        "-i",
        "clip.mp4",
        "-filter_complex",
        "[0:v]fps=10,scale='min(320,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
        "-loop",
        "0",
        "-an",
        "clip.gif",
      ],
      outputs: ["clip.gif"],
    });
  });
});

describe("buildConvertArgs: audio targets", () => {
  it("extracts audio from a video as high bitrate mp3", () => {
    expect(buildConvertArgs({ inputName: "lecture.mp4", target: "mp3", quality: "high" })).toEqual({
      args: ["-i", "lecture.mp4", "-vn", "-c:a", "libmp3lame", "-b:a", "320k", "lecture.mp3"],
      outputs: ["lecture.mp3"],
    });
  });

  it("extracts 16 bit PCM wav from a video and ignores the quality tier", () => {
    const balanced = buildConvertArgs({ inputName: "interview.mov", target: "wav" });
    const small = buildConvertArgs({
      inputName: "interview.mov",
      target: "wav",
      quality: "small",
    });
    expect(balanced).toEqual({
      args: ["-i", "interview.mov", "-vn", "-c:a", "pcm_s16le", "interview.wav"],
      outputs: ["interview.wav"],
    });
    expect(small.args).toEqual(balanced.args);
  });

  it("builds m4a, ogg and flac commands", () => {
    expect(buildConvertArgs({ inputName: "song.wav", target: "m4a" }).args).toEqual([
      "-i",
      "song.wav",
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "song.m4a",
    ]);
    expect(
      buildConvertArgs({ inputName: "song.wav", target: "ogg", quality: "high" }).args,
    ).toEqual(["-i", "song.wav", "-vn", "-c:a", "libvorbis", "-q:a", "7", "song.ogg"]);
    expect(
      buildConvertArgs({ inputName: "song.wav", target: "flac", quality: "small" }).args,
    ).toEqual(["-i", "song.wav", "-vn", "-c:a", "flac", "-compression_level", "12", "song.flac"]);
  });

  it("drops the picture for audio targets whether or not audioOnly is set", () => {
    const implied = buildConvertArgs({ inputName: "talk.mkv", target: "mp3" });
    const explicit = buildConvertArgs({ inputName: "talk.mkv", target: "mp3", audioOnly: true });
    expect(implied.args).toContain("-vn");
    expect(explicit.args).toEqual(implied.args);
  });

  it("never asks a video target to drop its own picture", () => {
    const args = buildConvertArgs({ inputName: "talk.mkv", target: "mp4", audioOnly: true }).args;
    expect(args).not.toContain("-vn");
  });

  it("offers only codecs the single thread ffmpeg core can encode", () => {
    const used = new Set<string>();
    for (const target of TARGET_IDS) {
      const { args } = buildConvertArgs({ inputName: "clip.mov", target });
      args.forEach((arg, i) => {
        const flag = args[i - 1];
        if (flag === "-c:v" || flag === "-c:a" || flag === "-c") used.add(arg);
      });
    }
    expect([...used].sort()).toEqual([
      "aac",
      "copy",
      "flac",
      "libmp3lame",
      "libvorbis",
      "libvpx",
      "libx264",
      "pcm_s16le",
    ]);
  });
});

describe("outputNameFor", () => {
  it("swaps the extension", () => {
    expect(outputNameFor("holiday.mov", "mp4")).toBe("holiday.mp4");
    expect(outputNameFor("song.flac", "mp3")).toBe("song.mp3");
  });

  it("avoids colliding with the input when the extension already matches", () => {
    expect(outputNameFor("clip.mp4", "mp4")).toBe("clip-converted.mp4");
    expect(outputNameFor("CLIP.MP4", "mp4")).toBe("CLIP-converted.mp4");
  });

  it("handles no extension, dot files, paths and empty names", () => {
    expect(outputNameFor("recording", "wav")).toBe("recording.wav");
    expect(outputNameFor(".hidden", "mp3")).toBe("hidden.mp3");
    expect(outputNameFor("C:/videos/my clip.mov", "mp4")).toBe("my-clip.mp4");
    expect(outputNameFor("   ", "gif")).toBe("output.gif");
  });

  it("rejects a format it cannot write", () => {
    expect(() => outputNameFor("clip.mov", "avi" as never)).toThrow(ToolError);
  });
});

describe("looksLikeAudio", () => {
  it("recognizes audio extensions and nothing else", () => {
    expect(looksLikeAudio("song.mp3")).toBe(true);
    expect(looksLikeAudio("SONG.FLAC")).toBe(true);
    expect(looksLikeAudio("clip.mp4")).toBe(false);
  });

  it("does not guess when there is no extension to read", () => {
    expect(looksLikeAudio("recording")).toBe(false);
    expect(looksLikeAudio("")).toBe(false);
  });
});

describe("errors", () => {
  it("refuses an unknown target", () => {
    expect(() => buildConvertArgs({ inputName: "clip.mov", target: "avi" as never })).toThrow(
      ToolError,
    );
    try {
      buildConvertArgs({ inputName: "clip.mov", target: "avi" as never });
    } catch (error) {
      expect((error as ToolError).code).toBe("unknown-target");
      expect((error as ToolError).fix).toContain("mp4");
    }
  });

  it("refuses an unknown quality tier", () => {
    try {
      buildConvertArgs({ inputName: "clip.mov", target: "mp4", quality: "ultra" as never });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("unknown-quality");
    }
  });

  it("refuses to build a command with no input file", () => {
    try {
      buildConvertArgs({ inputName: "   ", target: "mp4" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("missing-input");
    }
  });
});

describe("formatCommand", () => {
  it("renders a copy and paste command line", () => {
    expect(formatCommand(["-i", "a.mov", "-c:v", "libx264", "a.mp4"])).toBe(
      "ffmpeg -i a.mov -c:v libx264 a.mp4",
    );
  });

  it("quotes arguments that would break in a shell", () => {
    expect(formatCommand(["-i", "my clip.mov"])).toBe('ffmpeg -i "my clip.mov"');
  });
});

describe("run", () => {
  it("previews the planned command for a named file", () => {
    const rows = run("holiday.mov", { target: "webm", quality: "high" });
    expect(rows["Input"]).toBe("holiday.mov");
    expect(rows["Output file"]).toBe("holiday.webm");
    expect(rows["Target format"]).toBe(`${FORMATS.webm.label} (${FORMATS.webm.codecs})`);
    expect(rows["Quality"]).toBe(`high: ${describeQuality("webm", "high")}`);
    expect(rows["Command"]).toContain("ffmpeg -i holiday.mov");
    expect(rows["Command"]).toContain("libvpx");
  });

  it("reads a file name out of JSON input", () => {
    const rows = run(JSON.stringify({ name: "podcast.m4a" }), { target: "mp3" });
    expect(rows["Input"]).toBe("podcast.m4a");
    expect(rows["Output file"]).toBe("podcast.mp3");
  });

  it("returns usage rows for empty input instead of throwing", () => {
    const rows = run("");
    expect(rows["Getting started"]).toContain("never leave your device");
    expect(rows["Example input"]).toBe(DEFAULT_INPUT_NAME);
    expect(rows["Output file"]).toBe("clip.mp4");
  });

  it("falls back to the placeholder for bytes and for prose", () => {
    expect(run(new Uint8Array([0, 1, 2]))["Example input"]).toBe(DEFAULT_INPUT_NAME);
    expect(run("convert my wedding video please")["Example input"]).toBe(DEFAULT_INPUT_NAME);
  });

  it("reports what happens to the audio track", () => {
    expect(run("clip.mov", { target: "mp4" })["Audio"]).toBe("kept");
    expect(run("clip.mov", { target: "mp4", stripAudio: true })["Audio"]).toContain("-an");
    expect(run("clip.mov", { target: "flac" })["Audio"]).toContain("only the audio");
  });

  it("throws for an option value it cannot honor", () => {
    expect(() => run("clip.mov", { target: "avi" })).toThrow(ToolError);
  });
});
