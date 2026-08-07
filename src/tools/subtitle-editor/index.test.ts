import { describe, expect, it } from "vitest";
import { parseSubtitles, run, serializeSubtitles } from "./index";
import { ToolError } from "../types";

const SRT_CRLF_BOM =
  "﻿1\r\n00:00:01,000 --> 00:00:03,000\r\nHello there\r\nsecond line\r\n\r\n" +
  "2\r\n00:00:05,000 --> 00:00:07,500\r\nGoodbye\r\n";

const SRT_THREE = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "First",
  "",
  "2",
  "00:00:05,000 --> 00:00:06,000",
  "Middle",
  "",
  "3",
  "00:00:09,000 --> 00:00:10,000",
  "Last",
  "",
].join("\n");

const VTT_RICH = [
  "WEBVTT",
  "",
  "NOTE This file came out of an autocaptioner",
  "",
  "STYLE",
  "::cue { color: yellow }",
  "",
  "00:00:01.000 --> 00:00:03.000 line:80% align:middle",
  "<v Roger Bingham>We are in New York</v>",
  "",
  "chapter-two",
  "01:00:03.500 --> 01:00:05.000",
  "<i>Later that day</i>",
  "",
].join("\n");

describe("subtitle-editor parsing", () => {
  it("parses SRT with a BOM and CRLF line endings", () => {
    const doc = parseSubtitles(SRT_CRLF_BOM);
    expect(doc.format).toBe("srt");
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[0]).toMatchObject({
      index: 1,
      start: 1000,
      end: 3000,
      lines: ["Hello there", "second line"],
    });
    expect(doc.cues[1].start).toBe(5000);
    expect(doc.cues[1].end).toBe(7500);
  });

  it("parses VTT NOTE blocks, STYLE blocks, cue settings, and identifiers", () => {
    const doc = parseSubtitles(VTT_RICH);
    expect(doc.format).toBe("vtt");
    expect(doc.header).toBe("WEBVTT");
    expect(doc.blocks).toEqual([
      { kind: "NOTE", text: "This file came out of an autocaptioner" },
      { kind: "STYLE", text: "::cue { color: yellow }" },
    ]);
    expect(doc.cues[0].settings).toBe("line:80% align:middle");
    expect(doc.cues[0].id).toBeUndefined();
    expect(doc.cues[1].id).toBe("chapter-two");
  });

  it("parses timestamps past one hour and hourless VTT timestamps", () => {
    const doc = parseSubtitles(VTT_RICH);
    expect(doc.cues[1].start).toBe(3603500);
    expect(doc.cues[1].end).toBe(3605000);

    const hourless = parseSubtitles("WEBVTT\n\n01:03.500 --> 01:05.000\nShort form\n");
    expect(hourless.cues[0].start).toBe(63500);
    expect(serializeSubtitles(hourless)).toContain("00:01:03.500 --> 00:01:05.000");
  });

  it("tolerates SRT cues with no number line", () => {
    const doc = parseSubtitles("00:00:01,000 --> 00:00:02,000\nNo number\n");
    expect(doc.cues[0].index).toBe(1);
    expect(doc.cues[0].lines).toEqual(["No number"]);
  });
});

describe("subtitle-editor round trips", () => {
  it("round trips SRT through parse and serialize", () => {
    const doc = parseSubtitles(SRT_THREE);
    expect(parseSubtitles(serializeSubtitles(doc))).toEqual(doc);
    expect(serializeSubtitles(doc)).toBe(SRT_THREE);
  });

  it("round trips VTT through parse and serialize", () => {
    const doc = parseSubtitles(VTT_RICH);
    expect(parseSubtitles(serializeSubtitles(doc))).toEqual(doc);
  });

  it("converting to the same format is stable", () => {
    const once = run(SRT_THREE, { operation: "convert", format: "srt" });
    expect(run(once, { operation: "convert", format: "srt" })).toBe(once);
    const vtt = run(VTT_RICH, { operation: "convert", format: "vtt" });
    expect(run(vtt, { operation: "convert", format: "vtt" })).toBe(vtt);
  });
});

