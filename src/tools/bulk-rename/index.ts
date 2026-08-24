import { ToolError, type ToolLogic } from "../types";
import type { FsFileEntry, FsScan, WriteOp } from "@/lib/fs-access";

/**
 * Bulk rename: the pure planning half of the tool.
 *
 * `planRenames` takes an `FsScan` (plain data produced by `src/lib/fs-access`,
 * never a real handle) plus the options a visitor set in the panel, and returns
 * three things:
 *
 *   - `ops`, the `WriteOp[]` the panel hands to `applyWrites`
 *   - `preview`, one row per scanned file so the panel can show from -> to for
 *     everything, including the files nothing happens to
 *   - `collisions`, the plain language reasons some renames were held back
 *
 * Nothing here reads or writes a file. Every decision it makes is reproducible
 * from the scan object alone, which is what makes the whole tool testable.
 *
 * Two behaviors are worth knowing before reading the code:
 *
 *   1. Order matters. `planWrites` in the FS layer replays a batch against the
 *      set of paths the scan saw, and a rename never overwrites, so shifting a
 *      run of files down by one (002 -> 001, 003 -> 002) only works if the ops
 *      come out in an order where every target is free at the moment it runs.
 *      The emission loop below produces exactly that order, and whatever it
 *      cannot place is reported as a collision rather than left to fail.
 *   2. Case only renames are split in two. Windows and macOS treat "Photo.JPG"
 *      and "photo.jpg" as the same name, so a direct rename between them is
 *      refused by the executor's "never overwrite" check. Those go through a
 *      temporary name instead, which works on every filesystem and stays fully
 *      reversible from the undo manifest.
 */

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

export type RenameMode = "find-replace" | "template" | "case" | "sequence" | "clean";
export type CaseMode = "lower" | "upper" | "title" | "kebab" | "snake" | "camel";
export type FilterMode = "none" | "glob" | "regex";
export type SortMode = "name" | "date" | "size";
export type SeparatorChoice = "dash" | "underscore" | "none";

export interface BulkRenameOpts {
  /** Which renaming strategy runs. */
  mode: RenameMode;

  /* find-replace */
  find: string;
  replace: string;
  /** Treat `find` as a regular expression, so `$1` works in `replace`. */
  regex: boolean;
  caseInsensitive: boolean;

  /* template */
  /** Tokens: {name} {ext} {n} {counter} {parent} {date}. */
  template: string;
  /** First number {n} and {counter} use. */
  seqStart: number;
  /** Zero padding width for {n}, {counter} and sequence mode. */
  seqPad: number;

  /* case */
  caseMode: CaseMode;

  /* sequence */
  prefix: string;

  /* clean */
  separator: SeparatorChoice;
  lowercase: boolean;

  /** Transform the whole filename rather than just the part before the dot. */
  includeExt: boolean;

  /* filter */
  filterMode: FilterMode;
  filter: string;

  /** Order files are numbered in, and the order the preview is listed in. */
  sortBy: SortMode;

  [key: string]: unknown;
}

export const DEFAULT_OPTS: BulkRenameOpts = {
  mode: "find-replace",
  find: "",
  replace: "",
  regex: false,
  caseInsensitive: false,
  template: "{n}-{name}",
  seqStart: 1,
  seqPad: 3,
  caseMode: "lower",
  prefix: "file-",
  separator: "dash",
  lowercase: true,
  includeExt: false,
  filterMode: "none",
  filter: "",
  sortBy: "name",
};

/* ------------------------------------------------------------------ */
/* results                                                             */
/* ------------------------------------------------------------------ */

/** One scanned file and what would happen to it. */
export interface RenamePreviewRow {
  /** Current path, relative to the scanned folder. */
  from: string;
  /**
   * Intended new path. Equal to `from` when nothing applies. When a rename is
   * held back it still shows the name that was wanted, so the warning makes
   * sense next to it.
   */
  to: string;
  /** True only when this row produced an op. Blocked rows are false. */
  changed: boolean;
  /** Why this row was cleaned up, held back, or skipped. */
  warning?: string;
}

export interface RenamePlan {
  /** Renames in an order the executor can actually run. */
  ops: WriteOp[];
  /** Every file in the scan, in the chosen sort order. */
  preview: RenamePreviewRow[];
  /** Plain language reasons some renames were held back. */
  collisions: string[];
}

