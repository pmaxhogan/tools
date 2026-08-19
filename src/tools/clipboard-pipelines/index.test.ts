import { describe, expect, it } from "vitest";
import { PRESETS, STEPS, applyChain, findStep, parseChain, run } from "./index";
import { ToolError } from "../types";

/** En dash and em dash, spelled with escapes so the repo stays free of both. */
const LONG_DASHES = new RegExp("[\\u2013\\u2014]");

function chainOf(id: string): string {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no preset ${id}`);
  return preset.chain;
}

describe("clipboard-pipelines catalog", () => {
  it("has unique step ids and no dash characters in user facing text", () => {
    const ids = STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of STEPS) {
      expect(step.label).not.toMatch(LONG_DASHES);
      expect(step.description).not.toMatch(LONG_DASHES);
      expect(step.description.length).toBeGreaterThan(10);
    }
  });

  it("only ships presets whose steps all exist", () => {
    for (const preset of PRESETS) {
      for (const step of parseChain(preset.chain)) {
        expect(findStep(step.id), `${preset.id} references ${step.id}`).toBeTruthy();
      }
    }
  });
});

describe("clipboard-pipelines chain parsing", () => {
  it("accepts newline or comma separated tokens and trims them", () => {
    expect(parseChain("trim,\n  to-uppercase \n")).toEqual([
      { id: "trim" },
      { id: "to-uppercase" },
    ]);
  });

  it("splits on the first colon only, so arguments may contain colons", () => {
    expect(parseChain("prefix-lines:a:b")).toEqual([{ id: "prefix-lines", arg: "a:b" }]);
  });

  it("URL decodes arguments so spaces and commas survive the token format", () => {
    expect(parseChain("prefix-lines:%3E%20")).toEqual([{ id: "prefix-lines", arg: "> " }]);
    expect(parseChain("suffix-lines:%2C")).toEqual([{ id: "suffix-lines", arg: "," }]);
  });

  it("keeps a malformed percent escape verbatim instead of failing", () => {
    expect(parseChain("suffix-lines:100%")).toEqual([{ id: "suffix-lines", arg: "100%" }]);
  });

  it("treats a trailing colon as an empty argument", () => {
    expect(parseChain("prefix-lines:")).toEqual([{ id: "prefix-lines", arg: "" }]);
  });
});

describe("clipboard-pipelines presets", () => {
  it('"Clean paste" trims, collapses whitespace, and drops blank lines', () => {
    const out = run("  Hello   world  \n\n\tSecond    line\t\n  \n", {
      chain: chainOf("clean-paste"),
    });
    expect(out).toBe("Hello world\nSecond line");
  });

  it('"Markdown slug" lowercases and slugifies', () => {
    const out = run("Café Déjà Vu!", { chain: chainOf("markdown-slug") });
    expect(out).toBe("cafe-deja-vu");
  });

  it('"Sort and dedupe" sorts case-insensitively then removes exact repeats', () => {
    const out = run("banana\nApple\napple\nCherry\nbanana", { chain: chainOf("sort-dedupe") });
    expect(out).toBe("Apple\napple\nbanana\nCherry");
  });

  it('"Quote for email" applies its URL encoded prefix argument', () => {
    const out = run("hi   there\n\nbye", { chain: chainOf("quote-for-email") });
    expect(out).toBe("> hi there\n> \n> bye");
  });

  it('"HTML to plain text" strips tags and tidies the result', () => {
    const out = run("<h1>Title</h1>\n<p>Hello &amp; <b>bye</b></p>\n\n", {
      chain: chainOf("html-to-text"),
    });
    expect(out).toBe("Title\nHello & bye");
  });

  it('"Harvest links" extracts, dedupes, and sorts URLs', () => {
    const out = run(
      "go to https://b.example.com, then https://a.example.com and https://b.example.com.",
      {
        chain: chainOf("harvest-links"),
      },
    );
    expect(out).toBe("https://a.example.com\nhttps://b.example.com");
  });
});

describe("clipboard-pipelines steps", () => {
  it("uppercases, lowercases, and title cases", () => {
    expect(run("hello WORLD", { chain: "to-uppercase" })).toBe("HELLO WORLD");
    expect(run("hello WORLD", { chain: "to-lowercase" })).toBe("hello world");
    expect(run("hello WORLD foo", { chain: "title-case" })).toBe("Hello World Foo");
  });

  it("removes diacritics without changing anything else", () => {
    expect(run("Crème Brûlée", { chain: "remove-diacritics" })).toBe("Creme Brulee");
  });

  it("reverses, numbers, and dedupes lines", () => {
    expect(run("a\nb\nc", { chain: "reverse-lines" })).toBe("c\nb\na");
    expect(run("a\nb", { chain: "number-lines" })).toBe("1. a\n2. b");
    expect(run("a\nb\na\nb", { chain: "dedupe-lines" })).toBe("a\nb");
  });

  it("sorts Z to A", () => {
    expect(run("banana\napple\ncherry", { chain: "sort-lines-za" })).toBe("cherry\nbanana\napple");
  });

  it("strips HTML tags and decodes common entities", () => {
    expect(run("<p>Hello &amp; <b>bye</b></p>", { chain: "strip-html-tags" })).toBe("Hello & bye");
    expect(run("&amp;lt; stays literal", { chain: "strip-html-tags" })).toBe("&lt; stays literal");
  });

  it("round-trips URL encoding", () => {
    const text = "a b&c=d/é";
    expect(run(text, { chain: "url-encode,url-decode" })).toBe(text);
  });

  it("round-trips base64 including non-ASCII text", () => {
    const text = "héllo wörld\nsecond line";
    expect(run(text, { chain: "base64-encode,base64-decode" })).toBe(text);
    expect(run("hi", { chain: "base64-encode" })).toBe("aGk=");
    expect(run("aGk=", { chain: "base64-decode" })).toBe("hi");
  });

  it("escapes text as a JSON string, quotes included", () => {
    expect(run('a "b"\nc', { chain: "escape-json-string" })).toBe('"a \\"b\\"\\nc"');
  });

  it("slugifies each line separately", () => {
    expect(run("Hello World!\n  Second Post  ", { chain: "slugify" })).toBe(
      "hello-world\nsecond-post",
    );
  });

  it("word wraps at the given width and falls back to 80 on a bad argument", () => {
    expect(run("the quick brown fox jumps over the lazy dog", { chain: "wrap-lines:10" })).toBe(
      "the quick\nbrown fox\njumps over\nthe lazy\ndog",
    );
    const long = "word ".repeat(30).trim();
    expect(run(long, { chain: "wrap-lines:abc" }).split("\n")[0]!.length).toBeLessThanOrEqual(80);
  });

  it("prefixes and suffixes every line", () => {
    expect(run("a\nb", { chain: "prefix-lines:%2D%20,suffix-lines:%3B" })).toBe("- a;\n- b;");
  });

  it("replaces plain text using the find//replacement argument", () => {
    expect(run("foofoo", { chain: "replace:foo%2F%2Fbar" })).toBe("barbar");
    // A replacement may itself contain slashes: only the first // splits.
    expect(run("a", { chain: "replace:a%2F%2Fhttp%3A%2F%2Fx" })).toBe("http://x");
    // No // at all means delete the match.
    expect(run("xyzzy", { chain: "replace:xyz" })).toBe("zy");
    // An empty find is a no-op rather than an error.
    expect(run("keep me", { chain: "replace:" })).toBe("keep me");
  });

  it("extracts emails and URLs, deduplicated and without trailing punctuation", () => {
    expect(run("mail a@b.com and c@d.org, also a@b.com", { chain: "extract-emails" })).toBe(
      "a@b.com\nc@d.org",
    );
    expect(run("see https://example.com/a, and http://b.org.", { chain: "extract-urls" })).toBe(
      "https://example.com/a\nhttp://b.org",
    );
  });

  it("pretty prints valid JSON and leaves invalid JSON untouched", () => {
    expect(run('{"b":1,"a":[2]}', { chain: "json-pretty" })).toBe(
      '{\n  "b": 1,\n  "a": [\n    2\n  ]\n}',
    );
    expect(run("not json at all", { chain: "json-pretty" })).toBe("not json at all");
  });

  it("produces a fixed count report", () => {
    expect(run("hello world\nsecond line", { chain: "count-report" })).toBe(
      "chars: 23\nwords: 4\nlines: 2",
    );
  });
});

describe("clipboard-pipelines engine", () => {
  it("applies a multi-step chain with an argument in order", () => {
    const out = run("  beta\nalpha\nbeta  ", {
      chain: "trim\ncollapse-whitespace\nsort-lines-az\ndedupe-lines\nprefix-lines:%2D%20",
    });
    expect(out).toBe("- alpha\n- beta");
  });

  it("exposes applyChain for a structural caller", () => {
    expect(applyChain("a\nb", [{ id: "prefix-lines", arg: "> " }])).toBe("> a\n> b");
  });

  it("runs on empty input instead of throwing", () => {
    expect(run("", { chain: "trim,to-uppercase" })).toBe("");
    expect(run("", { chain: "count-report" })).toBe("chars: 0\nwords: 0\nlines: 0");
  });

  it("throws unknown-step for a transform that does not exist", () => {
    expect(() => run("x", { chain: "trim,nope" })).toThrow(ToolError);
    try {
      run("x", { chain: "trim,nope" });
      expect.unreachable();
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("unknown-step");
      expect(err.message).toBe('No transform named "nope".');
      expect(err.fix).toBe("Remove it from the chain or check the id.");
    }
  });

  it("validates the whole chain before running any step", () => {
    // base64-decode would throw on this input, but the unknown id wins first.
    expect(() => run("!!!", { chain: "nope,base64-decode" })).toThrowError(
      /No transform named "nope"/,
    );
  });

  it("throws empty-chain for a missing or blank chain", () => {
    for (const chain of ["", "   ", ",,", "\n\n"]) {
      try {
        run("text", { chain });
        expect.unreachable();
      } catch (e) {
        const err = e as ToolError;
        expect(err.code).toBe("empty-chain");
        expect(err.message).toBe("Add at least one transform to the pipeline.");
      }
    }
  });

  it("throws invalid-base64 on a decode step that cannot succeed", () => {
    try {
      run("!!!!", { chain: "base64-decode" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-base64");
    }
  });

  it("throws invalid-url-encoding on a malformed percent escape", () => {
    try {
      run("100% sure", { chain: "url-decode" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-url-encoding");
    }
  });

  it("is deterministic: the same chain and input always give the same output", () => {
    const input = "Zebra\nApple\nzebra\nBanana";
    const chain = chainOf("sort-dedupe");
    expect(run(input, { chain })).toBe(run(input, { chain }));
  });
});
