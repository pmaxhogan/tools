/**
 * The shared File System Access layer for the folder tools (Phase 5): bulk
 * rename, duplicate finder, folder diff, batch processor.
 *
 * ============================================================================
 * THE CONTRACT (quote this block in a tool's implementation prompt)
 * ============================================================================
 *
 * A folder tool is split in three, and the middle piece is the only one that
 * carries the tool's actual thinking:
 *
 *   1. This library owns every real handle. It picks a directory, walks it
 *      once, and turns it into `FsScan`, which is plain serializable data.
 *   2. The tool's logic layer in `src/tools/<slug>/index.ts` stays pure
 *      (rule 27). It takes an `FsScan` (plus its own options) and returns a
 *      `WriteOp[]`, or a report. It never sees a handle, never reads a file,
 *      never writes one. A unit test builds an `FsScan` object literal by
 *      hand and asserts on the `WriteOp[]` that comes back.
 *   3. This library executes the plan. `planWrites` checks it against the
 *      scan and produces the undo manifest; `executeWriteOps` performs it.
 *
 * So the injected interface a pure logic layer consumes is:
 *
 *   interface FsEntry       { kind: 'file' | 'directory'; name: string; path: string }
 *   interface FsFileEntry   extends FsEntry { kind: 'file'; size: number; lastModified: number }
 *   interface FsDirEntry    extends FsEntry { kind: 'directory' }
 *   interface FsScan        { rootName, entries: FsFileEntry[], directories: FsDirEntry[],
 *                             totalBytes, fileCount, truncated, depthCapped }
 *
 * and the mutation vocabulary it emits is:
 *
 *   type WriteOp =
 *     | { op: 'rename';    from: string; to: string }
 *     | { op: 'writeFile'; path: string; data: Uint8Array | string }
 *     | { op: 'delete';    path: string }
 *
 * `path` is always relative to the chosen folder, forward slash separated,
 * with no leading slash, no `.` and no `..` segment. `normalizePath` is the
 * one place that rule is enforced; anything else is rejected.
 *
 * A tool that needs file bytes (hashing, diffing, transforming) asks for them
 * one candidate at a time through `readFileBytes` / `hashFile`, from the panel
 * layer. A scan deliberately never reads content, which is what keeps a scan of
 * a 50,000 file folder cheap.
 *
 * ============================================================================
 * WRITE SAFETY (absolute rules, enforced here so no tool can get them wrong)
 * ============================================================================
 *
 *   - A rename never overwrites. If the target name already exists, that one
 *     op fails and is reported; the rest of the batch still runs.
 *   - A rename uses `FileSystemFileHandle.move()` when the browser has it.
 *     Otherwise it copies, verifies the copy byte count matches the source,
 *     and only then deletes the original.
 *   - A delete is never recursive. Removing a directory that still has
 *     something in it fails instead of taking the contents with it.
 *   - Nothing executes without an undo manifest existing first. There is no
 *     function here that takes a raw `WriteOp[]` and writes to disk:
 *     `planWrites(ops, { scan })` returns the plan and its `undoManifest`,
 *     and `executeWriteOps(handle, plan)` only accepts that plan. The panel
 *     offers the manifest as a download before it calls execute.
 *
 * Everything is guarded for server side rendering: no top level DOM access,
 * and no work happens at import time.
 */
import { ToolError } from '@/tools/types';

/* ------------------------------------------------------------------ */
/* handle types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Handles are typed structurally rather than through `lib.dom`, for three
 * reasons: `showDirectoryPicker` and the permission methods are not in the
 * standard DOM lib at all, `move()` is newer than the lib's definitions, and a
 * structural type lets a test inject a plain object that behaves like a
 * directory without a browser anywhere in sight.
 *
 * Every real Chromium handle satisfies these interfaces.
 */

/** The file object `getFile()` resolves to. A real `File` satisfies this. */
export interface FsFileLike {
  name: string;
  size: number;
  lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The writable stream `createWritable()` resolves to. */
export interface FsWritable {
  write(data: Uint8Array | string | ArrayBuffer): Promise<void>;
  close(): Promise<void>;
}

/**
 * A file handle. `kind` is deliberately the wide `'file' | 'directory'` union
 * rather than the literal `'file'`, because that is what the DOM declares and
 * narrowing it here would make a real handle unassignable. Use the `isFile` /
 * `isDirectory` guards, which test for the methods instead.
 */
export interface FsFileHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  getFile(): Promise<FsFileLike>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsWritable>;
  /** Chromium 111+. Absent elsewhere, which is why renames have a copy path. */
  move?(destination: FsDirectoryHandle | string, name?: string): Promise<void>;
}

