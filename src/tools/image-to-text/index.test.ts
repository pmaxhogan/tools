import { describe, expect, it } from "vitest";
import {
  LOW_CONFIDENCE,
  cleanText,
  collectLines,
  collectWords,
  confidenceSummary,
  formatResult,
  reconstructLayout,
  run,
  toBlocks,
  toTsv,
  type OcrBbox,
  type OcrLine,
  type OcrPage,
  type OcrWord,
} from "./index";
import { ToolError } from "../types";

/* ------------------------------------------------------------------ */
/* fixtures: tesseract shaped results, built by hand                   */
/* ------------------------------------------------------------------ */

function bbox(x0: number, y0: number, x1: number, y1: number): OcrBbox {
  return { x0, y0, x1, y1 };
}

function word(text: string, confidence: number, box: OcrBbox): OcrWord {
  return { text, confidence, bbox: box };
}

function line(text: string, confidence: number, box: OcrBbox, words: OcrWord[]): OcrLine {
  return { text, confidence, bbox: box, words };
}

/** Two blocks: a confident heading and a barely legible caption. */
function samplePage(): OcrPage {
  const headingWords = [
    word("Invoice", 96, bbox(10, 10, 80, 30)),
    word("2026", 92, bbox(90, 10, 140, 30)),
  ];
  const captionWords = [
    word("scanned", 41, bbox(10, 60, 90, 80)),
    word("copy", 37, bbox(100, 60, 150, 80)),
  ];
  return {
    text: "Invoice 2026\nscanned copy\n",
    confidence: 66,
    blocks: [
      {
        text: "Invoice 2026\n",
        confidence: 94,
        bbox: bbox(10, 10, 140, 30),
        paragraphs: [
          {
            text: "Invoice 2026\n",
            confidence: 94,
            bbox: bbox(10, 10, 140, 30),
            lines: [line("Invoice 2026", 94, bbox(10, 10, 140, 30), headingWords)],
          },
        ],
      },
      {
        text: "scanned copy\n",
        confidence: 39,
        bbox: bbox(10, 60, 150, 80),
        paragraphs: [
          {
            text: "scanned copy\n",
            confidence: 39,
            bbox: bbox(10, 60, 150, 80),
            lines: [line("scanned copy", 39, bbox(10, 60, 150, 80), captionWords)],
          },
        ],
      },
    ],
  };
}

/** What tesseract returns for a blank image: empty text, no blocks. */
const emptyPage: OcrPage = { text: "", confidence: 0, blocks: [] };

/* ------------------------------------------------------------------ */

describe("cleanText", () => {
  it("normalizes CRLF, trailing spaces, and runs of blank lines", () => {
    const raw = "\n\nHello world   \r\n\r\n\r\n\r\nSecond   paragraph\t\r\n\n\n";
    expect(cleanText(raw)).toBe("Hello world\n\nSecond   paragraph");
  });

  it("keeps interior runs of spaces, which carry the only column information", () => {
    expect(cleanText("Name      Amount\nAda        42")).toBe("Name      Amount\nAda        42");
  });

  it("returns an empty string for empty or missing text", () => {
    expect(cleanText("")).toBe("");
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
  });
});

describe("collectLines and collectWords", () => {
  it("flattens the block, paragraph, line, word nesting in reading order", () => {
    expect(collectLines(samplePage()).map((l) => l.text)).toEqual(["Invoice 2026", "scanned copy"]);
    expect(collectWords(samplePage()).map((w) => w.text)).toEqual([
      "Invoice",
      "2026",
      "scanned",
      "copy",
    ]);
  });

  it("returns nothing when blocks were never requested", () => {
    const noBlocks: OcrPage = { text: "hi", blocks: null };
    expect(collectLines(noBlocks)).toEqual([]);
    expect(collectWords(noBlocks)).toEqual([]);
  });
});

describe("toBlocks", () => {
  it("reports mean word confidence per block and marks the weak one", () => {
    const report = toBlocks(samplePage());
    expect(report).toContain("Block 1 of 2  mean confidence 94%");
    expect(report).toContain("Invoice 2026");
    expect(report).toContain("Block 2 of 2  mean confidence 39%  [low confidence]");
    expect(report).toContain("scanned copy");
    // The confident block must not carry the marker.
    expect(report.split("\n\n")[0]).not.toContain("[low confidence]");
  });

  it("falls back to the block confidence when a block holds no words", () => {
    const page: OcrPage = {
      text: "",
      blocks: [{ text: "", confidence: 75, bbox: bbox(0, 0, 10, 10), paragraphs: [] }],
    };
    expect(toBlocks(page)).toBe("Block 1 of 1  mean confidence 75%\n(no text)");
  });

  it("says so plainly when nothing was found", () => {
    expect(toBlocks(emptyPage)).toBe("No text blocks were found in this image.");
    expect(toBlocks(null)).toBe("No text blocks were found in this image.");
  });
});

