import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "unified-diff-patch-applier",
  icon: "FilePen",
  name: "Unified Diff and Patch Applier",
  description: "Apply a unified diff patch to pasted text and preview the result before download.",
  category: "Dev",
  keywords: [
    "apply patch online",
    "unified diff applier",
    "apply diff to text",
    "git apply online",
    "reverse a patch",
    "patch file viewer",
    "unified diff parser",
  ],
  searchTerms: [
    "apply patch",
    "git apply",
    "patch file",
    "unified diff",
    "reverse patch",
    "unpatch",
    "revert a diff",
    "apply .patch file",
    "diff apply tool",
    "patch does not apply",
    "hunk failed to apply",
    "patch text online",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "boolean",
      id: "reverse",
      label: "Reverse the patch",
      default: false,
    },
    {
      kind: "select",
      id: "lineEndings",
      label: "Line endings",
      default: "preserve",
      options: [
        {
          value: "preserve",
          label: "Preserve",
          synonyms: ["keep", "same as input", "auto", "detect"],
        },
        {
          value: "lf",
          label: "LF (Unix)",
          synonyms: ["unix", "linux", "macos", "newline", "line feed", "0a"],
        },
        {
          value: "crlf",
          label: "CRLF (Windows)",
          synonyms: ["windows", "dos", "carriage return", "0d0a"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "ignoreWhitespace",
      label: "Ignore trailing whitespace when matching",
      default: false,
    },
  ],
  examples: [
    {
      label: "Patch a small script",
      input: `function greet(name) {
  console.log("Hello, " + name);
}

greet("world");
=====
--- a/greet.js
+++ b/greet.js
@@ -1,5 +1,6 @@
-function greet(name) {
-  console.log("Hello, " + name);
+function greet(name, greeting) {
+  console.log(greeting + ", " + name);
 }

 greet("world");
+greet("everyone", "Hi");`,
      opts: { reverse: "false", lineEndings: "preserve", ignoreWhitespace: "false" },
    },
  ],
  copy: {
    what: "Applies a unified diff to text you paste, and shows the patched result alongside a report of what happened. It reads the whole patch format: diff --git and index lines, --- and +++ file headers, @@ hunk headers with or without line counts, and the no newline at end of file marker. Matching is strict, so every context line and every removed line has to line up with the original exactly, and a mismatch names the hunk, the line number, and both versions of the line. A reverse switch runs the same patch backwards, which turns a patched file back into the original.",
    how: "Paste the original text, then a line containing just ===== on its own, then the unified diff, all into the one input box. Everything above the separator is the file being patched and everything below it is the patch. Read the patched text in the first output row, and check the hunk count, the added and removed line counts, and the file paths in the rows under it. Turn on Reverse the patch to undo a patch instead of applying one.",
    why: "The usual options are running git apply against a scratch repository or trusting a paste box that uploads both halves to a server. This one runs in your browser, so your files and inputs never leave your device, and it explains failures instead of printing a bare hunk failed message: you get the hunk number, the exact line it expected, the line it actually found, and where in the original that line sits. There are no ads, no sign in, and no size limit beyond what your browser can hold.",
    faq: [
      {
        q: "Why does my patch fail to apply?",
        a: "This tool applies patches with fuzz 0, which means it never searches nearby lines for a better fit and never ignores a difference in whitespace. Every context line and every removed line has to match the original exactly at the position the @@ header claims. Almost always the cause is that the pasted original is a different revision than the one the diff was made from, or that a mail client or chat app reflowed the patch. The error names the hunk, the original line number, the line the patch expected, and the line that is actually there, so the fix is usually visible at a glance.",
      },
      {
        q: "Can it apply a patch that touches several files?",
        a: "Not as a whole. A patch covering many files gets parsed in full and every file path is listed in the Files in patch row, but only the first file's hunks are applied, because this tool patches one pasted text rather than a directory tree. The report says how many later files were skipped. To apply a multi file patch, split it and run each file separately, or use git apply on a checkout.",
      },
      {
        q: "What about blank lines, trailing spaces, and Windows line endings?",
        a: "An unchanged blank line inside a hunk is supposed to be a single space, but plenty of tools and mail clients strip that space and emit a bare empty line. Those are read as empty context lines, so a patch that was mangled that way still applies. Line endings are normalized to LF for matching, so a CRLF original patches cleanly against an LF diff, and the ending you asked for is written back on output. Trailing spaces are significant by default; the Ignore trailing whitespace option relaxes only that part of the match.",
      },
    ],
  },
};
