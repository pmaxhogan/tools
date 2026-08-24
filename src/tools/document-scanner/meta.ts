import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "document-scanner",
  icon: "Camera",
  matrixSlug: "scan",
  name: "Document Scanner",
  description: "Turn a phone photo of a page into a straightened, cropped, multi-page PDF.",
  category: "Docs",
  keywords: [
    "document scanner online",
    "photo to pdf scanner",
    "scan document with camera",
    "deskew scanned document",
    "crop and straighten page photo",
    "multi page pdf from photos",
    "free document scanner no app",
  ],
  searchTerms: [
    "camscanner alternative",
    "scan to pdf",
    "perspective correction",
    "dewarp page",
    "flatten document photo",
    "whiteboard capture",
    "receipt scanner",
    "book page scan",
    "auto crop document",
    "adaptive threshold scan",
    "black and white scan",
    "phone scanner web",
  ],
  input: "image/*",
  output: "application/json",
  requires: [],
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Enhancement",
      default: "grayscale",
      options: [
        {
          value: "none",
          label: "Original",
          synonyms: ["raw", "no cleanup", "unchanged", "as shot"],
        },
        {
          value: "grayscale",
          label: "Grayscale",
          synonyms: ["gray", "greyscale", "mono", "contrast"],
        },
        {
          value: "color",
          label: "Color",
          synonyms: ["colour", "white balance", "vivid", "boost"],
        },
        {
          value: "bw",
          label: "Black and white",
          synonyms: ["threshold", "1 bit", "ink", "high contrast", "text only"],
        },
      ],
    },
    {
      kind: "select",
      id: "scale",
      label: "Output size",
      default: "1",
      options: [
        {
          value: "1",
          label: "Match the photo",
          synonyms: ["auto", "native", "same size", "1x"],
        },
        { value: "1.5", label: "1.5x", synonyms: ["sharper", "bigger", "upscale"] },
        { value: "2", label: "2x", synonyms: ["largest", "double", "high resolution"] },
      ],
    },
    {
      kind: "select",
      id: "format",
      label: "Single page format",
      default: "png",
      options: [
        { value: "png", label: "PNG (lossless)", synonyms: ["portable network graphics"] },
        { value: "jpeg", label: "JPEG (smaller)", synonyms: ["jpg", "compressed", "photo"] },
      ],
    },
    {
      kind: "select",
      id: "pdfPage",
      label: "PDF page size",
      default: "image",
      options: [
        {
          value: "image",
          label: "Fit the scan",
          synonyms: ["image size", "auto", "match page", "crop to content"],
        },
        { value: "letter", label: "US Letter", synonyms: ["8.5x11", "letter", "us paper"] },
        { value: "a4", label: "A4", synonyms: ["210x297", "metric", "iso paper"] },
      ],
    },
  ],
  copy: {
    what: "Turns a photo of a page into something that looks scanned: the tool finds the four corners of the document, flattens the perspective so the page is a rectangle again, and cleans up the lighting. Corner detection runs on a downscaled copy of the photo using edge detection, and every guess carries a confidence, so you can see when it is unsure. All four corners are draggable handles with a magnifier, so a guess that lands in the wrong place takes one drag to fix. Enhancement offers the original pixels, a grayscale contrast stretch, a per channel color stretch that pulls a warm indoor cast back toward white paper, and a black and white adaptive threshold for text. Pages stack up in a strip you can reorder, and the whole stack saves as one PDF.",
    how: "Drop a photo, pick a file, paste from the clipboard, or start the camera and capture a frame. Check the outline the tool drew and drag any corner that missed, using the magnifier that appears next to the handle you are holding. Pick an enhancement mode, then add the page. Repeat for each page, reorder them with the move buttons if they came out of order, and save one page as a PNG or JPEG or the whole stack as a PDF.",
    why: "Scanner apps want an install, an account, and often a subscription before they will export a multi-page PDF without a watermark, and the free web ones upload your document to a server you have no reason to trust. Contracts, medical forms, and tax paperwork are exactly the documents you should not hand to a stranger. This one runs the detection, the perspective warp, the cleanup, and the PDF assembly in your browser, so your files and inputs never leave your device, and there is no page limit, no watermark, and no upsell.",
    faq: [
      {
        q: "Do I need a camera to use it?",
        a: "No. The camera is one way in and it is never started until you click Use camera, which is also when the browser asks for permission. You can drop a photo, pick a file, or paste an image from the clipboard instead, which is the usual path on a desktop where the photo came off a phone. When you do use the camera, the tool captures one frame and stops the camera tracks right away rather than holding the stream open.",
      },
      {
        q: "How good is the automatic corner detection?",
        a: "It is a heuristic, not a trained model. It downscales the photo, runs a Sobel edge pass, keeps the strongest connected edge region, and reduces its outline to four corners, then checks that the result covers at least a fifth of the frame, is convex, and has no corner sharper than 35 degrees. On the synthetic tests it lands within about 3 pixels of the true corners of an 800 by 600 frame. A page on a contrasting surface with all four edges visible works well. A page on a similar colored desk, or one whose edge runs off the photo, often does not, which is why the confidence is shown and the corners are draggable.",
      },
      {
        q: "Which enhancement mode should I use for text?",
        a: "Black and white for printed text you want to read or search later: it uses a local adaptive threshold, so a shadow across one corner does not swallow the words under it, and the result is the smallest file. Grayscale is the safer general choice, since it keeps the shading and cannot drop a faint pencil mark to white. Color is for anything where the color matters, such as a highlighted form or a receipt with a stamp, and it also corrects the warm cast that indoor light leaves on white paper.",
      },
    ],
  },
};
