import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "clipboard-pipelines",
  matrixSlug: "clip-pipes",
  icon: "ClipboardPaste",
  name: "Clipboard Pipelines",
  description: "Save a chain of text transforms and apply the whole chain to anything you paste.",
  category: "Files",
  keywords: [
    "clipboard pipeline",
    "chain text transforms",
    "text transform pipeline",
    "paste and clean text",
    "batch text operations",
    "saved text macros",
  ],
  searchTerms: [
    "clean up pasted text",
    "text macro",
    "multi step text cleanup",
    "trim collapse whitespace dedupe",
    "one click text formatting",
    "reusable text recipe",
    "strip formatting from paste",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "text",
      id: "chain",
      label: "Pipeline (step per line, id or id:arg)",
      default: "trim,collapse-whitespace,strip-blank-lines",
      placeholder: "trim,collapse-whitespace,strip-blank-lines",
    },
  ],
  copy: {
    what: "Clipboard Pipelines saves an ordered chain of small text transforms and runs the whole chain over whatever you paste. The catalog covers the cleanups you actually repeat: trim, collapse whitespace, drop blank lines, change case, remove accents, sort, dedupe, number lines, strip HTML, slugify, wrap, prefix or suffix every line, find and replace, extract emails or links, URL and base64 encoding, pretty print JSON, and a character, word, and line count. Steps run left to right, each one feeding the next, and a few take an argument such as the wrap width or the prefix string. Everything runs locally in your browser.",
    how: "Start from a preset like Clean paste, Markdown slug, or Sort and dedupe, or build your own chain by adding transforms in the order you want them. Steps that need a value, such as Prefix lines or Find and replace, show a field for it. Paste your text and the finished result appears with a copy button, and the chain lives in the page link so you can bookmark a pipeline and reuse it tomorrow.",
    why: "The usual answer is a site full of single purpose text tools, so a three step cleanup means three pages, three pastes, and an ad break between each one, with nothing saved for next time. This does all the steps in one pass, remembers the chain in the URL, has no sign up and no character limit, and your files and inputs never leave your device.",
    faq: [
      {
        q: "Can I save more than one pipeline?",
        a: "Yes. Each pipeline is encoded in the page link, so bookmark one link per pipeline and name the bookmarks. Opening a link restores the exact chain, including step arguments.",
      },
      {
        q: "What happens if one step gets input it cannot handle?",
        a: "Pretty print JSON passes non-JSON text through unchanged so the rest of the chain still runs. The two decode steps, URL decode and base64 decode, stop with a clear error instead, because silently returning garbage there would hide a real mistake.",
      },
      {
        q: "How do I write an argument that contains a comma or a space?",
        a: 'Arguments are URL encoded in the chain text, so a prefix of "> " is written as prefix-lines:%3E%20. The chain builder does the encoding for you; you only need this when you edit the chain string by hand.',
      },
    ],
  },
};
