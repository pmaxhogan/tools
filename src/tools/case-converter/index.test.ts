import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

describe("case-converter", () => {
  it("converts a simple phrase to every case", () => {
    const out = run("hello world", {});
    expect(out.camelCase).toBe("helloWorld");
    expect(out.PascalCase).toBe("HelloWorld");
    expect(out.snake_case).toBe("hello_world");
    expect(out.SCREAMING_SNAKE_CASE).toBe("HELLO_WORLD");
    expect(out["kebab-case"]).toBe("hello-world");
    expect(out["Title Case"]).toBe("Hello World");
    expect(out["Sentence case"]).toBe("Hello world");
    expect(out.lowercase).toBe("hello world");
    expect(out.UPPERCASE).toBe("HELLO WORLD");
    expect(out["URL slug"]).toBe("hello-world");
  });

  it("splits camelCase acronym runs correctly", () => {
    const a = run("parseHTMLDocument", {});
    expect(a.snake_case).toBe("parse_html_document");
    expect(a.camelCase).toBe("parseHtmlDocument");
    expect(a["Title Case"]).toBe("Parse Html Document");

    const b = run("XMLHttpRequest", {});
    expect(b.snake_case).toBe("xml_http_request");
    expect(b.camelCase).toBe("xmlHttpRequest");
    expect(b.PascalCase).toBe("XmlHttpRequest");
  });

  it("folds diacritics to ASCII in the URL slug", () => {
    const out = run("café résumé déjà vu", {});
    expect(out["URL slug"]).toBe("cafe-resume-deja-vu");
    // Other forms preserve the original characters.
    expect(out.lowercase).toBe("café résumé déjà vu");
  });

  it("applies small-word rules in Title Case", () => {
    const out = run("the lord of the rings", {});
    expect(out["Title Case"]).toBe("The Lord of the Rings");
  });

  it("handles multi-line input by converting each line independently", () => {
    const out = run("hello world\nfoo_bar baz", {});
    expect(out.camelCase).toBe("helloWorld\nfooBarBaz");
    expect(out["kebab-case"]).toBe("hello-world\nfoo-bar-baz");
    expect(out["Title Case"]).toBe("Hello World\nFoo Bar Baz");
  });

  it("throws a typed error on empty input", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    expect(() => run("   \n  ", {})).toThrowError(ToolError);
    try {
      run("", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toBeTruthy();
    }
  });
});
