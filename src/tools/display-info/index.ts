import { ToolError, type ToolLogic } from '../types';

/**
 * One physical or virtual display, as reported by the Screen Details API
 * (window.getScreenDetails()) when the panel has permission, or a
 * single-entry fallback built from window.screen otherwise.
 */
export interface ScreenSummary {
  width: number;
  height: number;
  left: number;
  top: number;
  isPrimary?: boolean;
  isInternal?: boolean;
  label?: string;
}

export interface DisplayMediaFeatures {
  colorGamut?: 'srgb' | 'p3' | 'rec2020' | null;
  dynamicRange?: 'standard' | 'high' | null;
  prefersColorScheme?: 'light' | 'dark' | null;
  prefersContrast?: 'no-preference' | 'more' | 'less' | 'custom' | null;
  prefersReducedMotion?: boolean | null;
  pointer?: 'none' | 'coarse' | 'fine' | null;
  anyPointer?: 'none' | 'coarse' | 'fine' | null;
  hover?: 'none' | 'hover' | null;
  anyHover?: 'none' | 'hover' | null;
}

export interface DisplayHardwareInfo {
  hardwareConcurrency?: number | null;
  deviceMemory?: number | null;
}

export interface DisplayNetworkInfo {
  effectiveType?: string | null;
  downlinkMbps?: number | null;
  rttMs?: number | null;
  saveData?: boolean | null;
}

/**
 * The full snapshot the panel assembles from live browser APIs before
 * serializing it to JSON and calling run(). Every field the panel could not
 * read (unsupported API, permission not granted) is null/undefined rather
 * than omitted, so the formatters below can render an honest "not
 * supported" row instead of a missing one.
 */
export interface DisplaySnapshot {
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
  };
  window: {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
  };
  orientation?: { type?: string | null; angle?: number | null } | null;
  media: DisplayMediaFeatures;
  hardware?: DisplayHardwareInfo | null;
  network?: DisplayNetworkInfo | null;
  refreshRateHz?: number | null;
  screens?: ScreenSummary[] | null;
}

export interface DisplayInfoOpts {
  [key: string]: unknown;
}

export type DisplayInfoResult = Record<string, string>;

const NOT_SUPPORTED = 'Not supported in this browser';

const INVALID_SNAPSHOT_FIX =
  'This panel builds the snapshot automatically from live screen and browser APIs. If pasting one by hand, it must be an object shaped like {"screen":{"width":1920,"height":1080,"availWidth":1920,"availHeight":1040,"colorDepth":24},"window":{"innerWidth":1200,"innerHeight":900,"devicePixelRatio":1},"media":{}}.';

/* ------------------------------------------------------------------ *
 * parsing / validation
 * ------------------------------------------------------------------ */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseSnapshot(raw: string): DisplaySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError('invalid-snapshot', 'The input is not valid JSON.', INVALID_SNAPSHOT_FIX);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolError(
      'invalid-snapshot',
      'The JSON is not a display snapshot object.',
      INVALID_SNAPSHOT_FIX,
    );
  }

  const obj = parsed as Record<string, unknown>;
  const screen = obj.screen as Record<string, unknown> | undefined;
  const win = obj.window as Record<string, unknown> | undefined;

  if (
    !screen ||
    !isFiniteNumber(screen.width) ||
    !isFiniteNumber(screen.height) ||
    !win ||
    !isFiniteNumber(win.innerWidth) ||
    !isFiniteNumber(win.innerHeight)
  ) {
    throw new ToolError(
      'invalid-snapshot',
      'The snapshot is missing required screen or window dimensions.',
      INVALID_SNAPSHOT_FIX,
    );
  }

  return obj as unknown as DisplaySnapshot;
}

/* ------------------------------------------------------------------ *
 * formatting helpers (each independently pure and testable)
 * ------------------------------------------------------------------ */

const COMMON_ASPECT_RATIOS: { name: string; value: number }[] = [
  { name: '1:1', value: 1 },
  { name: '5:4', value: 5 / 4 },
  { name: '4:3', value: 4 / 3 },
  { name: '3:2', value: 3 / 2 },
  { name: '16:10', value: 16 / 10 },
  { name: '16:9', value: 16 / 9 },
  { name: '21:9', value: 21 / 9 },
  { name: '32:9', value: 32 / 9 },
  { name: '4:5', value: 4 / 5 },
  { name: '3:4', value: 3 / 4 },
  { name: '2:3', value: 2 / 3 },
  { name: '10:16', value: 10 / 16 },
  { name: '9:16', value: 9 / 16 },
  { name: '9:21', value: 9 / 21 },
];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Reduces width:height to a common named ratio (16:9, 21:9, ...) when it is
 * within a small tolerance, otherwise a reduced integer fraction plus decimal. */
