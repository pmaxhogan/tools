import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { SEPARATOR, run, type PatchOpts } from "./index";
import { meta } from "./meta";

const DEFAULTS: PatchOpts = { reverse: false, lineEndings: "preserve", ignoreWhitespace: false };

function apply(input: string, opts: Partial<PatchOpts> = {}): Record<string, string> {
  return run(input, { ...DEFAULTS, ...opts });
}

function patched(input: string, opts: Partial<PatchOpts> = {}): string {
  return apply(input, opts)["Patched text"];
}

/** Original text, the separator line, then the diff. */
function build(original: string, diff: string): string {
  return `${original}\n${SEPARATOR}\n${diff}`;
}

const THREE = "alpha\nbeta\ngamma";
const SWAP_BETA = ["@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", " gamma"].join("\n");

describe("applying a unified diff", () => {
  it("applies a single hunk", () => {
    const out = apply(build(THREE, SWAP_BETA));
    expect(out["Patched text"]).toBe("alpha\nBETA\ngamma");
    expect(out.Hunks).toBe("1 hunk applied");
    expect(out.Changes).toBe("+1 line, -1 line");
  });

  it("reports that a bare diff carried no file headers", () => {
    expect(apply(build(THREE, SWAP_BETA))["Files in patch"]).toBe(
      "No file headers in the diff, so the hunks were applied to the pasted text directly.",
    );
  });

  it("applies a multi hunk patch with full git headers", () => {
    const original = [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ].join("\n");
    const diff = [
      "diff --git a/nums.txt b/nums.txt",
      "index 1a2b3c4..5d6e7f8 100644",
      "--- a/nums.txt",
      "+++ b/nums.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "@@ -8,3 +8,4 @@",
      " eight",
      " nine",
      "-ten",
      "+TEN",
      "+eleven",
    ].join("\n");
    const out = apply(build(original, diff));
    expect(out["Patched text"]).toBe(
      "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven",
    );
    expect(out.Hunks).toBe("2 hunks applied");
    expect(out.Changes).toBe("+3 lines, -2 lines");
    expect(out["Files in patch"]).toBe("a/nums.txt -> b/nums.txt");
  });

  it("applies a pure addition hunk with a zero old count", () => {
    const diff = ["@@ -2,0 +3,2 @@", "+delta", "+epsilon"].join("\n");
    const out = apply(build(THREE, diff));
    expect(out["Patched text"]).toBe("alpha\nbeta\ndelta\nepsilon\ngamma");
    expect(out.Changes).toBe("+2 lines, -0 lines");
  });

  it("applies a pure deletion hunk with a zero new count", () => {
    const diff = ["@@ -2,1 +1,0 @@", "-beta"].join("\n");
    const out = apply(build(THREE, diff));
    expect(out["Patched text"]).toBe("alpha\ngamma");
    expect(out.Changes).toBe("+0 lines, -1 line");
  });

  it("applies a hunk at the very start of the file", () => {
    const diff = ["@@ -1,1 +1,2 @@", "-alpha", "+ALPHA", "+alpha2"].join("\n");
    expect(patched(build(THREE, diff))).toBe("ALPHA\nalpha2\nbeta\ngamma");
  });

  it("applies a hunk at the very end of the file", () => {
    const diff = ["@@ -3,1 +3,2 @@", " gamma", "+omega"].join("\n");
    expect(patched(build(THREE, diff))).toBe("alpha\nbeta\ngamma\nomega");
  });

  it("treats an omitted count in the hunk header as 1", () => {
    const diff = ["@@ -2 +2 @@", "-beta", "+BETA"].join("\n");
    expect(patched(build(THREE, diff))).toBe("alpha\nBETA\ngamma");
  });

  it("reads a bare empty line inside a hunk as an empty context line", () => {
    const diff = ["@@ -1,3 +1,3 @@", "-alpha", "+ALPHA", "", " gamma"].join("\n");
    expect(patched(build("alpha\n\ngamma", diff))).toBe("ALPHA\n\ngamma");
  });

  it("ignores trailing junk after the last hunk, including a git signature", () => {
    const diff = [SWAP_BETA, "-- ", "2.43.0", ""].join("\n");
    expect(patched(build(THREE, diff))).toBe("alpha\nBETA\ngamma");
  });

  it("keeps trailing whitespace on context lines it copies through", () => {
    const original = "alpha  \nbeta";
    const diff = ["@@ -1,2 +1,2 @@", " alpha  ", "-beta", "+BETA"].join("\n");
    expect(patched(build(original, diff))).toBe("alpha  \nBETA");
  });
});

