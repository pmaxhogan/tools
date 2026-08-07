/**
 * Transcriber: the pure half of the Whisper speech to text tool.
 *
 * Inference itself cannot live here. Running Whisper needs WebAssembly, the
 * browser audio decoder, and a 43 MB model download, none of which belong in a
 * pure logic module (rule 27). What does live here is everything that turns the
 * model's raw output into something a person can read or hand to a video
 * editor: chunk normalization, the two subtitle formatters, the plain text
 * layout, and the JSON shape. Those are exactly the parts worth testing, and
 * they are testable without a single byte of audio.
 *
 * `TranscriberPanel.vue` decodes the file, drives the pipeline, and calls
 * `formatTranscript` with the chunks the model returned.
 */
import { ToolError, type ToolLogic } from "../types";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

/** One timed span of transcript. Times are seconds from the start of the file. */
export interface TranscriptChunk {
  text: string;
  start: number | null;
  end: number | null;
}

/**
 * A chunk exactly as transformers.js hands it back. The declared type says
 * `[number, number]`, but Whisper regularly closes the last chunk without a
 * closing timestamp token, so the end really can be null at runtime.
 */
export interface RawTranscriptChunk {
  text: string;
  timestamp: [number, number | null];
}

export type TranscriptFormat = "text" | "srt" | "vtt" | "json";

export interface TranscriberOpts {
  model?: string;
  format?: string;
  language?: string;
  timestamps?: boolean;
}

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * How long a cue with no closing timestamp is assumed to last.
 *
 * Whisper emits a start timestamp token, then the words, then a closing
 * timestamp token. The final chunk of a file often runs out of audio before
 * that closing token is generated, so its end arrives as null. A subtitle file
 * has no way to express "until further notice": every cue needs two times. Two
 * seconds is the smallest span that still reads comfortably on screen, and it
 * only ever applies to the tail of the transcript.
 */
export const FALLBACK_CUE_SECONDS = 2;

/** A silence at least this long starts a new paragraph in the plain text view. */
export const PARAGRAPH_GAP_SECONDS = 2;

/** A paragraph also breaks once it passes this many characters, so walls of text do not form. */
export const PARAGRAPH_MAX_CHARS = 500;

/* ------------------------------------------------------------------ */
/* normalizing                                                         */
/* ------------------------------------------------------------------ */

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turn the pipeline's chunks into the shape the formatters use.
 *
 * Whitespace is trimmed (Whisper prefixes almost every chunk with a space),
 * chunks with no words left are dropped, and any timestamp that is missing,
 * infinite, negative, or backwards becomes null so the formatters can decide
 * what to do about it rather than emitting a broken cue.
 */
export function normalizeChunks(raw: RawTranscriptChunk[] | null | undefined): TranscriptChunk[] {
  if (!Array.isArray(raw)) return [];

  const out: TranscriptChunk[] = [];
  for (const item of raw) {
    if (!item) continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;

    const pair = Array.isArray(item.timestamp) ? item.timestamp : [null, null];
    let start = finiteOrNull(pair[0]);
    let end = finiteOrNull(pair[1]);
    if (start !== null && start < 0) start = 0;
    if (end !== null && end < 0) end = null;
    // A backwards span is worse than a missing one: it would produce a cue that
    // ends before it starts, which every subtitle player rejects.
    if (start !== null && end !== null && end < start) end = null;

    out.push({ text, start, end });
  }
  return out;
}

/** Where a cue starts, in seconds. A chunk with no start is treated as time zero. */
function startOf(chunk: TranscriptChunk): number {
  return chunk.start ?? 0;
}

/** Where a cue ends, in seconds, filling in a missing end (see FALLBACK_CUE_SECONDS). */
function endOf(chunk: TranscriptChunk): number {
  const start = startOf(chunk);
  if (chunk.end === null || chunk.end <= start) return start + FALLBACK_CUE_SECONDS;
  return chunk.end;
}

/* ------------------------------------------------------------------ */
/* time formatting                                                     */
/* ------------------------------------------------------------------ */

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Format seconds as a subtitle timestamp: `hh:mm:ss,mmm` for SRT and
 * `hh:mm:ss.mmm` for WebVTT. Hours are always written, and never wrap, so a
 * two hour recording reads 02:05:… rather than starting over at 00:05:….
 */
