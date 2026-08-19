import QRCode from "qrcode";
import { ToolError, type ToolLogic } from "../types";

export interface TerminalQrOpts {
  /** Error correction level: 'L' | 'M' | 'Q' | 'H'. */
  ecc: string;
  /** Print the code on a dark background (glyphs swapped). */
  invert: boolean;
  /** Quiet zone width, in blank print rows/columns on each side. */
  margin: number;
  [key: string]: unknown;
}

const ECC_LEVELS = ["L", "M", "Q", "H"] as const;
type EccLevel = (typeof ECC_LEVELS)[number];

function normaliseEcc(ecc: string): EccLevel {
  const level = (ecc || "M").toUpperCase();
  if (!(ECC_LEVELS as readonly string[]).includes(level))
    throw new ToolError(
      "bad-ecc",
      `Unknown error correction level "${ecc}".`,
      "Use L (7%), M (15%), Q (25%) or H (30%).",
    );
  return level as EccLevel;
}

function normaliseMargin(margin: number): number {
  const m = margin ?? 1;
  if (!Number.isFinite(m) || m < 0 || m > 4)
    throw new ToolError("bad-margin", "Quiet zone must be between 0 and 4.");
  return Math.floor(m);
}

/** Swap each unicode block glyph for its visual inverse (dark <-> light). */
const INVERT_MAP: Record<string, string> = {
  " ": "█", // space -> full block
  "█": " ", // full block -> space
  "▀": "▄", // upper half -> lower half
  "▄": "▀", // lower half -> upper half
};

export function invertBlocks(grid: string): string {
  return grid.replace(/[ █▀▄]/g, (c) => INVERT_MAP[c] ?? c);
}

/**
 * Pad a margin-less unicode-block grid with our own quiet zone.
 *
 * The `qrcode` package's own `margin` option is unusable here: its utf8
 * renderer packs two vertical modules per printed row via half-block glyphs,
 * and computes the number of blank rows as `margin / 2`, which throws
 * `RangeError: Invalid array length` for any odd margin (1, 3, ...) because
 * `Array(1.5)` is not a valid length. We always render with margin 0 and add
 * our own blank rows/columns instead, one print row/column per margin unit
 * (rather than trying to reproduce the module-accurate, bug-prone math).
 */
export function padMargin(grid: string, margin: number): string {
  if (margin <= 0) return grid;
  const lines = grid.split("\n").filter((l) => l.length > 0);
  const width = lines[0]?.length ?? 0;
  const side = " ".repeat(margin);
  const blankRow = " ".repeat(width + margin * 2);
  const padded = lines.map((l) => `${side}${l}${side}`);
  const top = Array.from({ length: margin }, () => blankRow);
  const bottom = Array.from({ length: margin }, () => blankRow);
  return [...top, ...padded, ...bottom].join("\n");
}

export async function run(input: string, opts: TerminalQrOpts): Promise<string> {
  const text = (input ?? "").trim();
  if (!text)
    throw new ToolError(
      "empty-input",
      "Enter text or a URL to encode.",
      "Type something to turn into a QR code.",
    );

  const errorCorrectionLevel = normaliseEcc(opts?.ecc ?? "M");
  const margin = normaliseMargin(opts?.margin ?? 1);

  let raw: string;
  try {
    raw = await QRCode.toString(text, {
      type: "utf8",
      errorCorrectionLevel,
      margin: 0,
    });
  } catch {
    throw new ToolError(
      "too-long",
      "That is too much data for a single QR code.",
      "Shorten the text or lower the error correction level.",
    );
  }

  const padded = padMargin(raw, margin);
  return opts?.invert ? invertBlocks(padded) : padded;
}

export default { run } satisfies ToolLogic<string, string, TerminalQrOpts>;
