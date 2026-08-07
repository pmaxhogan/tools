import { ToolError, type ToolLogic } from '../types';

/**
 * Audio Trimmer logic layer.
 *
 * This tool's real work (running ffmpeg.wasm on the dropped file) happens in
 * the browser inside `AudioTrimmerPanel.vue`, which calls `buildTrimArgs`
 * directly with the values the panel already has (a sanitized ffmpeg
 * filesystem name and the probed source duration). This module stays pure:
 * it never touches ffmpeg, the DOM, or file bytes.
 *
 * `run()` below is the generic-shell / curl-API fallback: it plans the same
 * ffmpeg command from the option values alone and reports it as text, for
 * environments (tests, curl, the plain ToolShell) that cannot run ffmpeg.wasm.
 */

export type AudioFormat = 'mp3' | 'm4a' | 'wav' | 'ogg' | 'same';

/* ------------------------------------------------------------------ */
/* time parsing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Parses a trim time spec into seconds. Accepts plain seconds ("12", "12.5"),
 * mm:ss ("1:23", "1:23.5"), and hh:mm:ss.mmm ("01:23:45.678"). Returns null
 * for anything empty or unparseable rather than throwing, so callers can
 * treat "no value entered" and "bad value" differently.
 */
export function parseTimeSpec(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  if (/^\d+(\.\d+)?$/.test(s)) {
    return Number(s);
  }

  const parts = s.split(':');
  if (parts.length !== 2 && parts.length !== 3) return null;

  const lastIndex = parts.length - 1;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === lastIndex;
    const pattern = isLast ? /^\d+(\.\d+)?$/ : /^\d+$/;
    if (!pattern.test(parts[i])) return null;
  }

  const nums = parts.map(Number);
  // Every component except the first (hours, or minutes in mm:ss) rolls over
  // at 60, so a value of 60 or more there is not a valid time.
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] >= 60) return null;
  }

  if (nums.length === 2) {
    const [m, sec] = nums;
    return m * 60 + sec;
  }
  const [h, m, sec] = nums;
  return h * 3600 + m * 60 + sec;
}

/* ------------------------------------------------------------------ */
/* arg building                                                        */
/* ------------------------------------------------------------------ */

export interface TrimArgsInput {
  /** Name of the file inside the ffmpeg filesystem, e.g. "input.mp3". */
  inputName: string;
  startSec: number | null;
  endSec: number | null;
  /**
   * Source clip length in seconds, when known. The panel probes this from
   * the preview `<audio>` element's `duration`. It only matters when a fade
   * out is requested without an explicit end time: without it, ffmpeg has
   * no way to know where "the end" is until the run finishes, and the fade
   * out filter needs that number in advance.
   */
  durationSec: number | null;
  fadeInSec: number;
  fadeOutSec: number;
  normalize: boolean;
  format: AudioFormat;
}

export type TrimArgsResult =
  | { args: string[]; outputs: [string] }
  | { error: string; fix?: string; code: string };

const FORMAT_EXT: Record<Exclude<AudioFormat, 'same'>, string> = {
  mp3: 'mp3',
  m4a: 'm4a',
  wav: 'wav',
  ogg: 'ogg',
};

