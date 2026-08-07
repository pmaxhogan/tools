import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  LineAssembler,
  autoDetectBaudHint,
  formatHexDump,
  parseSendInput,
  run,
  timestamp,
} from "./index";

const enc = (s: string) => new TextEncoder().encode(s);

describe("LineAssembler", () => {
  it("splits on LF and carries the unfinished line as replaceLast", () => {
    const a = new LineAssembler();
    expect(a.push(enc("one\ntwo"))).toEqual({ lines: ["one"], replaceLast: "two" });
    expect(a.push(enc("\nthree\n"))).toEqual({ lines: ["two", "three"] });
  });

  it("carries a partial line across three pushes with no newline", () => {
    const a = new LineAssembler();
    expect(a.push(enc("ESP"))).toEqual({ lines: [], replaceLast: "ESP" });
    expect(a.push(enc("-ROM:"))).toEqual({ lines: [], replaceLast: "ESP-ROM:" });
    expect(a.push(enc("esp32\n"))).toEqual({ lines: ["ESP-ROM:esp32"] });
  });

  it("treats CRLF as one terminator, even split across chunks", () => {
    const a = new LineAssembler();
    expect(a.push(enc("a\r"))).toEqual({ lines: [], replaceLast: "a" });
    expect(a.push(enc("\nb"))).toEqual({ lines: ["a"], replaceLast: "b" });
  });

  it("treats CRLF inside a single chunk as one terminator", () => {
    const a = new LineAssembler();
    expect(a.push(enc("a\r\nb\r\n"))).toEqual({ lines: ["a", "b"] });
  });

  it("replaces the live line on a bare CR so progress rows redraw", () => {
    const a = new LineAssembler();
    expect(a.push(enc("50%\r"))).toEqual({ lines: [], replaceLast: "50%" });
    expect(a.push(enc("51%\r"))).toEqual({ lines: [], replaceLast: "51%" });
    expect(a.push(enc("done\n"))).toEqual({ lines: ["done"] });
  });

  it("replaces the live line on a bare CR in the middle of a chunk", () => {
    const a = new LineAssembler();
    expect(a.push(enc("Writing 10%\rWriting 20%"))).toEqual({
      lines: [],
      replaceLast: "Writing 20%",
    });
  });

  it("rejoins a multi-byte UTF-8 character split across a chunk boundary", () => {
    const bytes = enc("café µs\n");
    // Split inside the two byte sequence for "é".
    const cut = 4;
    const a = new LineAssembler();
    expect(a.push(bytes.subarray(0, cut))).toEqual({ lines: [], replaceLast: "caf" });
    expect(a.push(bytes.subarray(cut))).toEqual({ lines: ["café µs"] });
  });

  it("holds a pending CR when the next chunk decodes to nothing", () => {
    const bytes = enc("é\n");
    const a = new LineAssembler();
    expect(a.push(enc("x\r"))).toEqual({ lines: [], replaceLast: "x" });
    // First half of a two byte character: decodes to "", so the CR stays open.
    expect(a.push(bytes.subarray(0, 1))).toEqual({ lines: [], replaceLast: "x" });
    expect(a.push(bytes.subarray(1))).toEqual({ lines: ["é"] });
  });

  it("flush commits the unfinished line and reset clears everything", () => {
    const a = new LineAssembler();
    a.push(enc("tail"));
    expect(a.flush()).toEqual({ lines: ["tail"] });
    expect(a.flush()).toEqual({ lines: [] });

    a.push(enc("again"));
    a.reset();
    expect(a.push(enc("\n"))).toEqual({ lines: [""] });
  });
});

describe("formatHexDump", () => {
  it("formats a short row with padding and the ASCII column", () => {
    expect(formatHexDump(enc("Hello World!\n"))).toBe(
      "00000000  48 65 6c 6c 6f 20 57 6f  72 6c 64 21 0a           |Hello World!.|",
    );
  });

  it("formats a full row and continues the offset on the next row", () => {
    const bytes = new Uint8Array(18);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;
    expect(formatHexDump(bytes)).toBe(
      [
        "00000000  00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  |................|",
        "00000010  10 11                                             |..|",
      ].join("\n"),
    );
  });

  it("starts the offset column where the session says it does", () => {
    expect(formatHexDump(enc("ok"), 0x1234)).toBe(
      "00001234  6f 6b                                             |ok|",
    );
  });

  it("returns an empty string for no bytes", () => {
    expect(formatHexDump(new Uint8Array(0))).toBe("");
  });
});