export function formatTimestamp(seconds: number, format: "srt" | "vtt"): string {
  const totalMs = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs / 60_000) % 60;
  const secs = Math.floor(totalMs / 1000) % 60;
  const millis = totalMs % 1000;
  const sep = format === "srt" ? "," : ".";
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${sep}${pad(millis, 3)}`;
}

/**
 * Format seconds the way a person reads a player position: `0:07`, `4:31`, and
 * `1:04:31` once the recording crosses an hour. Used by the plain text layout,
 * where full millisecond precision would only add noise.
 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  if (hours > 0) return `${hours}:${pad(minutes, 2)}:${pad(secs, 2)}`;
  return `${minutes}:${pad(secs, 2)}`;
}

/* ------------------------------------------------------------------ */
/* formatters                                                          */
/* ------------------------------------------------------------------ */

/**
 * Plain text.
 *
 * With timestamps off this is prose: consecutive chunks join into a paragraph,
 * and a new paragraph starts after a real pause or once the paragraph gets long
 * enough to be tiring. With timestamps on every chunk gets its own line,
 * prefixed with the span it covers, which is the form people paste into notes.
 */
export function toText(chunks: TranscriptChunk[], opts: { timestamps: boolean }): string {
  if (chunks.length === 0) return "";

  if (opts.timestamps) {
    return chunks
      .map(
        (chunk) => `[${formatClock(startOf(chunk))} - ${formatClock(endOf(chunk))}] ${chunk.text}`,
      )
      .join("\n");
  }

  const paragraphs: string[] = [];
  let current = "";
  let previousEnd: number | null = null;

  for (const chunk of chunks) {
    const gap = previousEnd === null ? 0 : startOf(chunk) - previousEnd;
    const tooLong = current.length >= PARAGRAPH_MAX_CHARS;
    if (current && (gap >= PARAGRAPH_GAP_SECONDS || tooLong)) {
      paragraphs.push(current);
      current = "";
    }
    current = current ? `${current} ${chunk.text}` : chunk.text;
    previousEnd = endOf(chunk);
  }
  if (current) paragraphs.push(current);

  return paragraphs.join("\n\n");
}

/** SubRip. Cues are numbered from 1 and separated by a blank line. */
export function toSrt(chunks: TranscriptChunk[]): string {
  if (chunks.length === 0) return "";
  const blocks = chunks.map((chunk, index) => {
    const from = formatTimestamp(startOf(chunk), "srt");
    const to = formatTimestamp(endOf(chunk), "srt");
    return `${index + 1}\n${from} --> ${to}\n${chunk.text}`;
  });
  return `${blocks.join("\n\n")}\n`;
}

/** WebVTT. Same cues as SRT, with the required header and a dot before the milliseconds. */
export function toVtt(chunks: TranscriptChunk[]): string {
  const blocks = chunks.map((chunk) => {
    const from = formatTimestamp(startOf(chunk), "vtt");
    const to = formatTimestamp(endOf(chunk), "vtt");
    return `${from} --> ${to}\n${chunk.text}`;
  });
  return `${["WEBVTT", ...blocks].join("\n\n")}\n`;
}

/**
 * JSON, for anything that wants to process the transcript further. Missing end
 * times stay null here rather than being filled in: a program can decide what
 * to do about them, where a subtitle player cannot.
 */
export function toJson(chunks: TranscriptChunk[]): string {
  return `${JSON.stringify(
    {
      text: chunks.map((chunk) => chunk.text).join(" "),
      chunks: chunks.map((chunk) => ({
        text: chunk.text,
        start: chunk.start,
        end: chunk.end,
      })),
    },
    null,
    2,
  )}\n`;
}

/** Render chunks in whichever format the option panel selected. */
export function formatTranscript(
  chunks: TranscriptChunk[],
  opts: { format?: string; timestamps?: boolean },
): string {
  const timestamps = opts.timestamps !== false;
  switch (opts.format) {
    case "srt":
      return toSrt(chunks);
    case "vtt":
      return toVtt(chunks);
    case "json":
      return toJson(chunks);
    default:
      return toText(chunks, { timestamps });
  }
}

/** File extension that matches a format, for the download button. */
export function extensionFor(format: string | undefined): string {
  switch (format) {
    case "srt":
      return "srt";
    case "vtt":
      return "vtt";
    case "json":
      return "json";
    default:
      return "txt";
  }
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

const MODEL_SIZES: Record<string, string> = {
  "whisper-tiny": "Whisper tiny, about 43 MB to download once",
  "whisper-base": "Whisper base, about 78 MB to download once",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export type TranscriberResult = Record<string, string>;

/**
 * Transcriber is a panel tool: the answer to "what does this run do" is a
 * description of what the panel on this page will do, because the model, the
 * audio decoder, and the progress reporting all need a browser.
 */
export function run(input: Uint8Array | string, opts: TranscriberOpts): TranscriberResult {
  if (input === null || input === undefined || input.length === 0) {
    throw new ToolError(
      "empty-input",
      "No audio was provided.",
      "Drop an audio or video file onto the panel, or pick one with the file button.",
    );
  }

  const model = String(opts?.model ?? "whisper-tiny");
  const format = String(opts?.format ?? "text");
  const language = String(opts?.language ?? "auto");
  const timestamps = opts?.timestamps !== false;

  const modelNote = MODEL_SIZES[model] ?? MODEL_SIZES["whisper-tiny"]!;
  const languageNote =
    language === "auto"
      ? "detected from the first 30 seconds of speech"
      : `forced to ${language}, which is faster and stops the model switching language mid file`;
  const formatNote =
    format === "text"
      ? timestamps
        ? "plain text, one timestamped line per phrase"
        : "plain text paragraphs with no timestamps"
      : format === "json"
        ? "JSON with the full text plus every timed chunk"
        : `${format.toUpperCase()} subtitles, ready for a video editor`;

  if (typeof input === "string") {
    return {
      Status:
        "Transcriber turns speech into text. It needs audio, so give it a file rather than text: drop one on the panel above or use the file button.",
      Model: modelNote,
      Language: languageNote,
      Output: formatNote,
      Privacy: "The model runs inside this tab, and your files and inputs never leave your device.",
    };
  }

  return {
    Status:
      "The panel on this page does the transcription. It decodes the audio to 16 kHz mono, loads the speech model once you ask for it, and then runs Whisper in 30 second windows with a 5 second overlap so words are not cut in half at the seams.",
    File: `${formatBytes(input.length)} of audio data`,
    Model: modelNote,
    Language: languageNote,
    Output: formatNote,
    Speed:
      "WebAssembly inference is roughly real time with the tiny model on a laptop, and slower with base. A 10 minute recording is a coffee break, not an instant.",
    Privacy: "The model runs inside this tab, and your files and inputs never leave your device.",
  };
}

export default { run } satisfies ToolLogic<Uint8Array | string, TranscriberResult, TranscriberOpts>;
