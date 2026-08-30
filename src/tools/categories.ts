/**
 * The canonical tool categories. Every `ToolMeta.category` must equal one of
 * these labels (registry.test enforces it), and every surface that lists or
 * groups tools (sidebar, homepage, palette, breadcrumbs, category pages) reads
 * the display order, icon and copy from here instead of sorting labels.
 *
 * `slug` is the URL segment under /category/ and must never collide with a
 * tool slug (also enforced by registry.test). `icon` is a lucide export name
 * resolved through src/lib/tool-icons.ts, same as ToolMeta.icon. `description`
 * is the category page intro: one or two sentences, US English, no em dashes.
 *
 * Grouping rule: a category is a subject a visitor would name, not an
 * implementation detail. "CSS" and "Color" are subjects; "things built with a
 * canvas" is not. A category needs at least three tools to earn a heading;
 * below that its tools live with their nearest neighbor.
 */
export interface ToolCategory {
  slug: string;
  label: string;
  icon: string;
  description: string;
}

export const CATEGORIES: ToolCategory[] = [
  {
    slug: "text",
    label: "Text",
    icon: "Type",
    description:
      "Clean up, convert, count and transform text in the browser, from case changes and escaping to ciphers, Morse and fancy Unicode styles.",
  },
  {
    slug: "data",
    label: "Data",
    icon: "Braces",
    description:
      "Format, validate, convert, decode and inspect structured data: JSON, CSV, YAML, SQL, Parquet, SQLite, spreadsheets, Protobuf and opaque IDs.",
  },
  {
    slug: "dev",
    label: "Dev",
    icon: "Code",
    description:
      "Everyday developer utilities: regex, JSONPath, XPath, glob and semver testers, patch application, and WebAssembly and GPU inspection.",
  },
  {
    slug: "css",
    label: "CSS",
    icon: "Paintbrush",
    description:
      "Visual CSS builders with live previews: easing curves, gradients, shadows, keyframes, clip paths, fluid type and anchor positioning.",
  },
  {
    slug: "color",
    label: "Color",
    icon: "Palette",
    description:
      "Pick, convert and check colors: contrast against WCAG and APCA, color blindness simulation, and palettes pulled from an image.",
  },
  {
    slug: "security",
    label: "Security",
    icon: "ShieldCheck",
    description:
      "Hashes, keys, tokens, certificates, passwords and encryption, all computed on your device so secrets never leave it.",
  },
  {
    slug: "network",
    label: "Network",
    icon: "Globe",
    description:
      "DNS, headers, subnets, email authentication, WebRTC and other network tools for debugging what sits between you and a server.",
  },
  {
    slug: "time",
    label: "Time",
    icon: "Clock",
    description:
      "Timestamps, time zones, cron schedules, timers and durations, converted and explained without guesswork.",
  },
  {
    slug: "files",
    label: "Files",
    icon: "FolderOpen",
    description:
      "Inspect, rename, diff, deduplicate and process files, folders and archives locally, with safe undo for anything that writes.",
  },
  {
    slug: "images",
    label: "Images",
    icon: "Image",
    description:
      "Resize, convert, redact, dither, watermark and generate images, read or strip their metadata, and work out exposure, all without uploading anything.",
  },
  {
    slug: "media",
    label: "Media",
    icon: "Film",
    description:
      "Trim, convert, compress and analyze audio and video with ffmpeg running entirely in your browser.",
  },
  {
    slug: "audio",
    label: "Audio",
    icon: "AudioLines",
    description:
      "Tone generation, tuning, tempo and key detection, MIDI inspection, tag editing and audio data codecs from the Web Audio API.",
  },
  {
    slug: "docs",
    label: "Docs",
    icon: "FileText",
    description:
      "PDF, document conversion, scanning and font subsetting for paperwork that should stay on your machine.",
  },
  {
    slug: "qr",
    label: "QR",
    icon: "QrCode",
    description:
      "Generate, scan, decode and transfer data with QR codes and barcodes, including animated file transfer.",
  },
  {
    slug: "capture",
    label: "Capture",
    icon: "Camera",
    description:
      "Record your screen, a browser tab or a single element, then annotate, compare and beautify screenshots, all locally.",
  },
  {
    slug: "local-ai",
    label: "Local AI",
    icon: "Brain",
    description:
      "Speech to text, OCR, background removal and image upscaling with open models that download once and run on your device.",
  },
  {
    slug: "testers",
    label: "Testers",
    icon: "FlaskConical",
    description:
      "Test your keyboard, mouse, gamepad, touchscreen, webcam, microphone and display, and measure your own reaction time and click speed.",
  },
  {
    slug: "games",
    label: "Games",
    icon: "Gamepad2",
    description:
      "Puzzles, party tools and game utilities: Sudoku, bingo cards, random pickers and Factorio blueprints. Minecraft has its own section.",
  },
  {
    slug: "hardware",
    label: "Hardware",
    icon: "Cpu",
    description:
      "Talk to real devices over serial, HID, Bluetooth and NFC, flash firmware, inspect UF2 images, and read the sensors and light meter on a phone.",
  },
  {
    slug: "electronics",
    label: "Electronics",
    icon: "CircuitBoard",
    description:
      "Bench calculators: Ohm's law, resistor and capacitor codes, LED resistors, voltage dividers, 555 timers, trace width, wire gauge and battery life.",
  },
  {
    slug: "3d-printing",
    label: "3D Printing",
    icon: "Printer",
    description:
      "Preview G-code, visualize a bed mesh and estimate what a print costs, without sending your files anywhere.",
  },
  {
    slug: "homelab",
    label: "Homelab",
    icon: "Server",
    description:
      "For self-hosters: RAIDZ layouts, systemd units, reverse proxies, WireGuard, SMART reports, Docker Compose, PromQL, Jinja and log analysis.",
  },
  {
    slug: "platform",
    label: "Platform",
    icon: "Layers",
    description:
      "Tools that plug into the browser itself: the clipboard, bookmarklets, composable pipelines and an on-screen ruler.",
  },
  {
    slug: "geo",
    label: "Geo",
    icon: "MapPin",
    description:
      "Coordinates, distances, bearings, sun times, GPX tracks and lookups for cities, airports and countries.",
  },
  {
    slug: "astronomy",
    label: "Astronomy",
    icon: "Moon",
    description:
      "Sky and orbit calculators: moon phases, planet positions and rise times, orbital transfers, Julian dates and magnitudes.",
  },
  {
    slug: "weather-earth",
    label: "Weather & Earth",
    icon: "CloudSun",
    description:
      "Weather and earth science calculators: wind chill and heat index, dew point, pressure altitude and earthquake energy.",
  },
  {
    slug: "chemistry",
    label: "Chemistry",
    icon: "TestTube",
    description:
      "25,000-compound lookup, NFPA 704, GHS pictograms, the periodic table, and calculators for equations, solutions, pH and decay. Always check the SDS.",
  },
  {
    slug: "rf",
    label: "RF",
    icon: "Radio",
    description:
      "Radio spectrum references and calculators: US and worldwide allocations, band plans, channel tables, RF exposure, antennas, path loss, cables and matching.",
  },
  {
    slug: "minecraft",
    label: "Minecraft",
    icon: "Pickaxe",
    description:
      "Version-aware calculators for loot, damage, anvils, XP, villagers, spawning, projectiles, elytra, crops, redstone, portals, beacons and pixel circles.",
  },
];

const BY_LABEL = new Map(CATEGORIES.map((c) => [c.label, c]));
const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

/**
 * Slugs that used to be category pages. Astro serves a redirect for each so
 * old links and search results keep working (see astro.config.mjs).
 */
export const RETIRED_CATEGORY_SLUGS: Record<string, string> = {
  crypto: "security",
  generators: "games",
  mobile: "hardware",
  science: "rf",
  physics: "astronomy",
};

/** Look a category up by its display label (the value stored in ToolMeta.category). */
export function categoryByLabel(label: string): ToolCategory | undefined {
  return BY_LABEL.get(label);
}

/** Look a category up by its URL slug. */
export function categoryBySlug(slug: string): ToolCategory | undefined {
  return BY_SLUG.get(slug);
}

/** Display rank of a category label; unknown labels sort last. */
export function categoryRank(label: string): number {
  const idx = CATEGORIES.findIndex((c) => c.label === label);
  return idx === -1 ? CATEGORIES.length : idx;
}

/** URL path of a category page. */
export function categoryPath(category: ToolCategory | string): string {
  const slug =
    typeof category === "string" ? (categoryByLabel(category)?.slug ?? "") : category.slug;
  return `/category/${slug}`;
}
