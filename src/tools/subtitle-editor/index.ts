import { ToolError, type ToolLogic } from "../types";

export type SubtitleFormat = "srt" | "vtt";
export type SubtitleOperation = "convert" | "shift" | "resync" | "clean";

export interface SubtitleOpts {
  /** Which transform to apply. Defaults to 'convert'. */
  operation?: SubtitleOperation;
  /** Target format for 'convert'. Defaults to 'vtt'. */
  format?: SubtitleFormat;
  /** Offset for 'shift', e.g. "+2.5", "-500ms", "+1:03", "1500". */
  offset?: string;
  /** New time of the first cue for 'resync'. */
  first?: string;
  /** New time of the last cue for 'resync'. */
  last?: string;
  /** Minimum cue duration in milliseconds for 'clean'. */
  minDuration?: number;
  [key: string]: unknown;
}

/** One subtitle cue, format independent. Times are milliseconds from zero. */
export interface Cue {
  /** Sequential position, or the number printed in the SRT source. */
  index: number;
  /** WebVTT cue identifier, preserved verbatim when present. */
  id?: string;
  start: number;
  end: number;
  /** Text lines exactly as written, including any inline tags. */
  lines: string[];
  /** WebVTT cue settings written after the end timestamp. */
  settings?: string;
}

/** A NOTE, STYLE, or REGION block kept outside the cue list. */
export interface SubtitleBlock {
  kind: "NOTE" | "STYLE" | "REGION";
  text: string;
}

export interface SubtitleDoc {
  format: SubtitleFormat;
  /** The WebVTT header block verbatim, e.g. "WEBVTT" or "WEBVTT - Episode 1". */
  header?: string;
  blocks: SubtitleBlock[];
  cues: Cue[];
}

interface RawBlock {
  lines: string[];
  /** 1-based line number of the block's first line in the original input. */
  line: number;
}

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

const OFFSET_HELP =
  "Use forms like +2.5 for seconds, -500ms for milliseconds, +1:03 for minutes and seconds, 01:02:03.456, or 1500 for bare milliseconds.";

const TIMESTAMP_HELP =
  "Use hh:mm:ss,mmm for SRT or hh:mm:ss.mmm for WebVTT, for example 00:01:23,456.";

/* ------------------------------------------------------------------ parsing */

function splitBlocks(text: string): RawBlock[] {
  const lines = text.split("\n");
  const blocks: RawBlock[] = [];
  let current: string[] = [];
  let startLine = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (line === "") {
      if (current.length) {
        blocks.push({ lines: current, line: startLine });
        current = [];
      }
    } else {
      if (!current.length) startLine = i + 1;
      current.push(line);
    }
  }
  if (current.length) blocks.push({ lines: current, line: startLine });
  return blocks;
}

function parseTimestamp(value: string, cueNo: number, lineNo: number): number {
  const trimmed = value.trim();
  const m = TIMESTAMP.exec(trimmed);
  if (!m) {
    throw new ToolError(
      "invalid-subtitles",
      `Cue ${cueNo} on line ${lineNo} has a timestamp that could not be read: "${trimmed}".`,
      TIMESTAMP_HELP,
    );
  }
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4].padEnd(3, "0"));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function parseNoteBlock(block: RawBlock): SubtitleBlock {
  const head = block.lines[0].slice(4).trim();
  const rest = block.lines.slice(1);
  if (!rest.length) return { kind: "NOTE", text: head };
  const parts = head ? [head, ...rest] : rest;
  return { kind: "NOTE", text: parts.join("\n") };
}

