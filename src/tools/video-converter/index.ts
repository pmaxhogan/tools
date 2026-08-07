/**
 * A/V Converter: plans ffmpeg commands for converting video and audio.
 *
 * The logic layer never runs ffmpeg. It turns a target format, a quality tier
 * and a couple of switches into an exact argument list plus an output file
 * name, which is what `MediaShell` needs and what makes every decision here
 * testable in Node.
 *
 * Codec availability is fixed by the single thread @ffmpeg/core 0.12.10 build,
 * which is configured with libx264, libx265, libvpx, libmp3lame, libvorbis,
 * libopus, libtheora, libwebp and zlib, on top of the native encoders (aac,
 * flac, pcm and gif). Only codecs from that list are offered.
 *
 * Quality tiers, per target:
 *
 *   mp4   libx264 + aac    high: crf 18, preset medium,   audio 192k
 *                          balanced: crf 23, veryfast,    audio 128k
 *                          small: crf 30, veryfast,       audio 96k
 *                          always yuv420p (players reject other pixel
 *                          formats in mp4) and +faststart so the file starts
 *                          playing before it has finished downloading
 *   webm  libvpx VP8       high: crf 10, cap 2M, deadline good, cpu-used 1
 *          + libvorbis     balanced: crf 23, cap 1M, good, cpu-used 4
 *                          small: crf 33, cap 500k, realtime, cpu-used 8
 *                          VP8 has no true constant quality mode, so each
 *                          tier pairs a crf with a bitrate cap. Vorbis
 *                          quality runs 6, 4, 2.
 *   mkv   stream copy      no re-encoding at all, so the quality tier does
 *                          nothing and the run finishes in seconds
 *   gif   palette          high: 15 fps, 640 px wide
 *                          balanced: 12 fps, 480 px
 *                          small: 10 fps, 320 px
 *                          one pass: the clip is split, one branch builds the
 *                          palette and the other applies it
 *   mp3   libmp3lame       320k, 192k, 128k
 *   m4a   aac              256k, 160k, 96k (same container family as mp4)
 *   wav   pcm_s16le        uncompressed, so the quality tier does nothing
 *   ogg   libvorbis        quality 7, 5, 3
 *   flac  flac             compression level 5, 8, 12. All three are lossless
 *                          and decode to identical audio: a higher level just
 *                          spends longer making the file smaller.
 *
 * Widths are clamped with min(width, iw) so a small source is never upscaled.
 * Subtitle streams are dropped from mp4 and webm output.
 */
import { ToolError, type ToolLogic } from '../types';

/* ------------------------------------------------------------------ */
/* formats                                                             */
/* ------------------------------------------------------------------ */

export type TargetId = 'mp4' | 'webm' | 'mkv' | 'gif' | 'mp3' | 'm4a' | 'wav' | 'ogg' | 'flac';
export type QualityId = 'high' | 'balanced' | 'small';

export interface FormatSpec {
  /** Display name used in the picker and in the preview rows. */
  label: string;
  /** Output file extension, which is also how ffmpeg picks the muxer. */
  ext: string;
  /** Video targets carry a picture, audio targets never do. */
  kind: 'video' | 'audio';
  /** Codec summary, honest about what the wasm build actually encodes. */
  codecs: string;
  /** One line the panel and the preview can show about this target. */
  note: string;
  /** False when the tier changes nothing, so the UI can say so. */
  qualityApplies: boolean;
}