export function computeAspectRatio(width: number, height: number): string {
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    return 'Unknown';
  }
  const ratio = width / height;
  const match = COMMON_ASPECT_RATIOS.find((r) => Math.abs(r.value - ratio) < 0.015);
  if (match) return match.name;

  const w = Math.round(width);
  const h = Math.round(height);
  const divisor = gcd(w, h) || 1;
  return `${w / divisor}:${h / divisor} (${ratio.toFixed(2)}:1)`;
}

function trimZeros(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Labels a devicePixelRatio with a plain-language density class. */
export function classifyPixelDensity(dpr: number): string {
  if (!isFiniteNumber(dpr) || dpr <= 0) return 'Unknown';
  const label = trimZeros(dpr);
  if (dpr <= 1) return `${label}x, standard density`;
  if (dpr === 2) return `${label}x, Retina / HiDPI`;
  if (Number.isInteger(dpr)) return `${label}x, HiDPI`;
  return `${label}x, fractional scaling (HiDPI)`;
}

/** Multiplies the CSS resolution by the pixel ratio to get real device pixels. */
export function physicalResolution(width: number, height: number, dpr: number): string {
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || !isFiniteNumber(dpr) || dpr <= 0) {
    return 'Unknown';
  }
  return `${Math.round(width * dpr)} x ${Math.round(height * dpr)} px`;
}

const COMMON_REFRESH_RATES = [30, 60, 75, 90, 120, 144, 165, 180, 240, 360];

/** Snaps a rAF-measured refresh rate to the nearest common panel rate when close. */
export function formatRefreshRate(hz: number | null | undefined): string {
  if (!isFiniteNumber(hz) || hz <= 0) return 'Not measured yet';
  const nearest = COMMON_REFRESH_RATES.reduce((best, candidate) =>
    Math.abs(candidate - hz) < Math.abs(best - hz) ? candidate : best,
  );
  const snapped = Math.abs(nearest - hz) <= 2 ? nearest : Math.round(hz);
  const suffix = snapped >= 90 ? ' (high refresh rate)' : '';
  return `~${snapped} Hz${suffix}`;
}

export function describeColorGamut(gamut: string | null | undefined): string {
  switch (gamut) {
    case 'rec2020':
      return 'Rec. 2020, ultra-wide gamut';
    case 'p3':
      return 'Display P3, wide gamut';
    case 'srgb':
      return 'sRGB, standard gamut';
    default:
      return NOT_SUPPORTED;
  }
}

export function describeDynamicRange(range: string | null | undefined): string {
  if (range === 'high') return 'High dynamic range (HDR) capable';
  if (range === 'standard') return 'Standard dynamic range (SDR)';
  return NOT_SUPPORTED;
}

export function describeColorScheme(scheme: string | null | undefined): string {
  if (scheme === 'dark') return 'Dark';
  if (scheme === 'light') return 'Light';
  return NOT_SUPPORTED;
}

export function describeContrastPreference(pref: string | null | undefined): string {
  switch (pref) {
    case 'more':
      return 'More contrast requested';
    case 'less':
      return 'Less contrast requested';
    case 'custom':
      return 'Custom contrast preference';
    case 'no-preference':
      return 'No preference';
    default:
      return NOT_SUPPORTED;
  }
}

export function describeMotionPreference(reduced: boolean | null | undefined): string {
  if (reduced === true) return 'Reduced motion requested';
  if (reduced === false) return 'No preference, animations allowed';
  return NOT_SUPPORTED;
}

export function describePointerAccuracy(pointer: string | null | undefined): string {
  switch (pointer) {
    case 'fine':
      return 'Fine pointer (mouse, trackpad, or stylus)';
    case 'coarse':
      return 'Coarse pointer (touch)';
    case 'none':
      return 'No pointing device';
    default:
      return NOT_SUPPORTED;
  }
}

export function describeHoverCapability(hover: string | null | undefined): string {
  switch (hover) {
    case 'hover':
      return 'Can hover';
    case 'none':
      return 'Cannot hover (touch only)';
    default:
      return NOT_SUPPORTED;
  }
}

export function formatHardwareConcurrency(cores: number | null | undefined): string {
  if (!isFiniteNumber(cores) || cores <= 0) return NOT_SUPPORTED;
  return `${cores} logical ${cores === 1 ? 'core' : 'cores'}`;
}

export function formatDeviceMemory(gb: number | null | undefined): string {
  if (!isFiniteNumber(gb) || gb <= 0) return `${NOT_SUPPORTED} (Chromium only)`;
  return `~${gb} GB (approximate, capped by the browser)`;
}

const CONNECTION_TYPE_LABELS: Record<string, string> = {
  'slow-2g': 'Slow 2G',
  '2g': '2G',
  '3g': '3G',
  '4g': '4G or better',
};

export function describeConnectionType(effectiveType: string | null | undefined): string {
  if (!effectiveType) return NOT_SUPPORTED;
  return CONNECTION_TYPE_LABELS[effectiveType] ?? effectiveType;
}