/** A directory handle. */
export interface FsDirectoryHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  entries(): AsyncIterable<[string, FsFileHandle | FsDirectoryHandle]>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/** Permission state, mirroring `PermissionStatus.state`. */
export type FsPermissionState = 'granted' | 'denied' | 'prompt';

/** The permission pair Chromium puts on every handle. Neither is in lib.dom. */
interface PermissionCapable {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<FsPermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<FsPermissionState>;
}

interface DirectoryPickerWindow {
  showDirectoryPicker(options?: {
    mode?: 'read' | 'readwrite';
    id?: string;
    startIn?: string;
  }): Promise<FsDirectoryHandle>;
}

/**
 * What `pickDirectory` returns: the handle plus the things a panel keeps
 * asking for. Every function below accepts either this or a bare handle, so a
 * tool never has to remember which one it is holding.
 */
export interface DirectoryHandleWrapper {
  handle: FsDirectoryHandle;
  /** The folder's own name, for display. Not part of any entry path. */
  name: string;
  /** The mode it was picked with. */
  mode: 'read' | 'readwrite';
  /**
   * Re-checks permission, prompting when the browser has dropped it (which it
   * does between sessions, and after a long idle). Must be called from a user
   * gesture when it might prompt.
   */
  ensurePermission(mode?: 'read' | 'readwrite'): Promise<boolean>;
}

/** Anything the read and write helpers accept in place of a directory handle. */
export type FsDirectoryRef = FsDirectoryHandle | DirectoryHandleWrapper;

/* ------------------------------------------------------------------ */
/* plain data: what pure logic layers consume                          */
/* ------------------------------------------------------------------ */

/** One entry in a scanned folder. Plain data: no handle, JSON round trips. */
export interface FsEntry {
  kind: 'file' | 'directory';
  /** Base name including extension, e.g. "notes.txt". */
  name: string;
  /** Path relative to the scanned root, forward slash separated, no leading slash. */
  path: string;
}

export interface FsFileEntry extends FsEntry {
  kind: 'file';
  size: number;
  /** Epoch milliseconds, straight from the File object. */
  lastModified: number;
}

export interface FsDirEntry extends FsEntry {
  kind: 'directory';
}

/**
 * One complete walk of a folder. This is the whole input surface a folder
 * tool's pure logic gets. Both lists are sorted by path, so two scans of the
 * same folder produce the same array order and a tool's output is stable.
 */
export interface FsScan {
  /** Name of the folder that was picked. Display only. */
  rootName: string;
  /** Every file found, sorted by path. */
  entries: FsFileEntry[];
  /** Every subdirectory found, sorted by path. The root itself is not listed. */
  directories: FsDirEntry[];
  /** Sum of `entries[].size`. */
  totalBytes: number;
  /** `entries.length`, kept explicit so a serialized scan reads clearly. */
  fileCount: number;
  /** True when the walk stopped at `maxEntries` and the folder holds more. */
  truncated: boolean;
  /** True when something was deeper than the depth cap and was not walked. */
  depthCapped: boolean;
}

/** A change to make to the folder. Plain data, produced by pure logic. */
export type WriteOp =
  | { op: 'rename'; from: string; to: string }
  | { op: 'writeFile'; path: string; data: Uint8Array | string }
  | { op: 'delete'; path: string };

/* ------------------------------------------------------------------ */
/* limits                                                              */
/* ------------------------------------------------------------------ */

/** Default ceiling on entries per scan. Raise it per call if a tool needs to. */
export const DEFAULT_MAX_ENTRIES = 50_000;

/**
 * Directory nesting the walk will follow. Bind mounts, junctions and recursive
 * symlinks can present an endless tree; the cap turns that into a flag on the
 * scan rather than a hung tab.
 */
export const MAX_DEPTH = 64;

/**
 * Largest file `hashFile` will hash. WebCrypto has no streaming digest: the
 * whole file has to be in one buffer before `subtle.digest` sees it, so a
 * multi gigabyte file would mean a multi gigabyte allocation. The duplicate
 * finder is expected to group by size first and only hash the candidates that
 * share one, so this ceiling is a backstop rather than a normal path.
 */
export const MAX_HASH_BYTES = 256 * 1024 * 1024;

