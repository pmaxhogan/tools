import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-watermark",
  icon: "Layers",
  name: "Image Watermark",
  description:
    "Overlay a text or logo watermark on one image or a whole batch, with tiling, rotation and opacity.",
  category: "Images",
  keywords: [
    "image watermark",
    "add watermark to photo",
    "batch watermark images",
    "logo watermark online",
    "tiled watermark",
    "watermark without signup",
    "copyright photo watermark",
    "transparent text overlay",
  ],
  searchTerms: [
    "watermark maker",
    "put my logo on photos",
    "diagonal repeating watermark",
    "proof watermark",
    "protect photos before sharing",
    "bulk watermark",
    "confidential stamp on image",
  ],
  input: "image/*",
  output: "application/json",
  inputOptional: {
    label: "Quick entry",
    hint: 'The text surface only needs the picture size, written as "1920x1080".',
  },
  options: [
    {
      kind: "select",
      id: "kind",
      label: "Watermark",
      default: "text",
      options: [
        { value: "text", label: "Text", synonyms: ["caption", "words", "type", "signature"] },
        {
          value: "image",
          label: "Logo image",
          synonyms: ["logo", "png", "brand", "mark", "stamp"],
        },
      ],
    },
    {
      kind: "text",
      id: "text",
      label: "Watermark text",
      default: "© Your Name",
      placeholder: "© Your Name",
    },
    {
      kind: "select",
      id: "mode",
      label: "Placement",
      default: "single",
      options: [
        {
          value: "single",
          label: "One copy",
          synonyms: ["single", "corner", "once", "one place"],
        },
        {
          value: "tile",
          label: "Tiled across the image",
          synonyms: ["tile", "repeat", "pattern", "all over", "grid"],
        },
      ],
    },
    {
      kind: "select",
      id: "anchor",
      label: "Position",
      default: "bottom-right",
      groups: [
        {
          label: "Top",
          synonyms: ["top", "upper", "head"],
          options: [
            { value: "top-left", label: "Top left", synonyms: ["upper left", "nw"] },
            { value: "top-center", label: "Top center", synonyms: ["upper middle", "n"] },
            { value: "top-right", label: "Top right", synonyms: ["upper right", "ne"] },
          ],
        },
        {
          label: "Middle",
          synonyms: ["middle", "center", "centre", "vertical middle"],
          options: [
            { value: "middle-left", label: "Middle left", synonyms: ["west", "w"] },
            { value: "center", label: "Center", synonyms: ["middle", "centre", "dead center"] },
            { value: "middle-right", label: "Middle right", synonyms: ["east", "e"] },
          ],
        },
        {
          label: "Bottom",
          synonyms: ["bottom", "lower", "foot"],
          options: [
            { value: "bottom-left", label: "Bottom left", synonyms: ["lower left", "sw"] },
            { value: "bottom-center", label: "Bottom center", synonyms: ["lower middle", "s"] },
            { value: "bottom-right", label: "Bottom right", synonyms: ["lower right", "se"] },
          ],
        },
      ],
    },
    {
      kind: "slider",
      id: "fontPercent",
      label: "Text size",
      default: 6,
      min: 1,
      max: 30,
      step: 0.5,
    },
    {
      kind: "slider",
      id: "scalePercent",
      label: "Logo size",
      default: 20,
      min: 2,
      max: 100,
      step: 1,
    },
    { kind: "slider", id: "opacity", label: "Opacity", default: 60, min: 5, max: 100, step: 1 },
    { kind: "slider", id: "rotation", label: "Rotation", default: 0, min: -90, max: 90, step: 1 },
    {
      kind: "slider",
      id: "marginPercent",
      label: "Margin",
      default: 4,
      min: 0,
      max: 25,
      step: 0.5,
    },
    {
      kind: "slider",
      id: "tileGapPercent",
      label: "Tile gap",
      default: 40,
      min: 0,
      max: 300,
      step: 5,
    },
    { kind: "text", id: "color", label: "Text color", default: "#ffffff", placeholder: "#ffffff" },
    {
      kind: "text",
      id: "outline",
      label: "Outline color",
      default: "#000000",
      placeholder: "#000000",
    },
    {
      kind: "select",
      id: "format",
      label: "Export format",
      default: "image/png",
      options: [
        {
          value: "image/png",
          label: "PNG",
          synonyms: ["png", "lossless", "transparency"],
        },
        { value: "image/jpeg", label: "JPEG", synonyms: ["jpg", "jpeg", "photo", "small"] },
        { value: "image/webp", label: "WebP", synonyms: ["webp", "modern", "smaller"] },
      ],
    },
    { kind: "slider", id: "quality", label: "Quality", default: 90, min: 30, max: 100, step: 1 },
  ],
  examples: [{ label: "Sample landscape photo", file: "sample-photo.jpg" }],
  copy: {
    what: "Draws a text or logo watermark over a picture and exports the result as PNG, JPEG, or WebP. Text can be any size, color, opacity, and angle, with an outline behind it so it stays readable over both light and dark areas. Place one copy anywhere on a 3 by 3 grid with a margin you control, or tile it across the whole image at any angle with an adjustable gap. Every size is relative to the picture, so the same settings look right across a batch of mixed dimensions, and the batch mode watermarks a whole folder and hands it back as a zip.",
    how: "Drop a picture, then type the text or upload a logo. Drag the sliders and watch the preview update on the canvas. Switch placement to tiled for the repeating pattern people use on proofs and drafts, and set the angle you want. When it looks right, download the single image, or drop more files and export the whole set as a zip with the same settings applied to each one.",
    why: "The usual watermark sites put their own watermark on your watermark unless you pay, cap the file size, or make you sign in first. This one has none of that: no account, no size cap, no second watermark, and your files and inputs never leave your device, because the compositing happens on a canvas in this tab. It also scales the mark relative to each picture, so a batch of mixed sizes comes out looking consistent instead of having a huge caption on the small ones.",
    faq: [
      {
        q: "Does a watermark actually protect my photo?",
        a: "It makes casual reuse obvious and inconvenient, which is usually the point. It is not protection against someone determined: a corner mark can be cropped out and a light one can be painted over. A tiled, semi transparent mark across the middle of the image is much harder to remove cleanly, which is why proofs use it.",
      },
      {
        q: "Can I watermark a whole folder at once?",
        a: "Yes. Drop as many images as you like and every one gets the same settings, scaled to its own dimensions. The results download individually or together as a zip. Nothing is uploaded, so the only limit is what your browser can hold in memory.",
      },
      {
        q: "Why is my exported file bigger than the original?",
        a: "PNG is lossless, so a photo saved as PNG is often several times the size of the JPEG it came from. Switch the export format to JPEG or WebP and set the quality slider to get a file close to the original size. Use PNG when the image has transparency or hard edged graphics.",
      },
    ],
  },
};
