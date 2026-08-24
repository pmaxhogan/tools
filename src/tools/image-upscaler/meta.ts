import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-upscaler",
  matrixSlug: "upscale",
  icon: "WandSparkles",
  name: "Image Upscaler",
  description: "Enlarge an image four times with Real-ESRGAN running in your browser.",
  category: "Local AI",
  keywords: [
    "image upscaler",
    "ai upscale image",
    "enlarge image without losing quality",
    "real esrgan online",
    "4x image upscaler free",
    "increase image resolution",
    "upscale screenshot",
    "make picture bigger without blur",
  ],
  searchTerms: [
    "super resolution",
    "esrgan",
    "resize up",
    "sharpen small image",
    "upscayl",
    "waifu2x alternative",
    "hd image converter",
    "restore old photo",
    "enlarge logo",
    "pixel art upscale",
    "improve image quality",
    "webgpu upscaler",
    "offline upscaler",
    "increase dpi",
  ],
  input: "image/*",
  output: "application/json",
  // No capability gate on purpose. WebGPU makes this fast, but the WebAssembly
  // path runs the same network in any browser, so gating on WebGPU would lock
  // out visitors the tool can still serve.
  requires: [],
  options: [
    {
      kind: "select",
      id: "model",
      label: "Model",
      default: "general",
      ui: "segmented",
      options: [
        {
          value: "general",
          label: "General (fast, 4.9 MB)",
          synonyms: ["small", "x4v3", "realesr general", "quick", "default", "screenshots"],
        },
        {
          value: "photo",
          label: "Photo x4plus (66 MB)",
          synonyms: ["large", "x4plus", "rrdb", "best quality", "photographs", "slow"],
        },
      ],
    },
  ],
  copy: {
    what: "Enlarges an image to four times its width and height using Real-ESRGAN, a super resolution network that runs inside this browser tab. Two models are offered: a 4.9 MB general model that is quick on any machine and is the default, and the full 66 MB RealESRGAN_x4plus, which is noticeably better on photographs and much slower. The image is cut into overlapping tiles so memory stays flat on large pictures, each tile is enlarged, and the tiles are feathered back together so no seams show. Where the browser supports WebGPU the graphics card does the work; everywhere else it falls back to WebAssembly on the processor, which is slower but produces the same result.",
    how: "Drop an image on the panel, paste one from the clipboard, or pick a file. Choose a model: start with General, and switch to Photo x4plus when the subject is a photograph and you can wait. The weights download once and your browser keeps them, so the second visit starts immediately. Press Upscale and watch the tile counter, then drag the divider across the result to compare it against the original, or turn on the 100 percent view to inspect real pixels. Download saves a PNG named after the file you started with.",
    why: "Most upscaling sites make you create an account, watermark the result, cap you at a couple of free images a day, or hold the good model behind a subscription, and every one of them needs your picture on their server first. This runs the same open Real-ESRGAN weights on your own hardware with no account, no queue, and no limit on how many images you enlarge: your files and inputs never leave your device. The only thing fetched is the model itself, served from this site.",
    faq: [
      {
        q: "Is my image uploaded to a server?",
        a: "No. The network runs in this tab through ONNX Runtime Web, on your graphics card when WebGPU is available and on your processor otherwise, so your files and inputs never leave your device. The model weights are downloaded from this site the first time you use the tool, about 4.9 MB for the general model or 66 MB for the photo model, and your browser caches them for later visits. On a metered or Save-Data connection the download waits for you to press start instead of beginning on its own.",
      },
      {
        q: "Can I trust the extra detail it adds?",
        a: "Treat it as a plausible guess, not as recovered information. Real-ESRGAN was trained to produce sharp images from degraded ones, so it fills in texture that was never in your file. Faces can change subtly, small text often comes back as convincing nonsense, and repeating patterns can drift. For a wallpaper, a product photo, or an old graphic that just needs to be bigger, that is exactly what you want. For anything where the detail has to be faithful, such as evidence, medical images, or a document you plan to read, compare against the original with the divider before you rely on it.",
      },
      {
        q: "Why is it slow, and what are the size limits?",
        a: "Every 128 by 128 tile is a full pass through a convolutional network. With WebGPU a tile takes a fraction of a second; with the WebAssembly fallback it can take several seconds, and the photo model is roughly ten times heavier than the general one. The tool stops at 4096 pixels on a side, and because the result is four times larger on each side it also caps the output at 8192 pixels wide and about 16 megapixels, which works out to roughly 1024 by 1024 going in. Crop to the part you want enlarged if your image is over that, and use the Cancel button if a run is taking longer than it is worth.",
      },
    ],
  },
};
