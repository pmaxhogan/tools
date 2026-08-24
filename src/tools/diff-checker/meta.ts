import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "diff-checker",
  icon: "GitCompare",
  matrixSlug: "diff",
  name: "Diff Checker",
  description: "Compare two texts line by line, word by word, or as semantic JSON and YAML.",
  category: "Data",
  keywords: [
    "diff checker",
    "text compare",
    "compare two files online",
    "json diff",
    "yaml diff",
    "line diff tool",
    "word diff online",
    "compare text differences",
  ],
  searchTerms: [
    "text compare tool",
    "file compare online",
    "compare two strings",
    "patch viewer",
    "side by side diff",
    "inline diff",
    "merge conflict viewer",
    "string diff",
    "compare json objects",
    "compare yaml files",
    "diff tool",
    "compare text",
    "compare files",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "lines",
      options: [
        { value: "lines", label: "Lines", synonyms: ["line diff", "line by line"] },
        { value: "words", label: "Words", synonyms: ["word diff", "word by word"] },
        { value: "chars", label: "Characters", synonyms: ["character diff", "char diff"] },
        {
          value: "json",
          label: "JSON (semantic)",
          synonyms: ["json diff", "compare json objects", "structural json compare"],
        },
        {
          value: "yaml",
          label: "YAML (semantic)",
          synonyms: ["yaml diff", "compare yaml files", "structural yaml compare"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "ignoreWhitespace",
      label: "Ignore whitespace (lines mode)",
      default: false,
    },
    {
      kind: "boolean",
      id: "ignoreCase",
      label: "Ignore case",
      default: false,
    },
    {
      kind: "number",
      id: "context",
      label: "Context lines (lines mode)",
      default: 3,
      min: 0,
      max: 10,
    },
  ],
  examples: [
    {
      label: "Config file diff",
      input: `server_name api.example.com;
listen 443 ssl;
ssl_certificate /etc/ssl/certs/api.crt;
worker_processes 4;
keepalive_timeout 65;
=====
server_name api.example.com;
listen 443 ssl;
ssl_certificate /etc/ssl/certs/api-2024.crt;
worker_processes 8;
keepalive_timeout 65;
gzip on;`,
    },
    {
      label: "JSON semantic diff",
      input: `{"user":{"name":"Maria Alvarez","role":"editor","active":true},"lastLogin":"2024-01-10"}
=====
{"user":{"name":"Maria Alvarez","role":"admin","active":true},"lastLogin":"2024-03-02"}`,
      opts: { mode: "json" },
    },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Compares two pieces of text and shows what changed. Line mode shows added and removed lines, word and character modes mark inline insertions and deletions, and JSON or YAML mode parses both sides and reports semantic differences by path instead of raw text noise.",
    how: "Paste the first text, then a line containing just ===== on its own, then the second text, all into the single input box. Pick a mode, and for lines mode optionally ignore whitespace or adjust how many context lines surround each change. JSON and YAML mode ignore key order and formatting and only report values that actually changed.",
    why: "Most online diff tools upload both documents to a server and cap how much text you can paste. This one runs entirely in your browser: your files and inputs never leave your device, and there is no size cap beyond what your browser can hold.",
    faq: [
      {
        q: "How do I enter two separate texts in one box?",
        a: "Paste the first text, then a line with exactly ===== (five equals signs) on its own, then the second text. Everything before that line is document A, everything after is document B.",
      },
      {
        q: "What does semantic JSON or YAML mode mean?",
        a: "Instead of diffing raw text, it parses both sides and compares the resulting values by path. A key that just moved position or a value reformatted with different spacing is not reported as a change, only values that actually differ are.",
      },
      {
        q: "Is my text uploaded anywhere?",
        a: "No. Your files and inputs never leave your device. The comparison runs locally in your browser.",
      },
    ],
  },
};
