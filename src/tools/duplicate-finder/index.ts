/**
 * Duplicate finder: the pure half.
 *
 * The whole trick of a usable browser duplicate finder is what it refuses to
 * read. Two files can only hold the same bytes if they hold the same number of
 * bytes, so a size collision is the cheapest possible filter and a scan already
 * carries every size. Group by size first, throw away every bucket of one, and
 * a folder of 5,000 files usually leaves 80 or so candidates worth hashing.
 * That matters here more than it does in a native tool, because WebCrypto has
 * no streaming digest: every hashed file has to sit in memory whole (see
 * MAX_HASH_BYTES in src/lib/fs-access.ts).
 *
 * Nothing in this file reads a file, holds a handle, or knows what a browser
 * is. The panel walks the plan this module produces, asks fs-access for one
 * hash at a time, hands the results back to `groupByHash`, and turns the
 * chosen deletions into a confirmed write batch.
 */
import { ToolError, type ToolLogic } from "../types";
import { MAX_HASH_BYTES } from "@/lib/fs-access";
import type { FsFileEntry, FsScan, WriteOp } from "@/lib/fs-access";

/* ------------------------------------------------------------------ *
 * types
 * ------------------------------------------------------------------ */

/** Which file in a group survives when the rest are deleted. */
export type KeepStrategy = "first-alpha" | "shortest-path" | "newest" | "oldest" | "shallowest";

/** The strategies, in the order a picker should offer them. */
export const KEEP_STRATEGIES: { value: KeepStrategy; label: string }[] = [
  { value: "first-alpha", label: "First by path (A to Z)" },
  { value: "shortest-path", label: "Shortest path" },
  { value: "newest", label: "Newest file" },
  { value: "oldest", label: "Oldest file" },
  { value: "shallowest", label: "Closest to the top folder" },
];

const STRATEGY_SET = new Set<string>(KEEP_STRATEGIES.map((s) => s.value));

/** The sentinel hash used for the zero byte group, which is never hashed. */
export const EMPTY_FILE_HASH = "zero-bytes";

/**
 * Every empty file is byte for byte identical to every other empty file, which
 * is true and almost never what someone means by a duplicate. They get their
 * own group, with this note, and no suggested deletion.
 */
export const EMPTY_FILE_NOTE =
  "Every empty file is technically identical to every other empty file. They take up no space, so deleting them reclaims nothing. Keep or remove them on their own merits.";

/** A set of files that hold exactly the same bytes. */
export interface DuplicateGroup {
  /** Lowercase hex digest shared by every file here, or `EMPTY_FILE_HASH`. */
  hash: string;
  /** Byte size shared by every file here. */
  size: number;
  /** The files, sorted by path. */
  files: FsFileEntry[];
  /** What deleting all but one would free: `size * (files.length - 1)`. */
  wastedBytes: number;
  /** Set when the group is something other than a verified content match. */
  note?: string;
}

/** What actually needs hashing, and what was ruled out without reading a byte. */
export interface HashPlan {
  /** The files to hash, ordered by size then path. Nothing else is read. */
  files: FsFileEntry[];
  /** `files.length`, for the "hashing 84 of 5,000" line. */
  candidateCount: number;
  /** Every file in the scan. */
  totalFiles: number;
  /** Files no other file shares a size with, so they cannot have a content twin. */
  uniqueBySize: number;
  /** Zero byte files that the scan really did read. */
  emptyFiles: FsFileEntry[];
  /**
   * Buckets where every file is past the hashing ceiling. A bucket is one size,
   * so it is either entirely hashable or entirely not, and these are reported
   * as a size match that was never verified rather than quietly dropped.
   */
  sizeOnlyGroups: FsFileEntry[][];
  /**
   * Files the scan could not open. `scanDirectory` records those as zero bytes
   * with no timestamp, so they would otherwise land in the empty file group and
   * a real file could be deleted as "empty".
   */
  unreadable: FsFileEntry[];
  /** Bytes that will be read to produce the hashes. */
  bytesToHash: number;
}

/** One hashed candidate, as the panel hands them back. */
export interface HashedFile {
  entry: FsFileEntry;
  hash: string;
}

