import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { ToolError } from "../types";
import {
  MAX_INPUT_BYTES,
  blocksToPdf,
  cleanExtractedText,
  detectInputKind,
  docxToHtml,
  htmlToBlocks,
  htmlToMarkdown,
  htmlToText,
  markdownToHtml,
  run,
  runsText,
  sanitizeForPdf,
  textToHtml,
  type Block,
} from "./index";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const FIXTURE_HTML = [
  "<h1>Quarterly report</h1>",
  "<p>Intro with <strong>bold</strong> and <em>italic</em> words.</p>",
  "<ul><li>first bullet</li><li>second bullet</li></ul>",
  "<ol><li>step one</li><li>step two</li></ol>",
  "<blockquote><p>Quoted line</p></blockquote>",
  "<pre><code>const x = 1;\nconst y = 2;</code></pre>",
  "<table><tr><th>Name</th><th>Size</th></tr><tr><td>a.txt</td><td>12 KB</td></tr></table>",
  "<hr>",
  '<p><img src="chart.png" alt="Chart"> after image</p>',
].join("\n");

/** A minimal but real DOCX: the three parts Word needs to open a document. */
function buildDocx(text: string): Uint8Array {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>` +
    "</w:document>";
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "word/document.xml": strToU8(document),
  });
}

async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof ToolError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-error";
}

function typesOf(blocks: Block[]): string[] {
  return blocks.map((block) => block.type);
}

/* ------------------------------------------------------------------ */
/* markdown to html                                                    */
/* ------------------------------------------------------------------ */

describe("markdownToHtml", () => {
  it("converts headings, emphasis and links", () => {
    const html = markdownToHtml("# Title\n\nSome **bold** and [a link](https://example.com).");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://example.com"');
  });

  it("converts lists and fenced code", () => {
    const html = markdownToHtml("- one\n- two\n\n```js\nlet x = 1;\n```");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<pre>");
    expect(html).toContain("let x = 1;");
  });

  it("converts GitHub flavored tables", () => {
    const html = markdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });
});

/* ------------------------------------------------------------------ */
/* the block model                                                     */
/* ------------------------------------------------------------------ */

describe("htmlToBlocks", () => {
  const blocks = htmlToBlocks(FIXTURE_HTML);

  it("finds every block kind in the fixture", () => {
    expect(typesOf(blocks)).toEqual([
      "heading",
      "paragraph",
      "list-item",
      "list-item",
      "list-item",
      "list-item",
      "quote",
      "code",
      "table-row",
      "table-row",
      "rule",
      "paragraph",
    ]);
  });

  it("keeps heading level and inline styles", () => {
    expect(blocks[0]?.level).toBe(1);
    expect(runsText(blocks[0]?.runs ?? [])).toBe("Quarterly report");
    const intro = blocks[1];
    expect(intro?.runs.some((run) => run.bold && run.text === "bold")).toBe(true);
    expect(intro?.runs.some((run) => run.italic && run.text === "italic")).toBe(true);
    expect(runsText(intro?.runs ?? [])).toBe("Intro with bold and italic words.");
  });

  it("numbers ordered lists and bullets unordered ones", () => {
    expect(blocks[2]?.marker).toBe("•");
    expect(blocks[3]?.marker).toBe("•");
    expect(blocks[4]?.marker).toBe("1.");
    expect(blocks[5]?.marker).toBe("2.");
    expect(blocks[4]?.level).toBe(1);
  });

  it("indents blockquotes and preserves code line breaks", () => {
    expect(blocks[6]?.quoteDepth).toBe(1);
    expect(runsText(blocks[6]?.runs ?? [])).toBe("Quoted line");
    expect(runsText(blocks[7]?.runs ?? [])).toBe("const x = 1;\nconst y = 2;");
    expect(blocks[7]?.runs[0]?.mono).toBe(true);
  });

  it("flattens table rows to tab separated cells", () => {
    expect(blocks[8]?.header).toBe(true);
    expect(runsText(blocks[8]?.runs ?? [])).toBe("Name\tSize");
    expect(blocks[9]?.header).toBeUndefined();
    expect(runsText(blocks[9]?.runs ?? [])).toBe("a.txt\t12 KB");
  });

  it("notes images instead of dropping them silently", () => {
    expect(runsText(blocks[11]?.runs ?? [])).toBe("[image: Chart] after image");
  });

  it("nests lists and survives unclosed tags", () => {
    const nested = htmlToBlocks("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
    expect(nested.map((block) => block.level)).toEqual([1, 2]);
    const broken = htmlToBlocks("<p>one<p>two<div>three");
    expect(broken.map((block) => runsText(block.runs))).toEqual(["one", "two", "three"]);
  });
});

/* ------------------------------------------------------------------ */
/* text and markdown rendering                                         */
/* ------------------------------------------------------------------ */

describe("htmlToText", () => {
  it("puts a blank line between blocks and keeps lists tight", () => {
    expect(htmlToText("<h1>Title</h1><p>One</p><p>Two</p>")).toBe("Title\n\nOne\n\nTwo");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("• a\n• b");
  });

  it("marks quotes, rules and table rows", () => {
    const text = htmlToText(
      "<blockquote><p>quoted</p></blockquote><hr><table><tr><td>a</td><td>b</td></tr></table>",
    );
    expect(text).toBe("> quoted\n\n---\n\na\tb");
  });

  it("collapses layout whitespace but keeps br line breaks", () => {
    expect(htmlToText("<p>  spaced\n   out  </p>")).toBe("spaced out");
    expect(htmlToText("<p>line one<br>line two</p>")).toBe("line one\nline two");
  });
});

describe("htmlToMarkdown", () => {
  it("converts headings, lists and tables", () => {
    const markdown = htmlToMarkdown(FIXTURE_HTML);
    expect(markdown).toContain("# Quarterly report");
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("first bullet");
    expect(markdown).toContain("| Name |");
  });
});

describe("textToHtml", () => {
  it("makes paragraphs from blank lines and escapes markup", () => {
    expect(textToHtml("one\n\ntwo")).toBe("<p>one</p>\n<p>two</p>");
    expect(textToHtml("a < b & c")).toBe("<p>a &lt; b &amp; c</p>");
    expect(textToHtml("line one\nline two")).toBe("<p>line one<br>line two</p>");
  });
});

/* ------------------------------------------------------------------ */
/* pdf rendering                                                       */
/* ------------------------------------------------------------------ */

describe("blocksToPdf", () => {
  it("writes a real one page PDF", async () => {
    const bytes = await blocksToPdf(htmlToBlocks(FIXTURE_HTML));
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(Math.round(pdf.getPage(0).getWidth())).toBe(595);
  });

  it("breaks long documents across pages", async () => {
    const long = Array.from({ length: 120 }, (_, i) => `<p>Paragraph number ${i + 1}.</p>`).join("");
    const bytes = await blocksToPdf(htmlToBlocks(long));
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("honors the letter page size", async () => {
    const bytes = await blocksToPdf(htmlToBlocks("<p>Letter please</p>"), { pageSize: "letter" });
    const pdf = await PDFDocument.load(bytes);
    expect(Math.round(pdf.getPage(0).getWidth())).toBe(612);
  });

  it("wraps a word wider than the column instead of overflowing", async () => {
    const bytes = await blocksToPdf([
      { type: "paragraph", runs: [{ text: "x".repeat(600) }] },
    ]);
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("sanitizeForPdf", () => {
  it("keeps the punctuation the standard fonts encode", () => {
    expect(sanitizeForPdf("café — “quoted” • …")).toBe(
      "café — “quoted” • …",
    );
  });

  it("substitutes what they cannot encode instead of throwing", () => {
    expect(sanitizeForPdf("a\tb")).toBe("a    b");
    expect(sanitizeForPdf("go → there")).toBe("go -> there");
    expect(sanitizeForPdf("中文")).toBe("??");
    expect(sanitizeForPdf("line\nbreak")).toBe("line\nbreak");
  });
});

/* ------------------------------------------------------------------ */
/* docx                                                                */
/* ------------------------------------------------------------------ */

describe("docxToHtml", () => {
  it("reads a minimal Word document", async () => {
    const html = await docxToHtml(buildDocx("Hello docx"));
    expect(html).toContain("Hello docx");
    expect(html).toContain("<p>");
  });
});

/* ------------------------------------------------------------------ */
/* detection                                                           */
/* ------------------------------------------------------------------ */

describe("detectInputKind", () => {
  it("spots a DOCX by its zip magic and part name", () => {
    expect(detectInputKind(buildDocx("Hello docx"))).toBe("docx");
  });

  it("tells Markdown, HTML and plain text apart", () => {
    expect(detectInputKind("# Title\n\n- a\n- b")).toBe("markdown");
    expect(detectInputKind("<html><body><p>hi</p></body></html>")).toBe("html");
    expect(detectInputKind("Just a sentence with no markup at all.")).toBe("text");
    expect(detectInputKind("Read the [docs](https://example.com) first.")).toBe("markdown");
  });

  it("decodes text that arrived as bytes", () => {
    const bytes = new TextEncoder().encode("## Heading\n\ntext");
    expect(detectInputKind(bytes)).toBe("markdown");
  });
});

/* ------------------------------------------------------------------ */
/* pdf text cleanup                                                    */
/* ------------------------------------------------------------------ */

describe("cleanExtractedText", () => {
  it("rejoins hyphenated line breaks and tidies padding", () => {
    expect(cleanExtractedText("exam-\nple text")).toBe("example text");
    expect(cleanExtractedText("a     b")).toBe("a b");
    expect(cleanExtractedText("one\n\n\n\ntwo")).toBe("one\n\ntwo");
    expect(cleanExtractedText("page one\fpage two")).toBe("page one\n\npage two");
  });

  it("removes the invisible characters extraction leaves behind", () => {
    expect(cleanExtractedText("﻿title​ here ")).toBe("title here");
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe("run", () => {
  it("defaults to HTML out and detects Markdown in", async () => {
    const html = await run("# Title\n\nBody text.");
    expect(html).toContain("<h1>Title</h1>");
  });

  it("converts HTML to Markdown", async () => {
    const markdown = await run("<h2>Hi</h2><p>there</p>", { to: "markdown" });
    expect(markdown).toBe("## Hi\n\nthere");
  });

  it("converts HTML to plain text", async () => {
    const text = await run("<h2>Hi</h2><ul><li>a</li></ul>", { to: "text" });
    expect(text).toBe("Hi\n\n• a");
  });

  it("converts a DOCX to Markdown", async () => {
    const markdown = await run(buildDocx("Hello docx"), { to: "markdown" });
    expect(markdown).toBe("Hello docx");
  });

  it("wraps plain text into paragraphs when asked for HTML", async () => {
    const html = await run("just words", { from: "text" });
    expect(html).toBe("<p>just words</p>");
  });

  it("returns page count, size and a data URL for PDF output", async () => {
    const result = (await run("# Title\n\nBody text.", { to: "pdf" })) as Record<string, string>;
    expect(Object.keys(result)).toEqual(["Pages", "Size", "Data URL"]);
    expect(result.Pages).toBe("1");
    expect(result.Size).toMatch(/\d/);
    expect(result["Data URL"]?.startsWith("data:application/pdf;base64,")).toBe(true);
    const base64 = (result["Data URL"] ?? "").split(",")[1] ?? "";
    expect(atob(base64.slice(0, 8)).startsWith("%PDF-")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

describe("errors", () => {
  it("refuses empty input", async () => {
    expect(await errorCode(() => run(""))).toBe("empty-input");
    expect(await errorCode(() => run("   \n  "))).toBe("empty-input");
    expect(await errorCode(() => run(new Uint8Array()))).toBe("empty-input");
  });

  it("refuses formats it cannot read", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
    expect(await errorCode(() => run(pdf))).toBe("unknown-format");
    const zip = zipSync({ "notes.txt": strToU8("hi") });
    expect(await errorCode(() => run(zip))).toBe("unknown-format");
    expect(await errorCode(() => run(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])))).toBe(
      "unknown-format",
    );
    expect(await errorCode(() => run("plain text", { from: "docx" }))).toBe("unknown-format");
  });

  it("reports a Word document it cannot open", async () => {
    const broken = zipSync({ "word/document.xml": strToU8("this is not xml") });
    expect(await errorCode(() => run(broken))).toBe("docx-failed");
  });

  it("refuses documents past the size limit", async () => {
    const huge = new Uint8Array(MAX_INPUT_BYTES + 1);
    expect(await errorCode(() => run(huge))).toBe("too-large");
  });

  it("refuses options it does not understand", async () => {
    expect(await errorCode(() => run("hi", { to: "docx" }))).toBe("bad-option");
    expect(await errorCode(() => run("hi", { from: "pdf" }))).toBe("bad-option");
    expect(await errorCode(() => run("hi", { to: "pdf", pageSize: "a3" }))).toBe("bad-option");
    expect(await errorCode(() => run("hi", { to: "pdf", fontSize: 500 }))).toBe("bad-option");
    expect(await errorCode(() => run("hi", { to: "pdf", margin: 4 }))).toBe("bad-option");
  });
});
