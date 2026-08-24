import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "wasm-feature-detector",
  matrixSlug: "wasm-support",
  icon: "Binary",
  name: "WebAssembly Feature Check",
  description: "Which WebAssembly features this browser actually supports.",
  category: "Dev",
  keywords: [
    "webassembly feature detection",
    "wasm feature check",
    "wasm-feature-detect",
    "webassembly support checker",
    "simd wasm support",
    "wasm threads support",
  ],
  searchTerms: [
    "does my browser support wasm simd",
    "webassembly proposal support",
    "wasm gc browser support",
    "wasm exception handling support",
    "webassembly.validate feature test",
    "check wasm tail calls",
    "wasm compatibility test",
    "wasm bulk memory support",
    "browser webassembly support test",
    "wasm relaxed simd support",
    "wasm threads test browser",
    "check simd support browser",
    "webassembly 2.0 baseline test",
  ],
  input: "application/json",
  output: "application/json",
  copy: {
    what: "Builds the smallest possible WebAssembly module for each post-MVP proposal, bulk memory, both exception handling designs, extended-const, garbage collected types, memory64, multi-memory, multi-value, mutable globals, reference types, relaxed SIMD, non trapping float to int conversions, sign extension, fixed width SIMD, tail calls, and threads, then asks the browser itself whether each one parses. The result is a labeled yes or no for every feature, a summary count, and a verdict on whether this browser meets the 2023 Wasm 2.0 baseline.",
    how: "Open this page in the browser you want to test. It runs every probe automatically on load and lists what came back. Nothing to paste or configure; reload after changing browser flags or updating your browser to re-check.",
    why: "MDN's compatibility tables and caniuse show what browsers generally support, but not what the copy in front of you right now supports, after your flags, your update channel, your engine build. This page tests the exact browser you are in, the same way the wasm-feature-detect library does, and keeps every check local: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does a feature like exception handling show up twice?",
        a: "WebAssembly shipped two different designs for exceptions. The original 2021 proposal used try and catch opcodes directly. It was later reworked around a new exnref type and a try_table instruction for better performance and interop with the garbage collection proposal. Engines are moving to the newer design, but both are listed since real world modules still target either one.",
      },
      {
        q: "Can I trust this for a shipping decision?",
        a: "For the browser you tested it in, yes. Each row comes from asking that exact engine to validate a module that only parses when the feature is implemented, not from a table of what browsers generally claim to support. For a shipping decision you still need to test every browser and version your users actually run.",
      },
      {
        q: "Is anything about my browser sent anywhere?",
        a: "No. Every probe module is built and validated entirely in your browser using WebAssembly.validate, a purely local, synchronous check. Nothing about your browser, your results, or your device is transmitted.",
      },
    ],
  },
};
