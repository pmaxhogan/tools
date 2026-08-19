import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "wasm-inspector",
  matrixSlug: "wasm",
  icon: "Binary",
  name: "WASM Inspector",
  description:
    "Read a WebAssembly module's sections, imports, exports, and post-MVP features in your browser.",
  category: "Dev",
  keywords: [
    "wasm inspector",
    "webassembly module viewer",
    "wasm sections",
    "wasm imports exports",
    "wasm feature detection",
    "analyze wasm file",
  ],
  searchTerms: [
    "wasm viewer",
    "webassembly parser",
    "read wasm file",
    "wasm dump",
    "wasm objdump",
    "inspect webassembly binary",
    "wasm module info",
    "wasm magic bytes",
    "shared memory wasm",
    "wasm simd detection",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "view",
      label: "Detail",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary",
          synonyms: ["overview", "at a glance", "module info", "headline"],
        },
        {
          value: "sections",
          label: "Section table",
          synonyms: ["sections", "section list", "offsets", "layout", "sizes"],
        },
        {
          value: "symbols",
          label: "Imports and exports",
          synonyms: ["symbols", "imports", "exports", "names", "linking"],
        },
      ],
    },
  ],
  copy: {
    what: "Parses a WebAssembly binary and tells you what is inside it. It reads the magic bytes and version, walks the whole section table, and reports the type count, every import and export with its kind, the function and global counts, the memory limits in pages, the start function, and the data and element segment counts. It also works out which post-MVP proposals the module leans on: shared memory for threads, multiple memories, bulk memory, multi-value, SIMD, reference types, exception handling, and tail calls. The parser is hand written, so there is no toolchain to install and nothing to configure.",
    how: "Drop a .wasm file onto the panel or pick one with the file button. You can also paste the module as base64, as a hex dump with or without a 0x prefix, or as a data:application/wasm;base64 URL. The Detail option switches between a summary, a section table with every section id, size and byte offset, and a full list of imports and exports. Every row has its own copy button.",
    why: 'The usual way to answer "what does this module import?" is to install a whole toolchain for wasm-objdump, or to upload the binary to somebody\'s online wasm dumper. This one runs the parser in the page, so your files and inputs never leave your device, and it works offline after the first load. There are no size caps, no sign in, and no ads over the section table.',
    faq: [
      {
        q: "Does my .wasm get uploaded?",
        a: "No. The module is parsed locally in your browser, so your files and inputs never leave your device. The page keeps working with the network switched off.",
      },
      {
        q: "How reliable is the feature detection?",
        a: "Every reported feature comes from a definitive structural signal. Shared memory and Memory64 from the memory limits, multiple memories from the memory count, bulk memory from a DataCount section, exception handling from a tag section, multi-value and a v128 or externref from a function signature. Guessing features from raw code section bytes was tried and dropped, because the opcode bytes collide with ordinary instruction immediates and fired on almost every module. A feature that cannot be seen for certain is left off the list rather than reported inaccurately.",
      },
      {
        q: "Why does it refuse my component model binary?",
        a: "Component binaries share the same magic bytes but declare a different version number, so the inspector reports the version it found instead of misreading the layout. It reads version 1 core modules, which is what almost every .wasm file produced by Rust, C, Go, or AssemblyScript is.",
      },
    ],
  },
};