describe("parseSendInput", () => {
  it("encodes text as UTF-8 and appends the chosen ending", () => {
    expect(Array.from(parseSendInput("AT", "text", "none"))).toEqual([0x41, 0x54]);
    expect(Array.from(parseSendInput("AT", "text", "lf"))).toEqual([0x41, 0x54, 0x0a]);
    expect(Array.from(parseSendInput("AT", "text", "crlf"))).toEqual([0x41, 0x54, 0x0d, 0x0a]);
    expect(Array.from(parseSendInput("AT", "text", "cr"))).toEqual([0x41, 0x54, 0x0d]);
  });

  it("encodes non-ASCII text as UTF-8 bytes", () => {
    expect(Array.from(parseSendInput("é", "text", "none"))).toEqual([0xc3, 0xa9]);
  });

  it("accepts spaced, comma separated, 0x prefixed and unbroken hex", () => {
    const expected = [0x48, 0x65, 0x6c];
    expect(Array.from(parseSendInput("48 65 6C", "hex", "none"))).toEqual(expected);
    expect(Array.from(parseSendInput("0x48, 0x65, 0x6c", "hex", "none"))).toEqual(expected);
    expect(Array.from(parseSendInput("48656c", "hex", "none"))).toEqual(expected);
    expect(Array.from(parseSendInput("  48\n65\t6C  ", "hex", "none"))).toEqual(expected);
  });

  it("appends the line ending in hex mode too", () => {
    expect(Array.from(parseSendInput("41", "hex", "crlf"))).toEqual([0x41, 0x0d, 0x0a]);
    expect(Array.from(parseSendInput("41", "hex", "cr"))).toEqual([0x41, 0x0d]);
    expect(Array.from(parseSendInput("", "hex", "lf"))).toEqual([0x0a]);
  });

  it("rejects an odd number of hex digits", () => {
    expect(() => parseSendInput("48 6", "hex", "none")).toThrow(ToolError);
    try {
      parseSendInput("48 6", "hex", "none");
    } catch (e) {
      expect((e as ToolError).code).toBe("odd-nibbles");
      expect((e as ToolError).fix).toContain("pairs of hex digits");
    }
  });

  it("rejects characters that are not hex digits", () => {
    try {
      parseSendInput("48 zz", "hex", "none");
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-hex");
    }
  });

  it("rejects an empty send with no line ending", () => {
    try {
      parseSendInput("", "text", "none");
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });
});

describe("autoDetectBaudHint", () => {
  it("fires on a sample dominated by 0x00 and 0xFF", () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 2 === 0 ? 0xff : 0x00;
    const hint = autoDetectBaudHint(bytes);
    expect(hint).toContain("0x00 or 0xFF");
    expect(hint).toContain("115200");
  });

  it("fires on bytes that are not valid UTF-8", () => {
    const bytes = new Uint8Array(24).fill(0x9b);
    expect(autoDetectBaudHint(bytes)).toContain("not valid UTF-8");
  });

  it("fires on a sample full of odd control characters", () => {
    const bytes = new Uint8Array(24).fill(0x01);
    expect(autoDetectBaudHint(bytes)).toContain("control characters");
  });

  it("stays quiet on a clean ASCII boot log", () => {
    expect(
      autoDetectBaudHint(enc("ESP-ROM:esp32s3-20210327\r\nBuild:Mar 27 2021\r\nrst:0x1\r\n")),
    ).toBeNull();
  });

  it("stays quiet on a sample too short to judge", () => {
    expect(autoDetectBaudHint(new Uint8Array(8).fill(0xff))).toBeNull();
  });
});

describe("timestamp", () => {
  it("renders local wall clock time with milliseconds", () => {
    // Built from local date parts so the assertion holds in any timezone.
    const ms = new Date(2026, 0, 1, 12, 34, 56, 789).getTime();
    expect(timestamp(ms)).toBe("[12:34:56.789]");
  });

  it("pads single digit fields", () => {
    const ms = new Date(2026, 0, 1, 1, 2, 3, 4).getTime();
    expect(timestamp(ms)).toBe("[01:02:03.004]");
  });
});

describe("run", () => {
  it("returns usage rows when there is no input", () => {
    const out = run("");
    expect(out["How this works"]).toContain("Connect a device");
    expect(out.Privacy).toContain("your files and inputs never leave your device");
    expect(out.Browsers).toContain("Web Serial");
  });

  it("formats a pasted hex capture", () => {
    const out = run("48 65 6c 6c 6f 0a");
    expect(out.Summary).toBe("6 bytes, 1 line of text.");
    expect(out["Hex dump"]).toBe(
      "00000000  48 65 6c 6c 6f 0a                                 |Hello.|",
    );
    expect(out["Decoded text"]).toBe("Hello");
    expect(out["Baud check"]).toBe("Nothing in this sample looks like a baud rate mismatch.");
  });

  it("accepts raw bytes and honors the offset option", () => {
    const out = run(enc("ok"), { offset: 16 });
    expect(out["Hex dump"].startsWith("00000010  6f 6b")).toBe(true);
  });

  it("surfaces the baud hint for a garbled capture", () => {
    const out = run("ff 00 ff 00 ff 00 ff 00 ff 00 ff 00 ff 00 ff 00 ff 00");
    expect(out["Baud check"]).toContain("0x00 or 0xFF");
  });

  it("throws a ToolError for a malformed hex paste", () => {
    expect(() => run("48 6")).toThrow(ToolError);
  });
});
