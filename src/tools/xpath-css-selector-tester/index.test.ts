import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  checkHtmlSize,
  clampMatches,
  DEFAULT_MAX_MATCHES,
  engineError,
  explainSelector,
  formatMatches,
  MAX_HTML,
  parseMode,
  preview,
  queryWith,
  run,
  validateSelector,
  type RawMatch,
  type SelectorEngine,
  type SelectorMode,
} from "./index";

/** A stand-in for the browser: it records the call and replays canned matches. */
function fakeEngine(matches: RawMatch[]): SelectorEngine & {
  calls: { html: string; selector: string; mode: SelectorMode }[];
} {
  const calls: { html: string; selector: string; mode: SelectorMode }[] = [];
  return {
    calls,
    query(html, selector, mode) {
      calls.push({ html, selector, mode });
      return matches;
    },
  };
}

/** An engine that fails the way querySelectorAll and evaluate really do. */
const throwingEngine: SelectorEngine = {
  query() {
    throw new Error("'::nope' is not a valid selector");
  },
};

const element = (name: string, text: string, path: string): RawMatch => ({
  kind: "element",
  name,
  markup: `<${name}>${text}</${name}>`,
  text,
  path,
});

const SAMPLE_HTML =
  '<ul class="menu"><li class="item">Buy milk</li><li class="item done">Ship it</li></ul>';

/** Flatten an explanation into one searchable string. */
function explainText(selector: string, mode: SelectorMode): string {
  return explainSelector(selector, mode)
    .map((p) => `${p.source} ${p.description}`)
    .join("\n");
}

describe("parseMode", () => {
  it("defaults to CSS", () => {
    expect(parseMode(undefined)).toBe("css");
    expect(parseMode("")).toBe("css");
  });

  it("reads both modes, case insensitively", () => {
    expect(parseMode("css")).toBe("css");
    expect(parseMode("XPath")).toBe("xpath");
  });

  it("rejects anything else", () => {
    try {
      parseMode("jquery");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-mode");
      expect((e as ToolError).fix).toContain("Mode option");
    }
  });
});

describe("validateSelector", () => {
  it("accepts a normal selector in each mode", () => {
    expect(() => validateSelector("ul.menu > li:first-child", "css")).not.toThrow();
    expect(() => validateSelector("//ul[@class='menu']/li[1]", "xpath")).not.toThrow();
  });

  it("rejects an empty selector with a mode specific hint", () => {
    try {
      validateSelector("   ", "xpath");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-selector");
      expect((e as ToolError).fix).toContain("XPath");
    }
  });

  it("rejects an unclosed bracket", () => {
    try {
      validateSelector("a[href", "css");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unbalanced-selector");
      expect((e as ToolError).message).toContain("never closed");
    }
  });

  it("rejects a stray closing bracket and names its position", () => {
    try {
      validateSelector("a)b", "css");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unbalanced-selector");
      expect((e as ToolError).message).toContain("position 1");
    }
  });

  it("rejects an unterminated quote", () => {
    try {
      validateSelector("a[href='http]", "css");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unterminated-quote");
    }
  });

  it("does not mistake a bracket inside a quoted value for structure", () => {
    expect(() => validateSelector("a[title='a ] b']", "css")).not.toThrow();
  });

  it("rejects a triple slash in XPath", () => {
    try {
      validateSelector("///div", "xpath");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-xpath");
    }
  });
});

describe("checkHtmlSize", () => {
  it("accepts a document at the limit and refuses one past it", () => {
    expect(() => checkHtmlSize("a".repeat(MAX_HTML))).not.toThrow();
    try {
      checkHtmlSize("a".repeat(MAX_HTML + 1));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("input-too-large");
    }
  });
});