/** How many entries the walk covers between `onProgress` calls. */
const PROGRESS_EVERY = 250;

/* ------------------------------------------------------------------ */
/* paths (pure)                                                        */
/* ------------------------------------------------------------------ */

/**
 * Bring a path into the one form everything here uses: forward slashes, no
 * leading or trailing slash, no empty, `.` or `..` segments.
 *
 * `..` is rejected rather than resolved. A tool that produced one has a bug,
 * and quietly resolving it would let a rename escape the folder the visitor
 * chose, which is the one thing a folder tool must never do.
 */
export function normalizePath(path: string): string {
  const raw = String(path ?? '').replace(/\\/g, '/');
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');

  for (const part of parts) {
    if (part === '..') {
      throw new ToolError(
        'fs-path-escape',
        `The path "${path}" points outside the chosen folder.`,
        'Paths must stay inside the folder you picked. Remove the ".." segment.',
      );
    }
  }

  if (parts.length === 0) {
    throw new ToolError(
      'fs-path-empty',
      'A path is required, but an empty one was given.',
      'Use a path relative to the chosen folder, such as "photos/img.jpg".',
    );
  }

  return parts.join('/');
}

/** True when `path` is usable as a relative path inside the chosen folder. */
export function isSafeRelativePath(path: string): boolean {
  try {
    normalizePath(path);
    return true;
  } catch {
    return false;
  }
}

/** Join path segments, skipping empties. Does not normalize `..`. */
export function joinPath(...parts: string[]): string {
  return parts
    .map((part) => String(part ?? '').replace(/\\/g, '/'))
    .flatMap((part) => part.split('/'))
    .filter((part) => part !== '')
    .join('/');
}

/** The last segment of a path, e.g. `a/b/c.txt` gives `c.txt`. */
export function baseName(path: string): string {
  const parts = String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  return parts.length ? (parts[parts.length - 1] as string) : '';
}

/** Everything before the last segment, or `''` for a path at the root. */
export function parentPath(path: string): string {
  const parts = String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  return parts.slice(0, -1).join('/');
}

/** The extension without its dot, lowercased. `''` when there is none. */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/* ------------------------------------------------------------------ */
/* capability + picker                                                 */
/* ------------------------------------------------------------------ */

/**
 * True when this browser can open a folder in place. False during server
 * rendering and in every browser that has not shipped the File System Access
 * API, which today means Firefox and Safari.
 */
export function isFsAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Unwrap whichever of the two directory shapes a caller passed. */
export function toDirectoryHandle(ref: FsDirectoryRef): FsDirectoryHandle {
  return 'handle' in ref ? ref.handle : ref;
}

/**
 * Ask the browser whether a handle still carries the permission we need, and
 * prompt for it when it does not. Returns true only when access is granted.
 *
 * A handle that predates this call (restored from IndexedDB, or simply idle
 * for a while) commonly reports `prompt`, and the prompt only opens from a
 * user gesture, so call this from a click handler.
 */
export async function ensurePermission(
  ref: FsDirectoryRef,
  mode: 'read' | 'readwrite' = 'read',
): Promise<boolean> {
  const handle = toDirectoryHandle(ref) as FsDirectoryHandle & PermissionCapable;
  // A browser without the permission methods, and every injected test double,
  // is treated as already granted: the picker itself is the grant there.
  if (typeof handle.queryPermission !== 'function') return true;

  const current = await handle.queryPermission({ mode });
  if (current === 'granted') return true;
  if (typeof handle.requestPermission !== 'function') return false;

  return (await handle.requestPermission({ mode })) === 'granted';
}

/**
 * Open the folder picker.
 *
 * Returns null when the visitor cancels, which is a normal outcome and not an
 * error. Throws a `ToolError` when the browser cannot do this at all, or when
 * permission was actively refused.
 *
 * Must be called from inside a user gesture: browsers reject a picker opened
 * from a timer or a promise continuation.
 */
