import { describe, expect, it } from "vitest";
import { run } from "./index";

const opts = (encoding: "o200k_base" | "cl100k_base" = "o200k_base") => ({ encoding });

describe("character-counter", () => {
  it("counts a basic ASCII sentence", async () => {
    const out = await run("hello world", opts());
    expect(out["Characters"]).toBe("11");
    expect(out["Characters (no spaces)"]).toBe("10");
    expect(out["UTF-16 code units"]).toBe("11");
    expect(out["Unicode codepoints"]).toBe("11");
    expect(out["Words"]).toBe("2");
    expect(out["Sentences"]).toBe("1");
    expect(out["Lines"]).toBe("1");
    expect(out["Paragraphs"]).toBe("1");
    expect(out["UTF-8 bytes"]).toBe("11");
  });

  it("counts an emoji family sequence as one grapheme but many code units", async () => {
    const out = await run("👨‍👩‍👧‍👦", opts());
    expect(out["Characters"]).toBe("1");
    expect(out["UTF-16 code units"]).toBe("11");
    expect(out["Unicode codepoints"]).toBe("7");
  });

  it("counts accented text where codepoints and code units diverge from bytes", async () => {
    const out = await run("café résumé", opts());
    expect(out["Characters"]).toBe("11");
    expect(out["UTF-16 code units"]).toBe("11");
    expect(out["Unicode codepoints"]).toBe("11");
    expect(out["UTF-8 bytes"]).toBe("14");
  });

  it("returns all zeros for empty input, no error", async () => {
    const out = await run("", opts());
    expect(out["Characters"]).toBe("0");
    expect(out["Characters (no spaces)"]).toBe("0");
    expect(out["UTF-16 code units"]).toBe("0");
    expect(out["Unicode codepoints"]).toBe("0");
    expect(out["Words"]).toBe("0");
    expect(out["Sentences"]).toBe("0");
    expect(out["Lines"]).toBe("0");
    expect(out["Paragraphs"]).toBe("0");
    expect(out["UTF-8 bytes"]).toBe("0");
    expect(out["GPT tokens"]).toBe("0");
  });

  it("counts multiple lines and blank-line-separated paragraphs", async () => {
    const out = await run("line one\nline two\n\nline three", opts());
    expect(out["Lines"]).toBe("4");
    expect(out["Paragraphs"]).toBe("2");
  });

  it("computes a stable positive GPT token count for the o200k_base encoding", async () => {
    const out = await run("hello world", opts("o200k_base"));
    const n = Number(out["GPT tokens"]);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
    expect(n).toBe(2);
  });

  it("computes a stable positive GPT token count for the cl100k_base encoding", async () => {
    const out = await run("hello world", opts("cl100k_base"));
    const n = Number(out["GPT tokens"]);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
    expect(n).toBe(2);
  });

  it("defaults to o200k_base when no encoding is recognized", async () => {
    const out = await run("hello world", { encoding: "not-a-real-encoding" } as never);
    expect(out["GPT tokens"]).toBe("2");
  });
});
