import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "sprite-sheet-packer",
  matrixSlug: "sprite-packer",
  icon: "LayoutGrid",
  name: "Sprite Sheet Packer",
  description: "Pack loose images into one texture atlas plus JSON frame coordinates.",
  category: "Media",
  keywords: [
    "sprite sheet packer",
    "texture atlas generator online",
    "pack images into sprite sheet",
    "sprite sheet maker",
    "texturepacker alternative free",
    "css sprite generator",
  ],
  searchTerms: [
    "atlas packer",
    "maxrects",
    "bin packing",
    "rectangle packing",
    "spritesheet",
    "phaser atlas",
    "pixi atlas",
    "starling xml atlas",
    "unity sprite atlas",
    "godot atlas",
    "combine images into one png",
    "image montage",
    "trim transparent edges",
    "power of two texture",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "maxSize",
      label: "Maximum atlas side (px)",
      default: 2048,
      min: 256,
      max: 8192,
      step: 256,
    },
    {
      kind: "number",
      id: "padding",
      label: "Padding between sprites (px)",
      default: 2,
      min: 0,
      max: 16,
      step: 1,
    },
    {
      kind: "select",
      id: "algorithm",
      label: "Packing algorithm",
      default: "maxrects",
      options: [
        {
          value: "maxrects",
          label: "MaxRects (tightest)",
          synonyms: ["max rects", "best short side fit", "bssf", "jylanki", "texturepacker"],
        },
        {
          value: "guillotine",
          label: "Guillotine (edge to edge cuts)",
          synonyms: ["guillotine", "cut", "split", "shorter axis"],
        },
        {
          value: "shelf",
          label: "Shelf (rows, fastest)",
          synonyms: ["shelf", "rows", "next fit decreasing height", "nfdh", "strip"],
        },
      ],
    },
    {
      kind: "select",
      id: "format",
      label: "Metadata format",
      default: "json-hash",
      options: [
        {
          value: "json-hash",
          label: "JSON hash (TexturePacker, Phaser 3)",
          synonyms: ["texturepacker", "phaser", "phaser3", "hash", "frames object", "json"],
        },
        {
          value: "json-array",
          label: "JSON array (ordered frames)",
          synonyms: ["pixi", "pixijs", "array", "ordered", "animation order"],
        },
        {
          value: "css",
          label: "CSS background sprites",
          synonyms: ["stylesheet", "background position", "css sprite", "web"],
        },
        {
          value: "xml",
          label: "XML (Starling, Sparrow)",
          synonyms: ["starling", "sparrow", "subtexture", "flash", "adobe air"],
        },
        {
          value: "csv",
          label: "CSV rows",
          synonyms: ["spreadsheet", "excel", "table", "comma separated"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "trim",
      label: "Trim transparent edges",
      default: true,
    },
    {
      kind: "boolean",
      id: "powerOfTwo",
      label: "Power of two atlas size",
      default: false,
    },
    {
      kind: "boolean",
      id: "allowRotate",
      label: "Allow 90 degree rotation",
      default: false,
    },
  ],
  copy: {
    what: "Packs a pile of loose PNGs into one texture atlas and writes the frame coordinates that go with it. The layout is solved with MaxRects using the best short side fit heuristic, the same family of algorithm TexturePacker uses, with a guillotine packer and a shelf packer available when you want edge to edge cuts or plain rows instead. Sprites can be trimmed to their opaque bounds before packing, padded so bilinear filtering never samples a neighbor, rotated 90 degrees to fill awkward gaps, and rounded up to power of two sides for older GPUs. You get the packed PNG plus metadata in TexturePacker JSON hash, JSON array, Starling and Sparrow XML, CSS background sprites, or CSV, and a report of the atlas size and how much of it is real sprite pixels.",
    how: "Drop every sprite onto the panel at once, or pick them with the file button. Set the maximum atlas side, the padding, and whether you want trimming, rotation, and power of two sizes, then look at the preview: each frame is outlined so you can see where the space went. Download the PNG and the metadata file separately, or grab both in one zip. If you only need the layout and not the image, paste one line per sprite in the form name 32x32 and the tool computes coordinates without ever touching a pixel.",
    why: "The desktop packers cost money for a feature you need once a sprint, and the free web ones cap the number of images, watermark the output, or ask you to sign in before they will show you a download button. This one has no cap, no account, and no watermark, and because everything runs in the tab your files and inputs never leave your device, which matters when the art is unreleased. It also tells you the truth about the result: the reported efficiency is real sprite pixels over atlas pixels, and any sprite that did not fit is named rather than quietly dropped.",
    faq: [
      {
        q: "What does padding do, and why is 2 pixels the default?",
        a: "Padding is empty space kept between neighboring frames. When a sprite is drawn scaled, rotated, or at a fractional position, the GPU blends the pixels around the edge of the frame, and without a gap it blends in whatever sprite happens to sit next door, which shows up as a thin colored seam. Two pixels is enough for bilinear filtering at normal scales. Go to 4 or more if you use mipmaps or draw sprites much smaller than their source size, and use 0 only for a tile sheet you sample at exactly 1 to 1.",
      },
      {
        q: "Should I turn on trim and rotation?",
        a: "Trim almost always, rotation only sometimes. Trimming cuts the transparent margin off each sprite before packing and records the original size and offset in the metadata, so engines that read TexturePacker JSON draw the frame back in exactly the right place and you save real atlas space. Rotation lets the packer turn a tall sprite on its side to fill a wide gap, which can shrink the atlas noticeably, but the engine has to support the rotated flag. Phaser, Pixi, and Starling do. A CSS sprite sheet does not, so leave rotation off when the target is a stylesheet.",
      },
      {
        q: "Which metadata format does my engine want?",
        a: "Phaser 3, Pixi, and most modern loaders read TexturePacker JSON hash, which is the default here and is also what Phaser calls an atlas JSON. JSON array is the same data with the frames in an ordered list, which is handy when frame order drives an animation. Starling and Sparrow want the XML with SubTexture elements. Pick CSS if you are building a web sprite sheet and want ready made background position rules, and CSV if you are feeding the coordinates into your own build script.",
      },
    ],
  },
};
