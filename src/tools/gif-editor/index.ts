/**
 * GIF Toolbox: the planning layer for the browser side ffmpeg GIF editor.
 *
 * The panel runs ffmpeg.wasm, so the work this module does is deciding *what*
 * ffmpeg should be asked to do. Every exported planner is a pure function that
 * returns either a runnable `{ args, outputs }` pair for `runJob`, or a
 * `{ error, fix }` refusal that the shell shows instead of a broken command.
 * That is the same shape `MediaBuildArgs` expects, so a panel can hand a
 * planner's result straight to `MediaShell`.
 *
 * Two things drive most of the design here:
 *
 *  - **Every gif to gif operation re-palettizes.** A GIF carries at most 256
 *    colours in its own table. Re-encoding one without building a new palette
 *    makes ffmpeg fall back to a generic 8 bit palette, and the result bands
 *    and dithers badly. So every gif output goes through the standard
 *    split / palettegen / paletteuse graph, built by `paletteWrap`.
 *  - **`runJob` reads back exactly the file names a planner declares** and
 *    fails the whole run when one is missing. So planners only ever declare
 *    outputs ffmpeg is certain to write, and the frame export is deliberately
 *    a fixed, user chosen count (see `buildSplit`).
 *
 * `run()` is the headless fallback: it reads the GIF header itself and reports
 * the plan as text, since a wasm encode cannot happen outside a browser.
 */
import { ToolError, type ToolLogic } from "../types";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export type GifOperation =
  "resize" | "crop" | "optimize" | "reverse" | "speed" | "caption" | "split";

export type CaptionPosition = "top" | "bottom";

/** A runnable ffmpeg command plus the files it is guaranteed to produce. */
export interface GifPlan {
  args: string[];
  outputs: string[];
}

/** Why this combination of options cannot run, and what to change. */
export interface GifRefusal {
  error: string;
  fix?: string;
}

export type GifPlanResult = GifPlan | GifRefusal;

/** True when a planner refused. Narrowing helper for callers. */
export function isRefusal(result: GifPlanResult): result is GifRefusal {
  return "error" in result;
}

/** What the GIF header and block walk report about a file. */
export interface GifInfo {
  width: number;
  height: number;
  frames: number;
  /** Total playback time in milliseconds, using browser delay clamping. */
  durationMs: number;
  /** Average frames per second over the whole animation, or null for one frame. */
  fps: number | null;
}

/** What an ffmpeg log says about the input it just read. */
export interface GifLogInfo {
  width: number;
  height: number;
  fps: number | null;
  frames: number | null;
}

export interface GifOptions {
  operation?: GifOperation;
  width?: number;
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
  fps?: number;
  colors?: number;
  lossy?: boolean;
  factor?: number;
  speedFps?: number;
  text?: string;
  position?: CaptionPosition;
  fontSize?: number;
  everyNth?: number;
  frames?: number;
}

/** Name the panel and the fallback both use for the produced GIF. */
export const GIF_OUTPUT = "out.gif";

/* ------------------------------------------------------------------ */
/* validation helpers                                                  */
/* ------------------------------------------------------------------ */

function toInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function toNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Formats a number for a filter argument without exponent notation. */
function num(value: number): string {
  return String(Number(value.toFixed(4)));
}

function badInteger(label: string, min: number, max: number): GifRefusal {
  return {
    error: `${label} must be a whole number between ${min} and ${max}.`,
    fix: `Enter a whole number in that range and run again.`,
  };
}

