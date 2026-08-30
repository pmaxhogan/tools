import { ToolError, type ToolLogic } from "../types";

/** The line that splits the original text from the unified diff in the single input box. */
export const SEPARATOR = "=====";

export interface PatchOpts {
  /** Apply the diff backwards so a patched text can be turned back into the original. */
  reverse: boolean;
  /** "preserve" | "lf" | "crlf". */
  lineEndings: string;
  /** Compare context and removed lines with trailing spaces and tabs stripped. */
  ignoreWhitespace: boolean;
  [key: string]: unknown;
}

export type PatchResult = Record<string, string>;

/* ------------------------------------------------------------------ *
 * Splitting the single input box
 * ------------------------------------------------------------------ */

/**
 * Split on the first line whose content (ignoring a trailing \r) is exactly
 * `=====`. Everything before it is the original text, everything after it is
 * the unified diff. Same convention as the diff checker.
 */
function splitInput(input: string): [string, string] {
  const lines = input.split("\n");
  const idx = lines.findIndex((line) => line.replace(/\r$/, "") === SEPARATOR);
  if (idx === -1) {
    throw new ToolError(
      "missing-separator",
      "Could not find the ===== separator line between the original text and the diff.",
      "Paste the original text, then a line with just =====, then the unified diff.",
    );
  }
  return [lines.slice(0, idx).join("\n"), lines.slice(idx + 1).join("\n")];
}

/* ------------------------------------------------------------------ *
 * Line endings
 *
 * CRLF policy, stated once so the whole file follows it: both halves are
 * normalized to LF before anything is compared, so a CRLF original patches
 * cleanly against an LF diff and the reverse. The ending is measured on the
 * original half only (the diff is a carrier, not the document), and it is
 * restored on output: "preserve" writes whatever the original predominantly
 * used, "lf" and "crlf" force one. An original with no line breaks at all
 * falls back to LF.
 * ------------------------------------------------------------------ */

export type Ending = "lf" | "crlf";

interface EndingCounts {
  crlf: number;
  lf: number;
}

/**
 * Count the line breaks in the original half. The half is cut at a line
 * boundary, so its final break lives on the other side of the split and only a
 * leftover \r is left behind to prove it was a CRLF. That leftover is counted
 * as the break it was, which is what keeps a three line CRLF file from looking
 * half LF.
 */
function countOriginalEndings(text: string): EndingCounts {
  const boundaryWasCrlf = text.endsWith("\r");
  const body = boundaryWasCrlf ? text.slice(0, -1) : text;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const total = (body.match(/\n/g) ?? []).length;
  return { crlf: crlf + (boundaryWasCrlf ? 1 : 0), lf: total - crlf };
}

/**
 * Strip a trailing \r from every line. A plain `replace(/\r\n/g, "\n")` is not
 * enough here: the half before the separator ends at a line boundary, so its
 * last line keeps a lone \r that would otherwise never match the diff.
 */
function normalizeEndings(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .join("\n");
}

function endingLabel(ending: Ending): string {
  return ending === "crlf" ? "CRLF" : "LF";
}

/* ------------------------------------------------------------------ *
 * Lines
 * ------------------------------------------------------------------ */

interface Document {
  lines: string[];
  endsWithNewline: boolean;
}

function toDocument(text: string): Document {
  if (text === "") return { lines: [], endsWithNewline: false };
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
    return { lines, endsWithNewline: true };
  }
  return { lines, endsWithNewline: false };
}

/* ------------------------------------------------------------------ *
 * Parsing the unified diff
 * ------------------------------------------------------------------ */

export type EntryKind = "context" | "add" | "del";

export interface HunkEntry {
  kind: EntryKind;
  text: string;
  /** The `\ No newline at end of file` marker was attached to this line. */
  noNewline: boolean;
}

export interface Hunk {
  /** 1-based position of this hunk in the whole diff, used in error messages. */
  index: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  entries: HunkEntry[];
}

