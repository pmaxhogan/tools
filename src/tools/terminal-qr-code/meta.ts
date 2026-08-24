import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "terminal-qr-code",
  matrixSlug: "qr-terminal",
  icon: "QrCode",
  name: "Terminal QR Code",
  description: "Print a scannable QR code as unicode blocks, right in your terminal.",
  category: "QR",
  keywords: [
    "terminal qr code",
    "qr in terminal",
    "utf8 qr",
    "qrencode alternative",
    "ascii qr code",
    "curl qr code",
  ],
  searchTerms: [
    "qr code cli",
    "print qr code in shell",
    "ssh qr code",
    "qrencode -t utf8",
    "share a link from the terminal",
    "wifi qr code cli",
    "unicode block qr code",
    "curl qr code generator",
    "qr code no image",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "ecc",
      label: "Error correction",
      default: "M",
      options: [
        { value: "L", label: "L", synonyms: ["low", "7%"] },
        { value: "M", label: "M", synonyms: ["medium", "15%"] },
        { value: "Q", label: "Q", synonyms: ["quartile", "25%"] },
        { value: "H", label: "H", synonyms: ["high", "30%"] },
      ],
    },
    { kind: "boolean", id: "invert", label: "Invert (dark background)", default: false },
    { kind: "number", id: "margin", label: "Quiet zone", default: 1, min: 0, max: 4 },
  ],
  examples: [
    {
      label: "Share a link",
      input: "https://tools.maxhogan.dev",
      opts: { ecc: "M", invert: "false", margin: "1" },
    },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Renders a QR code as unicode block characters, the same trick qrencode -t UTF8 uses, so it prints and scans directly from a terminal window. Works for any text or URL, with adjustable error correction and quiet zone.",
    how: "Paste the text or URL you want encoded and the terminal-friendly QR appears immediately. It also runs as a plain curl endpoint, so `curl https://tools.maxhogan.dev/api/terminal-qr-code?input=...` prints a scannable code straight into any shell, over SSH, or in a CI log.",
    why: "Most QR generators only hand back a PNG or SVG, which is useless when you are stuck in a terminal or SSH session with no image viewer. This one is text in, text out, with no ads, no signup, and no server ever seeing what you encoded.",
    faq: [
      {
        q: "Will this scan from my screen?",
        a: "Yes, as long as the terminal font renders block characters at roughly square proportions and the window is not zoomed so small the blocks blur together. Most modern terminal fonts work fine.",
      },
      {
        q: "What error correction should I pick?",
        a: "M (15%) is a good default. Pick H (30%) if the code will be photographed or partially obscured; pick L (7%) if you need to pack in the most data and the terminal image will stay pristine.",
      },
      {
        q: "Can I use it in a shell script?",
        a: "Yes. The tool exposes a GET endpoint that returns plain text, so a single curl call can print a QR code from inside any script or CI pipeline.",
      },
    ],
  },
};
