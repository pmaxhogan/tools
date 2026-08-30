import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "clipboard-inspector",
  icon: "Clipboard",
  matrixSlug: "clipboard",
  name: "Clipboard Inspector",
  description: "See every MIME type sitting on your clipboard with sizes and previews.",
  category: "Platform",
  keywords: [
    "clipboard inspector",
    "what is on my clipboard",
    "clipboard mime types",
    "paste inspector",
    "clipboard viewer",
    "clipboard contents",
    "copy paste debugger",
  ],
  searchTerms: [
    "clipboard debugger",
    "clipboard mime type viewer",
    "what did i copy",
    "clipboard data viewer",
    "rich text clipboard",
    "html clipboard viewer",
    "clipboard permissions test",
    "copy paste format checker",
  ],
  input: "application/json",
  output: "application/json",
  requires: ["clipboard-read"],
  copy: {
    what: "Shows every format currently sitting on your clipboard, not just the plain text you expect. Copy something and this tool lists each MIME type present (text/plain, text/html, image/png, and more), its size, and a preview, including the hidden HTML markup or RTF payload many apps attach alongside plain text.",
    how: "Click the Read clipboard button and the browser will ask for permission to read what you last copied. Once granted, every format is listed with its byte size and a preview. You can also paste a snapshot JSON manually if you already have one.",
    why: "There is no comparable tool without installing a browser extension. Most sites and apps only ever show you the plain text they pasted, hiding the extra HTML or image data that rides along with a copy. This tool makes that invisible payload visible, entirely in your browser.",
    faq: [
      {
        q: "Why does the browser ask for permission?",
        a: "Reading the clipboard requires an explicit permission grant in every modern browser, since clipboard contents can include sensitive data from other apps. This tool only reads the clipboard when you click the button.",
      },
      {
        q: "Why do I see text/html when I copied from a website?",
        a: "Browsers and office apps automatically attach a text/html version alongside the plain text whenever you copy formatted content, so the destination app can preserve bold text, links, and colors. That HTML version is usually what gets pasted by default.",
      },
      {
        q: "Does my clipboard data leave my machine?",
        a: "No, your files and inputs never leave your device. The clipboard is read and analyzed entirely in your browser.",
      },
    ],
  },
};
