import { ToolError, type ToolLogic } from "../types";

export interface FaviconOpts {
  /** Used for both `name` and `short_name` in the generated web manifest. */
  appName: string;
  /** Hex color for the manifest `theme_color` and the theme-color meta tag. */
  themeColor: string;
  /** Hex color for the manifest `background_color` (the splash screen fill). */
  bgColor: string;
  [key: string]: unknown;
}

export type FaviconResult = Record<string, string>;

/** The 8 byte PNG file signature (PNG spec, section 5.2). */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Icon sizes referenced by the generated manifest and link tags. */
const MANIFEST_ICON_SIZES = [192, 512] as const;
const APPLE_TOUCH_SIZE = 180;

/** True when the buffer opens with the PNG signature. */
function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Read a big-endian uint32 (PNG stores every length and dimension this way). */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/**
 * Parse the IHDR header of a PNG and return its pixel dimensions.
 *
 * The IHDR chunk is always first: 8 signature bytes, a 4 byte length, the
 * ASCII type "IHDR", then width and height as big-endian uint32s.
 */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } {
  if (!hasPngSignature(bytes)) {
    throw new ToolError(
      "invalid-png",
      "That data does not start with the PNG file signature.",
      "Supply the raw bytes of a .png file. Other formats need converting to PNG first.",
    );
  }
  if (bytes.length < 24) {
    throw new ToolError(
      "invalid-png",
      "The PNG is truncated: it ends before the IHDR header is complete.",
      "Re-export or re-download the image, then drop the full file in again.",
    );
  }
  const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (type !== "IHDR") {
    throw new ToolError(
      "invalid-png",
      `Expected an IHDR chunk right after the PNG signature but found "${type}".`,
      "The file looks corrupt. Re-export it from your image editor and try again.",
    );
  }
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width === 0 || height === 0) {
    throw new ToolError(
      "invalid-png",
      "The PNG header declares a width or height of zero.",
      "Open the file in an image editor, confirm it has real pixel dimensions, and re-export it.",
    );
  }
  return { width, height };
}

/**
 * Assemble a Windows ICO container from one or more PNG blobs.
 *
 * Layout: a 6 byte ICONDIR, then one 16 byte ICONDIRENTRY per image, then the
 * image payloads back to back. Every multi-byte field is little-endian. PNG
 * compressed entries (rather than BMP) are read by every browser in use today,
 * so the payloads go in untouched.
 */
export function buildIco(images: { size: number; png: Uint8Array }[]): Uint8Array {
  if (images.length === 0) {
    throw new ToolError(
      "no-images",
      "buildIco was given an empty image list.",
      "Pass at least one entry shaped like { size, png }.",
    );
  }
  for (const image of images) {
    if (!Number.isInteger(image.size) || image.size < 1) {
      throw new ToolError(
        "invalid-ico-size",
        `Icon size "${image.size}" is not a positive whole number of pixels.`,
        "Use a whole pixel size between 1 and 256, for example 16, 32, 48, or 256.",
      );
    }
    if (image.size > 256) {
      throw new ToolError(
        "too-large-for-ico",
        `An ICO entry cannot be larger than 256 pixels, but ${image.size} was requested.`,
        "Drop sizes above 256 from the ICO and ship them as standalone PNG files instead.",
      );
    }
  }

  const count = images.length;
  const headerSize = 6 + 16 * count;
  const totalSize = images.reduce((sum, image) => sum + image.png.length, headerSize);
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  // ICONDIR: reserved (must be 0), image type (1 = icon), image count.
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, count, true);

  let payloadOffset = headerSize;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    // 256 does not fit in a byte, so the format spells it as 0.
    out[entry] = image.size === 256 ? 0 : image.size;
    out[entry + 1] = image.size === 256 ? 0 : image.size;
    out[entry + 2] = 0; // palette color count: 0 for truecolor
    out[entry + 3] = 0; // reserved
    view.setUint16(entry + 4, 1, true); // color planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, image.png.length, true); // payload size
    view.setUint32(entry + 12, payloadOffset, true); // payload offset
    out.set(image.png, payloadOffset);
    payloadOffset += image.png.length;
  });

  return out;
}