describe("no newline at end of file", () => {
  it("adds a trailing newline when the marker sits on the removed line", () => {
    const diff = ["@@ -2 +2 @@", "-beta", "\\ No newline at end of file", "+beta"].join("\n");
    expect(patched(build("alpha\nbeta", diff))).toBe("alpha\nbeta\n");
  });

  it("drops the trailing newline when the marker sits on the added line", () => {
    const diff = ["@@ -2 +2 @@", "-beta", "+beta", "\\ No newline at end of file"].join("\n");
    expect(patched(build("alpha\nbeta\n", diff))).toBe("alpha\nbeta");
  });

  it("keeps the original trailing newline when the diff carries no marker", () => {
    expect(patched(build("alpha\nbeta\ngamma\n", SWAP_BETA))).toBe("alpha\nBETA\ngamma\n");
    expect(patched(build(THREE, SWAP_BETA))).toBe("alpha\nBETA\ngamma");
  });

  it("matches a marker written in another language", () => {
    const diff = ["@@ -2 +2 @@", "-beta", "+beta", "\\ Pas de fin de ligne"].join("\n");
    expect(patched(build("alpha\nbeta\n", diff))).toBe("alpha\nbeta");
  });
});

describe("the reverse option", () => {
  it("applies the patch backwards", () => {
    expect(patched(build("alpha\nBETA\ngamma", SWAP_BETA), { reverse: true })).toBe(THREE);
  });

  it("says so in the hunk row", () => {
    expect(apply(build("alpha\nBETA\ngamma", SWAP_BETA), { reverse: true }).Hunks).toBe(
      "1 hunk applied in reverse",
    );
  });

  it("swaps the old and new line numbers so an offset hunk still lands", () => {
    // The new side starts two lines later than the old side.
    const diff = ["@@ -1,1 +3,1 @@", "-alpha", "+ALPHA"].join("\n");
    expect(patched(build("x\ny\nALPHA\nbeta", diff), { reverse: true })).toBe("x\ny\nalpha\nbeta");
  });

  it("round trips an insertion and a deletion back to the original", () => {
    const original = "one\ntwo\nthree\nfour";
    const diff = [
      "@@ -1,4 +1,4 @@",
      " one",
      "-two",
      "+TWO",
      "+two point five",
      " three",
      "-four",
    ].join("\n");
    const forward = patched(build(original, diff));
    expect(forward).toBe("one\nTWO\ntwo point five\nthree");
    expect(patched(build(forward, diff), { reverse: true })).toBe(original);
  });

  it("round trips a patch that carries a no newline marker", () => {
    const original = "alpha\nbeta";
    const diff = [
      "@@ -2 +2 @@",
      "-beta",
      "\\ No newline at end of file",
      "+BETA",
      "\\ No newline at end of file",
    ].join("\n");
    const forward = patched(build(original, diff));
    expect(forward).toBe("alpha\nBETA");
    expect(patched(build(forward, diff), { reverse: true })).toBe(original);
  });
});

describe("line endings", () => {
  const CRLF_INPUT = `alpha\r\nbeta\r\ngamma\r\n${SEPARATOR}\n${["@@ -2 +2 @@", "-beta", "+BETA"].join("\n")}`;

  it("patches a CRLF original against an LF diff", () => {
    const out = apply(CRLF_INPUT);
    expect(out["Patched text"]).toBe("alpha\r\nBETA\r\ngamma");
    expect(out["Line endings"]).toBe("Detected CRLF in the original. Wrote CRLF.");
  });

  it("forces LF on request", () => {
    const out = apply(CRLF_INPUT, { lineEndings: "lf" });
    expect(out["Patched text"]).toBe("alpha\nBETA\ngamma");
    expect(out["Line endings"]).toBe("Detected CRLF in the original. Wrote LF.");
  });

  it("forces CRLF on request", () => {
    const out = apply(build(THREE, SWAP_BETA), { lineEndings: "crlf" });
    expect(out["Patched text"]).toBe("alpha\r\nBETA\r\ngamma");
    expect(out["Line endings"]).toBe("Detected LF in the original. Wrote CRLF.");
  });

  it("preserves LF on an LF original", () => {
    const out = apply(build(THREE, SWAP_BETA), { lineEndings: "preserve" });
    expect(out["Patched text"]).toBe("alpha\nBETA\ngamma");
    expect(out["Line endings"]).toBe("Detected LF in the original. Wrote LF.");
  });

  it("reports a mixed original and follows the majority", () => {
    const input = `alpha\r\nbeta\ngamma\r\n${SEPARATOR}\n@@ -2 +2 @@\n-beta\n+BETA`;
    const out = apply(input);
    expect(out["Line endings"]).toBe(
      "Detected CRLF in the original (mixed: 2 CRLF, 1 LF). Wrote CRLF.",
    );
    expect(out["Patched text"]).toBe("alpha\r\nBETA\r\ngamma");
  });

  it("falls back to LF when the original has no line breaks", () => {
    const out = apply(build("alpha", "@@ -1 +1 @@\n-alpha\n+ALPHA"));
    expect(out["Line endings"]).toBe(
      "The original has no line breaks, so LF was assumed. Wrote LF.",
    );
    expect(out["Patched text"]).toBe("ALPHA");
  });
});