export async function pickDirectory(
  mode: 'read' | 'readwrite' = 'read',
): Promise<DirectoryHandleWrapper | null> {
  if (!isFsAccessSupported()) {
    throw new ToolError(
      'fs-unsupported',
      'This browser cannot open a folder in place.',
      'The File System Access API ships in Chromium browsers such as Chrome, Edge, Brave and Opera on desktop. Firefox and Safari do not support it yet.',
    );
  }

  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;

  let handle: FsDirectoryHandle;
  try {
    handle = await picker({ mode, id: 'tools-folder', startIn: 'documents' });
  } catch (error) {
    // AbortError is the visitor closing the dialog. Everything else is real.
    if (error instanceof Error && error.name === 'AbortError') return null;
    throw new ToolError(
      'fs-picker-failed',
      error instanceof Error ? error.message : 'The folder picker could not be opened.',
      'Try again, and pick a normal folder rather than a system location the browser blocks.',
    );
  }

  const wrapper: DirectoryHandleWrapper = {
    handle,
    name: handle.name,
    mode,
    ensurePermission: (next: 'read' | 'readwrite' = mode) => ensurePermission(handle, next),
  };

  if (!(await wrapper.ensurePermission(mode))) {
    throw new ToolError(
      'fs-permission-denied',
      `Permission to ${mode === 'readwrite' ? 'change' : 'read'} that folder was refused.`,
      'Pick the folder again and allow access, or choose a different folder.',
    );
  }

  return wrapper;
}

/* ------------------------------------------------------------------ */
/* scanning                                                            */
/* ------------------------------------------------------------------ */

export interface ScanOptions {
  /** Called with the running entry count, roughly every 250 entries. */
  onProgress?: (count: number) => void;
  /** Ceiling on entries walked. Default `DEFAULT_MAX_ENTRIES`. */
  maxEntries?: number;
  /**
   * Reserved, and only `false` is accepted. A scan never reads file contents:
   * that is what makes it affordable on a large folder. Ask for bytes per file
   * with `readFileBytes` once the tool knows which files it cares about.
   */
  includeContent?: false;
  /** Checked between entries so a panel can stop a long walk. */
  signal?: { aborted: boolean };
}

/** True for a handle that behaves like a directory. */
export function isDirectory(
  handle: FsFileHandle | FsDirectoryHandle,
): handle is FsDirectoryHandle {
  return 'entries' in handle && typeof handle.entries === 'function';
}

/** True for a handle that behaves like a file. */
export function isFile(handle: FsFileHandle | FsDirectoryHandle): handle is FsFileHandle {
  return 'getFile' in handle && typeof handle.getFile === 'function';
}

/**
 * Walk a folder once and turn it into plain data.
 *
 * Breadth first through an explicit queue, so nesting costs memory rather than
 * call stack, and the entry count climbs evenly for the progress line. Nothing
 * is filtered: `.DS_Store`, `node_modules`, `desktop.ini` and every dotfile all
 * come back, because which of those matter is the tool's business, not this
 * layer's. A directory that cannot be opened (permissions, a broken junction)
 * is skipped rather than failing the whole walk.
 */
export async function scanDirectory(ref: FsDirectoryRef, opts: ScanOptions = {}): Promise<FsScan> {
  const root = toDirectoryHandle(ref);
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? DEFAULT_MAX_ENTRIES));

  const entries: FsFileEntry[] = [];
  const directories: FsDirEntry[] = [];
  let totalBytes = 0;
  let truncated = false;
  let depthCapped = false;
  let seen = 0;

  const queue: { handle: FsDirectoryHandle; path: string; depth: number }[] = [
    { handle: root, path: '', depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    let iterator: AsyncIterable<[string, FsFileHandle | FsDirectoryHandle]>;
    try {
      iterator = current.handle.entries();
    } catch {
      // An unreadable directory is one lost subtree, not a failed scan.
      continue;
    }

    try {
      for await (const [name, handle] of iterator) {
        if (opts.signal?.aborted) {
          truncated = true;
          break;
        }
        if (seen >= maxEntries) {
          truncated = true;
          break;
        }

        const path = current.path ? `${current.path}/${name}` : name;
        seen += 1;

        if (isDirectory(handle)) {
          directories.push({ kind: 'directory', name, path });
          if (current.depth + 1 >= MAX_DEPTH) {
            depthCapped = true;
          } else {
            queue.push({ handle, path, depth: current.depth + 1 });
          }
        } else if (isFile(handle)) {
          try {
            const file = await handle.getFile();
            entries.push({
              kind: 'file',
              name,
              path,
              size: file.size,
              lastModified: file.lastModified,
            });
            totalBytes += file.size;
          } catch {
            // A file that vanished or is locked mid walk is recorded with what
            // is known rather than dropped, so a rename plan still sees it.
            entries.push({ kind: 'file', name, path, size: 0, lastModified: 0 });
          }
        }

        if (seen % PROGRESS_EVERY === 0) opts.onProgress?.(seen);
      }
    } catch {
      // Iteration itself can fail partway through on a folder being changed
      // underneath us. Keep whatever was collected.
      continue;
    }

    if (truncated) break;
  }

  opts.onProgress?.(seen);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  directories.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    rootName: root.name,
    entries,
    directories,
    totalBytes,
    fileCount: entries.length,
    truncated,
    depthCapped,
  };
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