describe("subtitle-editor convert", () => {
  it("converts SRT to VTT with a header and dot decimals", () => {
    const out = run(SRT_CRLF_BOM, { operation: "convert", format: "vtt" });
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
    expect(out).toContain("00:00:01.000 --> 00:00:03.000");
    expect(out).not.toContain(",000");
  });

  it("defaults to converting to VTT", () => {
    expect(run(SRT_THREE, {}).startsWith("WEBVTT")).toBe(true);
  });

  it("converts VTT to SRT, mapping voice tags and dropping settings", () => {
    const out = run(VTT_RICH, { operation: "convert", format: "srt" });
    expect(out).toContain("Roger Bingham: We are in New York");
    expect(out).not.toContain("line:80%");
    expect(out).not.toContain("chapter-two");
    expect(out).toContain("00:00:01,000 --> 00:00:03,000");
    expect(out).toContain("<i>Later that day</i>");
    // NOTE and STYLE have no SRT equivalent, so they are dropped with a notice.
    expect(out).toContain("NOTE Removed 2 WebVTT NOTE or STYLE blocks");
    expect(out).not.toContain("::cue");
    // Cues are renumbered from one.
    expect(out).toMatch(/\n1\n00:00:01,000/);
    expect(out).toMatch(/\n2\n01:00:03,500/);
  });
});

describe("subtitle-editor shift", () => {
  it("shifts every cue by +2.5 seconds", () => {
    const out = run(SRT_THREE, { operation: "shift", offset: "+2.5", format: "srt" });
    const doc = parseSubtitles(out);
    expect(doc.cues.map((c) => c.start)).toEqual([3500, 7500, 11500]);
    expect(doc.cues.map((c) => c.end)).toEqual([5500, 8500, 12500]);
  });

  it("accepts millisecond offsets and clamps at zero with a notice", () => {
    const out = run(SRT_THREE, { operation: "shift", offset: "-500ms" });
    const doc = parseSubtitles(out);
    expect(doc.cues.map((c) => c.start)).toEqual([500, 4500, 8500]);

    const big = run(SRT_THREE, { operation: "shift", offset: "-2000" });
    const bigDoc = parseSubtitles(big);
    expect(bigDoc.cues[0].start).toBe(0);
    expect(bigDoc.cues[0].end).toBe(1000);
    expect(bigDoc.blocks[0].kind).toBe("NOTE");
    expect(bigDoc.blocks[0].text).toContain("Held 1 cue at 00:00:00");
  });

  it("accepts mm:ss and hh:mm:ss.mmm offsets", () => {
    const mmss = parseSubtitles(run(SRT_THREE, { operation: "shift", offset: "+1:03" }));
    expect(mmss.cues[0].start).toBe(64000);
    const hms = parseSubtitles(run(SRT_THREE, { operation: "shift", offset: "+01:02:03.456" }));
    expect(hms.cues[0].start).toBe(3724456);
  });

  it("rejects an unparseable offset with the accepted forms", () => {
    expect(() => run(SRT_THREE, { operation: "shift", offset: "soon" })).toThrowError(ToolError);
    try {
      run(SRT_THREE, { operation: "shift", offset: "soon" });
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-offset");
      expect((e as ToolError).fix).toMatch(/500ms/);
    }
  });
});

describe("subtitle-editor resync", () => {
  it("retimes linearly from two anchors", () => {
    // Starts are 1000, 5000, 9000. Anchors 2000 and 18000 give scale 2, offset 0.
    const out = run(SRT_THREE, {
      operation: "resync",
      first: "00:00:02.000",
      last: "00:00:18.000",
    });
    const doc = parseSubtitles(out);
    expect(doc.cues.map((c) => c.start)).toEqual([2000, 10000, 18000]);
    expect(doc.cues.map((c) => c.end)).toEqual([6000, 12000, 20000]);
  });

  it("needs at least two cues", () => {
    const single = "1\n00:00:01,000 --> 00:00:02,000\nOnly one\n";
    expect(() => run(single, { operation: "resync", first: "0", last: "5000" })).toThrowError(
      /at least two cues/,
    );
    try {
      run(single, { operation: "resync", first: "0", last: "5000" });
    } catch (e) {
      expect((e as ToolError).code).toBe("need-two-cues");
    }
  });

  it("rejects anchors that share a start time", () => {
    const same = "1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:01,000 --> 00:00:03,000\nB\n";
    expect(() => run(same, { operation: "resync", first: "0", last: "5000" })).toThrowError(
      /different start times/,
    );
  });
});

