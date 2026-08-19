import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "gpu-inspector",
  matrixSlug: "gpu",
  icon: "Cpu",
  name: "GPU Inspector",
  description: "Inspect your browser's WebGPU adapter, its supported features, and its limits.",
  category: "Dev",
  keywords: [
    "webgpu inspector",
    "gpu adapter info",
    "webgpu limits",
    "webgpu features",
    "browser gpu info",
    "check webgpu support",
  ],
  searchTerms: [
    "webgpu adapter info",
    "gpu vendor and architecture",
    "webgpu compute limits",
    "webgpu feature detection",
    "chrome gpu info alternative",
    "webgpu support checker",
  ],
  requires: ["webgpu"],
  input: "application/json",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "detail",
      label: "Limits shown",
      default: "key",
      options: [
        {
          value: "key",
          label: "Key limits",
          synonyms: ["common limits", "important limits", "summary", "default"],
        },
        {
          value: "all",
          label: "All limits",
          synonyms: ["every limit", "full list", "complete", "everything"],
        },
      ],
    },
  ],
  copy: {
    what: "Reads your browser's WebGPU adapter and reports what it is, what it supports, and how much of everything it allows: vendor, architecture, device description, every supported feature, the preferred canvas format, and the numeric limits (texture size, buffer size, compute workgroup dimensions, and more).",
    how: "Open this page in a browser with WebGPU. It requests a GPU adapter automatically and lists everything it reports. Switch the limits option from key limits to all limits to see every value the adapter exposes, not just the handful developers check first.",
    why: "chrome://gpu buries the same information behind an unstructured dump built for bug reports, not for reading. This page pulls the same adapter data into a labeled, copyable list, works in any WebGPU browser, and never sends what it finds anywhere: your files and inputs never leave your device.",
    faq: [
      {
        q: "What is WebGPU?",
        a: "WebGPU is a browser API for talking directly to the GPU, for both graphics rendering and general purpose compute. It replaces the older, more limited WebGL for modern GPU workloads.",
      },
      {
        q: "Why does my browser say not available?",
        a: "WebGPU needs a Chromium based browser (Chrome, Edge, or a recent Firefox/Safari build) with the feature enabled, plus a GPU and driver combination the browser is willing to trust. Older hardware, disabled hardware acceleration, or a browser flag can all cause this.",
      },
      {
        q: "What are limits for?",
        a: "Limits are the maximum sizes and counts an adapter guarantees, such as the largest texture dimension or how many bindings a shader can use per bind group. A WebGPU app checks them before allocating resources so it never requests more than the device supports.",
      },
    ],
  },
};