function parseCue(block: RawBlock, position: number, isVtt: boolean): Cue {
  const tsIdx = block.lines.findIndex((l) => l.includes("-->"));
  if (tsIdx < 0) {
    throw new ToolError(
      "invalid-subtitles",
      `Cue ${position} starting on line ${block.line} has no timestamp line.`,
      "Every cue needs a line like 00:00:01,000 --> 00:00:04,000 between its number and its text.",
    );
  }
  if (tsIdx > 1) {
    throw new ToolError(
      "invalid-subtitles",
      `Cue ${position} starting on line ${block.line} has ${tsIdx} lines before its timestamp.`,
      "A cue may have at most one line (its number or identifier) above the timestamp line. Add a blank line to separate cues.",
    );
  }

  let id: string | undefined;
  let index = position;
  if (tsIdx === 1) {
    const head = block.lines[0].trim();
    if (isVtt) id = block.lines[0];
    else if (/^\d+$/.test(head)) index = Number(head);
  }

  const tsLineNo = block.line + tsIdx;
  const tsLine = block.lines[tsIdx];
  const arrow = tsLine.indexOf("-->");
  const left = tsLine.slice(0, arrow).trim();
  const right = tsLine.slice(arrow + 3).trim();
  const gap = right.search(/\s/);
  const endText = gap < 0 ? right : right.slice(0, gap);
  const settings = gap < 0 ? "" : right.slice(gap).trim();

  const start = parseTimestamp(left, position, tsLineNo);
  const end = parseTimestamp(endText, position, tsLineNo);
  if (end < start) {
    throw new ToolError(
      "invalid-subtitles",
      `Cue ${position} on line ${tsLineNo} ends before it starts.`,
      "Swap the two timestamps so the end time comes after the start time.",
    );
  }

  return {
    index,
    id,
    start,
    end,
    lines: block.lines.slice(tsIdx + 1),
    settings: isVtt && settings ? settings : undefined,
  };
}

/** Parse SRT or WebVTT text into the shared cue model, detecting the format. */
export function parseSubtitles(input: string): SubtitleDoc {
  const raw = (input ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!raw.trim()) {
    throw new ToolError(
      "empty-input",
      "There is nothing to work with yet.",
      "Paste an SRT or WebVTT file, or drop a .srt or .vtt file onto the input.",
    );
  }

  const blocks = splitBlocks(raw);
  const isVtt = /^WEBVTT/.test(blocks[0].lines[0]);
  const doc: SubtitleDoc = { format: isVtt ? "vtt" : "srt", blocks: [], cues: [] };

  let startIdx = 0;
  if (isVtt) {
    doc.header = blocks[0].lines.join("\n");
    startIdx = 1;
  }

  for (let i = startIdx; i < blocks.length; i++) {
    const block = blocks[i];
    const head = block.lines[0];
    if (/^NOTE(\s|$)/.test(head)) {
      doc.blocks.push(parseNoteBlock(block));
      continue;
    }
    if (isVtt && (head === "STYLE" || head === "REGION")) {
      doc.blocks.push({ kind: head, text: block.lines.slice(1).join("\n") });
      continue;
    }
    doc.cues.push(parseCue(block, doc.cues.length + 1, isVtt));
  }

  if (!doc.cues.length) {
    throw new ToolError(
      "invalid-subtitles",
      "No subtitle cues were found in the input.",
      "A cue needs a timestamp line like 00:00:01,000 --> 00:00:04,000 followed by its text.",
    );
  }

  return doc;
}