describe("engineError", () => {
  it("names the CSS mode and keeps the browser's own message", () => {
    const err = engineError(new Error("bad selector"), "css", "::nope");
    expect(err.code).toBe("bad-css-selector");
    expect(err.message).toContain("bad selector");
    expect(err.fix).toContain("::nope");
  });

  it("names the XPath mode", () => {
    expect(engineError(new Error("boom"), "xpath", "//x").code).toBe("bad-xpath");
  });

  it("passes a ToolError straight through", () => {
    const original = new ToolError("empty-input", "nothing");
    expect(engineError(original, "css", "a")).toBe(original);
  });
});

describe("explainSelector", () => {
  it("returns nothing for an empty selector", () => {
    expect(explainSelector("", "css")).toEqual([]);
  });

  it("reads a tag, class and id", () => {
    const text = explainText("h2#title.big", "css");
    expect(text).toContain("<h2> element");
    expect(text).toContain('with the id "title"');
    expect(text).toContain('with the class "big"');
  });

  it("names each CSS combinator", () => {
    expect(explainText("ul > li", "css")).toContain("direct child");
    expect(explainText("h2 + p", "css")).toContain("very next sibling");
    expect(explainText("h2 ~ p", "css")).toContain("later sibling");
    expect(explainText("a, b", "css")).toContain("separate selector");
    expect(explainText("article h2", "css")).toContain("anywhere inside it");
  });

  it("describes every attribute operator", () => {
    expect(explainText("[data-id]", "css")).toContain("has a data-id attribute");
    expect(explainText('[type="text"]', "css")).toContain('is exactly "text"');
    expect(explainText('a[href^="https"]', "css")).toContain('starts with "https"');
    expect(explainText('a[href$=".pdf"]', "css")).toContain('ends with ".pdf"');
    expect(explainText('a[href*="blog"]', "css")).toContain('contains "blog"');
  });

  it("does not read a dotted attribute value as a class", () => {
    expect(explainText('a[href$=".pdf"]', "css")).not.toContain('class "pdf"');
  });

  it("reads XPath steps, axes and predicates", () => {
    const text = explainText("//div[@class='card']/a[1]", "xpath");
    expect(text).toContain("Search the whole document");
    expect(text).toContain("<div> element");
    expect(text).toContain('class attribute is exactly "card"');
    expect(text).toContain("direct child");
    expect(text).toContain("only the first one");
  });

  it("reads an absolute path, an attribute step and text()", () => {
    expect(explainText("/html/body", "xpath")).toContain("Start at the document root");
    expect(explainText("//a/@href", "xpath")).toContain("The href attribute");
    expect(explainText("//p/text()", "xpath")).toContain("The text inside it");
  });

  it("reads contains() and last()", () => {
    expect(explainText("//a[contains(@href, 'blog')]", "xpath")).toContain('contains "blog"');
    expect(explainText("//li[last()]", "xpath")).toContain("only the last one");
  });

  it("reads a named axis", () => {
    expect(explainText("//li/following-sibling::li", "xpath")).toContain("following-sibling axis");
  });

  it("never throws on an unfinished selector", () => {
    expect(() => explainSelector("div[", "css")).not.toThrow();
    expect(() => explainSelector("//div[@", "xpath")).not.toThrow();
  });
});

describe("preview and clampMatches", () => {
  it("collapses whitespace and shortens long text", () => {
    expect(preview("  a\n\n  b  ")).toBe("a b");
    expect(preview("abcdef", 4)).toBe("abc…");
  });

  it("clamps a bad count to the default and a big one to the cap", () => {
    expect(clampMatches("nonsense")).toBe(DEFAULT_MAX_MATCHES);
    expect(clampMatches(0)).toBe(1);
    expect(clampMatches(99999)).toBe(5000);
    expect(clampMatches(25)).toBe(25);
  });
});

