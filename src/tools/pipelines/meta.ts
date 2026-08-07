import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "pipelines",
  icon: "Workflow",
  name: "Composable Pipelines",
  description: "Chain tools together and share the whole chain as a URL.",
  category: "Platform",
  keywords: [
    "chain tools together",
    "text processing pipeline",
    "compose tools",
    "shareable tool chain",
    "pipe tools browser",
  ],
  searchTerms: [
    "tool chain builder",
    "multi step converter",
    "workflow builder",
    "combine tools",
    "tool automation",
    "unix pipe for tools",
    "chained transformations",
    "macro tool chain",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "text",
      id: "pipeline",
      label: "Pipeline",
      default: "",
      placeholder: "json-formatter;json-to-typescript",
    },
  ],
  copy: {
    what: "Composable Pipelines chains the pure text tools on this site into one flow, feeding each tool's output straight into the next. Start with pasted text or a generator, add steps like format, convert, sort, or decode, and watch every stage run live. A step that produces labeled results, like a hash or a parsed URL, ends the chain. The whole pipeline lives in the page link, so a link is a runnable chain.",
    how: "Add a step and pick a tool, then set its options. Add another step and its input is the previous step's output. Each stage shows its result inline, and the final output has a copy button. Use Copy pipeline link to hand someone the exact chain, which they can open and run themselves.",
    why: "Every other multi-tool site makes you copy the result out of one page and paste it into the next, losing your steps each time. This pipes one tool's output into the next in a single view and puts the whole chain in the URL so you can share it, and it all runs locally with no accounts and no uploads.",
    faq: [
      {
        q: "Which tools can I chain?",
        a: "The pure text transforms: formatters, converters, sorters, decoders, and the like. Each step hands plain text to the next. Tools that produce labeled results, and tools that need files, media, or hardware, are not chainable and end or sit outside a pipeline.",
      },
      {
        q: "How do I share a pipeline?",
        a: "The full chain, every step with its options plus your starting text, is encoded in the page link. Copy the link and whoever opens it gets the same pipeline, ready to run. Very large inputs over 2000 characters are left out of the link, so paste those in again.",
      },
      {
        q: "Is my data uploaded anywhere?",
        a: "No. Every step runs in your browser, and the shareable link keeps the chain in the URL fragment, which is never sent to a server. Your files and inputs never leave your device.",
      },
    ],
  },
};
