import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-diff",
  icon: "ImageMinus",
  name: "Perceptual Image Diff",
  description: "Pixel and SSIM comparison that highlights what actually changed.",
  category: "Capture",
  keywords: [
    "compare two images online",
    "image diff tool",
    "pixel diff two screenshots",
    "ssim calculator online",
    "visual regression diff",
    "find difference between images",
    "screenshot comparison tool",
  ],
  searchTerms: [
    "pixelmatch",
    "image comparison",
    "photo difference finder",
    "spot the difference",
    "visual diff",
    "screenshot diff",
    "structural similarity index",
    "mssim",
    "before and after image",
    "anti aliasing diff",
    "diff two images",
    "compare screenshots",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "threshold",
      label: "Match threshold",
      default: 0.1,
      min: 0.05,
      max: 0.5,
      step: 0.01,
    },
    {
      kind: "boolean",
      id: "includeAA",
      label: "Count anti-aliased pixels",
      default: false,
    },
    {
      kind: "select",
      id: "view",
      label: "Show",
      default: "both",
      options: [
        {
          value: "both",
          label: "Pixel diff and SSIM",
          synonyms: ["everything", "all", "full report", "both measures"],
        },
        {
          value: "diff",
          label: "Pixel diff only",
          synonyms: ["pixelmatch", "changed pixels", "mask", "highlight"],
        },
        {
          value: "ssim",
          label: "SSIM only",
          synonyms: ["structural similarity", "mssim", "perceptual score", "quality score"],
        },
      ],
    },
  ],
  copy: {
    what: "Compares two images two different ways at once. The pixel pass is the pixelmatch algorithm: it measures color distance in YIQ space, ignores pixels that look like anti-aliasing rather than a real change, and paints a highlight image with every genuine difference in red and every anti-aliased edge in yellow. The structural pass computes SSIM on Rec.601 luma over overlapping 8 pixel windows, which answers the different question of whether the two pictures still look like the same picture. You get the count and percentage of changed pixels, the bounding box of the changed area, and a mean SSIM score with a plain reading of what it means. Images of different sizes are compared on their overlapping top left region and never resampled, so a stray pixel of width does not turn into a full page of false differences.",
    how: "Drop or pick two images in the panel: the first is the baseline, the second is the one you are checking. The panel shows them side by side with the highlight overlay and a slider so you can wipe between the original and the diff. Raise the match threshold if compression noise is lighting up areas you do not care about, and turn on counting anti-aliased pixels when the edge rendering itself is what you are testing.",
    why: "Most image comparison sites want an account before they show you anything at full size, and they all work by uploading both images to a server, which is the wrong shape for a screenshot of a staging environment or a customer document. This one runs the same pixelmatch algorithm your CI probably already uses, plus SSIM, in the tab you have open, so your files and inputs never leave your device. It also reports the bounding box of the change, which is the number you actually need when you are deciding whether a regression is a stray shadow or a broken layout.",
    faq: [
      {
        q: "What is the difference between a pixel diff and SSIM?",
        a: "A pixel diff counts how many pixels changed. It is exact and it is unforgiving: shift an image one pixel to the right and almost every pixel counts as different, even though nothing about the picture changed. SSIM compares small windows for their brightness, contrast, and structure, so it scores that same shifted image as very similar and scores a genuinely rearranged layout as different. Use the pixel count and the bounding box to find where something changed, and use the SSIM score to judge whether the change matters to a person looking at it.",
      },
      {
        q: "Why does saving a JPEG again show differences everywhere?",
        a: "JPEG is lossy, and it is lossy in blocks. Re-encoding an image at any quality setting rewrites nearly every pixel by a small amount, so a strict pixel comparison lights up the whole frame even though the two files look identical. That is exactly what the match threshold is for: the default of 0.1 already absorbs normal compression noise, and raising it further ignores more. SSIM handles this case better on its own, because a re-encode usually still scores above 0.95.",
      },
      {
        q: "Are my images uploaded anywhere?",
        a: "No. Both images are decoded, compared, and drawn inside this browser tab. Your files and inputs never leave your device, there is no account, and there is no per comparison limit. Once the page has loaded it keeps working with the network off.",
      },
    ],
  },
};
