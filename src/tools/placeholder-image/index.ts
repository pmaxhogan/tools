import { ToolError, type ToolLogic } from '../types';

export interface PlaceholderOpts {
  width: number;
  height: number;
  background: string;
  foreground: string;
  label: string;
  [key: string]: unknown;
}

export type PlaceholderResult = Record<string, string>;

const MIN_SIZE = 1;
const MAX_SIZE = 4000;
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Validate & normalize a hex color option, naming the bad value on failure. */
function validateHexColor(value: string, fieldLabel: string): string {
  const v = (value ?? '').trim();
  if (!HEX_COLOR_RE.test(v))
    throw new ToolError(
      'invalid-color',
      `"${value}" is not a valid hex color for ${fieldLabel}.`,
      'Use a hex color like #e2e8f0 (6-digit) or #fff (3-digit).'
    );
  return v;
}

/** Validate a size option is an integer within [MIN_SIZE, MAX_SIZE]. */
function validateSize(value: number, fieldLabel: string): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n < MIN_SIZE || n > MAX_SIZE)
    throw new ToolError(
      'invalid-size',
      `${fieldLabel} must be a whole number between ${MIN_SIZE} and ${MAX_SIZE}, got ${value}.`,
      `Choose a ${fieldLabel.toLowerCase()} between ${MIN_SIZE} and ${MAX_SIZE}.`
    );
  return n;
}

/** Escape text for safe placement inside SVG element content. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Build the SVG markup for the placeholder image. */
function buildSvg(width: number, height: number, background: string, foreground: string, label: string): string {
  const fontSize = Math.max(12, Math.round(Math.min(width, height) * 0.1));
  const safeLabel = escapeXml(label);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${safeLabel}">
  <rect width="100%" height="100%" fill="${background}"/>
  <text x="50%" y="50%" fill="${foreground}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize}" text-anchor="middle" dominant-baseline="middle">${safeLabel}</text>
</svg>`;
}

/**
 * Percent-encode an SVG string for use in a `data:image/svg+xml,` URI.
 * Encodes only what's necessary (%, #, <, >, ", and whitespace runs) so the
 * payload stays compact and readable, per the common data-URI-SVG technique.
 */
export function encodeSvgForDataUri(svg: string): string {
  const collapsed = svg.trim().replace(/\s+/g, ' ');
  return collapsed
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/"/g, '%22')
    .replace(/ /g, '%20');
}

export const run: ToolLogic<undefined, PlaceholderResult, PlaceholderOpts>['run'] = (
  _input,
  opts
) => {
  const width = validateSize(opts.width ?? 600, 'Width');
  const height = validateSize(opts.height ?? 400, 'Height');
  const background = validateHexColor(opts.background || '#e2e8f0', 'background');
  const foreground = validateHexColor(opts.foreground || '#64748b', 'foreground');
  const label = (opts.label ?? '').trim() || `${width}×${height}`;

  const svg = buildSvg(width, height, background, foreground, label);
  const dataUri = `data:image/svg+xml,${encodeSvgForDataUri(svg)}`;
  const htmlImg = `<img src="${dataUri}" width="${width}" height="${height}" alt="${escapeXml(label)}" />`;
  const cssBackground = `background-image: url("${dataUri}");`;

  return {
    'SVG markup': svg,
    'Data URI': dataUri,
    'HTML img tag': htmlImg,
    'CSS background': cssBackground,
  };
};

export default { run } satisfies ToolLogic<undefined, PlaceholderResult, PlaceholderOpts>;
