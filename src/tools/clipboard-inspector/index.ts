import { ToolError, type ToolLogic } from "../types";

/**
 * One entry the panel found on the clipboard. The panel calls
 * navigator.clipboard.read(), reads each ClipboardItem's blobs, and builds
 * one of these per MIME type before serializing the array to JSON.
 */
export interface ClipboardEntrySnapshot {
  /** MIME type as reported by the Clipboard API, e.g. "text/plain". */
  type: string;
  /** Size of the blob in bytes. */
  bytes: number;
  /** Decoded text content, for text/* types. */
  text?: string;
  /** Data URL prefix (up to and including the first comma), for image types. */
  dataUrlPrefix?: string;
}

export interface ClipboardSnapshot {
  entries: ClipboardEntrySnapshot[];
}

export interface ClipboardOpts {
  [key: string]: unknown;
}

const INVALID_SNAPSHOT_FIX =
  'The Read clipboard button in the panel produces this JSON automatically. If pasting one by hand, it must be an object shaped like {"entries":[{"type":"text/plain","bytes":11,"text":"hello world"}]}.';

/* ------------------------------------------------------------------ *
 * parsing / validation
 * ------------------------------------------------------------------ */

function parseSnapshot(raw: string): ClipboardSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError("invalid-snapshot", "The input is not valid JSON.", INVALID_SNAPSHOT_FIX);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "invalid-snapshot",
      "The JSON is not a clipboard snapshot object.",
      INVALID_SNAPSHOT_FIX,
    );
  }

  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new ToolError(
      "invalid-snapshot",
      'The snapshot is missing an "entries" array.',
      INVALID_SNAPSHOT_FIX,
    );
  }

  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof (entry as { type?: unknown }).type !== "string" ||
      typeof (entry as { bytes?: unknown }).bytes !== "number"
    ) {
      throw new ToolError(
        "invalid-snapshot",
        'One of the entries is missing a string "type" or a numeric "bytes" field.',
        INVALID_SNAPSHOT_FIX,
      );
    }
  }

  return { entries: entries as ClipboardEntrySnapshot[] };
}

/* ------------------------------------------------------------------ *
 * formatting helpers
 * ------------------------------------------------------------------ */

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} bytes`;
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function previewOf(text: string, max = 200): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}...`;
}

function countTags(html: string): number {
  const matches = html.match(/<\/?[a-zA-Z][^>]*>/g);
  return matches ? matches.length : 0;
}

function outermostTag(html: string): string | undefined {
  const m = /<([a-zA-Z][a-zA-Z0-9]*)\b/.exec(html);
  return m ? m[1]!.toLowerCase() : undefined;
}

function formatOf(dataUrlPrefix: string | undefined): string {
  // e.g. "data:image/png;base64" -> "png"
  const m = dataUrlPrefix ? /^data:image\/([a-zA-Z0-9+.-]+)/.exec(dataUrlPrefix) : null;
  return m ? m[1]! : "unknown";
}

function describeEntry(entry: ClipboardEntrySnapshot): string {
  const size = humanBytes(entry.bytes);

  if (entry.type.startsWith("text/html") && entry.text) {
    const tags = countTags(entry.text);
    const outer = outermostTag(entry.text) ?? "none found";
    return `${size}. ${tags} tags, outermost tag <${outer}>. Preview: "${previewOf(entry.text)}"`;
  }

  if (entry.type.startsWith("text/") && entry.text) {
    return `${size}. Preview: "${previewOf(entry.text)}"`;
  }

  if (entry.type.startsWith("image/")) {
    return `${size}. Format: ${formatOf(entry.dataUrlPrefix)}.`;
  }

  return `${size}. Binary data, no text preview available.`;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function run(input: string, _opts: ClipboardOpts): Record<string, string> {
  const raw = input ?? "";
  if (!raw.trim()) {
    throw new ToolError(
      "empty-input",
      "No clipboard snapshot to inspect.",
      "Click the Read clipboard button in the panel to fill this in, or paste a snapshot JSON manually.",
    );
  }

  const snapshot = parseSnapshot(raw);

  if (snapshot.entries.length === 0) {
    return {
      Clipboard: "The clipboard is empty, or its contents could not be read by the browser.",
    };
  }

  const out: Record<string, string> = {};
  for (const entry of snapshot.entries) {
    out[entry.type] = describeEntry(entry);
  }

  const types = snapshot.entries.map((e) => e.type);
  out.Formats = `${types.length} type${types.length === 1 ? "" : "s"}: ${types.join(", ")}`;

  const plain = snapshot.entries.find((e) => e.type === "text/plain");
  const html = snapshot.entries.find((e) => e.type === "text/html");
  if (plain && html) {
    const plainBytes = plain.bytes;
    const htmlBytes = html.bytes;
    const diff = htmlBytes - plainBytes;
    if (diff > 0) {
      const pct = plainBytes > 0 ? Math.round((diff / plainBytes) * 100) : 100;
      out["HTML vs plain text"] =
        `The HTML version is what most apps paste by default. It is ${humanBytes(diff)} larger than the plain text version (about ${pct}% bigger).`;
    } else if (diff < 0) {
      out["HTML vs plain text"] =
        `The HTML version is what most apps paste by default, and it is actually ${humanBytes(-diff)} smaller than the plain text version here.`;
    } else {
      out["HTML vs plain text"] =
        "The HTML version is what most apps paste by default. It is the same size as the plain text version.";
    }
  }

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, ClipboardOpts>;