/* -------------------------------------------------------------- serializing */

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Format milliseconds as hh:mm:ss,mmm (SRT) or hh:mm:ss.mmm (WebVTT). */
export function formatTimestamp(ms: number, format: SubtitleFormat): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const millis = total % 1000;
  const sep = format === "srt" ? "," : ".";
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${sep}${pad(millis, 3)}`;
}

function blockText(block: SubtitleBlock): string {
  if (block.kind === "NOTE") {
    if (!block.text) return "NOTE";
    return block.text.includes("\n") ? `NOTE\n${block.text}` : `NOTE ${block.text}`;
  }
  return block.text ? `${block.kind}\n${block.text}` : block.kind;
}

/** Render the cue model back to a valid subtitle file. */
export function serializeSubtitles(doc: SubtitleDoc): string {
  const parts: string[] = [];
  if (doc.format === "vtt") parts.push(doc.header || "WEBVTT");
  for (const block of doc.blocks) parts.push(blockText(block));

  for (const cue of doc.cues) {
    const lines: string[] = [];
    if (doc.format === "srt") lines.push(String(cue.index));
    else if (cue.id !== undefined) lines.push(cue.id);

    let ts = `${formatTimestamp(cue.start, doc.format)} --> ${formatTimestamp(cue.end, doc.format)}`;
    if (doc.format === "vtt" && cue.settings) ts += ` ${cue.settings}`;
    lines.push(ts);
    lines.push(...cue.lines);
    parts.push(lines.join("\n"));
  }

  return `${parts.join("\n\n")}\n`;
}

/* ----------------------------------------------------------------- time opts */

/**
 * Parse a duration or absolute time. Accepts an optional sign, then
 * hh:mm:ss.mmm, mm:ss, "500ms", "2.5s", a decimal number of seconds, or a
 * bare integer of milliseconds.
 */
export function parseOffset(raw: string | undefined, label: string): number {
  const text = (raw ?? "").trim();
  if (!text) throw new ToolError("bad-offset", `${label} is empty.`, OFFSET_HELP);

  let sign = 1;
  let body = text;
  if (body.startsWith("+")) body = body.slice(1).trim();
  else if (body.startsWith("-")) {
    sign = -1;
    body = body.slice(1).trim();
  }
  if (!body) throw new ToolError("bad-offset", `${label} has a sign but no value.`, OFFSET_HELP);

  if (body.includes(":")) {
    const parts = body.split(":").map((p) => p.replace(",", "."));
    if (parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
      throw new ToolError(
        "bad-offset",
        `${label} value "${text}" is not a valid time.`,
        OFFSET_HELP,
      );
    }
    let total = 0;
    for (const part of parts) total = total * 60 + Number(part);
    return sign * Math.round(total * 1000);
  }

  const asMillis = /^(\d+(?:\.\d+)?)\s*ms$/i.exec(body);
  if (asMillis) return sign * Math.round(Number(asMillis[1]));

  const asSeconds = /^(\d+(?:\.\d+)?|\.\d+)\s*s(?:ec|ecs|econd|econds)?$/i.exec(body);
  if (asSeconds) return sign * Math.round(Number(asSeconds[1]) * 1000);

  if (/^(?:\d+\.\d+|\.\d+)$/.test(body)) return sign * Math.round(Number(body) * 1000);
  if (/^\d+$/.test(body)) return sign * Number(body);

  throw new ToolError("bad-offset", `${label} value "${text}" is not a valid time.`, OFFSET_HELP);
}

/* ------------------------------------------------------------------ helpers */

const KEEP_TAG = /^\/?[ibu]$/i;

/** Remove every inline tag except i, b, and u. */
export function stripTags(line: string): string {
  return line.replace(/<([^>]*)>/g, (_m, inner: string) => {
    const name = inner.trim();
    return KEEP_TAG.test(name) ? `<${name.toLowerCase()}>` : "";
  });
}

/** Turn a WebVTT voice span into an SRT-friendly speaker prefix. */
function voiceToPrefix(line: string): string {
  return line
    .replace(/<v(?:\.[^\s>]+)*\s+([^>]*?)>/gi, (_m, name: string) => `${name.trim()}: `)
    .replace(/<\/v>/gi, "");
}

function cloneCue(cue: Cue): Cue {
  return { ...cue, lines: [...cue.lines] };
}

function withNotice(doc: SubtitleDoc, text: string): SubtitleDoc {
  return { ...doc, blocks: [{ kind: "NOTE", text }, ...doc.blocks] };
}

/* --------------------------------------------------------------- operations */

function convert(doc: SubtitleDoc, target: SubtitleFormat): SubtitleDoc {
  if (target === "vtt") {
    return {
      format: "vtt",
      header: doc.format === "vtt" ? doc.header : "WEBVTT",
      blocks: doc.blocks.map((b) => ({ ...b })),
      cues: doc.cues.map(cloneCue),
    };
  }

  const cues = doc.cues.map((cue, i) => ({
    index: i + 1,
    id: undefined,
    start: cue.start,
    end: cue.end,
    lines: cue.lines.map((line) => stripTags(voiceToPrefix(line))),
    settings: undefined,
  }));

  const dropped = doc.format === "vtt" ? doc.blocks.length : 0;
  const blocks = doc.format === "vtt" ? [] : doc.blocks.map((b) => ({ ...b }));
  const out: SubtitleDoc = { format: "srt", blocks, cues };

  if (dropped > 0) {
    const label = dropped === 1 ? "block" : "blocks";
    return withNotice(
      out,
      `Removed ${dropped} WebVTT NOTE or STYLE ${label}: SubRip has no comment or styling syntax.`,
    );
  }
  return out;
}

function shift(doc: SubtitleDoc, raw: string | undefined): SubtitleDoc {
  const delta = parseOffset(raw, "Offset");
  let clamped = 0;
  const cues = doc.cues.map((cue) => {
    if (cue.start + delta < 0) clamped++;
    const start = Math.max(0, cue.start + delta);
    const end = Math.max(start, cue.end + delta);
    return { ...cloneCue(cue), start, end };
  });

  const out: SubtitleDoc = { ...doc, blocks: doc.blocks.map((b) => ({ ...b })), cues };
  if (clamped > 0) {
    const [label, pronoun] = clamped === 1 ? ["cue", "it"] : ["cues", "them"];
    return withNotice(
      out,
      `Held ${clamped} ${label} at 00:00:00 because the offset moved ${pronoun} before the start of the file.`,
    );
  }
  return out;
}

function resync(doc: SubtitleDoc, opts: SubtitleOpts): SubtitleDoc {
  if (doc.cues.length < 2) {
    throw new ToolError(
      "need-two-cues",
      "Resync needs at least two cues so it can work out the scale and the offset.",
      "Use the shift operation instead when the file has a single cue.",
    );
  }
  const newFirst = parseOffset(opts.first, "First cue time");
  const newLast = parseOffset(opts.last, "Last cue time");

  const oldFirst = doc.cues[0].start;
  const oldLast = doc.cues[doc.cues.length - 1].start;
  if (oldLast === oldFirst) {
    throw new ToolError(
      "need-two-cues",
      "Resync needs two cues with different start times.",
      "The first and last cues start at the same moment, so use the shift operation instead.",
    );
  }

  const scale = (newLast - newFirst) / (oldLast - oldFirst);
  const offset = newFirst - scale * oldFirst;
  const at = (t: number) => Math.max(0, Math.round(scale * t + offset));

  const cues = doc.cues.map((cue) => {
    const start = at(cue.start);
    return { ...cloneCue(cue), start, end: Math.max(start, at(cue.end)) };
  });
  return { ...doc, blocks: doc.blocks.map((b) => ({ ...b })), cues };
}

/** Fold a cue down to two lines by repeatedly merging the shortest neighbors. */
function collapseLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 2) {
    let best = 0;
    let bestLen = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const len = out[i].length + out[i + 1].length;
      if (len < bestLen) {
        bestLen = len;
        best = i;
      }
    }
    out.splice(best, 2, `${out[best]} ${out[best + 1]}`.trim());
  }
  return out;
}

function clean(doc: SubtitleDoc, rawMin: number | undefined): SubtitleDoc {
  const minDuration = Math.min(5000, Math.max(0, Math.round(Number(rawMin ?? 500) || 0)));

  let cues = doc.cues
    .map((cue) => ({
      ...cloneCue(cue),
      lines: collapseLines(
        cue.lines.map((line) => stripTags(line).replace(/\s+/g, " ").trim()).filter(Boolean),
      ),
    }))
    .filter((cue) => cue.lines.length > 0 && cue.end > cue.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const limit = next ? next.start : Infinity;
    if (cues[i].end > limit) cues[i].end = limit;
    const wanted = cues[i].start + minDuration;
    if (cues[i].end < wanted) cues[i].end = Math.min(wanted, limit);
  }

  cues = cues.filter((cue) => cue.end > cue.start).map((cue, i) => ({ ...cue, index: i + 1 }));

  if (!cues.length) {
    throw new ToolError(
      "invalid-subtitles",
      "Cleaning removed every cue because none of them had text and a positive duration.",
      "Check that the cues have text lines and that each end time is later than its start time.",
    );
  }

  return { ...doc, blocks: doc.blocks.map((b) => ({ ...b })), cues };
}

/* --------------------------------------------------------------------- run */

export function run(input: string, opts: SubtitleOpts): string {
  const doc = parseSubtitles(input);
  const operation = (opts?.operation ?? "convert") as SubtitleOperation;

  switch (operation) {
    case "convert":
      return serializeSubtitles(convert(doc, (opts?.format ?? "vtt") as SubtitleFormat));
    case "shift":
      return serializeSubtitles(shift(doc, opts?.offset));
    case "resync":
      return serializeSubtitles(resync(doc, opts ?? {}));
    case "clean":
      return serializeSubtitles(clean(doc, opts?.minDuration));
    default:
      throw new ToolError(
        "bad-operation",
        `Unknown operation "${String(operation)}".`,
        "Choose convert, shift, resync, or clean.",
      );
  }
}

export default { run } satisfies ToolLogic<string, string, SubtitleOpts>;