function checkInput(inputName: string): GifRefusal | null {
  if (!inputName || !inputName.trim()) {
    return {
      error: "No GIF has been selected yet.",
      fix: "Drop a .gif file on the input above, or use the file picker.",
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* palette                                                             */
/* ------------------------------------------------------------------ */

export interface PaletteOptions {
  /** Extra `palettegen` arguments, e.g. "max_colors=64". */
  palettegen?: string;
  /** Extra `paletteuse` arguments, e.g. "dither=bayer:bayer_scale=5". */
  paletteuse?: string;
}

/**
 * Wraps a filter chain in the single pass palette graph.
 *
 * ffmpeg cannot write a good GIF without a palette built from the frames it is
 * about to write, so the stream is split: one branch generates the palette, the
 * other waits and then maps its frames onto it. Doing it in one graph is what
 * keeps this a single run instead of the two pass recipe most guides show.
 *
 * @param filter the video filter chain applied before palette generation, e.g.
 *   "scale=480:-1:flags=lanczos". Pass an empty string for a pure re-encode.
 */
export function paletteWrap(filter: string, options: PaletteOptions = {}): string {
  const chain = filter.trim() ? `${filter.trim()},` : "";
  const gen = options.palettegen ? `palettegen=${options.palettegen}` : "palettegen";
  const use = options.paletteuse ? `paletteuse=${options.paletteuse}` : "paletteuse";
  return `[0:v]${chain}split[pgs][pgu];[pgs]${gen}[pal];[pgu][pal]${use}`;
}

/** Assembles the full argument list for a gif to gif run. */
function gifArgs(inputName: string, filterComplex: string): string[] {
  // -loop 0 is an infinite loop in the gif muxer, which is what a source GIF
  // almost always was before it was edited.
  return ["-i", inputName, "-filter_complex", filterComplex, "-loop", "0", GIF_OUTPUT];
}

function gifPlan(inputName: string, filterComplex: string): GifPlan {
  return { args: gifArgs(inputName, filterComplex), outputs: [GIF_OUTPUT] };
}

/* ------------------------------------------------------------------ */
/* planners                                                            */
/* ------------------------------------------------------------------ */

export const MIN_WIDTH = 16;
export const MAX_WIDTH = 4000;

/**
 * Scales the GIF to a target width, height following to keep the aspect ratio.
 * Lanczos is the sharpest of the practical scalers, which matters at the small
 * sizes GIFs are usually resized to.
 */
export function buildResize(input: { inputName: string; width: number }): GifPlanResult {
  const missing = checkInput(input.inputName);
  if (missing) return missing;

  const width = toInt(input.width);
  if (width === null || width < MIN_WIDTH || width > MAX_WIDTH) {
    return badInteger("Width", MIN_WIDTH, MAX_WIDTH);
  }

  return gifPlan(input.inputName, paletteWrap(`scale=${width}:-1:flags=lanczos`));
}

/**
 * Cuts a rectangle out of every frame. The planner never sees the real frame
 * size, so it can only check that the numbers are sane; a rectangle that runs
 * off the edge is rejected by ffmpeg itself, and the fix text says so.
 */
export function buildCrop(input: {
  inputName: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): GifPlanResult {
  const missing = checkInput(input.inputName);
  if (missing) return missing;

  const w = toInt(input.w);
  const h = toInt(input.h);
  if (w === null || w < 1 || h === null || h < 1) {
    return {
      error: "Crop width and height must be whole numbers of at least 1 pixel.",
      fix: "Enter the size of the region you want to keep, in pixels.",
    };
  }

  const x = toInt(input.x);
  const y = toInt(input.y);
  if (x === null || x < 0 || y === null || y < 0) {
    return {
      error: "Crop offsets must be whole numbers of 0 or more.",
      fix: "The offset is measured from the top left corner, so 0 and 0 keeps the corner.",
    };
  }

  // A rectangle larger than the frame is only detectable at run time, and
  // ffmpeg reports it clearly, so the planner lets it through.
  return gifPlan(input.inputName, paletteWrap(`crop=${w}:${h}:${x}:${y}`));
}

export const MIN_COLORS = 4;
export const MAX_COLORS = 256;
export const MIN_FPS = 1;
export const MAX_FPS = 50;

/**
 * Makes a GIF smaller the two ways ffmpeg actually can: fewer frames per
 * second, and a smaller colour table.
 *
 * ffmpeg has no equivalent of gifsicle's lossy mode, which perturbs pixel
 * values so the LZW stream compresses better. Asking for it here is refused
 * rather than quietly ignored.
 */
export function buildOptimize(input: {
  inputName: string;
  fps: number;
  colors: number;
  lossy?: boolean;
}): GifPlanResult {
  const missing = checkInput(input.inputName);
  if (missing) return missing;

  if (input.lossy === true) {
    return {
      error: "Lossy GIF compression is not something ffmpeg can do.",
      fix: "Lower the color count or the frame rate instead. Those are the two levers ffmpeg has, and together they usually beat a lossy pass.",
    };
  }

  const fps = toInt(input.fps);
  if (fps === null || fps < MIN_FPS || fps > MAX_FPS) {
    return badInteger("Frame rate", MIN_FPS, MAX_FPS);
  }

  const colors = toInt(input.colors);
  if (colors === null || colors < MIN_COLORS || colors > MAX_COLORS) {
    return badInteger("Colors", MIN_COLORS, MAX_COLORS);
  }

  return gifPlan(
    input.inputName,
    paletteWrap(`fps=${fps}`, {
      palettegen: `max_colors=${colors}`,
      // Bayer dithering costs a little detail and saves a lot of bytes,
      // because ordered noise compresses far better than error diffusion.
      paletteuse: "dither=bayer:bayer_scale=5",
    }),
  );
}

/**
 * Plays the animation backwards. The reverse filter buffers every frame in
 * memory, so a very long GIF can exhaust the wasm heap; the panel says so.
 */
export function buildReverse(input: { inputName: string }): GifPlanResult {
  const missing = checkInput(input.inputName);
  if (missing) return missing;
  return gifPlan(input.inputName, paletteWrap("reverse"));
}

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/**
 * Changes playback speed by rewriting presentation timestamps: a factor of 2
 * plays twice as fast, 0.5 half as fast. An optional frame rate resamples
 * afterwards, which is how you turn a slow motion pass into evenly spaced
 * frames rather than long delays.
 */
export function buildSpeed(input: {
  inputName: string;
  factor: number;
  fps?: number;
}): GifPlanResult {
  const missing = checkInput(input.inputName);
  if (missing) return missing;

  const factor = toNumber(input.factor);
  if (factor === null || factor < MIN_SPEED || factor > MAX_SPEED) {
    return {
      error: `Speed must be between ${MIN_SPEED} and ${MAX_SPEED} times.`,
      fix: "Values under 1 slow the GIF down, values over 1 speed it up. Run the tool twice for anything more extreme.",
    };
  }

  let chain = `setpts=PTS/${num(factor)}`;
  if (input.fps !== undefined && input.fps !== null) {
    const fps = toInt(input.fps);
    if (fps === null || fps < MIN_FPS || fps > MAX_FPS) {
      return badInteger("Frame rate", MIN_FPS, MAX_FPS);
    }
    chain += `,fps=${fps}`;
  }

  return gifPlan(input.inputName, paletteWrap(chain));
}

/* ------------------------------------------------------------------ */
/* caption                                                             */
/* ------------------------------------------------------------------ */

/**
 * Escapes a string so it survives both unescaping passes ffmpeg performs on a
 * filtergraph before drawtext sees the text.
 *
 * The filtergraph description is parsed first (`,` `;` `[` `]` `'` `\` are
 * special there), then each filter's own option string is parsed (`:` and `\`
 * are special there). A character that matters at both levels therefore needs
 * escaping twice, which is why a quote becomes three backslashes and a quote.
 * This matches the escaping example in the ffmpeg filters documentation.
 *
 * Backslashes are replaced first, otherwise the backslashes this function adds
 * would be escaped again by the later passes.
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "\\\\\\'")
    .replace(/:/g, "\\\\:")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 200;

/**
 * Burns a caption into every frame.
 *
 * This needs two things the site does not have yet, so it refuses without a
 * font file rather than producing a command that fails inside the worker:
 *
 *  1. A TrueType or OpenType font *inside the ffmpeg filesystem*. drawtext
 *     cannot read woff2, and the only fonts this site ships are the woff2
 *     Geist files the pages themselves use.
 *  2. A core built with libfreetype. drawtext is a compile time option, so a
 *     core without it rejects the filter no matter what font is supplied.
 *
 * Pass `fontFile` once a font is written into the filesystem under a plain
 * ASCII name, and this returns a real plan.
 */
export function buildCaption(input: {
  inputName: string;
  text: string;
  position: CaptionPosition;
  fontSize: number;
  fontFile?: string;
}): GifPlanResult {
  const missing = checkInput(input.inputName);
  if (missing) return missing;

  const text = (input.text ?? "").trim();
  if (!text) {
    return {
      error: "The caption is empty.",
      fix: "Type the words you want burned into the GIF.",
    };
  }

  const fontSize = toInt(input.fontSize);
  if (fontSize === null || fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) {
    return badInteger("Font size", MIN_FONT_SIZE, MAX_FONT_SIZE);
  }

  const fontFile = (input.fontFile ?? "").trim();
  if (!fontFile) {
    return {
      error: "Captioning needs a font file, and this build does not ship one.",
      fix: "Add the text in an image editor first, or use resize, crop, optimize, reverse, speed or split here.",
    };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(fontFile)) {
    return {
      error: "The font file name has characters ffmpeg cannot read in a filter.",
      fix: "Use a plain name made of letters, digits, dots, dashes and underscores.",
    };
  }

  const y =
    input.position === "top"
      ? `${Math.max(4, Math.round(fontSize * 0.3))}`
      : `h-text_h-${Math.max(4, Math.round(fontSize * 0.3))}`;

  // expansion=none keeps a literal %{...} in the caption from being read as a
  // drawtext expression. White on a black outline is the meme caption look and
  // stays readable over any frame.
  const draw = [
    `drawtext=fontfile=${fontFile}`,
    `text=${escapeDrawtext(text)}`,
    `fontsize=${fontSize}`,
    "fontcolor=white",
    "borderw=2",
    "bordercolor=black",
    "expansion=none",
    "x=(w-text_w)/2",
    `y=${y}`,
  ].join(":");

  return gifPlan(input.inputName, paletteWrap(draw));
}

/* ------------------------------------------------------------------ */
/* split                                                               */
/* ------------------------------------------------------------------ */

export const MAX_SPLIT_FRAMES = 50;
export const MAX_EVERY_NTH = 20;

/** Zero padded name of the nth exported frame, matching the image2 muxer. */
export function splitFrameName(index: number): string {
  return `out${String(index).padStart(4, "0")}.png`;
}

/**
 * Exports individual frames as PNG files.
 *
 * The declared output list has to be exact, because `runJob` reads back every
 * name it was given and fails when one is missing. Nothing in the build context
 * says how many frames the GIF has, so the count is the user's: ffmpeg is asked
 * for exactly `frames` files and the same names are declared. A GIF with fewer
 * frames than that stops early and the run reports the first missing file,
 * which is why the panel tells you to lower the count.
 *
 * Padding the stream to guarantee the count was the alternative, and it was
 * rejected: cloned or looped frames would look like real ones.
 *
 * `-vsync 0` keeps frames exactly as they arrive. GIF frames have individual
 * delays, so without it the muxer would duplicate frames to reach a constant
 * rate and "every second frame" would no longer mean what it says.
 */
export function buildSplit(input: {
  inputName: string;
  everyNth: number;
  frames: number;
}): GifPlanResult {
  const missing = checkInput(input.inputName);
  if (missing) return missing;

  const everyNth = toInt(input.everyNth);
  if (everyNth === null || everyNth < 1 || everyNth > MAX_EVERY_NTH) {
    return badInteger("Frame step", 1, MAX_EVERY_NTH);
  }

  const frames = toInt(input.frames);
  if (frames === null || frames < 1 || frames > MAX_SPLIT_FRAMES) {
    return badInteger("Frames to export", 1, MAX_SPLIT_FRAMES);
  }

  const args = ["-i", input.inputName];
  if (everyNth > 1) {
    // The comma inside the select expression belongs to mod(), so it is escaped
    // to keep the filtergraph parser from reading it as the next filter.
    args.push("-vf", `select=not(mod(n\\,${everyNth}))`);
  }
  args.push("-vsync", "0", "-frames:v", String(frames), "out%04d.png");

  return {
    args,
    outputs: Array.from({ length: frames }, (_, i) => splitFrameName(i + 1)),
  };
}

/* ------------------------------------------------------------------ */
/* reading a GIF                                                       */
/* ------------------------------------------------------------------ */

/** Browsers treat a delay under 2 hundredths of a second as 10, so this does too. */
const MIN_DELAY_CS = 2;
const CLAMPED_DELAY_CS = 10;

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let pos = start;
  while (pos < bytes.length) {
    const size = bytes[pos];
    pos += 1;
    if (size === 0) return pos;
    pos += size;
  }
  return pos;
}

/**
 * Reads size, frame count and timing straight out of the GIF byte stream.
 *
 * ffmpeg never reports a GIF frame count, and neither does an `<img>` element,
 * so walking the blocks is the only way to know how many frames a file has.
 * The walk is cheap: it reads block headers and steps over the compressed
 * pixel data without decoding any of it.
 *
 * Returns null when the bytes are not a GIF or the block structure is broken.
 */
export function readGifInfo(bytes: Uint8Array): GifInfo | null {
  if (bytes.length < 13) return null;
  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (signature !== "GIF") return null;

  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1));

  let frames = 0;
  let delayCs = 0;
  let pendingDelay = 0;

  while (pos < bytes.length) {
    const marker = bytes[pos];
    pos += 1;

    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      const label = bytes[pos];
      pos += 1;
      if (label === 0xf9 && bytes[pos] === 4) {
        // Graphic control extension: delay is a little endian hundredths value.
        pendingDelay = bytes[pos + 2] | (bytes[pos + 3] << 8);
      }
      pos = skipSubBlocks(bytes, pos);
      continue;
    }

    if (marker === 0x2c) {
      frames += 1;
      delayCs += pendingDelay < MIN_DELAY_CS ? CLAMPED_DELAY_CS : pendingDelay;
      pendingDelay = 0;
      pos += 8; // left, top, width, height
      const localPacked = bytes[pos];
      pos += 1;
      if (localPacked & 0x80) pos += 3 * (1 << ((localPacked & 0x07) + 1));
      pos += 1; // LZW minimum code size
      pos = skipSubBlocks(bytes, pos);
      continue;
    }

    // Anything else means the walk has lost the block structure.
    return frames > 0 ? finishInfo(width, height, frames, delayCs) : null;
  }

  if (frames === 0) return null;
  return finishInfo(width, height, frames, delayCs);
}

