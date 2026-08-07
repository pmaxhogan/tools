import figlet from "figlet";
import Banner from "figlet/importable-fonts/Banner.js";
import Big from "figlet/importable-fonts/Big.js";
import Block from "figlet/importable-fonts/Block.js";
import Doom from "figlet/importable-fonts/Doom.js";
import Ghost from "figlet/importable-fonts/Ghost.js";
import Mini from "figlet/importable-fonts/Mini.js";
import Shadow from "figlet/importable-fonts/Shadow.js";
import Slant from "figlet/importable-fonts/Slant.js";
import Small from "figlet/importable-fonts/Small.js";
import Standard from "figlet/importable-fonts/Standard.js";
import { ToolError, type ToolLogic } from "../types";

/**
 * Fonts are imported as strings and registered with `parseFont` rather than
 * loaded from disk. figlet's filesystem loader only exists in the Node build;
 * the importable-fonts pattern is the one path that works identically in
 * vitest (Node) and in the browser bundle, and it keeps the logic layer pure.
 */
const FONT_DATA: Record<string, string> = {
  Standard,
  Slant,
  Small,
  Big,
  Banner,
  Block,
  Shadow,
  Doom,
  Ghost,
  Mini,
};

/** Registered font names, in menu order. Source of truth for meta + tests. */
export const FONTS: string[] = Object.keys(FONT_DATA);

for (const [name, data] of Object.entries(FONT_DATA)) figlet.parseFont(name, data);

/** figlet's horizontal kerning modes that are worth exposing. */
export const LAYOUTS = ["default", "full", "fitted"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** Long banners wrap into unreadable walls of characters — and cost real CPU. */
export const MAX_LENGTH = 100;

/**
 * Sentinel for the "Maximum width" option: at this value figlet's own
 * line-wrapping is left off entirely, so every rendered row stays a single
 * line (the panel scrolls it horizontally instead of the shell wrapping it,
 * which is what used to slice glyphs in half).
 */
export const MAX_WIDTH_UNLIMITED = 0;

export interface FigletOpts {
  font: string;
  layout: string;
  /** Column budget before figlet wraps to a new banner block. 0 = unlimited. */
  maxWidth?: number;
  [key: string]: unknown;
}

export function run(input: string, opts: FigletOpts): string {
  const text = input ?? "";

  if (!text.trim())
    throw new ToolError(
      "empty-input",
      "Enter some text to render as a banner.",
      'Type a word or short phrase, for example "hello".',
    );

  if (text.length > MAX_LENGTH)
    throw new ToolError(
      "input-too-long",
      `Input is ${text.length} characters; the limit is ${MAX_LENGTH}.`,
      "Banner fonts are several characters tall: shorten the text to a headline-length phrase.",
    );

  const font = opts?.font || "Standard";
  if (!Object.prototype.hasOwnProperty.call(FONT_DATA, font))
    throw new ToolError(
      "unknown-font",
      `"${font}" is not one of the available fonts.`,
      `Pick one of: ${FONTS.join(", ")}.`,
    );

  const requested = opts?.layout || "default";
  if (!(LAYOUTS as readonly string[]).includes(requested))
    throw new ToolError(
      "unknown-layout",
      `"${requested}" is not a valid horizontal layout.`,
      `Use one of: ${LAYOUTS.join(", ")}.`,
    );

  const maxWidthRaw = opts?.maxWidth;
  const maxWidth =
    typeof maxWidthRaw === "number" && Number.isFinite(maxWidthRaw)
      ? maxWidthRaw
      : MAX_WIDTH_UNLIMITED;
  if (maxWidth < MAX_WIDTH_UNLIMITED)
    throw new ToolError(
      "invalid-max-width",
      "Maximum width cannot be negative.",
      "Use 0 for unlimited width, or a positive number of columns to wrap at.",
    );

  // Not trimmed: leading/trailing spaces are legitimate banner padding.
  // At the unlimited sentinel, `width` is left unset so figlet never wraps: a
  // banner stays exactly one line per row, however wide, and the panel scrolls
  // it horizontally instead. A set width is handed straight to figlet, whose
  // own wrapper only ever breaks between whole rendered characters (it flushes
  // the accumulated line before appending one that would overflow), so a
  // glyph is never split down the middle.
  return figlet.textSync(text, {
    font,
    horizontalLayout: requested as Layout,
    ...(maxWidth > MAX_WIDTH_UNLIMITED ? { width: maxWidth } : {}),
  });
}

export default { run } satisfies ToolLogic<string, string, FigletOpts>;