describe("toTsv", () => {
  it("writes a header and one rounded row per word", () => {
    const rows = toTsv(collectWords(samplePage())).split("\n");
    expect(rows[0]).toBe("text\tconfidence\tx0\ty0\tx1\ty1");
    expect(rows[1]).toBe("Invoice\t96\t10\t10\t80\t30");
    expect(rows[4]).toBe("copy\t37\t100\t60\t150\t80");
    expect(rows).toHaveLength(5);
  });

  it("replaces tabs and newlines inside a word so the row stays parseable", () => {
    expect(toTsv([word("a\tb\nc", 80.4, bbox(1.2, 2.6, 3, 4))]).split("\n")[1]).toBe(
      "a b c\t80\t1\t3\t3\t4",
    );
  });

  it("emits the header alone for an empty page", () => {
    expect(toTsv([])).toBe("text\tconfidence\tx0\ty0\tx1\ty1");
    expect(toTsv(null)).toBe("text\tconfidence\tx0\ty0\tx1\ty1");
  });
});

describe("reconstructLayout", () => {
  // Every line below is drawn on a 10 pixel per character grid, so the expected
  // indent of a line starting at x0 is exactly x0 / 10 spaces.
  const grid: OcrLine[] = [
    line("0123456789", 90, bbox(0, 0, 100, 20), []),
    line("ABCDEF", 90, bbox(50, 25, 110, 45), []),
    line("after gap", 90, bbox(200, 90, 290, 110), []),
  ];

  it("indents each line in proportion to its left edge", () => {
    const out = reconstructLayout(grid, 1000).split("\n");
    expect(out[0]).toBe("0123456789");
    expect(out[1]).toBe("     ABCDEF");
    expect(out[out.length - 1]).toBe("                    after gap");
  });

  it("inserts one blank line where the vertical gap exceeds a line height", () => {
    const out = reconstructLayout(grid, 1000).split("\n");
    // Rows 1 and 2 are adjacent (5 px apart); row 3 sits 45 px lower.
    expect(out).toEqual(["0123456789", "     ABCDEF", "", "                    after gap"]);
  });

  it("sorts by vertical position, so out of order lines still read top to bottom", () => {
    const shuffled = [grid[2]!, grid[0]!, grid[1]!];
    expect(reconstructLayout(shuffled, 1000)).toBe(reconstructLayout(grid, 1000));
  });

  it("clamps the indent so a line cannot be pushed past the page width", () => {
    const narrow = [
      line("0123456789", 90, bbox(0, 0, 100, 20), []),
      line("edge", 90, bbox(900, 25, 940, 45), []),
    ];
    // 200 px page at 10 px per character is 20 columns, so "edge" starts at 16.
    expect(reconstructLayout(narrow, 200).split("\n")[1]).toBe(`${" ".repeat(16)}edge`);
  });

  it("falls back to plain reading order when no character width can be derived", () => {
    const zeroWidth = [
      line("one", 90, bbox(0, 0, 0, 0), []),
      line("two", 90, bbox(0, 10, 0, 10), []),
    ];
    expect(reconstructLayout(zeroWidth, 0)).toBe("one\ntwo");
  });

  it("returns an empty string when there is nothing to lay out", () => {
    expect(reconstructLayout([], 500)).toBe("");
    expect(reconstructLayout([line("   ", 0, bbox(0, 0, 1, 1), [])], 500)).toBe("");
    expect(reconstructLayout(null, 500)).toBe("");
  });
});