/** Walk down to a subdirectory by relative path. `''` returns the root. */
async function directoryAt(
  root: FsDirectoryHandle,
  path: string,
  create = false,
): Promise<FsDirectoryHandle> {
  if (path === '') return root;
  let handle = root;
  for (const segment of path.split('/')) {
    handle = await handle.getDirectoryHandle(segment, { create });
  }
  return handle;
}

/** Resolve a relative path to its file handle. */
async function fileAt(
  root: FsDirectoryHandle,
  path: string,
  create = false,
): Promise<FsFileHandle> {
  const clean = normalizePath(path);
  const parent = await directoryAt(root, parentPath(clean), create);
  return parent.getFileHandle(baseName(clean), { create });
}

function missingFileError(path: string, error: unknown): ToolError {
  const reason = error instanceof Error ? error.message : String(error);
  return new ToolError(
    'fs-read-failed',
    `Could not read "${path}": ${reason}.`,
    'The file may have been moved or renamed since the folder was scanned. Rescan the folder and try again.',
  );
}

/** Read one file from the chosen folder as bytes. */
export async function readFileBytes(ref: FsDirectoryRef, path: string): Promise<Uint8Array> {
  const root = toDirectoryHandle(ref);
  try {
    const handle = await fileAt(root, path);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw missingFileError(path, error);
  }
}

/** Read one file as UTF-8 text. */
export async function readFileText(ref: FsDirectoryRef, path: string): Promise<string> {
  return new TextDecoder().decode(await readFileBytes(ref, path));
}

