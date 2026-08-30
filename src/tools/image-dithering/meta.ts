import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-dithering",
  matrixSlug: "dither",
  icon: "Grid3x3",
  name: "Image Dithering",
  description:
    "Convert an image to a fixed palette with classic error diffusion or ordered dithering algorithms and a live preview.",
  category: "Images",
  keywords: [
    "image dithering online",
    "floyd steinberg dither",
    "dither image",
    "1 bit image converter",
    "e-ink dithering",
    "atkinson dithering",
    "bayer dithering",
    "retro pixel art dither",
  ],
  searchTerms: [
    "dither",
    "halftone",
    "error diffusion",
    "ordered dither",
    "blue noise",
    "stucki",
    "burkes",
    "sierra",
    "jarvis judice ninke",
    "1-bit",
    "one bit",
    "monochrome converter",
    "game boy filter",
    "gameboy camera",
    "pico-8 palette",
    "c64 palette",
    "cga palette",
    "e-paper",
    "epaper",
    "eink",
    "acep",
    "posterize",
    "pixel art converter",
    "black and white converter",
    "floyd steinberg",
    "atkinson dither",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "algorithm",
      label: "Algorithm",
      default: "floyd-steinberg",
      groups: [
        {
          label: "Error diffusion",
          synonyms: ["diffusion", "error", "photographic", "classic", "serpentine"],
          options: [
            {
              value: "floyd-steinberg",
              label: "Floyd Steinberg",
              synonyms: ["fs", "floyd", "steinberg", "default", "standard", "1976"],
            },
            {
              value: "atkinson",
              label: "Atkinson",
              synonyms: ["mac", "macintosh", "hypercard", "bill atkinson", "high contrast"],
            },
            {
              value: "jarvis-judice-ninke",
              label: "Jarvis Judice Ninke",
              synonyms: ["jjn", "jarvis", "judice", "ninke", "minimized average error"],
            },
            {
              value: "stucki",
              label: "Stucki",
              synonyms: ["peter stucki", "sharp", "12 tap"],
            },
            {
              value: "burkes",
              label: "Burkes",
              synonyms: ["daniel burkes", "fast stucki", "two row"],
            },
            {
              value: "sierra",
              label: "Sierra",
              synonyms: ["sierra 3", "frankie sierra", "three row"],
            },
            {
              value: "sierra-lite",
              label: "Sierra Lite",
              synonyms: ["sierra 2 4a", "filter lite", "fastest", "cheap"],
            },
          ],
        },
        {
          label: "Ordered patterns",
          synonyms: ["ordered", "matrix", "tiled", "screen", "halftone", "crosshatch"],
          options: [
            {
              value: "bayer-2",
              label: "Bayer 2x2",
              synonyms: ["bayer 2", "checkerboard", "coarse", "chunky"],
            },
            {
              value: "bayer-4",
              label: "Bayer 4x4",
              synonyms: ["bayer 4", "16 level", "retro game", "classic ordered"],
            },
            {
              value: "bayer-8",
              label: "Bayer 8x8",
              synonyms: ["bayer 8", "64 level", "fine", "smooth ordered"],
            },
            {
              value: "blue-noise",
              label: "Blue noise 64x64",
              synonyms: ["blue", "noise", "void and cluster", "ulichney", "no grid", "organic"],
            },
          ],
        },
        {
          label: "No pattern",
          synonyms: ["plain", "none", "simple", "flat"],
          options: [
            {
              value: "threshold",
              label: "Threshold (no dithering)",
              synonyms: ["none", "off", "posterize", "hard", "cutoff", "quantize only"],
            },
            {
              value: "random",
              label: "Random noise",
              synonyms: ["white noise", "grain", "static", "film grain"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "palette",
      label: "Palette",
      default: "bw",
      groups: [
        {
          label: "Monochrome",
          synonyms: ["gray", "grey", "grayscale", "greyscale", "black and white", "mono"],
          options: [
            {
              value: "bw",
              label: "Black and white (1 bit)",
              synonyms: ["1 bit", "one bit", "bilevel", "mono", "bw", "two color"],
            },
            {
              value: "gray-4",
              label: "Grayscale, 4 levels",
              synonyms: ["2 bit", "four grays", "four greys", "quad gray"],
            },
            {
              value: "gray-16",
              label: "Grayscale, 16 levels",
              synonyms: ["4 bit", "sixteen grays", "sixteen greys", "smooth gray"],
            },
          ],
        },
        {
          label: "E paper",
          synonyms: ["e-ink", "eink", "epaper", "e-paper", "kindle", "waveshare", "acep"],
          options: [
            {
              value: "e-ink-3",
              label: "E ink, black white red",
              synonyms: ["bwr", "three color", "red e-ink", "tricolor", "shelf label"],
            },
            {
              value: "e-ink-7",
              label: "E ink ACeP, 7 colors",
              synonyms: [
                "acep",
                "seven color",
                "color e-ink",
                "gallery palette",
                "waveshare 7 color",
              ],
            },
          ],
        },
        {
          label: "Retro hardware",
          synonyms: ["retro", "console", "8 bit", "vintage", "pixel art", "demoscene"],
          options: [
            {
              value: "gameboy",
              label: "Game Boy (4 greens)",
              synonyms: ["gameboy", "dmg", "nintendo", "green", "handheld", "gb camera"],
            },
            {
              value: "cga",
              label: "CGA (16 colors)",
              synonyms: ["ibm", "dos", "rgbi", "ega", "pc", "1981"],
            },
            {
              value: "c64",
              label: "Commodore 64 (16 colors)",
              synonyms: ["commodore", "vic ii", "pepto", "breadbin", "8 bit"],
            },
            {
              value: "pico-8",
              label: "PICO-8 (16 colors)",
              synonyms: ["pico8", "fantasy console", "lexaloffle", "indie game"],
            },
          ],
        },
        {
          label: "Your own",
          synonyms: ["custom", "brand", "hex", "manual", "own colors"],
          options: [
            {
              value: "custom",
              label: "Custom hex list",
              synonyms: ["custom", "hex", "brand colors", "my palette", "user defined"],
            },
          ],
        },
      ],
    },
    {
      kind: "text",
      id: "customPalette",
      label: "Custom palette (hex, comma separated)",
      default: "",
      placeholder: "#1a1c2c, #5d275d, #ef7d57, #ffcd75",
    },
    {
      kind: "number",
      id: "scale",
      label: "Pixel scale (downscale before dithering)",
      default: 1,
      min: 1,
      max: 8,
      step: 1,
    },
    {
      kind: "number",
      id: "strength",
      label: "Dither strength",
      default: 1,
      min: 0,
      max: 1,
      step: 0.1,
    },
    {
      kind: "boolean",
      id: "serpentine",
      label: "Serpentine scan (error diffusion only)",
      default: true,
    },
    {
      kind: "boolean",
      id: "gamma",
      label: "Gamma correct (dither in linear light)",
      default: true,
    },
  ],
  copy: {
    what: "Converts any image to a fixed palette using the dithering algorithm you pick, from the seven classic error diffusion kernels (Floyd Steinberg, Atkinson, Jarvis Judice Ninke, Stucki, Burkes, Sierra, Sierra Lite) to ordered Bayer matrices at 2x2, 4x4, and 8x8, plus a 64x64 blue noise tile, plain thresholding, and seeded random noise. Palettes cover 1 bit black and white, 4 and 16 level grayscale, the Game Boy greens, CGA, Commodore 64, PICO-8, the black white red e-ink combination, the 7 color ACeP e-paper set, and any list of hex colors you paste in. All the math runs in linear light by default, so a dithered midtone reflects the same amount of light as the original instead of coming out too bright. A pixel scale option shrinks the image with a box filter before dithering, which is how you get clean chunky pixel art rather than a fine dither pattern squeezed into a small canvas.",
    how: "Drop or pick an image, then choose an algorithm and a palette. The preview redraws as you change anything, and the result is upscaled with hard pixel edges so you can actually see what each algorithm is doing. Turn the pixel scale up to shrink the image before it is dithered, drag the strength down if the pattern is too loud, and switch serpentine scanning off if you want the older left to right look with its diagonal streaks. Download the PNG at its dithered size when you are happy with it.",
    why: "Most dithering sites either upload your picture to a server or give you one algorithm and one palette, which is useless when the whole point is comparing Atkinson against Floyd Steinberg on your own photo. This one runs 13 algorithms and 10 palettes in the tab you already have open, so your files and inputs never leave your device, and it does the arithmetic in linear light, which most online converters skip and which is the reason their output looks washed out. There is no account, no watermark, no size cap other than your own memory, and the page keeps working with the network off.",
    faq: [
      {
        q: "Which dithering algorithm should I use for an e-ink or e-paper display?",
        a: "Start with Floyd Steinberg on the black white red or 7 color ACeP palette. Error diffusion suits e-paper because the panel holds a still image and nothing crawls between frames, and Floyd Steinberg gives the most detail per palette color. If the picture comes out muddy on a 7 color panel, try Atkinson: it drops a quarter of the error on purpose, which lifts contrast and stops flat areas from turning into noise. Avoid Bayer for photographs on e-paper, since the visible grid competes with the panel's own dot structure. Blue noise is the one ordered pattern worth trying, because it has no repeating structure to clash with.",
      },
      {
        q: "Why does my dithered image look darker than the original?",
        a: "Because it is correct. sRGB is not linear: a pixel of 128 emits about 21 percent of the light of white, not 50 percent. If you dither in sRGB numbers, half your pixels turn white and the result reflects 50 percent of the light, so it looks too bright. Doing the math in linear light lights up about a fifth of the pixels instead, which matches what the original actually emitted. Most other converters skip this step, so their output looks brighter and yours looks right. If you want the old look on purpose, turn off gamma correct.",
      },
      {
        q: "Can I export the result for a Game Boy screen or an e-paper panel?",
        a: "Yes. Set the pixel scale so the output lands at the native resolution of the target (160 by 144 for a Game Boy, whatever your e-paper panel reports), pick the matching palette, and download the PNG. The download is the dithered image at its real pixel size, not the magnified preview, so every pixel in the file is one pixel on the device and every color in it is one of the palette entries. From there you can feed it to your usual tile converter or panel driver without a second quantization step undoing the dither.",
      },
    ],
  },
};