describe("confidenceSummary", () => {
  it("averages the words and counts the weak ones", () => {
    const summary = confidenceSummary(collectWords(samplePage()));
    expect(summary.wordCount).toBe(4);
    expect(summary.mean).toBe(66.5);
    expect(summary.lowConfidenceCount).toBe(2);
    expect(summary.verdict).toBe("poor");
    expect(summary.summary).toContain("4 words, mean confidence 67%, 2 under 60%");
    expect(summary.summary).toContain("higher resolution");
  });

  it("calls a clean scan great and a middling one good", () => {
    const great = confidenceSummary([word("crisp", 97, bbox(0, 0, 1, 1))]);
    expect(great.verdict).toBe("great");
    expect(great.summary).toContain("1 word,");
    expect(great.summary).toContain("Quality looks great.");

    const good = confidenceSummary([
      word("ok", 72, bbox(0, 0, 1, 1)),
      word("fine", 78, bbox(0, 0, 1, 1)),
    ]);
    expect(good.verdict).toBe("good");
    expect(good.lowConfidenceCount).toBe(0);
  });

  it("treats a word exactly at the threshold as acceptable", () => {
    expect(
      confidenceSummary([word("edge", LOW_CONFIDENCE, bbox(0, 0, 1, 1))]).lowConfidenceCount,
    ).toBe(0);
  });

  it("advises on the photo rather than apologizing when nothing was found", () => {
    const summary = confidenceSummary([]);
    expect(summary).toMatchObject({
      wordCount: 0,
      mean: 0,
      lowConfidenceCount: 0,
      verdict: "poor",
    });
    expect(summary.summary).toContain("No words were recognized.");
    expect(confidenceSummary(null).verdict).toBe("poor");
  });
});

describe("formatResult", () => {
  it("renders plain text, blocks, and TSV from the same stored result", () => {
    const page = samplePage();
    expect(formatResult(page, { format: "text", preserveLayout: false })).toBe(
      "Invoice 2026\nscanned copy",
    );
    expect(formatResult(page, { format: "blocks", preserveLayout: false })).toContain(
      "Block 1 of 2",
    );
    expect(formatResult(page, { format: "tsv", preserveLayout: false })).toContain(
      "Invoice\t96\t10\t10\t80\t30",
    );
  });

  it("rebuilds indentation only when preserveLayout is on", () => {
    const page = samplePage();
    const laid = formatResult(page, { format: "text", preserveLayout: true }, 400);
    expect(laid.split("\n")[0]).toMatch(/^ +Invoice 2026$/);
    expect(formatResult(page, { format: "text", preserveLayout: false })).not.toMatch(/^ /);
  });

  it("falls back to the page text when layout is requested but no boxes exist", () => {
    const noBlocks: OcrPage = { text: "just text", blocks: null };
    expect(formatResult(noBlocks, { format: "text", preserveLayout: true }, 400)).toBe("just text");
  });

  it("handles an empty result in every format", () => {
    expect(formatResult(emptyPage, { format: "text", preserveLayout: false })).toBe("");
    expect(formatResult(emptyPage, { format: "text", preserveLayout: true }, 800)).toBe("");
    expect(formatResult(emptyPage, { format: "blocks", preserveLayout: false })).toBe(
      "No text blocks were found in this image.",
    );
    expect(formatResult(emptyPage, { format: "tsv", preserveLayout: false })).toBe(
      "text\tconfidence\tx0\ty0\tx1\ty1",
    );
  });
});

describe("run", () => {
  const bytes = new Uint8Array(2048);
  const opts = { language: "eng", format: "text", preserveLayout: false };

  it("reports what the panel will do with the image and the options", () => {
    const rows = run(bytes, opts);
    expect(rows.Image).toBe("2.0 KB of image data, ready to recognize.");
    expect(rows.Language).toContain("English (eng)");
    expect(rows["Output format"]).toBe("Plain text");
    expect(rows.Layout).toContain("Off.");
    expect(rows.Engine).toContain("WebAssembly worker");
  });

  it("describes the layout option and other languages and formats", () => {
    const rows = run(bytes, { language: "jpn", format: "tsv", preserveLayout: true });
    expect(rows.Language).toContain("Japanese (jpn)");
    expect(rows["Output format"]).toBe("TSV with positions");
    expect(rows.Layout).toContain("rebuilt from word positions");
  });

  it("rejects an empty input with a fix", () => {
    expect(() => run(new Uint8Array(0), opts)).toThrow(ToolError);
    try {
      run(new Uint8Array(0), opts);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toContain("Ctrl+V");
    }
  });

  it("rejects text input, which has nothing to recognize", () => {
    try {
      run("hello", opts);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("not-an-image");
    }
  });

  it("rejects a language with no staged pack", () => {
    try {
      run(bytes, { ...opts, language: "kor" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unsupported-language");
      expect((e as ToolError).fix).toContain("eng");
    }
  });

  it("rejects an output format it does not produce", () => {
    try {
      run(bytes, { ...opts, format: "pdf" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unsupported-format");
    }
  });
});
