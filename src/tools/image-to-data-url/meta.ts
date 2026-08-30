import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-to-data-url",
  icon: "Image",
  name: "Image to Data URL",
  description:
    "Convert an image to a base64 data URL, or decode a data URL back into a downloadable file.",
  category: "Images",
  keywords: [
    "image to data url",
    "image to base64",
    "base64 image encoder",
    "data url decoder",
    "css background image base64",
    "inline image html",
    "png to base64",
    "svg to data uri",
  ],
  searchTerms: [
    "base64 image converter",
    "data uri generator",
    "embed image in css",
    "inline svg background",
    "decode base64 image",
    "base64 to png",
    "img src base64",
    "convert picture to text string",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "direction",
      label: "Direction",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Detect automatically",
          synonyms: ["auto", "guess", "either way", "both"],
        },
        {
          value: "encode",
          label: "Image to data URL",
          synonyms: ["encode", "to base64", "inline", "forward"],
        },
        {
          value: "decode",
          label: "Data URL to file",
          synonyms: ["decode", "from base64", "reverse", "back to image"],
        },
      ],
    },
    {
      kind: "select",
      id: "snippet",
      label: "Output form",
      default: "raw",
      options: [
        {
          value: "raw",
          label: "Raw data URL",
          synonyms: ["plain", "just the url", "data uri", "string"],
        },
        {
          value: "css",
          label: "CSS background rule",
          synonyms: ["css", "background image", "stylesheet", "url()"],
        },
        {
          value: "html",
          label: "HTML img tag",
          synonyms: ["html", "img src", "markup", "image tag"],
        },
      ],
    },
    {
      kind: "select",
      id: "mediaType",
      label: "Declared media type",
      default: "auto",
      groups: [
        {
          label: "Automatic",
          synonyms: ["detect", "sniff", "magic bytes", "guess"],
          options: [
            {
              value: "auto",
              label: "Read from the file",
              synonyms: ["auto", "detect", "magic number", "sniff"],
            },
          ],
        },
        {
          label: "Raster images",
          synonyms: ["bitmap", "photo", "picture", "pixels"],
          options: [
            { value: "image/png", label: "image/png", synonyms: ["png", "portable network"] },
            { value: "image/jpeg", label: "image/jpeg", synonyms: ["jpg", "jpeg", "photo"] },
            { value: "image/webp", label: "image/webp", synonyms: ["webp", "google"] },
            { value: "image/gif", label: "image/gif", synonyms: ["gif", "animated"] },
            { value: "image/avif", label: "image/avif", synonyms: ["avif", "av1"] },
            { value: "image/bmp", label: "image/bmp", synonyms: ["bmp", "bitmap"] },
            {
              value: "image/x-icon",
              label: "image/x-icon",
              synonyms: ["ico", "favicon", "icon"],
            },
          ],
        },
        {
          label: "Vector and text",
          synonyms: ["svg", "markup", "code", "font"],
          options: [
            { value: "image/svg+xml", label: "image/svg+xml", synonyms: ["svg", "vector", "xml"] },
            { value: "text/plain", label: "text/plain", synonyms: ["txt", "plain text"] },
            { value: "text/css", label: "text/css", synonyms: ["css", "stylesheet"] },
            {
              value: "application/octet-stream",
              label: "application/octet-stream",
              synonyms: ["binary", "generic", "unknown", "raw bytes"],
            },
          ],
        },
      ],
    },
    {
      kind: "text",
      id: "selector",
      label: "CSS selector",
      default: ".hero",
      placeholder: ".hero",
    },
  ],
  examples: [{ label: "Sample PNG image", file: "sample.png" }],
  copy: {
    what: "Turns an image into a base64 data URL you can paste straight into HTML, CSS, or JSON, and turns a data URL back into a file you can save. It reads the real media type from the file's magic bytes rather than trusting the extension, reports the exact character count of the finished URL against the size of the source file, and warns you when the inline form has grown past the point where it is worth using. The same page decodes both base64 and percent encoded data URLs, which is the form an inline SVG usually takes in a stylesheet.",
    how: "Drop an image, paste one from the clipboard, or pick a file, and the data URL appears with a copy button. Switch the output form to get a ready made CSS background-image rule or an HTML img tag instead of the bare string, and set the selector if you want the CSS rule to name your own class. To go the other way, paste a data URL into the box: the panel shows the decoded image, its real media type, and a download button with a sensible filename.",
    why: "Most base64 image converters upload your picture to a server to do arithmetic that a browser can do instantly, then cap the file size or wrap the answer in ads. This one does the encoding in the page, so your files and inputs never leave your device, and there is no size limit beyond your own memory. It also tells you the truth about the tradeoff, including the exact overhead and a warning past 100 KB, rather than encouraging you to inline a photo that should have been a separate request.",
    faq: [
      {
        q: "How much bigger does base64 make my image?",
        a: "About 33 percent, plus the short prefix that names the media type. Three bytes of file become four characters of base64, so a 90 KB PNG becomes roughly 120 KB of text. The tool reports the exact overhead for your specific file rather than the rule of thumb.",
      },
      {
        q: "When should I inline an image instead of linking to it?",
        a: "When it is small and always needed: an icon, a tiny texture, a one pixel gradient. Inlining saves a request, but the bytes cannot be cached separately from the document that holds them, so every page load pays for them again, and a data URL inside a stylesheet blocks first paint. Past roughly 100 KB a normal file reference almost always wins, which is why this tool warns at that point.",
      },
      {
        q: "Can it decode a data URL that is not base64?",
        a: "Yes. The RFC also allows a percent encoded payload, which is the form most people use for an inline SVG in CSS because it stays readable and compresses better. Paste either one and the tool reports which encoding it found, then hands back the decoded bytes.",
      },
    ],
  },
};