export interface PatchFile {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function badHeader(index: number, line: string): ToolError {
  return new ToolError(
    "bad-hunk-header",
    `Hunk ${index} has a header this tool cannot read: "${line}".`,
    "A hunk header looks like @@ -12,7 +12,9 @@ where the numbers are the starting line and the line count on each side. Line numbers start at 1.",
  );
}

function countMismatch(hunk: { index: number; oldCount: number; newCount: number }): ToolError {
  return new ToolError(
    "hunk-count-mismatch",
    `Hunk ${hunk.index} claims ${plural(hunk.oldCount, "original line")} and ${plural(hunk.newCount, "patched line")}, but its body does not add up to that.`,
    "Fix the numbers in the @@ header, or re-export the diff with git diff so the counts match the hunk body.",
  );
}

/** A path from a `--- ` or `+++ ` header, without the trailing timestamp column. */
function headerPath(rest: string): string {
  return rest.split("\t")[0].trim();
}

/**
 * A line that clearly belongs to a hunk body rather than to the junk that can
 * follow the last hunk. The exclusions matter: git format-patch ends its output
 * with a "-- " signature line and a version, and the next file's `--- ` and
 * `+++ ` headers also start with a body-looking character.
 */
function looksLikeBody(line: string): boolean {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return false;
  if (line === "--" || line === "-- ") return false;
  return line.startsWith(" ") || line.startsWith("+") || line.startsWith("-");
}

export function parseDiff(diffText: string): PatchFile[] {
  const lines = toDocument(diffText).lines;
  const files: PatchFile[] = [];
  let hunkIndex = 0;
  let i = 0;

  const startFile = (): PatchFile => {
    const file: PatchFile = { oldPath: "", newPath: "", hunks: [] };
    files.push(file);
    return file;
  };
  /** The file section being read, which is always the last one opened. */
  const ensureFile = (): PatchFile => (files.length === 0 ? startFile() : files[files.length - 1]);

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      const file = startFile();
      const parts = /^diff --git (\S+) (\S+)$/.exec(line);
      if (parts) {
        file.oldPath = parts[1];
        file.newPath = parts[2];
      }
      i++;
      continue;
    }

    if (line.startsWith("--- ")) {
      // A `--- ` outside a hunk body always opens a file section, so a second
      // one after hunks have been collected means the next file in the patch.
      const open = files.length === 0 ? null : files[files.length - 1];
      const file = open === null || open.hunks.length > 0 ? startFile() : open;
      file.oldPath = headerPath(line.slice(4));
      i++;
      continue;
    }

    if (line.startsWith("+++ ")) {
      ensureFile().newPath = headerPath(line.slice(4));
      i++;
      continue;
    }

    if (line.startsWith("@@")) {
      hunkIndex++;
      const parsed = HUNK_HEADER.exec(line);
      if (!parsed) throw badHeader(hunkIndex, line);

      const oldStart = Number(parsed[1]);
      const oldCount = parsed[2] === undefined ? 1 : Number(parsed[2]);
      const newStart = Number(parsed[3]);
      const newCount = parsed[4] === undefined ? 1 : Number(parsed[4]);
      // Line numbers are 1-based, so a start of 0 is only legal alongside a
      // count of 0, which is how a patch says "insert here, replace nothing".
      if ((oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) {
        throw badHeader(hunkIndex, line);
      }

      const hunk: Hunk = { index: hunkIndex, oldStart, oldCount, newStart, newCount, entries: [] };
      let oldSeen = 0;
      let newSeen = 0;
      i++;

      while (oldSeen < hunk.oldCount || newSeen < hunk.newCount) {
        if (i >= lines.length) throw countMismatch(hunk);
        const body = lines[i];

        // Match on the backslash alone: some tools translate the sentence that
        // follows it, and GNU patch keys on the backslash too.
        if (body.startsWith("\\")) {
          const last = hunk.entries[hunk.entries.length - 1];
          if (last) last.noNewline = true;
          i++;
          continue;
        }

        // Many editors and mail clients strip the single space that marks an
        // unchanged blank line, leaving a bare empty line in the middle of a
        // hunk. Treat it as the empty context line it was meant to be.
        if (body === "") {
          hunk.entries.push({ kind: "context", text: "", noNewline: false });
          oldSeen++;
          newSeen++;
          i++;
          continue;
        }

        const text = body.slice(1);
        if (body.startsWith(" ")) {
          hunk.entries.push({ kind: "context", text, noNewline: false });
          oldSeen++;
          newSeen++;
        } else if (body.startsWith("+")) {
          hunk.entries.push({ kind: "add", text, noNewline: false });
          newSeen++;
        } else if (body.startsWith("-")) {
          hunk.entries.push({ kind: "del", text, noNewline: false });
          oldSeen++;
        } else if (body.startsWith("@@") || body.startsWith("diff --git ")) {
          throw countMismatch(hunk);
        } else {
          throw new ToolError(
            "unknown-hunk-line",
            `Hunk ${hunkIndex} contains a line this tool cannot read: "${body}".`,
            "Every line inside a hunk starts with a space for context, a plus for an addition, a minus for a deletion, or a backslash for the no newline marker.",
          );
        }
        i++;
      }

      if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) throw countMismatch(hunk);

      while (i < lines.length && lines[i].startsWith("\\")) {
        const last = hunk.entries[hunk.entries.length - 1];
        if (last) last.noNewline = true;
        i++;
      }

      if (i < lines.length && looksLikeBody(lines[i])) throw countMismatch(hunk);

      ensureFile().hunks.push(hunk);
      continue;
    }

