import { ToolError, type ToolLogic } from '../types';

/**
 * Frame Extractor logic.
 *
 * The capture itself belongs to the panel: a video element decodes the file
 * and a canvas reads pixels off it. Everything that can be decided without a
 * decoder lives here, pure and tested: reading a time the user typed, printing
 * a timecode back, naming a saved frame, and planning a burst of capture times
 * against the length of the video.
 */

export interface FrameExtractorOpts {
  /** How many frames a single burst captures. */
  count?: number;
  /** Seconds between burst frames, as typed (a text option, so "0.5" works). */
  interval?: string;
  /** Encoder for saved frames: png, jpeg, or webp. */
  format?: string;
  /** Encoder quality 1 to 100. Ignored by PNG, which is lossless. */
  quality?: number;
  [key: string]: unknown;
}

export type FrameExtractorResult = Record<string, string>;

/** A burst that passed validation: the exact times to seek to, in seconds. */
export interface BurstPlan {
  times: number[];
}

/** A burst that cannot run, phrased for the user. */
export interface BurstError {
  error: string;
  fix?: string;
}

export interface BurstRequest {
  startSec: number;
  count: number;
  intervalSec: number;
  /** Length of the video. Pass Infinity when it is not known yet. */
  durationSec: number;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function pad(value: number, width: number): string {
  return String(Math.trunc(value)).padStart(width, '0');
}

/** Milliseconds are the finest unit this tool ever quotes, so times snap to them. */
function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/* ------------------------------------------------------------------ */
/* time parsing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Read a time the user typed and return seconds, or null when it is not a
 * time at all. Accepted shapes: plain seconds ("12", "12.5"), "mm:ss",
 * "hh:mm:ss", each optionally with a fractional second written with either a
 * dot or a comma ("00:01:12.500", "00:01:12,500").
 *
 * Returns null rather than throwing: callers decide whether an unreadable time
 * is an error (run) or simply an input the field is not finished with (panel).
 */
export function parseTimeSpec(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(',', '.');
  if (!text) return null;

  const parts = text.split(':');
  if (parts.length > 3) return null;

  const values: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const isLast = i === parts.length - 1;
    // Only the seconds field may carry a fraction: "1.5:30" is a typo, not a time.
    const pattern = isLast ? /^\d+(\.\d+)?$/ : /^\d+$/;
    if (!pattern.test(part)) return null;
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    // In a clock style time, everything below the leading field wraps at 60.
    if (i > 0 && value >= 60) return null;
    values.push(value);
  }

  let seconds = 0;
  for (const value of values) seconds = seconds * 60 + value;
  return roundMs(seconds);
}

/**
 * Print seconds as "hh:mm:ss.mmm". With a frame rate, appends the frame index
 * inside that second as "hh:mm:ss.mmm:ff", which is how a player or an editor
 * quotes a position.
 *
 * Rounds to whole milliseconds first, so 59.9996 reads as 00:01:00.000 rather
 * than carrying a 1000 into the milliseconds field.
 */