/** The headline numbers for a finished run. */
export interface DuplicateSummary {
  /** Groups holding two or more identical files. */
  groupCount: number;
  /** Files across every group. */
  totalFiles: number;
  /** Files that could go: one keeper per group stays. */
  duplicateFiles: number;
  /** Bytes freed by deleting every duplicate. */
  reclaimableBytes: number;
  /** The same number, in units a person reads. */
  reclaimableHuman: string;
  /** The five groups wasting the most space. */
  largest: DuplicateGroup[];
}

export interface DuplicateFinderOpts {
  keep?: KeepStrategy;
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/** Bytes in units a person reads. Binary units, matching what a file manager shows. */
export function humanBytes(bytes: number): string {
  const n = Math.max(0, Math.round(bytes));
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function byPath(a: FsFileEntry, b: FsFileEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** How many segments deep a path sits. `a.txt` is 1, `a/b.txt` is 2. */
export function pathDepth(path: string): number {
  return String(path ?? "")
    .split("/")
    .filter(Boolean).length;
}

/**
 * True for an entry the scan could not actually open.
 *
 * `scanDirectory` records a locked, vanished or permission-blocked file as
 * `{ size: 0, lastModified: 0 }` so a plan still sees it. A file that is
 * genuinely empty still carries a real modification time, so the pair of zeroes
 * is the signature of "unknown", and treating it as empty would be a way to
 * delete a real file by accident.
 */
export function isUnreadable(entry: FsFileEntry): boolean {
  return entry.size === 0 && entry.lastModified === 0;
}

/* ------------------------------------------------------------------ *
 * step 1: group by size
 * ------------------------------------------------------------------ */

/**
 * The candidate set: every size that more than one file shares.
 *
 * Zero byte files are left out entirely. They are handled separately, because
 * "identical" is technically true of all of them and useless as advice, and
 * because an unreadable file is indistinguishable from an empty one by size.
 *
 * Keys come out in ascending size order and each bucket is sorted by path, so
 * two runs over the same folder produce the same plan.
 */
export function groupBySize(scan: FsScan): Map<number, FsFileEntry[]> {
  const buckets = new Map<number, FsFileEntry[]>();

  for (const entry of scan?.entries ?? []) {
    if (entry.size <= 0) continue;
    const bucket = buckets.get(entry.size);
    if (bucket) bucket.push(entry);
    else buckets.set(entry.size, [entry]);
  }

  const out = new Map<number, FsFileEntry[]>();
  for (const size of [...buckets.keys()].sort((a, b) => a - b)) {
    const files = buckets.get(size) as FsFileEntry[];
    // A size only one file has cannot be a content match, and skipping it here
    // is the entire reason this tool is usable on a big folder.
    if (files.length < 2) continue;
    out.set(size, [...files].sort(byPath));
  }

  return out;
}

/** Zero byte files the scan really did read, sorted by path. */
export function emptyFiles(scan: FsScan): FsFileEntry[] {
  return (scan?.entries ?? []).filter((e) => e.size === 0 && !isUnreadable(e)).sort(byPath);
}

/**
 * The zero byte files as a reported group, or null when there are fewer than
 * two of them. It carries `EMPTY_FILE_NOTE` and wastes nothing, so the panel
 * shows it without suggesting a deletion.
 */
export function emptyFileGroup(scan: FsScan): DuplicateGroup | null {
  const files = emptyFiles(scan);
  if (files.length < 2) return null;
  return { hash: EMPTY_FILE_HASH, size: 0, files, wastedBytes: 0, note: EMPTY_FILE_NOTE };
}

/* ------------------------------------------------------------------ *
 * step 2: plan the hashing
 * ------------------------------------------------------------------ */

/**
 * Work out which files actually have to be read.
 *
 * This is the optimization the tool lives on, so it also reports the numbers
 * that justify it: how many files the folder holds, how many are already ruled
 * out by size alone, and how many bytes the hashing pass will read.
 */
export function planHashing(scan: FsScan): HashPlan {
  const entries = scan?.entries ?? [];
  const buckets = groupBySize(scan);

  const files: FsFileEntry[] = [];
  const sizeOnlyGroups: FsFileEntry[][] = [];
  let bucketed = 0;
  let bytesToHash = 0;

  for (const [size, bucket] of buckets) {
    bucketed += bucket.length;
    // Every file in a bucket is the same size, so a bucket is either entirely
    // hashable or entirely past the ceiling. Never a mix.
    if (size > MAX_HASH_BYTES) {
      sizeOnlyGroups.push(bucket);
      continue;
    }
    files.push(...bucket);
    bytesToHash += size * bucket.length;
  }

  const unreadable = entries.filter(isUnreadable).sort(byPath);
  const empty = emptyFiles(scan);

  return {
    files,
    candidateCount: files.length,
    totalFiles: entries.length,
    uniqueBySize: Math.max(0, entries.length - unreadable.length - empty.length - bucketed),
    emptyFiles: empty,
    sizeOnlyGroups,
    unreadable,
    bytesToHash,
  };
}

/** The one line a panel shows before it starts reading anything. */
export function describePlan(plan: HashPlan): string {
  const total = plan.totalFiles.toLocaleString();
  if (plan.candidateCount === 0) {
    return `No file in this folder shares a size with another, so there is nothing to hash. All ${total} files are unique by size.`;
  }
  return `Hashing ${plan.candidateCount.toLocaleString()} of ${total} files (${plan.uniqueBySize.toLocaleString()} are unique by size, so they cannot have a twin), reading ${humanBytes(plan.bytesToHash)}.`;
}

/* ------------------------------------------------------------------ *
 * step 3: group by hash
 * ------------------------------------------------------------------ */

/**
 * Turn hashed candidates into duplicate groups.
 *
 * The point of the hashing pass is right here: files that collided on size go
 * their separate ways unless the digest matches too, so a size collision on its
 * own never produces a group.
 *
 * Order is fixed rather than whatever order the hashes finished in: files
 * sorted by path inside a group, groups by wasted space descending with the
 * hash breaking ties.
 */
export function groupByHash(hashedFiles: HashedFile[]): DuplicateGroup[] {
  const byHash = new Map<string, Map<string, FsFileEntry>>();

  for (const item of hashedFiles ?? []) {
    const entry = item?.entry;
    const hash = typeof item?.hash === "string" ? item.hash.trim().toLowerCase() : "";
    if (!entry || !entry.path) {
      throw new ToolError(
        "missing-entry",
        "A hashed result came back without the file it belongs to.",
        "Pass one { entry, hash } pair per hashed file, using the entries from planHashing.",
      );
    }
    if (!hash) {
      throw new ToolError(
        "missing-hash",
        `No hash was given for "${entry.path}".`,
        "Hash every candidate before grouping, and leave out any file whose hash failed rather than passing an empty string.",
      );
    }
    const group = byHash.get(hash) ?? new Map<string, FsFileEntry>();
    // Keyed by path, so hashing the same file twice does not invent a duplicate.
    group.set(entry.path, entry);
    byHash.set(hash, group);
  }

  const groups: DuplicateGroup[] = [];
  for (const [hash, members] of byHash) {
    const files = [...members.values()].sort(byPath);
    if (files.length < 2) continue;
    const size = files[0]?.size ?? 0;
    groups.push({ hash, size, files, wastedBytes: size * (files.length - 1) });
  }

  return groups.sort(
    (a, b) => b.wastedBytes - a.wastedBytes || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
  );
}

/* ------------------------------------------------------------------ *
 * step 4: choose what survives
 * ------------------------------------------------------------------ */

function assertStrategy(keepStrategy: KeepStrategy): void {
  if (!STRATEGY_SET.has(keepStrategy)) {
    throw new ToolError(
      "unknown-keep-strategy",
      `"${String(keepStrategy)}" is not a way of choosing which copy to keep.`,
      `Use one of: ${KEEP_STRATEGIES.map((s) => s.value).join(", ")}.`,
    );
  }
}

/**
 * The file in a group that survives.
 *
 * Every strategy falls back to path order, so the answer never depends on the
 * order the files arrived in: two folders with the same contents give the same
 * keeper.
 */
export function chooseKeeper(group: DuplicateGroup, keepStrategy: KeepStrategy): FsFileEntry {
  assertStrategy(keepStrategy);

  const files = group?.files ?? [];
  if (files.length < 2) {
    throw new ToolError(
      "not-a-duplicate-group",
      "A duplicate group needs at least two files before one of them can be kept.",
      "Only pass groups that groupByHash returned, which always hold two or more files.",
    );
  }

  const ranked = [...files].sort((a, b) => {
    switch (keepStrategy) {
      case "shortest-path":
        return a.path.length - b.path.length || byPath(a, b);
      case "newest":
        return b.lastModified - a.lastModified || byPath(a, b);
      case "oldest":
        return a.lastModified - b.lastModified || byPath(a, b);
      case "shallowest":
        return (
          pathDepth(a.path) - pathDepth(b.path) || a.path.length - b.path.length || byPath(a, b)
        );
      default:
        return byPath(a, b);
    }
  });

  return ranked[0] as FsFileEntry;
}

/**
 * The deletions that leave exactly one copy of a group behind.
 *
 * This only ever computes a suggestion. Nothing here deletes anything: the
 * panel has to show every path, take an explicit confirmation per group, and
 * hand the ops to the write flow in `src/lib/fs-access.ts`, which builds an
 * undo manifest before a single file is touched.
 */
export function chooseDeletions(group: DuplicateGroup, keepStrategy: KeepStrategy): WriteOp[] {
  const keeper = chooseKeeper(group, keepStrategy);
  return group.files
    .filter((file) => file.path !== keeper.path)
    .map((file) => ({ op: "delete", path: file.path }));
}

/**
 * The same suggestion across every group. Empty byte groups are skipped: they
 * free nothing, so deleting them is a decision this tool has no business
 * making for anybody.
 */
export function planDeletions(groups: DuplicateGroup[], keepStrategy: KeepStrategy): WriteOp[] {
  assertStrategy(keepStrategy);
  return (groups ?? [])
    .filter((group) => group.hash !== EMPTY_FILE_HASH && group.files.length > 1)
    .flatMap((group) => chooseDeletions(group, keepStrategy));
}

/* ------------------------------------------------------------------ *
 * step 5: summarize
 * ------------------------------------------------------------------ */

/** The headline numbers, ignoring the zero byte group because it frees nothing. */
export function summarize(groups: DuplicateGroup[]): DuplicateSummary {
  const real = (groups ?? []).filter((g) => g.hash !== EMPTY_FILE_HASH && g.files.length > 1);

  let totalFiles = 0;
  let duplicateFiles = 0;
  let reclaimableBytes = 0;
  for (const group of real) {
    totalFiles += group.files.length;
    duplicateFiles += group.files.length - 1;
    reclaimableBytes += group.wastedBytes;
  }

  return {
    groupCount: real.length,
    totalFiles,
    duplicateFiles,
    reclaimableBytes,
    reclaimableHuman: humanBytes(reclaimableBytes),
    largest: [...real].sort((a, b) => b.wastedBytes - a.wastedBytes).slice(0, 5),
  };
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const USAGE_ROWS: Record<string, string> = {
  "How this works":
    "Choose a folder and the tool walks it once, then compares sizes. Only files that share a size with another file get read and hashed, because two files cannot hold the same bytes unless they hold the same number of bytes. A folder of several thousand files usually leaves a few dozen worth reading.",
  "Why it is fast":
    "The scan reads names, sizes and timestamps, never contents. Hashing is the expensive part, so it runs on the short list of same size candidates rather than on the whole folder.",
  "What counts as identical":
    "A SHA-256 digest of the file contents. Names, extensions and timestamps are ignored, so two copies of the same photo match even when one is called IMG_0421.jpg and the other Copy of holiday.jpg.",
  "Very large files":
    "Anything past 256 MB is reported as a size match that was not verified. Hashing in a browser has to hold the whole file in memory at once, so the tool says so instead of freezing the tab.",
  "Empty files":
    "Zero byte files are listed on their own. They are all identical to each other, and deleting them frees nothing, so the tool never suggests removing them.",
  Deleting:
    "Nothing is deleted until you pick which copy to keep in each group and confirm. Deletion is permanent: it frees the bytes, and the undo file records what went, not the contents.",
  Browsers:
    "Opening a folder in place needs the File System Access API, which Chromium browsers such as Chrome, Edge, Brave and Opera ship on desktop. Firefox and Safari do not support it yet.",
  Privacy: "Everything runs in this tab: your files and inputs never leave your device.",
};

/**
 * This tool is panel first: the folder, the handles and the hashing only exist
 * in a live browser session, so there is nothing for a text in, text out call
 * to transform. `run` returns how it works, and the real surface is the panel,
 * which drives the exported functions above.
 */
export function run(
  _input: string = "",

  _opts: DuplicateFinderOpts = {},
): Record<string, string> {
  return { ...USAGE_ROWS };
}

export default { run } satisfies ToolLogic<string, Record<string, string>, DuplicateFinderOpts>;