describe("multi file patches", () => {
  const MULTI = [
    "diff --git a/first.txt b/first.txt",
    "--- a/first.txt",
    "+++ b/first.txt",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-beta",
    "+BETA",
    " gamma",
    "diff --git a/second.txt b/second.txt",
    "--- a/second.txt",
    "+++ b/second.txt",
    "@@ -1,1 +1,1 @@",
    "-nope",
    "+never applied",
  ].join("\n");

  it("applies only the first file's hunks", () => {
    const out = apply(build(THREE, MULTI));
    expect(out["Patched text"]).toBe("alpha\nBETA\ngamma");
    expect(out.Hunks).toBe("1 hunk applied");
  });

  it("lists every file and says why the later ones were skipped", () => {
    const row = apply(build(THREE, MULTI))["Files in patch"];
    expect(row).toContain("a/first.txt -> b/first.txt");
    expect(row).toContain("a/second.txt -> b/second.txt");
    expect(row).toContain(
      "Applied only the hunks for a/first.txt -> b/first.txt. Skipped 1 later file because this tool patches one pasted text, not a directory tree.",
    );
  });

  it("starts a new file on a second --- header even without diff --git", () => {
    const diff = [
      "--- first.txt",
      "+++ first.txt",
      "@@ -2 +2 @@",
      "-beta",
      "+BETA",
      "--- second.txt",
      "+++ second.txt",
      "@@ -1 +1 @@",
      "-nope",
      "+never applied",
    ].join("\n");
    const out = apply(build(THREE, diff));
    expect(out["Patched text"]).toBe("alpha\nBETA\ngamma");
    expect(out["Files in patch"]).toContain("Skipped 1 later file");
  });

  it("strips the timestamp column from a diff -u header", () => {
    const diff = [
      "--- old.txt\t2026-01-02 10:00:00.000000000 +0000",
      "+++ new.txt\t2026-01-02 10:05:00.000000000 +0000",
      "@@ -2 +2 @@",
      "-beta",
      "+BETA",
    ].join("\n");
    expect(apply(build(THREE, diff))["Files in patch"]).toBe("old.txt -> new.txt");
  });
});

describe("the ignoreWhitespace option", () => {
  const DIFF = ["@@ -1,2 +1,2 @@", " alpha", "-beta", "+BETA"].join("\n");

  it("is off by default, so trailing spaces break the match", () => {
    expect(() => apply(build("alpha   \nbeta", DIFF))).toThrow(ToolError);
  });

  it("matches when trailing whitespace is ignored", () => {
    expect(patched(build("alpha   \nbeta", DIFF), { ignoreWhitespace: true })).toBe(
      "alpha   \nBETA",
    );
  });
});