export function formatDownlink(mbps: number | null | undefined): string {
  if (!isFiniteNumber(mbps) || mbps < 0) return NOT_SUPPORTED;
  return `~${mbps} Mbps (rounded estimate)`;
}

export function formatRoundTripTime(ms: number | null | undefined): string {
  if (!isFiniteNumber(ms) || ms < 0) return NOT_SUPPORTED;
  return `~${ms} ms`;
}

export function describeSaveData(saveData: boolean | null | undefined): string {
  if (typeof saveData !== 'boolean') return NOT_SUPPORTED;
  return saveData ? 'Enabled, user requested reduced data usage' : 'Disabled';
}

const ORIENTATION_LABELS: Record<string, string> = {
  'landscape-primary': 'Landscape (primary)',
  'landscape-secondary': 'Landscape (secondary, rotated)',
  'portrait-primary': 'Portrait (primary)',
  'portrait-secondary': 'Portrait (secondary, rotated)',
};

export function describeOrientation(
  type: string | null | undefined,
  angle: number | null | undefined,
): string {
  if (!type) return NOT_SUPPORTED;
  const label = ORIENTATION_LABELS[type] ?? type;
  const angleStr = isFiniteNumber(angle) ? `, ${angle} deg rotation` : '';
  return `${label}${angleStr}`;
}

/** Summarizes the Screen Details API layout, or explains why it is absent. */
export function describeMultiMonitor(screens: ScreenSummary[] | null | undefined): string {
  if (!screens || screens.length === 0) {
    return `${NOT_SUPPORTED}, or permission was not granted (Screen Details API)`;
  }
  if (screens.length === 1) {
    const s = screens[0]!;
    return `1 display detected: ${s.width} x ${s.height} at (${s.left}, ${s.top})`;
  }
  const parts = screens.map((s, i) => {
    const primary = s.isPrimary ? ', primary' : '';
    return `#${i + 1} ${s.width} x ${s.height} at (${s.left}, ${s.top})${primary}`;
  });
  return `${screens.length} displays detected: ${parts.join('; ')}`;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function run(input: string, _opts: DisplayInfoOpts): DisplayInfoResult {
  const raw = input ?? '';
  if (!raw.trim()) {
    throw new ToolError(
      'empty-input',
      'No display snapshot to describe.',
      'This panel reads live screen and browser data automatically. Reload the page if nothing appeared.',
    );
  }

  const snapshot = parseSnapshot(raw);
  const { screen, window: win, media, orientation, hardware, network } = snapshot;

  const out: Record<string, string> = {};

  out['Screen resolution'] = `${screen.width} x ${screen.height} px`;
  out['Available screen area'] = `${screen.availWidth} x ${screen.availHeight} px`;
  out['Window size'] = `${win.innerWidth} x ${win.innerHeight} px`;
  out['Device pixel ratio'] = classifyPixelDensity(win.devicePixelRatio);
  out['Physical pixel resolution'] = physicalResolution(
    screen.width,
    screen.height,
    win.devicePixelRatio,
  );
  out['Aspect ratio'] = computeAspectRatio(screen.width, screen.height);
  out['Color depth'] = isFiniteNumber(screen.colorDepth) ? `${screen.colorDepth}-bit` : NOT_SUPPORTED;
  out['Orientation'] = describeOrientation(orientation?.type, orientation?.angle);
  out['Refresh rate'] = formatRefreshRate(snapshot.refreshRateHz);
  out['Color gamut'] = describeColorGamut(media.colorGamut);
  out['Dynamic range (HDR)'] = describeDynamicRange(media.dynamicRange);
  out['Prefers color scheme'] = describeColorScheme(media.prefersColorScheme);
  out['Prefers contrast'] = describeContrastPreference(media.prefersContrast);
  out['Prefers reduced motion'] = describeMotionPreference(media.prefersReducedMotion);
  out['Pointer, primary input'] = describePointerAccuracy(media.pointer);
  out['Pointer, any input'] = describePointerAccuracy(media.anyPointer);
  out['Hover, primary input'] = describeHoverCapability(media.hover);
  out['Hover, any input'] = describeHoverCapability(media.anyHover);
  out['CPU logical cores'] = formatHardwareConcurrency(hardware?.hardwareConcurrency);
  out['Device memory'] = formatDeviceMemory(hardware?.deviceMemory);
  out['Network type'] = describeConnectionType(network?.effectiveType);
  out['Network downlink'] = formatDownlink(network?.downlinkMbps);
  out['Network round trip time'] = formatRoundTripTime(network?.rttMs);
  out['Data saver'] = describeSaveData(network?.saveData);
  out['Connected displays'] = describeMultiMonitor(snapshot.screens);

  return out;
}

export default { run } satisfies ToolLogic<string, DisplayInfoResult, DisplayInfoOpts>;
