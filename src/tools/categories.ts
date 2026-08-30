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
      "Clean up, convert, count and transform text in the browser, from case changes and escaping to regex and invisible characters.",
  },
  {
    slug: "data",
    label: "Data",
    icon: "Braces",
    description:
      "Format, validate, convert and inspect structured data: JSON, CSV, YAML, TOML, SQL, Parquet, SQLite and more.",
  },
  {
    slug: "dev",
    label: "Dev",
    icon: "Code",
    description:
      "Everyday developer utilities: formatters, decoders, generators and playgrounds for the things you would otherwise script.",
  },
  {
    slug: "crypto",
    label: "Crypto",
    icon: "KeyRound",
    description:
      "Hashes, keys, tokens, certificates and passwords, all computed on your device so secrets never leave it.",
  },
  {
    slug: "network",
    label: "Network",
    icon: "Globe",
    description:
      "DNS, headers, subnets, proxies, WebRTC and other network tools for debugging what sits between you and a server.",
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
      "Inspect, rename, diff, deduplicate and process files and folders locally, with safe undo for anything that writes.",
  },
  {
    slug: "images",
    label: "Images",
    icon: "Image",
    description:
      "Resize, convert, redact, diff, dither and generate images without uploading them anywhere.",
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
      "Tone generation, tuning, tempo and key detection, spectrograms and audio data codecs, all from the Web Audio API.",
  },
  {
    slug: "docs",
    label: "Docs",
    icon: "FileText",
    description:
      "PDF, Markdown, document conversion and scanning tools for paperwork that should stay on your machine.",
  },
  {
    slug: "qr",
    label: "QR",
    icon: "QrCode",
    description:
      "Generate, scan, decode and transfer data with QR codes and barcodes, including animated file transfer.",
  },
  {
    slug: "generators",
    label: "Generators",
    icon: "Sparkles",
    description:
      "Random and structured generators: identifiers, fake data, passwords, placeholder images, bingo cards and pickers.",
  },
  {
    slug: "testers",
    label: "Testers",
    icon: "FlaskConical",
    description:
      "Test your keyboard, mouse, gamepad, touchscreen, webcam, microphone, display and browser features in one place.",
  },
  {
    slug: "hardware",
    label: "Hardware",
    icon: "Cpu",
    description:
      "Talk to real devices over serial, HID, Bluetooth, MIDI and NFC, flash firmware, and inspect GPUs, displays and sensors.",
  },
  {
    slug: "homelab",
    label: "Homelab",
    icon: "Server",
    description:
      "Calculators and generators for self-hosters: RAIDZ layouts, systemd units, reverse proxies, WireGuard, SMART reports and Docker Compose.",
  },
  {
    slug: "platform",
    label: "Platform",
    icon: "Layers",
    description:
      "Tools about the browser platform itself: feature detection, privacy checks, capability probes and WebAssembly.",
  },
  {
    slug: "capture",
    label: "Capture",
    icon: "Camera",
    description:
      "Record your screen, a browser tab or a single element, annotate screenshots and beautify them, all locally.",
  },
  {
    slug: "local-ai",
    label: "Local AI",
    icon: "Brain",
    description:
      "Speech to text, OCR, background removal and image upscaling with open models that download once and run on your device.",
  },
  {
    slug: "geo",
    label: "Geo",
    icon: "MapPin",
    description:
      "Coordinates, distances, bearings, sun times, GPX tracks and lookups for places, airports and countries.",
  },
  {
    slug: "rf",
    label: "RF",
    icon: "Radio",
    description:
      "Radio spectrum references: who is allocated what frequency in the United States and worldwide, band plans, channel tables and RF exposure limits.",
  },
  {
    slug: "science",
    label: "Science",
    icon: "Atom",
    description:
      "Reference tools for physics and engineering, from the electromagnetic spectrum to unit-aware calculators.",
  },
  {
    slug: "physics",
    label: "Physics",
    icon: "Orbit",
    description:
      "Visual physics: animated projectiles, ray diagrams, moving wave sources and orbits you can steer with real numbers.",
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
      "Weather and earth science calculators: wind chill and heat index, dew point, pressure altitude, earthquake energy and tides.",
  },
  {
    slug: "chemistry",
    label: "Chemistry",
    icon: "TestTube",
    description:
      "Chemical lookups, NFPA 704 fire diamonds, GHS pictograms, molar mass and the periodic table. Reference only: always check the safety data sheet.",
  },
  {
    slug: "minecraft",
    label: "Minecraft",
    icon: "Pickaxe",
    description:
      "Version-aware calculators for loot, damage, anvils, XP, villagers, spawning, projectiles, elytra, crops and redstone, verified against the game's own code.",
  },
  {
    slug: "mobile",
    label: "Mobile",
    icon: "Smartphone",
    description: "Sensors and device features that only make sense on a phone or tablet.",
  },
];

const BY_LABEL = new Map(CATEGORIES.map((c) => [c.label, c]));
const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

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