/* ------------------------------------------------------------------ */
/* small path helpers                                                  */
/* ------------------------------------------------------------------ */

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function lastSegment(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Split a filename into its base and its extension, dot included. */
export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  // A leading dot is part of the name (".gitignore" has no extension).
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* filename safety                                                     */
/* ------------------------------------------------------------------ */

/**
 * The characters Windows refuses in a filename. Keeping both slashes in the
 * set is deliberate: it is what stops a template from turning into a path and
 * quietly moving the file into another folder.
 */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface SanitizeResult {
  name: string;
  warnings: string[];
}

/**
 * Make one filename safe to write on any desktop filesystem.
 *
 * This runs on the base name only, never on a path, which is also what keeps a
 * template like `{parent}/{name}` from quietly moving a file into a different
 * folder: the slash is replaced rather than treated as a separator.
 */
export function sanitizeFileName(name: string): SanitizeResult {
  const warnings: string[] = [];
  let out = name;

  const cleaned = out.replace(ILLEGAL_CHARS, "_");
  if (cleaned !== out) {
    out = cleaned;
    warnings.push(
      'Characters Windows does not allow in a filename (\\ / : * ? " < > |) were replaced with an underscore.',
    );
  }

  const trimmed = out.replace(/[. ]+$/, "");
  if (trimmed !== out) {
    out = trimmed;
    warnings.push("Trailing dots and spaces were removed, because Windows drops them silently.");
  }

  const leading = out.replace(/^ +/, "");
  if (leading !== out) {
    out = leading;
    warnings.push("A leading space was removed.");
  }

  const { base } = splitName(out);
  if (RESERVED_NAMES.test(base)) {
    out = `_${out}`;
    warnings.push(
      `"${base}" is a name Windows reserves for a device, so an underscore was added in front.`,
    );
  }

  return { name: out, warnings };
}

/* ------------------------------------------------------------------ */
/* text transforms                                                     */
/* ------------------------------------------------------------------ */

/** Break a string into words, splitting camelCase as well as separators. */
function words(text: string): string[] {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_all, lead: string, letter: string) => {
      return lead + letter.toUpperCase();
    });
}

export function applyCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "lower":
      return text.toLowerCase();
    case "upper":
      return text.toUpperCase();
    case "title":
      return titleCase(text);
    case "kebab":
      return words(text)
        .map((word) => word.toLowerCase())
        .join("-");
    case "snake":
      return words(text)
        .map((word) => word.toLowerCase())
        .join("_");
    case "camel":
      return words(text)
        .map((word, index) =>
          index === 0
            ? word.toLowerCase()
            : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join("");
    default:
      return text;
  }
}

function separatorChar(choice: SeparatorChoice): string {
  if (choice === "underscore") return "_";
  if (choice === "none") return "";
  return "-";
}

/**
 * Slugify: strip diacritics, turn whitespace into the chosen separator, drop
 * anything that is not a letter, digit, dot, dash or underscore, then collapse
 * repeated separators.
 */
export function cleanName(text: string, choice: SeparatorChoice, lowercase: boolean): string {
  const sep = separatorChar(choice);
  let out = text.normalize("NFD").replace(/\p{M}+/gu, "");
  out = out.replace(/\s+/g, sep);
  out = out.replace(/[^\p{L}\p{N}._-]+/gu, "");
  out = out
    .replace(/-{2,}/g, "-")
    .replace(/_{2,}/g, "_")
    .replace(/\.{2,}/g, ".");
  out = out.replace(/^[-_.]+/, "").replace(/[-_]+$/, "");
  return lowercase ? out.toLowerCase() : out;
}

/* ------------------------------------------------------------------ */
/* filtering and sorting                                               */
/* ------------------------------------------------------------------ */