    // Everything else (index lines, mode lines, commit messages, the trailing
    // signature after the last hunk) is header noise this tool does not need.
    i++;
  }

  return files;
}

/* ------------------------------------------------------------------ *
 * Reversing
 * ------------------------------------------------------------------ */

/**
 * Swap the two sides of a hunk. Additions become deletions, the old and new
 * line numbers trade places, and the no newline marker rides along on the entry
 * it was attached to, which is what keeps a round trip exact.
 */
export function reverseHunk(hunk: Hunk): Hunk {
  return {
    index: hunk.index,
    oldStart: hunk.newStart,
    oldCount: hunk.newCount,
    newStart: hunk.oldStart,
    newCount: hunk.oldCount,
    entries: hunk.entries.map((entry) => ({
      kind: entry.kind === "add" ? "del" : entry.kind === "del" ? "add" : "context",
      text: entry.text,
      noNewline: entry.noNewline,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Applying, with fuzz 0
 * ------------------------------------------------------------------ */

function linesMatch(actual: string, expected: string, ignoreWhitespace: boolean): boolean {
  if (actual === expected) return true;
  if (!ignoreWhitespace) return false;
  return actual.replace(/[ \t]+$/, "") === expected.replace(/[ \t]+$/, "");
}

export function contextMismatchError(
  hunkIndex: number,
  lineNumber: number,
  expected: string,
  actual: string | null,
): ToolError {
  const found = actual === null ? "the end of the text" : JSON.stringify(actual);
  return new ToolError(
    "context-mismatch",
    `Hunk ${hunkIndex} does not match the original text at line ${lineNumber}: expected ${JSON.stringify(expected)} but found ${found}.`,
    "This tool applies patches with fuzz 0, so every context line and every removed line has to match the original exactly, whitespace included. Make sure the original text is the same revision the diff was made from.",
  );
}

interface ApplyResult {
  lines: string[];
  endsWithNewline: boolean;
  added: number;
  removed: number;
}

function applyHunks(
  original: Document,
  hunks: Hunk[],
  diffHasNoNewlineMarker: boolean,
  ignoreWhitespace: boolean,
): ApplyResult {
  const out: string[] = [];
  let cursor = 0;
  let endsWithNewline = original.endsWithNewline;
  let added = 0;
  let removed = 0;

  const copyOriginalTo = (upto: number): void => {
    for (; cursor < upto; cursor++) {
      out.push(original.lines[cursor]);
      endsWithNewline = original.endsWithNewline;
    }
  };

  /**
   * A diff that carries no marker at all says nothing about the final newline,
   * so the original's own trailing newline is kept. A diff that does carry one
   * is describing both files' endings, so the marker wins.
   */
  const endingFor = (entry: HunkEntry): boolean =>
    diffHasNoNewlineMarker ? !entry.noNewline : original.endsWithNewline;

  for (const hunk of hunks) {
    // A count of 0 means the hunk inserts after line oldStart rather than
    // replacing anything, so it does not shift back by one.
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;

    if (start > original.lines.length) {
      throw new ToolError(
        "hunk-past-end",
        `Hunk ${hunk.index} starts at original line ${hunk.oldStart}, but the original text only has ${plural(original.lines.length, "line")}.`,
        "The diff was almost certainly made from a longer file. Paste that full original above the ===== line.",
      );
    }
    if (start < cursor) {
      throw new ToolError(
        "overlapping-hunks",
        `Hunk ${hunk.index} starts at original line ${hunk.oldStart}, which an earlier hunk already consumed.`,
        "Hunks have to run in ascending order and must not overlap. Re-export the diff instead of reordering hunks by hand.",
      );
    }

    copyOriginalTo(start);

    for (const entry of hunk.entries) {
      if (entry.kind === "add") {
        out.push(entry.text);
        endsWithNewline = endingFor(entry);
        added++;
        continue;
      }
      const actual = cursor < original.lines.length ? original.lines[cursor] : null;
      if (actual === null || !linesMatch(actual, entry.text, ignoreWhitespace)) {
        throw contextMismatchError(hunk.index, cursor + 1, entry.text, actual);
      }
      if (entry.kind === "context") {
        out.push(actual);
        endsWithNewline = endingFor(entry);
      } else {
        removed++;
      }
      cursor++;
    }
  }

  copyOriginalTo(original.lines.length);
  return { lines: out, endsWithNewline, added, removed };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function describeFile(file: PatchFile): string {
  const from = file.oldPath || "(unnamed)";
  const to = file.newPath || "(unnamed)";
  return from === to ? from : `${from} -> ${to}`;
}

function filesRow(files: PatchFile[], applied: PatchFile[]): string {
  const named = files.filter((file) => file.oldPath !== "" || file.newPath !== "");
  const rows: string[] = [];
  if (named.length === 0) {
    rows.push(
      "No file headers in the diff, so the hunks were applied to the pasted text directly.",
    );
  } else {
    for (const file of named) rows.push(describeFile(file));
  }
  if (applied.length > 1) {
    const skipped = applied.length - 1;
    rows.push(
      `Applied only the hunks for ${describeFile(applied[0])}. Skipped ${plural(skipped, "later file")} because this tool patches one pasted text, not a directory tree.`,
    );
  }
  return rows.join("\n");
}

function endingsRow(counts: EndingCounts, detected: Ending, written: Ending): string {
  if (counts.crlf === 0 && counts.lf === 0) {
    return `The original has no line breaks, so LF was assumed. Wrote ${endingLabel(written)}.`;
  }
  const mixed =
    counts.crlf > 0 && counts.lf > 0 ? ` (mixed: ${counts.crlf} CRLF, ${counts.lf} LF)` : "";
  return `Detected ${endingLabel(detected)} in the original${mixed}. Wrote ${endingLabel(written)}.`;
}

function readEndingOption(value: unknown): "preserve" | Ending {
  const raw = typeof value === "string" && value !== "" ? value : "preserve";
  if (raw === "preserve" || raw === "lf" || raw === "crlf") return raw;
  throw new ToolError(
    "bad-line-endings",
    `Unknown line endings option "${raw}".`,
    "Pick one of: preserve, lf, crlf.",
  );
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export function run(input: string, opts: PatchOpts): PatchResult {
  const raw = input ?? "";
  if (raw.trim() === "") {
    throw new ToolError(
      "empty-input",
      "There is nothing to patch yet.",
      "Paste the original text, then a line with just =====, then the unified diff.",
    );
  }

  const [originalRaw, diffRaw] = splitInput(raw);
  if (diffRaw.trim() === "") {
    throw new ToolError(
      "empty-diff",
      "The half after the ===== separator is empty, so there is no diff to apply.",
      "Paste the unified diff below the ===== line, including its @@ hunk header.",
    );
  }

  const requested = readEndingOption(opts.lineEndings);
  const counts = countOriginalEndings(originalRaw);
  const detected: Ending = counts.crlf > counts.lf ? "crlf" : "lf";
  const written: Ending = requested === "preserve" ? detected : requested;

  const original = toDocument(normalizeEndings(originalRaw));
  const files = parseDiff(normalizeEndings(diffRaw));
  const applicable = files.filter((file) => file.hunks.length > 0);

  if (applicable.length === 0) {
    throw new ToolError(
      "no-hunks",
      "The diff has no @@ hunk header, so there is nothing to apply.",
      "Paste a unified diff (git diff, diff -u, or a .patch file). A summary or a side by side diff will not work.",
    );
  }

  const reverse = opts.reverse === true;
  const hunks = reverse ? applicable[0].hunks.map(reverseHunk) : applicable[0].hunks;
  const diffHasNoNewlineMarker = applicable[0].hunks.some((hunk) =>
    hunk.entries.some((entry) => entry.noNewline),
  );

  const result = applyHunks(
    original,
    hunks,
    diffHasNoNewlineMarker,
    opts.ignoreWhitespace === true,
  );

  const eol = written === "crlf" ? "\r\n" : "\n";
  const patched = result.lines.join(eol) + (result.endsWithNewline ? eol : "");

  return {
    "Patched text": patched,
    Hunks: `${plural(hunks.length, "hunk")} applied${reverse ? " in reverse" : ""}`,
    Changes: `+${plural(result.added, "line")}, -${plural(result.removed, "line")}`,
    "Files in patch": filesRow(files, applicable),
    "Line endings": endingsRow(counts, detected, written),
  };
}

export default { run } satisfies ToolLogic<string, PatchResult, PatchOpts>;