export const FORMATS: Record<TargetId, FormatSpec> = {
  mp4: {
    label: 'MP4',
    ext: 'mp4',
    kind: 'video',
    codecs: 'H.264 video (libx264), AAC audio',
    note: 'The safe default: every browser, phone, TV and editor plays it.',
    qualityApplies: true,
  },
  webm: {
    label: 'WebM',
    ext: 'webm',
    kind: 'video',
    codecs: 'VP8 video (libvpx), Vorbis audio',
    note: 'Royalty free and good for the web. This tool encodes VP8 rather than VP9 because VP9 in WebAssembly is several times slower for a small size win.',
    qualityApplies: true,
  },
  mkv: {
    label: 'MKV (remux, no re-encode)',
    ext: 'mkv',
    kind: 'video',
    codecs: 'copies the existing video and audio streams',
    note: 'Rewraps the main video and audio streams into Matroska without touching a single frame, so it is fast and lossless. The quality setting does nothing here.',
    qualityApplies: false,
  },
  gif: {
    label: 'GIF',
    ext: 'gif',
    kind: 'video',
    codecs: 'GIF with a generated colour palette',
    note: 'Builds a palette from the clip in the same pass. Keep it short: GIF stores whole frames, so a few seconds is already megabytes.',
    qualityApplies: true,
  },
  mp3: {
    label: 'MP3',
    ext: 'mp3',
    kind: 'audio',
    codecs: 'MP3 audio (libmp3lame)',
    note: 'Plays on everything, including hardware old enough to vote.',
    qualityApplies: true,
  },
  m4a: {
    label: 'M4A',
    ext: 'm4a',
    kind: 'audio',
    codecs: 'AAC audio in an MP4 container',
    note: 'Better sound than MP3 at the same bitrate, and the format Apple devices prefer.',
    qualityApplies: true,
  },
  wav: {
    label: 'WAV',
    ext: 'wav',
    kind: 'audio',
    codecs: '16 bit PCM audio (pcm_s16le)',
    note: 'Uncompressed and lossless, which also means large. The quality setting does nothing here.',
    qualityApplies: false,
  },
  ogg: {
    label: 'OGG',
    ext: 'ogg',
    kind: 'audio',
    codecs: 'Vorbis audio (libvorbis)',
    note: 'Royalty free, smaller than MP3 at the same perceived quality.',
    qualityApplies: true,
  },
  flac: {
    label: 'FLAC',
    ext: 'flac',
    kind: 'audio',
    codecs: 'FLAC lossless audio',
    note: 'Lossless compression, roughly half the size of WAV. Every tier decodes to identical audio.',
    qualityApplies: true,
  },
};

export const TARGET_IDS = Object.keys(FORMATS) as TargetId[];
export const QUALITY_IDS: QualityId[] = ['high', 'balanced', 'small'];

/** Extensions treated as audio-only sources when guessing what was dropped. */
const AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'aac',
  'flac',
  'opus',
  'wma',
  'aiff',
  'aif',
  'caf',
  'amr',
  'mka',
];

/** Placeholder used by the textual preview when no real file name is known. */
export const DEFAULT_INPUT_NAME = 'clip.mov';

/* ------------------------------------------------------------------ */
/* quality tables                                                      */
/* ------------------------------------------------------------------ */

const MP4_TIERS: Record<QualityId, { crf: string; preset: string; audio: string }> = {
  high: { crf: '18', preset: 'medium', audio: '192k' },
  balanced: { crf: '23', preset: 'veryfast', audio: '128k' },
  small: { crf: '30', preset: 'veryfast', audio: '96k' },
};

const WEBM_TIERS: Record<
  QualityId,
  { crf: string; bitrate: string; deadline: string; cpuUsed: string; vorbis: string }
> = {
  high: { crf: '10', bitrate: '2M', deadline: 'good', cpuUsed: '1', vorbis: '6' },
  balanced: { crf: '23', bitrate: '1M', deadline: 'good', cpuUsed: '4', vorbis: '4' },
  small: { crf: '33', bitrate: '500k', deadline: 'realtime', cpuUsed: '8', vorbis: '2' },
};

const GIF_TIERS: Record<QualityId, { fps: string; width: string }> = {
  high: { fps: '15', width: '640' },
  balanced: { fps: '12', width: '480' },
  small: { fps: '10', width: '320' },
};

const MP3_TIERS: Record<QualityId, string> = { high: '320k', balanced: '192k', small: '128k' };
const M4A_TIERS: Record<QualityId, string> = { high: '256k', balanced: '160k', small: '96k' };
const OGG_TIERS: Record<QualityId, string> = { high: '7', balanced: '5', small: '3' };
const FLAC_TIERS: Record<QualityId, string> = { high: '5', balanced: '8', small: '12' };

/** Plain English summary of what a tier does for one target. */
export function describeQuality(target: TargetId, quality: QualityId): string {
  switch (target) {
    case 'mp4': {
      const t = MP4_TIERS[quality];
      return `CRF ${t.crf}, ${t.preset} preset, ${t.audio} audio`;
    }
    case 'webm': {
      const t = WEBM_TIERS[quality];
      return `CRF ${t.crf} capped at ${t.bitrate}, ${t.deadline} deadline, Vorbis quality ${t.vorbis}`;
    }
    case 'mkv':
      return 'not used: the streams are copied, not re-encoded';
    case 'gif': {
      const t = GIF_TIERS[quality];
      return `${t.fps} fps, up to ${t.width} px wide`;
    }
    case 'mp3':
      return `${MP3_TIERS[quality]} MP3`;
    case 'm4a':
      return `${M4A_TIERS[quality]} AAC`;
    case 'wav':
      return 'not used: 16 bit PCM is uncompressed';
    case 'ogg':
      return `Vorbis quality ${OGG_TIERS[quality]}`;
    case 'flac':
      return `compression level ${FLAC_TIERS[quality]}, lossless either way`;
  }
}