function codecArgs(format: Exclude<AudioFormat, 'same'>): string[] {
  switch (format) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-q:a', '2'];
    case 'm4a':
      return ['-c:a', 'aac', '-b:a', '192k'];
    case 'wav':
      return ['-c:a', 'pcm_s16le'];
    case 'ogg':
      return ['-c:a', 'libvorbis', '-q:a', '5'];
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Trims trailing float noise (e.g. 8.000000001) without losing precision ffmpeg needs. */
function secStr(n: number): string {
  return Number(n.toFixed(3)).toString();
}

/**
 * Builds the ffmpeg argument list for one trim job, or an error explaining
 * why the requested combination cannot run.
 *
 * Seeking: `-ss` is placed before `-i` so ffmpeg seeks at the demuxer level
 * instead of decoding and discarding from the start of the file. This is
 * fast and, unlike video, carries no keyframe-alignment risk for audio.
 *
 * Trim length: the end of the clip is expressed with `-t` (a duration) as an
 * input option rather than `-to` (an absolute position). `-to` combined with
 * an input-side `-ss` is a well known ffmpeg gotcha: it is not reliably
 * relative to the seek point, so callers who want "ten seconds starting at
 * five seconds in" must compute the duration themselves anyway. Doing that
 * once here and passing `-t` sidesteps the ambiguity entirely.
 *
 * Fades: `afade` filters place their start point (`st=`) on the OUTPUT
 * timeline, which after an input-side `-ss` already starts at zero. So the
 * fade out's start is `duration - fadeOutSec`, computed from the same
 * `duration` used for `-t`, not from the original file's timeline.
 *
 * Stream copy (`format: 'same'`): copying is only valid when no filter is
 * active, since `-c:a copy` cannot run `afade` or `loudnorm` (those need
 * decoded samples). Requesting fades or normalization with `same` is an
 * error rather than a silent re-encode, so the panel can point the visitor
 * at the fix: pick a real output format, or turn the filters off.
 */
export function buildTrimArgs(o: TrimArgsInput): TrimArgsResult {
  const { inputName, startSec, endSec, durationSec, fadeInSec, fadeOutSec, normalize, format } =
    o;

  if (startSec !== null && (!Number.isFinite(startSec) || startSec < 0)) {
    return { error: 'Start time cannot be negative.', code: 'invalid-start' };
  }
  if (endSec !== null && (!Number.isFinite(endSec) || endSec <= 0)) {
    return { error: 'End time must be a positive number of seconds.', code: 'invalid-end' };
  }
  if (!Number.isFinite(fadeInSec) || !Number.isFinite(fadeOutSec) || fadeInSec < 0 || fadeOutSec < 0) {
    return { error: 'Fade lengths cannot be negative.', code: 'invalid-fade' };
  }

  const effectiveStart = startSec ?? 0;
  let effectiveEnd = endSec;
  if (effectiveEnd === null && fadeOutSec > 0) {
    effectiveEnd = durationSec;
  }
  if (effectiveEnd === null && fadeOutSec > 0) {
    return {
      error: 'Fade out needs to know where the clip ends.',
      fix: 'Set an end time, or wait for the audio preview to report the file length.',
      code: 'fadeout-needs-end',
    };
  }

  let duration: number | null = null;
  if (effectiveEnd !== null) {
    duration = effectiveEnd - effectiveStart;
    if (duration <= 0) {
      return {
        error: 'End time must be after the start time.',
        fix: 'Pick an end time later than the start time.',
        code: 'invalid-range',
      };
    }
    if (fadeInSec + fadeOutSec > duration) {
      return {
        error: 'The fades are longer than the trimmed clip.',
        fix: 'Shorten the fade in or fade out, or widen the trim range.',
        code: 'fades-too-long',
      };
    }
  }

  const filters: string[] = [];
  if (fadeInSec > 0) filters.push(`afade=t=in:st=0:d=${secStr(fadeInSec)}`);
  if (fadeOutSec > 0 && duration !== null) {
    filters.push(`afade=t=out:st=${secStr(duration - fadeOutSec)}:d=${secStr(fadeOutSec)}`);
  }
  if (normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');

  let outExt: string;
  if (format === 'same') {
    if (filters.length > 0) {
      return {
        error: 'Stream copy cannot apply fades or normalization.',
        fix: 'Choose an output format other than Same, or turn off fades and normalization.',
        code: 'copy-with-filters',
      };
    }
    const ext = extensionOf(inputName);
    if (!ext) {
      return {
        error: 'The source file has no recognizable audio extension to copy into.',
        fix: 'Pick an output format instead of Same.',
        code: 'copy-unknown-extension',
      };
    }
    outExt = ext;
  } else {
    outExt = FORMAT_EXT[format];
  }

  const outputName = `trimmed.${outExt}`;

  const args: string[] = [];
  if (effectiveStart > 0) args.push('-ss', secStr(effectiveStart));
  if (duration !== null) args.push('-t', secStr(duration));
  args.push('-i', inputName, '-vn');
  if (filters.length) args.push('-af', filters.join(','));
  if (format === 'same') {
    args.push('-c:a', 'copy');
  } else {
    args.push(...codecArgs(format));
  }
  args.push(outputName);

  return { args, outputs: [outputName] };
}

/* ------------------------------------------------------------------ */
/* run() textual fallback                                              */
/* ------------------------------------------------------------------ */

export interface AudioTrimmerOpts {
  start: string;
  end: string;
  fadeIn: number;
  fadeOut: number;
  normalize: boolean;
  format: AudioFormat;
  [key: string]: unknown;
}

function parseOptTime(raw: string, label: string): number | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const parsed = parseTimeSpec(trimmed);
  if (parsed === null) {
    throw new ToolError(
      'invalid-time',
      `"${raw}" is not a valid ${label} time.`,
      'Use seconds like 12.5, mm:ss like 1:23, or hh:mm:ss.mmm like 01:23:45.678.'
    );
  }
  return parsed;
}

/**
 * Textual fallback: plans the ffmpeg command from the option values and
 * reports it, without touching ffmpeg or the input bytes. Tolerant of empty
 * input, since the plan depends only on the options, not on the file itself.
 */
export function run(input: Uint8Array | string, opts: AudioTrimmerOpts): Record<string, string> {
  const startSec = parseOptTime(opts.start, 'start');
  const endSec = parseOptTime(opts.end, 'end');

  const built = buildTrimArgs({
    inputName: 'input.mp3',
    startSec,
    endSec,
    durationSec: null,
    fadeInSec: Number(opts.fadeIn) || 0,
    fadeOutSec: Number(opts.fadeOut) || 0,
    normalize: Boolean(opts.normalize),
    format: opts.format ?? 'same',
  });

  if ('error' in built) {
    throw new ToolError(built.code, built.error, built.fix);
  }

  const hasFile = typeof input === 'string' ? input.trim().length > 0 : input.length > 0;

  return {
    Command: `ffmpeg ${built.args.join(' ')}`,
    'Output file': built.outputs[0],
    Note: hasFile
      ? 'This previews the ffmpeg command. Open the Audio Trimmer tool in a browser to run it on your file.'
      : 'This previews the ffmpeg command for the options above. Pick a file on the tool page to run it.',
  };
}

export default {
  run,
} satisfies ToolLogic<Uint8Array | string, Record<string, string>, AudioTrimmerOpts>;