describe("formatMatches", () => {
  const matches = [
    element("li", "Buy milk", "html > body > ul > li:nth-of-type(1)"),
    element("li", "Ship it", "html > body > ul > li:nth-of-type(2)"),
  ];

  it("counts matches and lists them with path and text", () => {
    const out = formatMatches(matches, "li", "css");
    expect(out.Mode).toBe("CSS selector");
    expect(out.Matches).toBe("2 matches");
    expect(out["Match list"]).toContain("1. <li>");
    expect(out["Match list"]).toContain("li:nth-of-type(1)");
    expect(out["Match list"]).toContain("Buy milk");
  });

  it("says No matches and omits the list", () => {
    const out = formatMatches([], "li", "css");
    expect(out.Matches).toBe("No matches");
    expect(out["Match list"]).toBeUndefined();
  });

  it("adds the markup rows only when asked", () => {
    expect(formatMatches(matches, "li", "css").Markup).toBeUndefined();
    expect(formatMatches(matches, "li", "css", { showMarkup: true }).Markup).toContain(
      "<li>Buy milk</li>",
    );
  });

  it("truncates at maxMatches and says so", () => {
    const out = formatMatches(matches, "li", "css", { maxMatches: 1 });
    expect(out.Matches).toBe("2 matches, showing the first 1");
    expect(out["Match list"]).not.toContain("Ship it");
  });

  it("labels attribute, text and value matches distinctly", () => {
    const out = formatMatches(
      [
        { kind: "attribute", name: "href", markup: "/a" },
        { kind: "text", markup: "hello" },
        { kind: "value", markup: "3" },
      ],
      "//a/@href",
      "xpath",
    );
    expect(out.Mode).toBe("XPath expression");
    expect(out["Match list"]).toContain("1. @href");
    expect(out["Match list"]).toContain("2. text()");
    expect(out["Match list"]).toContain("3. value");
  });
});

describe("queryWith", () => {
  it("hands the html, selector and mode to the engine and formats the result", () => {
    const engine = fakeEngine([element("li", "Buy milk", "ul > li:nth-of-type(1)")]);
    const out = queryWith(SAMPLE_HTML, engine, { selector: "li.item", mode: "css" });
    expect(engine.calls).toEqual([{ html: SAMPLE_HTML, selector: "li.item", mode: "css" }]);
    expect(out.Matches).toBe("1 match");
    expect(out.Explanation).toContain('with the class "item"');
  });

  it("validates the selector before it ever reaches the engine", () => {
    const engine = fakeEngine([]);
    expect(() => queryWith(SAMPLE_HTML, engine, { selector: "a[href", mode: "css" })).toThrow(
      ToolError,
    );
    expect(engine.calls).toEqual([]);
  });

  it("refuses empty HTML", () => {
    try {
      queryWith("  ", fakeEngine([]), { selector: "li", mode: "css" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("turns an engine failure into an actionable ToolError", () => {
    try {
      queryWith(SAMPLE_HTML, throwingEngine, { selector: "::nope", mode: "css" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-css-selector");
      expect((e as ToolError).message).toContain("not a valid selector");
    }
  });
});

describe("run", () => {
  it("validates and explains a CSS selector without an engine", () => {
    const out = run(SAMPLE_HTML, { selector: "ul.menu > li", mode: "css" });
    expect(out.Mode).toBe("CSS selector");
    expect(out.Valid).toContain("querySelectorAll");
    expect(out["In plain English"]).toContain("direct child");
    expect(out["Run it"]).toContain("panel above");
  });

  it("names document.evaluate in XPath mode", () => {
    const out = run(SAMPLE_HTML, { selector: "//li", mode: "xpath" });
    expect(out.Valid).toContain("document.evaluate");
  });

  it("still explains the selector when no HTML has been pasted", () => {
    const out = run("", { selector: "li", mode: "css" });
    expect(out["Run it"]).toContain("Paste your HTML");
  });

  it("throws on a bad selector", () => {
    try {
      run(SAMPLE_HTML, { selector: "", mode: "css" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-selector");
    }
  });

  it("throws on a bad mode", () => {
    try {
      run(SAMPLE_HTML, { selector: "li", mode: "sizzle" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-mode");
    }
  });

  it("throws on HTML past the size cap", () => {
    try {
      run("a".repeat(MAX_HTML + 1), { selector: "li", mode: "css" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("input-too-large");
    }
  });
});
