import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

describe("speculation-rules-generator: generate", () => {
  it("builds document rules with an include pattern and a not-exclusion, exact JSON", () => {
    const out = run("/products/*\nnot /products/admin/*", {
      mode: "generate",
      action: "prerender",
      eagerness: "moderate",
      documentRules: true,
      scriptTag: false,
    }) as string;

    expect(JSON.parse(out)).toEqual({
      prerender: [
        {
          source: "document",
          where: {
            and: [{ href_matches: "/products/*" }, { not: { href_matches: "/products/admin/*" } }],
          },
          eagerness: "moderate",
        },
      ],
    });
  });

  it("builds a list rule from plain URLs (no patterns present)", () => {
    const out = run("/a\n/b\nhttps://example.com/c", {
      mode: "generate",
      action: "prefetch",
      eagerness: "conservative",
      documentRules: true,
      scriptTag: false,
    }) as string;

    expect(JSON.parse(out)).toEqual({
      prefetch: [{ source: "list", urls: ["/a", "/b", "https://example.com/c"], eagerness: "conservative" }],
    });
  });

  it("forces a list rule when documentRules is false, even with pattern-shaped lines", () => {
    const out = run("/products/*\n/other/:id", {
      mode: "generate",
      action: "prefetch",
      eagerness: "moderate",
      documentRules: false,
      scriptTag: false,
    }) as string;

    const parsed = JSON.parse(out);
    expect(parsed.prefetch[0].source).toBe("list");
    expect(parsed.prefetch[0].urls).toEqual(["/products/*", "/other/:id"]);
  });

  it("passes each eagerness value through unchanged", () => {
    for (const eagerness of ["conservative", "moderate", "eager", "immediate"]) {
      const out = run("/a", { mode: "generate", action: "prefetch", eagerness, scriptTag: false }) as string;
      expect(JSON.parse(out).prefetch[0].eagerness).toBe(eagerness);
    }
  });

  it("wraps output in a script tag by default", () => {
    const out = run("/a", { mode: "generate", action: "prefetch", eagerness: "moderate" }) as string;
    expect(out).toMatch(/^<script type="speculationrules">/);
    expect(out.trim()).toMatch(/<\/script>$/);
  });

  it("emits both a document rule and a list rule when patterns and plain URLs are mixed", () => {
    const out = run("/products/*\n/about", {
      mode: "generate",
      action: "prefetch",
      eagerness: "moderate",
      documentRules: true,
      scriptTag: false,
    }) as string;

    const parsed = JSON.parse(out);
    expect(parsed.prefetch).toHaveLength(2);
    expect(parsed.prefetch[0].source).toBe("document");
    expect(parsed.prefetch[1]).toEqual({ source: "list", urls: ["/about"], eagerness: "moderate" });
  });

  it("adds a cross-origin advisory comment when prerendering an absolute URL", () => {
    const out = run("https://other-site.example/page", {
      mode: "generate",
      action: "prerender",
      eagerness: "moderate",
      scriptTag: true,
    }) as string;
    expect(out).toMatch(/^<!--.*other-site\.example.*-->/s);
  });

  it("throws empty-input for blank input", () => {
    expect(() => run("", { mode: "generate" })).toThrowError(ToolError);
    try {
      run("   \n  ", { mode: "generate" });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws no-urls when input has no usable lines", () => {
    expect(() => run("not\nnot   ", { mode: "generate" })).toThrowError(ToolError);
    try {
      run("not", { mode: "generate" });
    } catch (e) {
      expect((e as ToolError).code).toBe("no-urls");
    }
  });
});

describe("speculation-rules-generator: validate", () => {
  it("accepts a correct ruleset with a Valid verdict and no findings", () => {
    const json = JSON.stringify({
      prefetch: [{ source: "list", urls: ["/a", "/b"], eagerness: "conservative" }],
    });
    const out = run(json, { mode: "validate" }) as Record<string, string>;
    expect(out.Verdict).toBe("Valid");
    expect(Object.keys(out).some((k) => k.startsWith("Finding"))).toBe(false);
    expect(out.Summary).toMatch(/Prefetches/);
  });

  it("flags an unknown key and a bad eagerness value as specific findings", () => {
    const json = JSON.stringify({
      prefetch: [{ source: "list", urls: ["/a"], eagerness: "yesterday", foo: "bar" }],
    });
    const out = run(json, { mode: "validate" }) as Record<string, string>;
    expect(out.Verdict).toBe("Invalid");
    const values = Object.values(out);
    expect(values.some((v) => v.includes('Unknown key "foo"'))).toBe(true);
    expect(values.some((v) => v.includes("eagerness") && v.includes("yesterday"))).toBe(true);
  });

  it("accepts implied source from urls or where without an explicit source key", () => {
    const json = JSON.stringify({
      prefetch: [{ urls: ["/a"] }],
      prerender: [{ where: { href_matches: "/x/*" } }],
    });
    const out = run(json, { mode: "validate" }) as Record<string, string>;
    expect(out.Verdict).toBe("Valid");
  });

  it("flags anonymous-client-ip-when-cross-origin used on a prerender rule", () => {
    const json = JSON.stringify({
      prerender: [{ urls: ["/a"], requires: ["anonymous-client-ip-when-cross-origin"] }],
    });
    const out = run(json, { mode: "validate" }) as Record<string, string>;
    expect(out.Verdict).toBe("Invalid");
    expect(Object.values(out).some((v) => v.includes("only valid on prefetch rules"))).toBe(true);
  });

  it("warns on the deprecated prefetch_with_subresources key", () => {
    const json = JSON.stringify({
      prefetch_with_subresources: [{ source: "list", urls: ["/a"] }],
    });
    const out = run(json, { mode: "validate" }) as Record<string, string>;
    expect(out.Verdict).toBe("Valid with warnings");
    expect(Object.values(out).some((v) => v.includes("deprecated"))).toBe(true);
  });

  it("strips a full <script type=speculationrules> wrapper before parsing", () => {
    const wrapped = `<script type="speculationrules">\n${JSON.stringify({
      prefetch: [{ source: "list", urls: ["/a"] }],
    })}\n</script>`;
    const out = run(wrapped, { mode: "validate" }) as Record<string, string>;
    expect(out.Verdict).toBe("Valid");
  });

  it("throws empty-input for blank input", () => {
    expect(() => run("", { mode: "validate" })).toThrowError(ToolError);
    try {
      run("  ", { mode: "validate" });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws bad-json for malformed JSON, with a position in the message", () => {
    try {
      run("{ not valid json", { mode: "validate" });
      throw new Error("expected ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-json");
    }
  });
});