/* ------------------------------------------------------------------ */
/* names                                                               */
/* ------------------------------------------------------------------ */

/** Strips any directory part, leaving the file name. */
function baseNameOf(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return cut >= 0 ? name.slice(cut + 1) : name;
}

/** True when the extension says this is an audio file with no picture in it. */
export function looksLikeAudio(name: string): boolean {
  const base = baseNameOf((name ?? '').trim()).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return AUDIO_EXTENSIONS.includes(base.slice(dot + 1));
}

/**
 * Swaps the extension for the target's own. The ffmpeg filesystem is flat and
 * already holds the input, so a name that would collide with it (converting
 * an mp4 to an mp4 at a different quality) gains a "-converted" suffix.
 */
export function outputNameFor(inputName: string, target: TargetId): string {
  const spec = FORMATS[target];
  if (!spec) {
    throw new ToolError(
      'unknown-target',
      `"${String(target)}" is not a format this converter can write.`,
      `Pick one of: ${TARGET_IDS.join(', ')}.`
    );
  }
  const base = baseNameOf((inputName ?? '').trim());
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const safe =
    stem
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|-+$/g, '')
      .slice(0, 60) || 'output';
  const name = `${safe}.${spec.ext}`;
  return name.toLowerCase() === base.toLowerCase() ? `${safe}-converted.${spec.ext}` : name;
}

/* ------------------------------------------------------------------ */
/* argument builder                                                    */
/* ------------------------------------------------------------------ */

export interface ConvertOptions {
  /** Name of the input inside the ffmpeg filesystem, e.g. "holiday.mov". */
  inputName: string;
  target: TargetId;
  quality?: QualityId;
  /** Drop the audio track. Ignored for audio targets, which are all audio. */
  stripAudio?: boolean;
  /** Drop the picture. Implied by every audio target, so it only ever adds
   *  clarity at the call site. Ignored for video targets. */
  audioOnly?: boolean;
}

export interface ConvertPlan {
  args: string[];
  outputs: [string];
}

function normalizeTarget(value: unknown): TargetId {
  if (value === undefined || value === null || value === '') return 'mp4';
  const key = String(value).toLowerCase();
  if ((TARGET_IDS as string[]).includes(key)) return key as TargetId;
  throw new ToolError(
    'unknown-target',
    `"${String(value)}" is not a format this converter can write.`,
    `Pick one of: ${TARGET_IDS.join(', ')}.`
  );
}

function normalizeQuality(value: unknown): QualityId {
  if (value === undefined || value === null || value === '') return 'balanced';
  const key = String(value).toLowerCase();
  if ((QUALITY_IDS as string[]).includes(key)) return key as QualityId;
  throw new ToolError(
    'unknown-quality',
    `"${String(value)}" is not a quality setting.`,
    'Pick high, balanced or small.'
  );
}

/**
 * Turns one set of choices into the exact ffmpeg argument list. Pure: the
 * same options always produce the same array, which is what the tests assert.
 */
