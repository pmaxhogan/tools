import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "uf2-inspector",
  matrixSlug: "uf2",
  icon: "Cpu",
  name: "UF2 Inspector",
  description: "Decode UF2 blocks, family IDs and memory ranges from a firmware file.",
  category: "Hardware",
  keywords: [
    "uf2 inspector",
    "uf2 file viewer",
    "decode uf2 blocks",
    "uf2 family id lookup",
    "raspberry pi pico firmware",
    "rp2040 uf2",
  ],
  searchTerms: [
    "uf2 parser",
    "uf2 dump",
    "rpi-rp2 firmware",
    "usb flashing format",
    "uf2 memory map",
    "pico firmware inspector",
    "uf2 block viewer",
    "uf2 checksum",
    "circuitpython uf2",
    "arduino uf2 file",
    "uf2 family id list",
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
          synonyms: ["overview", "at a glance", "families", "flags", "verdict"],
        },
        {
          value: "blocks",
          label: "Block table",
          synonyms: ["blocks", "per block", "block list", "addresses", "block details"],
        },
      ],
    },
  ],
  copy: {
    what: "Parses a UF2 firmware file block by block: the magic numbers, flags, target flash address and payload size of every 512 byte block. It reports which family IDs the file declares (an RP2350 build often carries more than one, such as the secure Arm image plus an absolute or data partition ID), the contiguous address ranges the file writes to and any gaps between them, whether the block numbers form a clean sequence, and any MD5 or extension tag metadata the file embeds, such as a firmware version string or device description.",
    how: "Drop a .uf2 file onto the panel or pick one with the file button. You can also paste the file as base64 or as a hex dump. The Detail option switches between a summary (block count, families, flags, address ranges, and a pass or fail verdict) and a block table listing every block's address and size, capped at 200 rows for very large files.",
    why: "Most UF2 tooling is a command line script bundled with one specific board's SDK. This one reads any UF2 file in the browser, covers the full family ID table across RP2040, RP2350, SAMD, NRF52, STM32, ESP32 and more, and flags structural problems (a wrong magic number, a missing block, an address gap) instead of just listing bytes. Your files and inputs never leave your device, and there is no install step.",
    faq: [
      {
        q: "What is UF2?",
        a: "UF2 (USB Flashing Format) is a file format designed by Microsoft for drag and drop firmware flashing. The file is split into fixed 512 byte blocks, each one carrying its own destination flash address, so a device can appear as a plain USB drive and still be flashed reliably by just copying the file onto it.",
      },
      {
        q: "Why does my RP2350 file show two families?",
        a: "The RP2350 uses one family ID for the secure Arm image and a separate one for the RISC-V image, and some tooling adds an absolute or data partition family ID alongside the main one for the same build. Seeing more than one family in a single file is normal for that chip; the summary lists each family and how many blocks carry it.",
      },
      {
        q: "Can I drag this onto the RPI-RP2 drive?",
        a: "Yes, unchanged. This tool only reads the file to report on it; it never modifies the bytes, so the .uf2 you inspect here is exactly the one you can still copy onto the device's drive to flash it.",
      },
    ],
  },
};
