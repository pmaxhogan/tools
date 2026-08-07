import figlet from 'figlet';
import Banner from 'figlet/importable-fonts/Banner.js';
import Big from 'figlet/importable-fonts/Big.js';
import Block from 'figlet/importable-fonts/Block.js';
import Doom from 'figlet/importable-fonts/Doom.js';
import Ghost from 'figlet/importable-fonts/Ghost.js';
import Mini from 'figlet/importable-fonts/Mini.js';
import Shadow from 'figlet/importable-fonts/Shadow.js';
import Slant from 'figlet/importable-fonts/Slant.js';
import Small from 'figlet/importable-fonts/Small.js';
import Standard from 'figlet/importable-fonts/Standard.js';
import { ToolError, type ToolLogic } from '../types';

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
export const LAYOUTS = ['default', 'full', 'fitted'] as const;
export type Layout = (typeof LAYOUTS)[number];

/** Long banners wrap into unreadable walls of characters — and cost real CPU. */
export const MAX_LENGTH = 100;

export interface FigletOpts {
  font: string;
  layout: string;
  [key: string]: unknown;
}

export const run: ToolLogic<string, string, FigletOpts>['run'] = (input, opts) => {
  const text = input ?? '';

  if (!text.trim())
    throw new ToolError(
      'empty-input',
      'Enter some text to render as a banner.',
      'Type a word or short phrase, for example "hello".',
    );

  if (text.length > MAX_LENGTH)
    throw new ToolError(
      'input-too-long',
      `Input is ${text.length} characters; the limit is ${MAX_LENGTH}.`,
      'Banner fonts are several characters tall — shorten the text to a headline-length phrase.',
    );

  const font = opts?.font || 'Standard';
  if (!Object.prototype.hasOwnProperty.call(FONT_DATA, font))
    throw new ToolError(
      'unknown-font',
      `"${font}" is not one of the available fonts.`,
      `Pick one of: ${FONTS.join(', ')}.`,
    );

  const requested = opts?.layout || 'default';
  if (!(LAYOUTS as readonly string[]).includes(requested))
    throw new ToolError(
      'unknown-layout',
      `"${requested}" is not a valid horizontal layout.`,
      `Use one of: ${LAYOUTS.join(', ')}.`,
    );

  // Not trimmed: leading/trailing spaces are legitimate banner padding.
  return figlet.textSync(text, {
    font,
    horizontalLayout: requested as Layout,
  });
};

export default { run } satisfies ToolLogic<string, string, FigletOpts>;