export function buildConvertArgs(options: ConvertOptions): ConvertPlan {
  const target = normalizeTarget(options.target);
  const quality = normalizeQuality(options.quality);

  const inputName = (options.inputName ?? '').trim();
  if (!inputName) {
    throw new ToolError(
      'missing-input',
      'No input file was given to convert.',
      'Drop a video or audio file on the panel, then press Convert.'
    );
  }

  const outputName = outputNameFor(inputName, target);
  const args = ['-i', inputName];
  const stripAudio = options.stripAudio === true;

  switch (target) {
    case 'mp4': {
      const tier = MP4_TIERS[quality];
      args.push('-c:v', 'libx264', '-preset', tier.preset, '-crf', tier.crf);
      args.push('-pix_fmt', 'yuv420p');
      if (stripAudio) args.push('-an');
      else args.push('-c:a', 'aac', '-b:a', tier.audio);
      args.push('-sn', '-movflags', '+faststart');
      break;
    }
    case 'webm': {
      const tier = WEBM_TIERS[quality];
      args.push('-c:v', 'libvpx', '-crf', tier.crf, '-b:v', tier.bitrate);
      args.push('-deadline', tier.deadline, '-cpu-used', tier.cpuUsed);
      if (stripAudio) args.push('-an');
      else args.push('-c:a', 'libvorbis', '-q:a', tier.vorbis);
      args.push('-sn');
      break;
    }
    case 'mkv': {
      args.push('-c', 'copy');
      if (stripAudio) args.push('-an');
      break;
    }
    case 'gif': {
      const tier = GIF_TIERS[quality];
      // One pass: split the stream, build a palette from one branch and apply
      // it to the other. Two passes give a slightly better palette; this is
      // the fast path, and the dedicated GIF tool does the fancy version.
      args.push(
        '-filter_complex',
        `[0:v]fps=${tier.fps},scale='min(${tier.width},iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`
      );
      args.push('-loop', '0', '-an');
      break;
    }
    case 'mp3': {
      args.push('-vn', '-c:a', 'libmp3lame', '-b:a', MP3_TIERS[quality]);
      break;
    }
    case 'm4a': {
      args.push('-vn', '-c:a', 'aac', '-b:a', M4A_TIERS[quality]);
      break;
    }
    case 'wav': {
      args.push('-vn', '-c:a', 'pcm_s16le');
      break;
    }
    case 'ogg': {
      args.push('-vn', '-c:a', 'libvorbis', '-q:a', OGG_TIERS[quality]);
      break;
    }
    case 'flac': {
      args.push('-vn', '-c:a', 'flac', '-compression_level', FLAC_TIERS[quality]);
      break;
    }
  }

  args.push(outputName);
  return { args, outputs: [outputName] };
}

/** Renders an argument list as a command line, quoting anything with spaces. */
export function formatCommand(args: string[]): string {
  const rendered = args.map((arg) =>
    /^[A-Za-z0-9._:/=+,-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`
  );
  return ['ffmpeg', ...rendered].join(' ');
}

/* ------------------------------------------------------------------ */
/* run: the textual preview                                            */
/* ------------------------------------------------------------------ */

export interface ConvertRunOptions {
  target?: string;
  quality?: string;
  stripAudio?: boolean;
}

/**
 * Reads a file name out of whatever the shell handed over. Bytes carry no
 * name, JSON may carry one under a few common keys, and a single line of text
 * that looks like a file name is taken at face value.
 */
function resolveInputName(input: Uint8Array | string): string {
  if (typeof input !== 'string') return '';
  const text = input.trim();
  if (!text) return '';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['inputName', 'name', 'fileName', 'filename', 'file']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return '';
    } catch {
      // Not JSON after all, so fall through and treat it as plain text.
    }
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  return /^[^\s"']{1,120}\.[A-Za-z0-9]{1,5}$/.test(firstLine) ? firstLine : '';
}

/**
 * The generic shell fallback. This tool's real surface is its media panel, so
 * `run` explains the command the current options would produce rather than
 * pretending to transcode. Empty input is not an error: it returns the same
 * plan against a placeholder file, plus a line on where to go next.
 */
export function run(
  input: Uint8Array | string = '',
  opts: ConvertRunOptions = {}
): Record<string, string> {
  const target = normalizeTarget(opts.target);
  const quality = normalizeQuality(opts.quality);
  const spec = FORMATS[target];

  const named = resolveInputName(input);
  const inputName = named || DEFAULT_INPUT_NAME;
  const plan = buildConvertArgs({
    inputName,
    target,
    quality,
    stripAudio: opts.stripAudio === true,
  });

  const rows: Record<string, string> = {};
  if (!named) {
    rows['Getting started'] =
      'Drop a video or audio file on the converter panel, pick a format, then press Convert. Everything runs in this tab: your files and inputs never leave your device.';
    rows['Example input'] = inputName;
  } else {
    rows['Input'] = inputName;
  }

  rows['Target format'] = `${spec.label} (${spec.codecs})`;
  rows['Output file'] = plan.outputs[0];
  rows['Quality'] = spec.qualityApplies
    ? `${quality}: ${describeQuality(target, quality)}`
    : `${quality} (${describeQuality(target, quality)})`;
  rows['Audio'] =
    spec.kind === 'audio'
      ? 'the picture is dropped and only the audio is written'
      : opts.stripAudio === true
        ? 'removed with -an'
        : 'kept';
  rows['Command'] = formatCommand(plan.args);
  rows['Notes'] = spec.note;

  return rows;
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>>;
