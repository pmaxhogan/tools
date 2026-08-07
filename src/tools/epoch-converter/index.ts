import { ToolError, type ToolLogic } from '../types';

export interface EpochOpts {
  /** IANA zone name, 'local', or 'UTC'. */
  tz: string;
  [key: string]: unknown;
}

export interface EpochResult {
  [label: string]: string;
}

/** Parse a timestamp: unix seconds, unix millis, ISO 8601, or common date strings. */
function parse(raw: string): Date {
  const s = raw.trim();
  if (!s) throw new ToolError('empty-input', 'Enter a timestamp to convert.');

  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    // Heuristic: |n| >= 1e12 is millis, otherwise seconds. Covers 1973–33658.
    const ms = Math.abs(n) >= 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime()))
      throw new ToolError('out-of-range', `"${s}" is outside the representable date range.`);
    return d;
  }

  const d = new Date(s);
  if (isNaN(d.getTime()))
    throw new ToolError(
      'unparseable-date',
      `Could not parse "${s}" as a date.`,
      'Use a unix timestamp (seconds or milliseconds) or an ISO 8601 date like 2026-08-06T21:00:00Z.'
    );
  return d;
}

function fmt(d: Date, tz: string): EpochResult {
  const zone = tz === 'local' ? undefined : tz;
  const seconds = Math.floor(d.getTime() / 1000);

  let inZone: string;
  try {
    inZone = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(d);
  } catch {
    throw new ToolError(
      'bad-timezone',
      `Unknown time zone "${tz}".`,
      'Use an IANA name like America/Chicago, Europe/Berlin, or UTC.'
    );
  }

  const rel = relative(d);

  return {
    'Unix seconds': String(seconds),
    'Unix milliseconds': String(d.getTime()),
    'ISO 8601 (UTC)': d.toISOString(),
    [tz === 'local' ? 'Local time' : tz]: inZone,
    Relative: rel,
  };
}

function relative(d: Date): string {
  const deltaSec = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, secs] of units) {
    if (abs >= secs || unit === 'second')
      return rtf.format(Math.trunc(deltaSec / secs), unit);
  }
  return 'now';
}

export const run: ToolLogic<string, EpochResult, EpochOpts>['run'] = (input, opts) => {
  const raw = (input ?? '').trim() || String(Math.floor(Date.now() / 1000));
  return fmt(parse(raw), opts.tz || 'UTC');
};

export default { run } satisfies ToolLogic<string, EpochResult, EpochOpts>;
