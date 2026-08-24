import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const opts = {};

describe("html-to-markdown", () => {
  it("converts headings, paragraphs, and lists", () => {
    const md = run(
      "<h1>Title</h1><p>Some <strong>bold</strong> prose.</p><ul><li>one</li><li>two</li></ul>",
      opts,
    );
    expect(md).toContain("# Title");
    expect(md).toContain("Some **bold** prose.");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("honors the bullet marker option", () => {
    const md = run("<ul><li>one</li></ul>", { bullet: "*" });
    expect(md).toMatch(/^\*\s+one/m);
  });

  it("converts a table to a GFM table", () => {
    const md = run(
      "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Bolt</td><td>4</td></tr></tbody></table>",
      opts,
    );
    expect(md).toContain("| Name | Qty |");
    expect(md).toMatch(/\| *--- *\|/);
    expect(md).toMatch(/\| Bolt +\| 4 +\|/);
  });

  it("cleans a Google Docs paste without making the whole document bold", () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-9f1c2b3a-7fff-1234">' +
      '<p dir="ltr" style="line-height:1.38;margin-top:0pt;"><span style="font-size:11pt;font-family:Arial;' +
      'font-weight:400;">Plain then </span><span style="font-size:11pt;font-weight:700;">bold</span>' +
      '<span style="font-weight:400;"> then </span><span style="font-style:italic;">italic</span>' +
      '<span style="font-weight:400;">.</span></p></b>';
    const md = run(html, opts);
    expect(md).toBe("Plain then **bold** then _italic_.\n");
    expect(md.startsWith("**")).toBe(false);
    expect(md).not.toContain("docs-internal-guid");
    expect(md).not.toContain("font-weight");
  });

  it("cleans a Word paste of o:p tags, mso styles, and conditional comments", () => {
    const html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head>' +
      '<style><!-- p.MsoNormal {mso-style-parent:""; font-family:"Calibri";} --></style></head><body>' +
      "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Normal</w:View></w:WordDocument></xml><![endif]-->" +
      '<w:sdt><p class="MsoNormal" style="mso-margin-top-alt:auto;mso-pagination:widow-orphan">' +
      'Quarterly <b style="mso-bidi-font-weight:normal">results</b> summary.<o:p></o:p></p></w:sdt>' +
      "<![if !supportLists]><p class=MsoListParagraph style='mso-list:l0 level1 lfo1'>Item one</p><![endif]>" +
      "</body></html>";
    const md = run(html, opts);
    expect(md).toContain("Quarterly **results** summary.");
    expect(md).toContain("Item one");
    expect(md).not.toMatch(/mso/i);
    expect(md).not.toContain("o:p");
    expect(md).not.toContain("[if");
    expect(md).not.toContain("MsoNormal");
  });

  it("converts strikethrough and task lists to GFM", () => {
    const md = run(
      '<p>Was <s>late</s> fine.</p><ul><li><input type="checkbox" checked>shipped</li>' +
        '<li><input type="checkbox">pending</li></ul>',
      opts,
    );
    expect(md).toContain("~~late~~");
    expect(md).toContain("[x] shipped");
    expect(md).toContain("[ ] pending");
  });

  it("indents nested lists", () => {
    const md = run("<ul><li>outer<ul><li>inner</li></ul></li></ul>", opts);
    expect(md).toMatch(/^-\s+outer/m);
    expect(md).toMatch(/\n[ \t]+-\s+inner/);
  });

  it("emits a single space after the list marker", () => {
    const md = run("<ul><li>one</li><li>two</li></ul>", opts);
    expect(md).toBe("- one\n- two\n");
  });

  it("keeps nested list indentation valid with the single-space marker", () => {
    const md = run("<ul><li>outer<ul><li>inner</li></ul></li></ul>", opts);
    expect(md).toBe("- outer\n  - inner\n");
  });

  it("converts pre + code to a fenced code block", () => {
    const md = run("<pre><code>const a = 1;\nconst b = 2;</code></pre>", opts);
    expect(md).toContain("```");
    expect(md).toContain("const a = 1;\nconst b = 2;");
    expect(md.match(/```/g)?.length).toBe(2);
  });

  it("strips links to their text when keepLinks is false", () => {
    const html = '<p>See <a href="https://example.com" title="x">the docs</a> now.</p>';
    expect(run(html, {})).toContain("[the docs](https://example.com");
    const md = run(html, { keepLinks: false });
    expect(md).toContain("See the docs now.");
    expect(md).not.toContain("example.com");
  });

  it("drops images when keepImages is false", () => {
    const html = '<p>Before <img src="cat.png" alt="A cat"> after.</p>';
    expect(run(html, {})).toContain("![A cat](cat.png)");
    const md = run(html, { keepImages: false });
    expect(md).not.toContain("cat.png");
    expect(md).toContain("Before");
    expect(md).toContain("after.");
  });

  it("passes plain text through with paragraphs normalized", () => {
    const md = run("First line.\n\n\n\nSecond line.   \n", opts);
    expect(md).toBe("First line.\n\nSecond line.\n");
  });

  it("collapses runs of non-breaking spaces used as layout", () => {
    const md = run("<p>Left&nbsp;&nbsp;&nbsp;&nbsp;Right</p><p>One&nbsp;space</p>", opts);
    expect(md).toContain("Left Right");
    expect(md).toContain("One space");
    expect(md).not.toContain("\u00A0");
  });

  it("throws a ToolError on empty input", () => {
    expect(() => run("", opts)).toThrowError(ToolError);
    expect(() => run("   \n ", opts)).toThrowError(ToolError);
    try {
      run("", opts);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/rich text or HTML/i);
    }
  });
});