describe("errors", () => {
  function codeOf(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      return (err as ToolError).code;
    }
    throw new Error("expected a ToolError");
  }

  it("rejects empty input", () => {
    expect(codeOf(() => apply(""))).toBe("empty-input");
    expect(codeOf(() => apply("   \n  "))).toBe("empty-input");
  });

  it("rejects input with no ===== separator", () => {
    expect(codeOf(() => apply("alpha\nbeta\n@@ -1 +1 @@"))).toBe("missing-separator");
  });

  it("rejects an empty diff half", () => {
    expect(codeOf(() => apply(`${THREE}\n${SEPARATOR}\n   `))).toBe("empty-diff");
  });

  it("rejects a diff with no @@ hunk header", () => {
    expect(codeOf(() => apply(build(THREE, "--- a/x\n+++ b/x\nnothing useful here")))).toBe(
      "no-hunks",
    );
  });

  it("rejects a malformed hunk header", () => {
    expect(codeOf(() => apply(build(THREE, "@@ -x,y +z @@\n-beta\n+BETA")))).toBe(
      "bad-hunk-header",
    );
  });

  it("rejects a hunk header that starts at line 0 with a nonzero count", () => {
    expect(codeOf(() => apply(build(THREE, "@@ -0,1 +1,1 @@\n-alpha\n+ALPHA")))).toBe(
      "bad-hunk-header",
    );
  });

  it("rejects a hunk whose body is shorter than its counts", () => {
    expect(codeOf(() => apply(build(THREE, "@@ -1,3 +1,3 @@\n alpha\n-beta")))).toBe(
      "hunk-count-mismatch",
    );
  });

  it("rejects a hunk whose body is longer than its counts", () => {
    expect(codeOf(() => apply(build(THREE, "@@ -1,1 +1,1 @@\n alpha\n beta")))).toBe(
      "hunk-count-mismatch",
    );
  });

  it("rejects an unknown line prefix inside a hunk", () => {
    expect(codeOf(() => apply(build(THREE, "@@ -1,2 +1,2 @@\n alpha\n?beta")))).toBe(
      "unknown-hunk-line",
    );
  });

  it("rejects a hunk that starts past the end of the original", () => {
    const err = codeOf(() => apply(build(THREE, "@@ -50,1 +50,1 @@\n-beta\n+BETA")));
    expect(err).toBe("hunk-past-end");
  });

  it("rejects overlapping hunks", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+BETA",
      "@@ -2,1 +2,1 @@",
      "-beta",
      "+again",
    ].join("\n");
    expect(codeOf(() => apply(build(THREE, diff)))).toBe("overlapping-hunks");
  });

  it("rejects an unknown line endings value", () => {
    expect(codeOf(() => apply(build(THREE, SWAP_BETA), { lineEndings: "ebcdic" }))).toBe(
      "bad-line-endings",
    );
  });

  it("names the hunk, the line number, and both lines on a context mismatch", () => {
    let caught: ToolError | undefined;
    try {
      apply(build("alpha\nBETA\ngamma", SWAP_BETA));
    } catch (err) {
      caught = err as ToolError;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect(caught?.code).toBe("context-mismatch");
    expect(caught?.message).toBe(
      'Hunk 1 does not match the original text at line 2: expected "beta" but found "BETA".',
    );
    expect(caught?.fix).toContain("fuzz 0");
  });

  it("numbers the mismatched hunk by its position in the whole diff", () => {
    const diff = [
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+ALPHA",
      "@@ -3,1 +3,1 @@",
      "-GAMMA",
      "+omega",
    ].join("\n");
    let caught: ToolError | undefined;
    try {
      apply(build(THREE, diff));
    } catch (err) {
      caught = err as ToolError;
    }
    expect(caught?.message).toBe(
      'Hunk 2 does not match the original text at line 3: expected "GAMMA" but found "gamma".',
    );
  });

  it("says the end of the text when the original runs out mid hunk", () => {
    const diff = ["@@ -1,2 +1,2 @@", " alpha", "-beta", "+BETA"].join("\n");
    let caught: ToolError | undefined;
    try {
      apply(build("alpha", diff));
    } catch (err) {
      caught = err as ToolError;
    }
    expect(caught?.message).toBe(
      'Hunk 1 does not match the original text at line 2: expected "beta" but found the end of the text.',
    );
  });
});

describe("meta", () => {
  it("declares the slug, category, and a curated icon", () => {
    expect(meta.slug).toBe("unified-diff-patch-applier");
    expect(meta.category).toBe("Dev");
    expect(meta.icon).toBe("FilePen");
    expect(meta.http).toBeUndefined();
  });

  it("ships exactly three FAQ entries", () => {
    expect(meta.copy.faq).toHaveLength(3);
  });

  it("has an example that applies cleanly", () => {
    const example = meta.examples?.[0];
    expect(example?.input).toBeDefined();
    const opts: PatchOpts = {
      reverse: example?.opts?.reverse === "true",
      lineEndings: example?.opts?.lineEndings ?? "preserve",
      ignoreWhitespace: example?.opts?.ignoreWhitespace === "true",
    };
    const out = run(example?.input ?? "", opts);
    expect(out["Patched text"]).toBe(
      [
        "function greet(name, greeting) {",
        '  console.log(greeting + ", " + name);',
        "}",
        "",
        'greet("world");',
        'greet("everyone", "Hi");',
      ].join("\n"),
    );
    expect(out.Hunks).toBe("1 hunk applied");
    expect(out.Changes).toBe("+3 lines, -2 lines");
  });
});