export function formatTimecode(seconds: number, fps?: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const totalMinutes = (totalSeconds - s) / 60;
  const m = totalMinutes % 60;
  const h = (totalMinutes - m) / 60;

  const base = `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return base;

  // ms is always below 1000, so the frame index can never reach fps itself.
  const frame = Math.floor((ms / 1000) * fps);
  return `${base}:${pad(frame, 2)}`;
}

/* ------------------------------------------------------------------ */
/* file naming                                                         */
/* ------------------------------------------------------------------ */

/** Lowercase, hyphenated, filesystem safe, and never empty. */
function sanitizeBase(name: string): string {
  const withoutExtension = name.replace(/\.[a-z0-9]{1,8}$/i, '');
  const slug = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'video';
}

function sanitizeExtension(ext: string): string {
  const cleaned = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned || 'png';
}

/** "00m12s500", or "01h02m03s400" once the time passes an hour. */
function stampFor(timeSec: number): string {
  const safe = Number.isFinite(timeSec) && timeSec > 0 ? timeSec : 0;
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const totalMinutes = (totalSeconds - s) / 60;
  const m = totalMinutes % 60;
  const h = (totalMinutes - m) / 60;

  const tail = `${pad(m, 2)}m${pad(s, 2)}s${pad(ms, 3)}`;
  return h > 0 ? `${pad(h, 2)}h${tail}` : tail;
}

/**
 * Deterministic name for one saved frame: the video's own name, the exact
 * position it was taken at, and an optional burst index so a burst sorts in
 * capture order. "My Video.mp4" at 12.5 seconds becomes
 * "my-video-00m12s500.png".
 */
export function frameName(videoName: string, timeSec: number, index?: number, ext = 'png'): string {
  const base = sanitizeBase(typeof videoName === 'string' ? videoName : '');
  const stamp = stampFor(timeSec);
  const suffix =
    typeof index === 'number' && Number.isFinite(index) ? `-${pad(Math.max(0, index), 2)}` : '';
  return `${base}-${stamp}${suffix}.${sanitizeExtension(ext)}`;
}

/* ------------------------------------------------------------------ */
/* burst planning                                                      */
/* ------------------------------------------------------------------ */

/** True when a burst result is the failure branch. */
export function isBurstError(result: BurstPlan | BurstError): result is BurstError {
  return 'error' in result;
}

/**
 * Work out the capture times for an evenly spaced burst, or explain why it
 * cannot run. Returns a result rather than throwing, because the panel asks
 * for a plan on every keystroke and an unfinished field is not an exception.
 *
 * A duration of Infinity means the length is not known yet, in which case the
 * end of video checks are skipped and only the shape of the request is judged.
 */
export function planBurst(request: BurstRequest): BurstPlan | BurstError {
  const { startSec, count, intervalSec, durationSec } = request;

  if (!Number.isFinite(startSec) || startSec < 0) {
    return {
      error: 'The start time must be zero or a positive number of seconds.',
      fix: 'Enter a time like 0, 12.5, or 00:00:12.500.',
    };
  }
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
    return {
      error: 'The frame count must be a whole number of at least 1.',
      fix: 'Set the count anywhere from 1 to 30.',
    };
  }
  if (count > 30) {
    return {
      error: 'A single burst captures at most 30 frames.',
      fix: 'Lower the count to 30 or fewer, then run a second burst from where the first ended.',
    };
  }
  // A single frame has nothing to space, so a blank interval is not a problem there.
  if (count > 1 && (!Number.isFinite(intervalSec) || intervalSec <= 0)) {
    return {
      error: 'The interval between burst frames must be greater than zero.',
      fix: 'Try 1 for one frame a second, or 0.5 for two.',
    };
  }

  const knownDuration = Number.isFinite(durationSec) && durationSec > 0;
  if (knownDuration && startSec >= durationSec) {
    return {
      error: 'The start time is at or past the end of the video.',
      fix: `Pick a start time before ${formatTimecode(durationSec)}.`,
    };
  }

  const step = count > 1 ? intervalSec : 0;
  const times: number[] = [];
  for (let i = 0; i < count; i++) times.push(roundMs(startSec + i * step));

  const last = times[times.length - 1]!;
  if (knownDuration && last > durationSec) {
    return {
      error: 'The burst would run past the end of the video.',
      fix: `The video ends at ${formatTimecode(durationSec)}. Lower the frame count or the interval so the last frame lands before that.`,
    };
  }

  return { times };
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const FORMAT_LABELS: Record<string, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
};

const FORMAT_EXTENSIONS: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

function describeInput(input: Uint8Array | string): string {
  if (input instanceof Uint8Array) {
    return `${input.length.toLocaleString('en-US')} bytes of video, which only a media decoder can turn into pictures.`;
  }
  const text = input.trim();
  if (!text) return 'Nothing yet. The panel takes the video, not this field.';
  return `Read as a start time: ${text}`;
}

/**
 * Textual surface for a panel first tool. There is no way to decode a video
 * frame without a decoder, so instead of pretending, this reports what the
 * panel will do with the current options: where the burst lands, what the
 * saved frames will be called, and how to drive the capture.
 */
export function run(
  input: Uint8Array | string,
  opts: FrameExtractorOpts = {},
): FrameExtractorResult {
  const typed = typeof input === 'string' ? input.trim() : '';
  let startSec = 0;
  if (typed) {
    const parsed = parseTimeSpec(typed);
    if (parsed === null) {
      throw new ToolError(
        'invalid-time',
        `"${typed}" is not a time this tool can read.`,
        'Use seconds (12.5), mm:ss (01:12), or hh:mm:ss.mmm (00:01:12.500).',
      );
    }
    startSec = parsed;
  }

  const rawInterval = String(opts.interval ?? '1');
  const intervalSec = parseTimeSpec(rawInterval);
  if (intervalSec === null) {
    throw new ToolError(
      'invalid-interval',
      `"${rawInterval}" is not a readable interval.`,
      'Give the gap between burst frames in seconds, such as 1 or 0.5.',
    );
  }

  const count = Number(opts.count ?? 1);
  const plan = planBurst({
    startSec,
    count,
    intervalSec,
    durationSec: Number.POSITIVE_INFINITY,
  });
  if (isBurstError(plan)) {
    throw new ToolError('invalid-burst', plan.error, plan.fix);
  }

  const format = String(opts.format ?? 'png').toLowerCase();
  const label = FORMAT_LABELS[format] ?? 'PNG';
  const ext = FORMAT_EXTENSIONS[format] ?? 'png';
  const quality = Number(opts.quality ?? 92);
  const multiple = plan.times.length > 1;

  return {
    'How to use':
      'Drop a video onto the panel above, scrub to the moment you want, then press "Capture this frame". Frames land in a strip below the player, each one downloadable on its own.',
    Input: describeInput(input),
    'Start time': formatTimecode(startSec),
    'Burst plan': multiple
      ? `${plan.times.length} frames, ${intervalSec} s apart: ${plan.times.map((t) => formatTimecode(t)).join(', ')}`
      : `1 frame at ${formatTimecode(startSec)}`,
    'File names': plan.times
      .map((t, i) => frameName('video', t, multiple ? i + 1 : undefined, ext))
      .join(', '),
    Format:
      format === 'png'
        ? 'PNG, lossless, so the quality setting is ignored'
        : `${label} at quality ${quality}`,
    Resolution:
      "Every capture is drawn at the video's own pixel size, so a 4K source gives 4K frames.",
    'Seeking precision':
      'Browsers seek to the nearest decodable frame, so a capture can land a few milliseconds either side of the time you asked for.',
  };
}

export default { run } satisfies ToolLogic<
  Uint8Array | string,
  FrameExtractorResult,
  FrameExtractorOpts
>;