/** Turn a shell style glob into a regular expression. `**` crosses folders. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function buildFilter(opts: BulkRenameOpts): (entry: FsFileEntry) => boolean {
  const pattern = opts.filter.trim();
  if (opts.filterMode === "none" || pattern === "") return () => true;

  if (opts.filterMode === "glob") {
    const matcher = globToRegExp(pattern);
    const wholePath = pattern.includes("/");
    return (entry) => matcher.test(wholePath ? entry.path : entry.name);
  }

  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, "i");
  } catch (error) {
    throw new ToolError(
      "bad-filter",
      `The filter is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the pattern, or switch the filter to glob and use something like *.jpg.",
    );
  }
  return (entry) => matcher.test(entry.name);
}

function sortEntries(entries: FsFileEntry[], sortBy: SortMode): FsFileEntry[] {
  const out = [...entries];
  out.sort((a, b) => {
    if (sortBy === "date" && a.lastModified !== b.lastModified) {
      return a.lastModified - b.lastModified;
    }
    if (sortBy === "size" && a.size !== b.size) return a.size - b.size;
    if (sortBy === "name" && a.name !== b.name) return a.name < b.name ? -1 : 1;
    // Path is the tie break everywhere, so two scans of the same folder always
    // number the files the same way.
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* the naming modes                                                    */
/* ------------------------------------------------------------------ */

function pad(value: number, width: number): string {
  const digits = String(Math.abs(Math.trunc(value)));
  const sign = value < 0 ? "-" : "";
  return sign + digits.padStart(Math.max(1, Math.trunc(width)), "0");
}

/** `lastModified` as YYYY-MM-DD, in UTC so a plan never depends on a timezone. */
export function dateToken(lastModified: number): string {
  if (!Number.isFinite(lastModified) || lastModified <= 0) return "";
  return new Date(lastModified).toISOString().slice(0, 10);
}