/** The metadata a scan records, re-read for one file. */
export async function statFile(ref: FsDirectoryRef, path: string): Promise<FsFileEntry> {
  const root = toDirectoryHandle(ref);
  try {
    const clean = normalizePath(path);
    const handle = await fileAt(root, clean);
    const file = await handle.getFile();
    return {
      kind: 'file',
      name: baseName(clean),
      path: clean,
      size: file.size,
      lastModified: file.lastModified,
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw missingFileError(path, error);
  }
}

/* ------------------------------------------------------------------ */
/* hashing                                                             */
/* ------------------------------------------------------------------ */

export type HashAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

/** The slice of WebCrypto used here, injectable so tests do not need one. */
export interface SubtleLike {
  digest(algorithm: string, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>;
}

function defaultSubtle(): SubtleLike {
  const subtle = globalThis.crypto?.subtle as SubtleLike | undefined;
  if (!subtle) {
    throw new ToolError(
      'fs-no-crypto',
      'This browser does not expose WebCrypto on this page.',
      'WebCrypto is only available over a secure connection. Open the page over https.',
    );
  }
  return subtle;
}

/** Lowercase hex of a digest. */
export function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Hash bytes already in memory. */
export async function hashBytes(
  bytes: Uint8Array,
  algo: HashAlgorithm = 'SHA-256',
  subtle: SubtleLike = defaultSubtle(),
): Promise<string> {
  return toHex(await subtle.digest(algo, bytes));
}

/**
 * Hash one file from the chosen folder.
 *
 * WebCrypto has no streaming digest, so the file is read into a single buffer
 * first. Anything over `MAX_HASH_BYTES` (256 MiB) is refused with a message
 * that says so rather than tipping the tab over. The duplicate finder groups
 * by size before it hashes anything, so the files that reach here are already
 * a short list of same-size candidates.
 */
export async function hashFile(
  ref: FsDirectoryRef,
  path: string,
  algo: HashAlgorithm = 'SHA-256',
  subtle: SubtleLike = defaultSubtle(),
): Promise<string> {
  const info = await statFile(ref, path);
  if (info.size > MAX_HASH_BYTES) {
    throw new ToolError(
      'fs-file-too-large',
      `"${path}" is ${Math.round(info.size / (1024 * 1024))} MB, past the ${MAX_HASH_BYTES / (1024 * 1024)} MB hashing limit.`,
      'Browser hashing has to hold the whole file in memory at once. Compare files this large by size and name instead.',
    );
  }
  return hashBytes(await readFileBytes(ref, path), algo, subtle);
}

/* ------------------------------------------------------------------ */
/* planning (pure)                                                     */
/* ------------------------------------------------------------------ */

/** One op the plan has something to say about. */
export interface WritePlanIssue {
  op: WriteOp;
  /** Position in the submitted op list. */
  index: number;
  reason: string;
}

/**
 * The reverse of a plan, in the order that undoes it. Written to disk by the
 * visitor before anything runs, so a bad batch is recoverable outside this tab.
 */
export interface UndoManifest {
  version: 1;
  tool: string;
  root: string;
  createdAt: string;
  /** Reverse operations, already in the order they should be replayed. */
  ops: WriteOp[];
  /** Anything the reverse list cannot cover, in plain language. */
  notes: string[];
}

/** The only thing `executeWriteOps` accepts. Produced by `planWrites`. */
export interface WritePlan {
  /** The ops to run, normalized and in submitted order. */
  ops: WriteOp[];
  undoManifest: UndoManifest;
  /** Ops that are expected to fail as written, and why. */
  conflicts: WritePlanIssue[];
  /** Ops the undo manifest cannot reverse, and why. */
  irreversible: WritePlanIssue[];
}

export interface PlanOptions {
  /** The scan the ops were derived from. Without it, conflicts go undetected. */
  scan?: FsScan;
  /** Folder name recorded in the manifest. Defaults to `scan.rootName`. */
  root?: string;
  /** Tool slug recorded in the manifest. */
  tool?: string;
  /** Injected clock, so a test can assert on the whole manifest. */
  now?: Date;
}

function normalizeOp(op: WriteOp): WriteOp {
  switch (op.op) {
    case 'rename':
      return { op: 'rename', from: normalizePath(op.from), to: normalizePath(op.to) };
    case 'writeFile':
      return { op: 'writeFile', path: normalizePath(op.path), data: op.data };
    case 'delete':
      return { op: 'delete', path: normalizePath(op.path) };
    default: {
      const unknown = op as { op?: unknown };
      throw new ToolError(
        'fs-unknown-op',
        `"${String(unknown.op)}" is not a change this tool knows how to make.`,
        'Valid operations are rename, writeFile and delete.',
      );
    }
  }
}

/**
 * Reverse one operation, given whether its target existed beforehand.
 *
 * A rename reverses cleanly. A `writeFile` that created a new file reverses to
 * deleting it; one that replaced an existing file cannot be reversed, because
 * the old bytes were never captured. A delete never reverses, for the same
 * reason. Both of those come back as null and are recorded as notes instead of
 * being silently dropped.
 */
function reverseOp(op: WriteOp, targetExisted: boolean): WriteOp | null {
  switch (op.op) {
    case 'rename':
      return { op: 'rename', from: op.to, to: op.from };
    case 'writeFile':
      return targetExisted ? null : { op: 'delete', path: op.path };
    case 'delete':
      return null;
  }
}

/**
 * Check a list of changes against the folder they will be applied to, and
 * build the undo manifest.
 *
 * This is the gate: `executeWriteOps` takes a plan, never a bare op list, so
 * the manifest always exists before anything touches disk.
 *
 * Conflicts are found by replaying the ops against the set of paths the scan
 * saw, so a batch that renames `a` to `b` and then `b` to `c` is understood as
 * fine, while two files renamed onto the same name is caught before either one
 * runs. Without a scan the path set starts empty and only collisions between
 * the ops themselves are found; the executor still refuses to overwrite.
 */
export function planWrites(ops: WriteOp[], opts: PlanOptions = {}): WritePlan {
  const list = (ops ?? []).map(normalizeOp);

  const existing = new Set<string>();
  for (const entry of opts.scan?.entries ?? []) existing.add(entry.path);
  for (const dir of opts.scan?.directories ?? []) existing.add(dir.path);
  const known = opts.scan !== undefined;

  const conflicts: WritePlanIssue[] = [];
  const irreversible: WritePlanIssue[] = [];
  const undo: WriteOp[] = [];
  const notes: string[] = [];

  list.forEach((op, index) => {
    if (op.op === 'rename') {
      if (op.from === op.to) {
        conflicts.push({ op, index, reason: 'The new name is the same as the old one.' });
        return;
      }
      if (known && !existing.has(op.from)) {
        conflicts.push({
          op,
          index,
          reason: `"${op.from}" is not in the folder that was scanned.`,
        });
        return;
      }
      if (existing.has(op.to)) {
        conflicts.push({
          op,
          index,
          reason: `"${op.to}" already exists, and a rename never overwrites.`,
        });
        return;
      }
      existing.delete(op.from);
      existing.add(op.to);
      undo.push(reverseOp(op, false) as WriteOp);
      return;
    }

    if (op.op === 'writeFile') {
      const targetExisted = existing.has(op.path);
      if (targetExisted) {
        irreversible.push({
          op,
          index,
          reason: `"${op.path}" already exists and its current contents will be replaced.`,
        });
      }
      existing.add(op.path);
      const reverse = reverseOp(op, targetExisted);
      if (reverse) undo.push(reverse);
      return;
    }

    if (known && !existing.has(op.path)) {
      conflicts.push({ op, index, reason: `"${op.path}" is not in the folder that was scanned.` });
      return;
    }
    irreversible.push({
      op,
      index,
      reason: `Deleting "${op.path}" cannot be undone from this manifest.`,
    });
    existing.delete(op.path);
  });

  if (irreversible.some((issue) => issue.op.op === 'delete')) {
    notes.push(
      'Deleted files are not in this manifest. Nothing here restores them, so check your backups first.',
    );
  }
  if (irreversible.some((issue) => issue.op.op === 'writeFile')) {
    notes.push(
      'Some files were overwritten. Their earlier contents are not in this manifest, so those changes cannot be reversed.',
    );
  }
  if (conflicts.length > 0) {
    notes.push(
      `${conflicts.length} ${conflicts.length === 1 ? 'change was' : 'changes were'} skipped because of a conflict, so nothing was recorded to undo for ${conflicts.length === 1 ? 'it' : 'them'}.`,
    );
  }

  // Reversed, because undoing a batch means walking back through it.
  undo.reverse();

  return {
    ops: list,
    conflicts,
    irreversible,
    undoManifest: {
      version: 1,
      tool: opts.tool ?? 'folder tool',
      root: opts.root ?? opts.scan?.rootName ?? '',
      createdAt: (opts.now ?? new Date()).toISOString(),
      ops: undo,
      notes,
    },
  };
}

/** The ops in a plan that are not already known to conflict. */
export function runnableOps(plan: WritePlan): WriteOp[] {
  const blocked = new Set(plan.conflicts.map((issue) => issue.index));
  return plan.ops.filter((_, index) => !blocked.has(index));
}

/* ------------------------------------------------------------------ */
/* manifest serialization (pure)                                       */
/* ------------------------------------------------------------------ */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without `btoa`, so the manifest serializes in a test runner too. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

/**
 * The undo manifest as JSON, ready to hand to a download.
 *
 * A `writeFile` op can carry bytes, which JSON has no way to hold, so those
 * become `{ "$base64": "..." }`. Text data stays text, so a manifest a person
 * opens in an editor is still readable.
 */
export function undoManifestToJson(manifest: UndoManifest): string {
  const ops = manifest.ops.map((op) =>
    op.op === 'writeFile' && op.data instanceof Uint8Array
      ? { op: op.op, path: op.path, data: { $base64: bytesToBase64(op.data) } }
      : op,
  );
  return `${JSON.stringify({ ...manifest, ops }, null, 2)}\n`;
}

/** A sensible download name for a manifest, e.g. `undo-photos-2026-08-07.json`. */
export function undoManifestFileName(manifest: UndoManifest): string {
  const slug =
    manifest.root
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'folder';
  const day = manifest.createdAt.slice(0, 10);
  return `undo-${slug}-${day}.json`;
}

/* ------------------------------------------------------------------ */
/* execution                                                           */
/* ------------------------------------------------------------------ */

export interface ExecuteOptions {
  /** Called after each op with how many are finished out of the total. */
  onProgress?: (done: number, total: number, op: WriteOp) => void;
  /** Walk the whole plan and report, without changing anything on disk. */
  dryRun?: boolean;
  /** Checked between ops so a panel can stop a long batch partway. */
  signal?: { aborted: boolean };
}

export interface ExecuteFailure {
  op: WriteOp;
  error: string;
}

export interface ExecuteResult {
  done: WriteOp[];
  failed: ExecuteFailure[];
  /** True when nothing was actually written. */
  dryRun: boolean;
  /** True when a signal stopped the batch before the end. */
  stopped: boolean;
  /**
   * The manifest that was in force. Handed back so a panel that skipped the
   * download beforehand can still offer it after the fact.
   */
  undoManifest: UndoManifest;
}

/** True when a name already exists in that directory, either as file or folder. */
async function nameExists(dir: FsDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name, { create: false });
    return true;
  } catch {
    // Not a file. It may still be a directory with that name.
  }
  try {
    await dir.getDirectoryHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

async function writeBytes(handle: FsFileHandle, data: Uint8Array | string): Promise<number> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
  return bytes.byteLength;
}

/**
 * Rename or move one file.
 *
 * Two paths, and the safe one is the fallback. `move()` is atomic but only
 * exists in Chromium 111 and later; without it the file is copied, the copy's
 * byte count is compared against the source, and the original is only removed
 * once they match. A short copy therefore leaves both files in place rather
 * than destroying the original.
 */
async function performRename(root: FsDirectoryHandle, from: string, to: string): Promise<void> {
  const fromDir = await directoryAt(root, parentPath(from));
  const fromName = baseName(from);
  const source = await fromDir.getFileHandle(fromName, { create: false });

  const toDir = await directoryAt(root, parentPath(to), true);
  const toName = baseName(to);

  if (await nameExists(toDir, toName)) {
    throw new Error(`"${to}" already exists, so the rename was skipped rather than overwriting it`);
  }

  if (typeof source.move === 'function') {
    if (parentPath(from) === parentPath(to)) await source.move(toName);
    else await source.move(toDir, toName);
    return;
  }

  const file = await source.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const target = await toDir.getFileHandle(toName, { create: true });
  const written = await writeBytes(target, bytes);

  const check = await (await toDir.getFileHandle(toName, { create: false })).getFile();
  if (check.size !== bytes.byteLength || written !== bytes.byteLength) {
    throw new Error(
      `the copy of "${from}" came out ${check.size} bytes instead of ${bytes.byteLength}, so the original was left alone`,
    );
  }

  await fromDir.removeEntry(fromName);
}

async function performOp(root: FsDirectoryHandle, op: WriteOp): Promise<void> {
  if (op.op === 'rename') {
    await performRename(root, op.from, op.to);
    return;
  }
  if (op.op === 'writeFile') {
    const dir = await directoryAt(root, parentPath(op.path), true);
    const handle = await dir.getFileHandle(baseName(op.path), { create: true });
    await writeBytes(handle, op.data);
    return;
  }
  const dir = await directoryAt(root, parentPath(op.path));
  // Never recursive: removing a folder that still holds something fails here
  // rather than taking its contents with it.
  await dir.removeEntry(baseName(op.path), { recursive: false });
}

/**
 * Apply a plan to the chosen folder.
 *
 * Takes a `WritePlan`, never a bare op list, so the undo manifest has already
 * been built (and, in the panel, offered as a download) before this runs.
 * Anything `planWrites` flagged as a conflict is skipped and reported as a
 * failure. Every other op is independent: one failure is recorded and the
 * batch carries on, because stopping halfway through a rename of 400 files is
 * worse than finishing the 399 that work.
 */
export async function executeWriteOps(
  ref: FsDirectoryRef,
  plan: WritePlan,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const root = toDirectoryHandle(ref);
  const dryRun = opts.dryRun === true;

  if (!dryRun && !(await ensurePermission(ref, 'readwrite'))) {
    throw new ToolError(
      'fs-permission-denied',
      'Permission to change that folder was refused.',
      'Choose the folder again and allow changes when the browser asks.',
    );
  }

  const done: WriteOp[] = [];
  const failed: ExecuteFailure[] = [];
  const blocked = new Map(plan.conflicts.map((issue) => [issue.index, issue.reason]));
  const total = plan.ops.length;
  let stopped = false;

  for (const [index, op] of plan.ops.entries()) {
    if (opts.signal?.aborted) {
      stopped = true;
      break;
    }

    const conflict = blocked.get(index);
    if (conflict !== undefined) {
      failed.push({ op, error: conflict });
    } else if (dryRun) {
      done.push(op);
    } else {
      try {
        await performOp(root, op);
        done.push(op);
      } catch (error) {
        failed.push({ op, error: error instanceof Error ? error.message : String(error) });
      }
    }

    opts.onProgress?.(done.length + failed.length, total, op);
  }

  return { done, failed, dryRun, stopped, undoManifest: plan.undoManifest };
}