function finishInfo(width: number, height: number, frames: number, delayCs: number): GifInfo {
  const durationMs = delayCs * 10;
  const fps =
    frames > 1 && durationMs > 0 ? Number((frames / (durationMs / 1000)).toFixed(2)) : null;
  return { width, height, frames, durationMs, fps };
}

/**
 * Pulls what an ffmpeg log says about the GIF it read.
 *
 * The stream line carries size and rate. A frame count only appears in the
 * progress summary of a run that actually encoded something, so it is null for
 * a log that only probed the file.
 */
export function parseGifInfo(logText: string): GifLogInfo | null {
  const streamLine = logText
    .split(/\r?\n/)
    .find((line) => /Stream #\d+:\d+/.test(line) && /Video:/.test(line));
  if (!streamLine) return null;

  const size = /\b(\d{1,5})x(\d{1,5})\b/.exec(streamLine);
  if (!size) return null;

  const fpsMatch = /([\d.]+)\s+fps\b/.exec(streamLine);
  const fps = fpsMatch ? Number(fpsMatch[1]) : null;

  // The last frame= line wins: ffmpeg rewrites the progress line as it works.
  let frames: number | null = null;
  const frameMatches = logText.matchAll(/frame=\s*(\d+)/g);
  for (const match of frameMatches) frames = Number(match[1]);

  return {
    width: Number(size[1]),
    height: Number(size[2]),
    fps: fps !== null && Number.isFinite(fps) ? fps : null,
    frames,
  };
}

/* ------------------------------------------------------------------ */
/* headless fallback                                                   */
/* ------------------------------------------------------------------ */

const OPERATION_LABELS: Record<GifOperation, string> = {
  resize: "Resize",
  crop: "Crop",
  optimize: "Optimize",
  reverse: "Reverse",
  speed: "Change speed",
  caption: "Caption",
  split: "Split into frames",
};

const OPERATION_NOTES: Record<GifOperation, string> = {
  resize:
    "Height follows the width so the aspect ratio is kept. The frames are re-palettized, which is what stops a resized GIF from banding.",
  crop: "The rectangle is measured in pixels from the top left corner. A rectangle larger than the frame is rejected by ffmpeg at run time.",
  optimize:
    "Fewer frames per second and a smaller color table are the two levers ffmpeg has. There is no gifsicle style lossy mode.",
  reverse:
    "Every frame is buffered in memory to play them back to front, so a very long GIF can run out of room in the browser.",
  speed:
    "Speed is a timestamp rewrite. GIF delays are stored in hundredths of a second and browsers treat anything under two of those as ten, so very fast results stop getting faster.",
  caption:
    "Captioning needs a font file inside the media engine and a build of ffmpeg that includes drawtext, so it is turned off for now.",
  split:
    "Frames come out as PNG files. The count is fixed in advance because the run declares its output names before it starts.",
};

/** Quotes an argument the way a shell would need it, for the copyable command. */
function quoteArg(arg: string): string {
  return /[\s"'\\[\]();$*?]/.test(arg) ? `"${arg.replace(/(["\\$`])/g, "\\$1")}"` : arg;
}

function formatCommand(args: string[]): string {
  return ["ffmpeg", ...args.map(quoteArg)].join(" ");
}

function planFor(operation: GifOperation, inputName: string, opts: GifOptions): GifPlanResult {
  switch (operation) {
    case "resize":
      return buildResize({ inputName, width: opts.width ?? 480 });
    case "crop":
      return buildCrop({
        inputName,
        x: opts.cropX ?? 0,
        y: opts.cropY ?? 0,
        w: opts.cropW ?? 0,
        h: opts.cropH ?? 0,
      });
    case "optimize":
      return buildOptimize({
        inputName,
        fps: opts.fps ?? 15,
        colors: opts.colors ?? 128,
        lossy: opts.lossy,
      });
    case "reverse":
      return buildReverse({ inputName });
    case "speed":
      return buildSpeed({
        inputName,
        factor: opts.factor ?? 2,
        fps: opts.speedFps && opts.speedFps > 0 ? opts.speedFps : undefined,
      });
    case "caption":
      return buildCaption({
        inputName,
        text: opts.text ?? "",
        position: opts.position ?? "bottom",
        fontSize: opts.fontSize ?? 32,
      });
    case "split":
      return buildSplit({
        inputName,
        everyNth: opts.everyNth ?? 1,
        frames: opts.frames ?? 8,
      });
    default:
      return {
        error: `"${String(operation)}" is not one of the operations this tool knows.`,
        fix: "Pick resize, crop, optimize, reverse, speed, caption or split.",
      };
  }
}

function describeSource(input: Uint8Array): string {
  const info = readGifInfo(input);
  if (!info) return "Not a readable GIF file.";
  const parts = [`${info.width} x ${info.height} px`, `${info.frames} frames`];
  if (info.durationMs > 0) parts.push(`${(info.durationMs / 1000).toFixed(2)} s`);
  if (info.fps !== null) parts.push(`${info.fps} fps average`);
  return parts.join(", ");
}

/**
 * The headless view of the tool: what would run, and what the file contains.
 *
 * The encode itself needs ffmpeg.wasm and therefore a browser, so this reports
 * the plan rather than pretending to produce a GIF. The GIF header is parsed
 * here in plain TypeScript, so the file summary is real either way.
 */
export function run(input: Uint8Array | string, opts: GifOptions = {}): Record<string, string> {
  if (typeof input === "string") {
    if (!input.trim()) {
      throw new ToolError(
        "empty-input",
        "No GIF was provided.",
        "Drop a .gif file on the input, or pick one with the file button.",
      );
    }
    throw new ToolError(
      "not-a-gif",
      "This tool reads GIF files, not text.",
      "Drop a .gif file on the input instead of pasting text.",
    );
  }

  const operation = (opts.operation ?? "resize") as GifOperation;
  const inputName = "in.gif";
  const plan = planFor(operation, inputName, opts);

  if (isRefusal(plan)) {
    throw new ToolError("cannot-plan", plan.error, plan.fix);
  }

  return {
    Operation: OPERATION_LABELS[operation] ?? operation,
    Source: describeSource(input),
    Command: formatCommand(plan.args),
    "Output files": plan.outputs.join(", "),
    Note: OPERATION_NOTES[operation] ?? "",
  };
}

export default { run } satisfies ToolLogic<Uint8Array | string, Record<string, string>, GifOptions>;