function findReplace(target: string, opts: BulkRenameOpts): string {
  if (opts.find === "") return target;

  const flags = `g${opts.caseInsensitive ? "i" : ""}`;
  let matcher: RegExp;
  try {
    matcher = new RegExp(opts.regex ? opts.find : escapeRegExp(opts.find), flags);
  } catch (error) {
    throw new ToolError(
      "bad-regex",
      `"${opts.find}" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the pattern, or turn the regex switch off to search for that text literally.",
    );
  }

  // Without regex mode, `$` in the replacement is literal text, not a group
  // reference, so it has to be escaped before String.replace sees it.
  const replacement = opts.regex ? opts.replace : opts.replace.replace(/\$/g, "$$$$");
  return target.replace(matcher, replacement);
}

interface TemplateContext {
  base: string;
  ext: string;
  parent: string;
  date: string;
  n: string;
  counter: string;
}

function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{(name|ext|n|counter|parent|date)\}/g, (_all, token: string) => {
    switch (token) {
      case "name":
        return ctx.base;
      case "ext":
        return ctx.ext;
      case "n":
        return ctx.n;
      case "counter":
        return ctx.counter;
      case "parent":
        return ctx.parent;
      default:
        return ctx.date;
    }
  });
}

/* ------------------------------------------------------------------ */
/* the plan                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fill in the defaults and coerce the text fields.
 *
 * The panel hands these across as `unknown` values from schema driven inputs,
 * and an explicit `undefined` has to fall back to the default rather than
 * overwrite it, so the merge skips undefined instead of spreading it.
 */
function resolveOpts(opts: Partial<BulkRenameOpts> = {}): BulkRenameOpts {
  const merged = { ...DEFAULT_OPTS };
  for (const [key, value] of Object.entries(opts ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  for (const key of ["find", "replace", "template", "prefix", "filter"] as const) {
    merged[key] = String(merged[key] ?? "");
  }
  return merged;
}

/** True for two names in the same folder that differ only in capitalization. */
function isCaseOnlyRename(from: string, to: string): boolean {
  return from !== to && from.toLowerCase() === to.toLowerCase();
}

function freeTempPath(target: string, occupied: Set<string>): string {
  let candidate = `${target}.renaming-tmp`;
  let counter = 1;
  while (occupied.has(candidate)) {
    candidate = `${target}.renaming-tmp${counter}`;
    counter += 1;
  }
  return candidate;
}

function addWarning(row: RenamePreviewRow, text: string) {
  row.warning = row.warning ? `${row.warning} ${text}` : text;
}

/**
 * Work out the new name for every file in a scan.
 *
 * Throws `ToolError` only for input the visitor can fix: an unusable regular
 * expression in the find field or in the filter, or an unknown mode. Everything
 * else that goes wrong for a single file becomes a warning on that file's row,
 * so one awkward name never stops the other 400 renames.
 */
export function planRenames(scan: FsScan, options: Partial<BulkRenameOpts> = {}): RenamePlan {
  const opts = resolveOpts(options);
  const preview: RenamePreviewRow[] = [];
  const collisions: string[] = [];

  const entries = sortEntries(scan?.entries ?? [], opts.sortBy);
  if (entries.length === 0) return { ops: [], preview, collisions };

  const matches = buildFilter(opts);
  const start = Math.trunc(Number.isFinite(opts.seqStart) ? opts.seqStart : 1);
  const width = Math.max(1, Math.trunc(Number.isFinite(opts.seqPad) ? opts.seqPad : 1));

  let sequence = start;
  const perExtension = new Map<string, number>();

  for (const entry of entries) {
    const row: RenamePreviewRow = { from: entry.path, to: entry.path, changed: false };
    preview.push(row);

    if (!matches(entry)) continue;

    const { base, ext } = splitName(entry.name);
    const extNoDot = ext.startsWith(".") ? ext.slice(1) : ext;

    const nextCounter = perExtension.get(extNoDot.toLowerCase()) ?? start;
    perExtension.set(extNoDot.toLowerCase(), nextCounter + 1);
    const nth = sequence;
    sequence += 1;

    const target = opts.includeExt ? entry.name : base;
    /** The transformed part. The extension is put back afterwards. */
    let body: string;
    /** True when the extension is already inside `body`. */
    let bodyHasExt = opts.includeExt;

    switch (opts.mode) {
      case "find-replace":
        body = findReplace(target, opts);
        break;
      case "template":
        body = renderTemplate(opts.template, {
          base,
          ext: extNoDot,
          parent: lastSegment(parentOf(entry.path)) || scan.rootName || "",
          date: dateToken(entry.lastModified),
          n: pad(nth, width),
          counter: pad(nextCounter, width),
        });
        break;
      case "case":
        body = applyCase(target, opts.caseMode);
        break;
      case "sequence":
        // The extension always survives here: a sequence is about ordering, and
        // a numbered file with no extension is not what anybody wants.
        body = `${opts.prefix}${pad(nth, width)}`;
        bodyHasExt = false;
        break;
      case "clean":
        body = cleanName(target, opts.separator, opts.lowercase);
        break;
      default:
        throw new ToolError(
          "unknown-mode",
          `"${String(opts.mode)}" is not a renaming mode this tool knows.`,
          "Choose find and replace, template, case, sequence or clean up.",
        );
    }

    // An emptied body means the pattern ate the whole name. Putting the
    // extension back would leave a hidden file called ".txt", which is never
    // what was meant, so the file is left alone and the row says why.
    if (body.trim() === "") {
      addWarning(row, "The new name would be empty, so this file was left alone.");
      continue;
    }

    const safe = sanitizeFileName(bodyHasExt ? body : body + ext);
    for (const warning of safe.warnings) addWarning(row, warning);

    if (safe.name === "") {
      addWarning(row, "The new name would be empty, so this file was left alone.");
      continue;
    }

    row.to = joinRelative(parentOf(entry.path), safe.name);
  }

  /* --- collisions ------------------------------------------------- */

  const candidates = preview
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.to !== row.from);

  const blocked = new Set<number>();

  // Two or more files aiming at one name. Neither one wins: the visitor picks
  // a pattern that separates them instead.
  const byTarget = new Map<string, number[]>();
  for (const { row, index } of candidates) {
    const list = byTarget.get(row.to);
    if (list) list.push(index);
    else byTarget.set(row.to, [index]);
  }
  for (const [target, indexes] of byTarget) {
    if (indexes.length < 2) continue;
    const names = indexes.map((i) => (preview[i] as RenamePreviewRow).from);
    collisions.push(
      `${names.length} files would all be renamed to "${target}": ${names.join(", ")}.`,
    );
    for (const index of indexes) {
      blocked.add(index);
      addWarning(
        preview[index] as RenamePreviewRow,
        `Another file in this batch would get the name "${target}" too, so this rename was held back.`,
      );
    }
  }

  /* --- ordering --------------------------------------------------- */

  const occupied = new Set<string>();
  for (const entry of scan.entries) occupied.add(entry.path);
  for (const dir of scan.directories ?? []) occupied.add(dir.path);

  const movingAway = new Set(
    candidates.filter(({ index }) => !blocked.has(index)).map(({ row }) => row.from),
  );

  // A name that already exists in a different case is the same name on Windows
  // and macOS. Not a hard block, because it is perfectly legal on Linux, but
  // worth saying before the executor skips the op.
  const lowerToPath = new Map<string, string>();
  for (const path of occupied) lowerToPath.set(path.toLowerCase(), path);
  for (const { row, index } of candidates) {
    if (blocked.has(index)) continue;
    if (isCaseOnlyRename(row.from, row.to)) continue;
    const clash = lowerToPath.get(row.to.toLowerCase());
    if (clash && clash !== row.from && clash !== row.to && !movingAway.has(clash)) {
      addWarning(
        row,
        `"${clash}" already exists with different capitalization, and Windows and macOS treat that as the same name, so this rename may be skipped there.`,
      );
    }
  }

  const ops: WriteOp[] = [];
  let remaining = candidates.filter(({ index }) => !blocked.has(index));

  // Emit any rename whose target is free right now, then look again: that is
  // what lets a whole run shift down by one without any file overwriting the
  // next. Whatever is still stuck when nothing moves is a real collision.
  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    const stuck: typeof remaining = [];

    for (const item of remaining) {
      const { row } = item;

      // Checked before the case only branch, because on a case sensitive
      // filesystem both spellings can genuinely exist side by side.
      if (occupied.has(row.to)) {
        stuck.push(item);
        continue;
      }

      if (isCaseOnlyRename(row.from, row.to)) {
        // Same name, different capitalization. Going through a temporary name
        // is the only form of this rename that works on a case insensitive
        // filesystem, and both steps are in the undo manifest.
        const temp = freeTempPath(row.to, occupied);
        ops.push({ op: "rename", from: row.from, to: temp });
        ops.push({ op: "rename", from: temp, to: row.to });
        occupied.delete(row.from);
        occupied.add(row.to);
        row.changed = true;
        progressed = true;
        continue;
      }

      ops.push({ op: "rename", from: row.from, to: row.to });
      occupied.delete(row.from);
      occupied.add(row.to);
      row.changed = true;
      progressed = true;
    }

    remaining = stuck;
  }

  const stuckSources = new Set(remaining.map(({ row }) => row.from));
  for (const { row } of remaining) {
    if (stuckSources.has(row.to)) {
      collisions.push(
        `"${row.from}" and "${row.to}" would swap names, which cannot be done in one pass.`,
      );
      addWarning(
        row,
        "These names form a loop, so the rename was held back. Rename one of them to something else first.",
      );
    } else {
      collisions.push(`"${row.to}" already exists, and a rename never overwrites a file.`);
      addWarning(row, `"${row.to}" already exists, so this rename was held back.`);
    }
  }

  return { ops, preview, collisions };
}

/* ------------------------------------------------------------------ */
/* the generic surface                                                 */
/* ------------------------------------------------------------------ */

const USAGE_ROWS: Record<string, string> = {
  "How this works":
    "This tool is panel first. Choose a folder, and the panel reads it in place and shows every file with the name it would get. Nothing is written until you press Apply renames, review the exact list, and confirm.",
  Modes:
    "Find and replace (with optional regular expressions and $1 group references), template (tokens {name}, {ext}, {n}, {counter}, {parent} and {date}), case (lower, upper, title, kebab, snake, camel), sequence (a prefix plus a zero padded number) and clean up (strip accents, tidy spaces and drop characters that cause trouble).",
  Safety:
    "Every plan is checked before it runs: two files aiming at one name, a name that already exists, and names that would swap are all held back and listed. Renames come out in an order that lets a whole run shift down by one without any file overwriting the next.",
  Undo: "An undo file listing the reverse of every rename downloads before anything is written, and it stays on your device.",
  Browsers:
    "Opening a folder in place needs the File System Access API, which Chromium browsers such as Chrome, Edge, Brave and Opera ship on desktop. Firefox and Safari do not support it yet.",
  Privacy: "Everything happens in this tab: your files and inputs never leave your device.",
};

/**
 * With no input this returns the usage rows, because the real surface is the
 * folder panel: a rename plan needs a folder handle, and the pure layer only
 * ever sees the plain scan the panel hands it.
 */
export function run(): Record<string, string> {
  return { ...USAGE_ROWS };
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<BulkRenameOpts>>;