describe("subtitle-editor clean", () => {
  it("merges a four line cue down to two lines", () => {
    const input = ["1", "00:00:01,000 --> 00:00:04,000", "aa", "b", "c", "dddd", ""].join("\n");
    const doc = parseSubtitles(run(input, { operation: "clean" }));
    expect(doc.cues[0].lines).toEqual(["aa b c", "dddd"]);
  });

  it("drops empty cues, renumbers, fixes overlaps, and enforces a minimum duration", () => {
    const input = [
      "7",
      "00:00:01,000 --> 00:00:06,000",
      "Overlaps the next one",
      "",
      "8",
      "00:00:04,000 --> 00:00:04,100",
      "Too short",
      "",
      "9",
      "00:00:10,000 --> 00:00:12,000",
      '<font color="red">tags</font> go away',
      "",
      "10",
      "00:00:20,000 --> 00:00:22,000",
      "",
    ].join("\n");
    const doc = parseSubtitles(run(input, { operation: "clean", minDuration: 500 }));

    // The empty cue is gone and the rest are renumbered from one.
    expect(doc.cues.map((c) => c.index)).toEqual([1, 2, 3]);
    // The overlap is trimmed back to the next cue's start.
    expect(doc.cues[0].end).toBe(4000);
    // The short cue is stretched to the 500 ms minimum.
    expect(doc.cues[1].start).toBe(4000);
    expect(doc.cues[1].end).toBe(4500);
    // Unknown tags are stripped.
    expect(doc.cues[2].lines).toEqual(["tags go away"]);
  });

  it("keeps i, b, and u tags but removes everything else", () => {
    const input = "1\n00:00:01,000 --> 00:00:04,000\n<i>keep</i> <c.yellow>drop</c> <b>keep</b>\n";
    const doc = parseSubtitles(run(input, { operation: "clean" }));
    expect(doc.cues[0].lines).toEqual(["<i>keep</i> drop <b>keep</b>"]);
  });

  it("never stretches a cue past the next cue start", () => {
    const input = [
      "1",
      "00:00:01,000 --> 00:00:01,100",
      "A",
      "",
      "2",
      "00:00:01,300 --> 00:00:03,000",
      "B",
      "",
    ].join("\n");
    const doc = parseSubtitles(run(input, { operation: "clean", minDuration: 2000 }));
    expect(doc.cues[0].end).toBe(1300);
    expect(doc.cues[1].end).toBe(3300);
  });
});

describe("subtitle-editor errors", () => {
  it("throws empty-input for blank input", () => {
    expect(() => run("   \n  ", {})).toThrowError(ToolError);
    try {
      run("", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws invalid-subtitles naming the line for a malformed timestamp", () => {
    const bad = [
      "1",
      "00:00:01,000 --> 00:00:03,000",
      "Fine",
      "",
      "2",
      "00:0X:05 --> nope",
      "Bad",
      "",
    ].join("\n");
    try {
      run(bad, {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-subtitles");
      expect((e as ToolError).message).toContain("line 6");
      expect((e as ToolError).message).toContain("Cue 2");
      expect((e as ToolError).fix).toMatch(/hh:mm:ss/);
    }
  });

  it("throws invalid-subtitles when a block has no timestamp line", () => {
    expect(() => run("1\nJust some text\n", {})).toThrowError(/no timestamp line/);
  });

  it("throws invalid-subtitles when nothing looks like a cue", () => {
    expect(() => run("WEBVTT\n\nNOTE only a comment here\n", {})).toThrowError(
      /No subtitle cues were found/,
    );
  });

  it("throws invalid-subtitles when the end time precedes the start", () => {
    expect(() => run("1\n00:00:05,000 --> 00:00:02,000\nBackwards\n", {})).toThrowError(
      /ends before it starts/,
    );
  });

  it("rejects an unknown operation", () => {
    expect(() => run(SRT_THREE, { operation: "nope" as never })).toThrowError(/Unknown operation/);
  });
});
