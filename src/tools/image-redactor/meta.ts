import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-redactor",
  icon: "EyeOff",
  matrixSlug: "redact",
  name: "Redaction Tool",
  description: "Black out parts of a screenshot by destroying the pixels, not hiding them.",
  category: "Images",
  keywords: [
    "redact screenshot",
    "black out text in image",
    "censor image online",
    "remove sensitive info from screenshot",
    "safe image redaction",
    "redact image online",
    "hide personal info in screenshot",
  ],
  searchTerms: [
    "blackout image",
    "blur alternative",
    "redact pdf screenshot",
    "cover sensitive info",
    "obscure text in photo",
    "anonymize screenshot",
    "mask part of image",
    "privacy blur tool",
    "remove personal info from image",
    "tap to redact",
    "auto redact text",
    "click to censor",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Redaction style",
      default: "solid",
      choices: [
        { value: "solid", label: "Solid fill (safest)" },
        { value: "pixelate", label: "Pixelate (weaker)" },
      ],
    },
    {
      kind: "select",
      id: "color",
      label: "Solid color",
      default: "black",
      choices: [
        { value: "black", label: "Black" },
        { value: "white", label: "White" },
      ],
    },
    {
      kind: "number",
      id: "blockSize",
      label: "Pixelate block size (px)",
      default: 12,
      min: 4,
      max: 64,
      step: 1,
    },
    {
      kind: "number",
      id: "randomness",
      label: "Pixelate randomness strength (%)",
      default: 35,
      min: 0,
      max: 100,
      step: 5,
    },
    {
      kind: "select",
      id: "format",
      label: "Export format",
      default: "png",
      choices: [
        { value: "png", label: "PNG (lossless)" },
        { value: "jpeg", label: "JPEG (quality 90)" },
      ],
    },
  ],
  copy: {
    what: "Redacts a screenshot by overwriting the pixels underneath your selection, so the covered content is gone from the image data rather than parked behind a shape. Draw rectangles by hand, or switch to Smart tap and click a spot to select the word, line, or contiguous blob under the pointer automatically. Smart tap reads text with an OCR engine that runs entirely in your browser and falls back to selecting the solid region under the tap when there is no text nearby. Every selection, drawn or tapped, becomes a normal region you can undo. Solid black or white fill is the default and the safest option, and a pixelate mode is available with a clear warning about its limits. Pixelate mixes in seeded random noise on top of each block average, generated fresh per region, so its output is no longer a fixed function of the source image, which raises the bar for reconstruction without making it a guaranteed-safe choice. There is no blur mode, because blurred text keeps enough of the original signal to be recovered.",
    how: 'Drop a screenshot onto the canvas and pick solid or pixelate. In Rectangle mode, drag a box over each thing you want gone. In Smart tap mode, click a word or object and the tool draws the redaction for you, with a toggle to catch the whole line instead of a single word. The preview shows the real redacted pixels, not an overlay, and the sidebar lists every region with a remove button. Press Escape to cancel a drag in progress or Delete to drop the last region. Export as PNG or JPEG and the file downloads with a "-redacted" name.',
    why: "Drawing a black box in a normal image editor can leave the text recoverable: the shape may stay on its own layer, compression artifacts around it can hint at what was there, and one forgotten flatten step ships the original. Uploading to a redaction site is worse, since sending the sensitive screenshot to a stranger is exactly the thing you were trying to avoid. This tool overwrites the pixels in your browser and re-encodes the result, so the redacted areas hold one flat color and your files and inputs never leave your device.",
    faq: [
      {
        q: "Why is solid fill safer than pixelate or blur?",
        a: "A solid fill replaces every sample in the region with one color, so there is no residual signal left to analyze. Pixelate keeps the average of each block, and blur keeps a low pass version of the whole area: both were, in their plain form, a deterministic function of the original pixels, and researchers have reconstructed pixelated and blurred text by rendering candidate strings through the same transform until the output matches. This tool now mixes seeded random noise into each pixelate block on top of the average, so the same source image no longer produces the same output twice and that specific attack no longer works the same way. That makes reconstruction much harder, not impossible: a rough trace of the original brightness still survives the average. Solid fill remains the only option here with nothing left to analyze, which is why it is the default and why blur is not offered at all.",
      },
      {
        q: "Does the exported file still contain the original metadata?",
        a: "No. The export is re-encoded from the canvas, so it is built out of the redacted pixels alone. None of the original compressed data survives, and EXIF, XMP, and IPTC blocks, including any GPS coordinates or device name, are dropped with it. The only thing carried over is the image content you can see.",
      },
      {
        q: "How does Smart tap find what to redact, and does it upload my image?",
        a: "Smart tap runs the same OCR engine used by the text recognition tool, and that engine runs inside your browser: your files and inputs never leave your device. The first time you use Smart tap, the engine and its English language pack download once, about 6 MB total, and your browser keeps them for later. When you tap, the tool picks the word or line under the pointer from what the engine read, or, when there is no text near the tap, selects the contiguous same colored blob under it instead. Whatever it selects is redacted with your current style, so solid fill is still the safest choice for a tapped selection just as it is for a drawn one. If the engine cannot load, Smart tap still works for blobs using the color selector alone.",
      },
      {
        q: "Is my screenshot uploaded anywhere?",
        a: "No. Decoding, redaction, and encoding all happen in this tab using the canvas in your browser: your files and inputs never leave your device. The region list lives in memory only, so it is not written to the URL or to storage, and closing the tab discards it.",
      },
    ],
  },
};