/** Build the web app manifest JSON for the generated icon set. */
export function buildManifest(opts: {
  name: string;
  shortName: string;
  themeColor: string;
  bgColor: string;
}): string {
  const manifest = {
    name: opts.name,
    short_name: opts.shortName,
    icons: MANIFEST_ICON_SIZES.map((size) => ({
      src: `/icon-${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    })),
    theme_color: opts.themeColor,
    background_color: opts.bgColor,
    display: "standalone",
    start_url: "/",
  };
  return JSON.stringify(manifest, null, 2);
}

/** Build the head snippet that wires the icon set into a page. */
export function buildLinkTags(opts: { themeColor: string }): string {
  return [
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    '<link rel="icon" type="image/png" href="/favicon-16x16.png" sizes="16x16">',
    '<link rel="icon" type="image/png" href="/favicon-32x32.png" sizes="32x32">',
    ...MANIFEST_ICON_SIZES.map(
      (size) =>
        `<link rel="icon" type="image/png" href="/icon-${size}.png" sizes="${size}x${size}">`,
    ),
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="${APPLE_TOUCH_SIZE}x${APPLE_TOUCH_SIZE}">`,
    '<link rel="manifest" href="/site.webmanifest">',
    `<meta name="theme-color" content="${opts.themeColor}">`,
  ].join("\n");
}

/**
 * Base64-encode bytes without blowing the argument limit.
 *
 * `btoa` wants a binary string, and spreading a multi-megabyte array into
 * `String.fromCharCode` overflows the call stack, so the buffer is walked in
 * 32 KB slices.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Normalize a user-supplied hex color, or throw an actionable error. */
function normalizeHexColor(raw: string, label: string): string {
  const value = (raw ?? "").trim();
  const body = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{3}$/.test(body) && !/^[0-9a-fA-F]{6}$/.test(body)) {
    throw new ToolError(
      "bad-color",
      `${label} is not a hex color: "${value}".`,
      "Use a 3 or 6 digit hex value such as #5B4BD6 or #fff.",
    );
  }
  return `#${body.toLowerCase()}`;
}

/** Human-readable byte count for the source summary row. */
function formatBytes(count: number): string {
  if (count < 1024) return `${count} bytes`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(2)} MB`;
}

export async function run(input: Uint8Array | string, opts: FaviconOpts): Promise<FaviconResult> {
  if (input === null || input === undefined || input.length === 0) {
    throw new ToolError(
      "empty-input",
      "No image was provided.",
      "Drop a PNG onto the input area or pick one with the file button.",
    );
  }

  if (typeof input === "string") {
    throw new ToolError(
      "not-an-image",
      "This tool needs image bytes, but it received text.",
      "Drop a PNG file onto the input area instead of pasting text.",
    );
  }

  if (!hasPngSignature(input)) {
    throw new ToolError(
      "png-only",
      "That file is not a PNG. The pure logic layer only packs PNG data today, because reading other formats needs a canvas.",
      "Convert the image to PNG first, or use the editor panel once it ships: the panel decodes JPEG, WebP, SVG, and friends before packing.",
    );
  }

  const { width, height } = readPngSize(input);
  const appName = (opts.appName ?? "").trim() || "My App";
  const themeColor = normalizeHexColor(opts.themeColor ?? "#5B4BD6", "Theme color");
  const bgColor = normalizeHexColor(opts.bgColor ?? "#ffffff", "Background color");

  const rows: FaviconResult = {
    Source: `${width} x ${height} PNG, ${formatBytes(input.length)}`,
  };

  const problems: string[] = [];
  if (width !== height) {
    problems.push(
      `the source is ${width} x ${height}, so it is not square and browsers will squash it`,
    );
  }
  if (Math.min(width, height) < 256) {
    problems.push(
      `the source is only ${Math.min(width, height)} pixels on its short side, so the 512 pixel manifest icon would be upscaled`,
    );
  }
  if (problems.length > 0) {
    rows.Warning = `Heads up: ${problems.join(", and ")}. The files below were still generated. For the sharpest result, start from a square PNG of at least 512 by 512.`;
  }

  // The ICO carries the source PNG untouched at its declared size. Proper
  // multi-size rasterization is the canvas panel's job.
  const icoSize = Math.min(256, Math.max(1, Math.min(width, height)));
  const ico = buildIco([{ size: icoSize, png: input }]);

  rows["favicon.ico"] = `data:image/x-icon;base64,${bytesToBase64(ico)}`;
  rows["site.webmanifest"] = buildManifest({
    name: appName,
    shortName: appName,
    themeColor,
    bgColor,
  });
  rows["Link tags"] = buildLinkTags({ themeColor });
  rows["Next step"] =
    "Save the ICO as favicon.ico, the manifest as site.webmanifest, and paste the link tags into your head. The editor panel will resize your source into proper 16, 32, 180, 192, and 512 pixel variants; until it ships, this ICO holds one image and browsers scale it down themselves.";

  return rows;
}

export default { run } satisfies ToolLogic<Uint8Array | string, FaviconResult, FaviconOpts>;
