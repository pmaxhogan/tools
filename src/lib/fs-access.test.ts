import { describe, expect, it } from 'vitest';
import {
  baseName,
  bytesToBase64,
  executeWriteOps,
  extensionOf,
  hashBytes,
  isSafeRelativePath,
  joinPath,
  normalizePath,
  parentPath,
  planWrites,
  runnableOps,
  scanDirectory,
  undoManifestFileName,
  undoManifestToJson,
  type FsDirectoryHandle,
  type FsFileHandle,
  type FsScan,
  type SubtleLike,
} from './fs-access';

/* ------------------------------------------------------------------ */
/* an in memory folder, which is the whole point of the handle types    */
/* ------------------------------------------------------------------ */

interface Tree {
  [name: string]: string | Tree;
}

function makeFile(name: string, content: string): FsFileHandle {
  let bytes: Uint8Array = new TextEncoder().encode(content);
  return {
    kind: 'file',
    name,
    async getFile() {
      const snapshot = bytes;
      return {
        name,
        size: snapshot.byteLength,
        lastModified: 1_700_000_000_000,
        arrayBuffer: async () => snapshot.slice().buffer,
      };
    },
    async createWritable() {
      let staged: Uint8Array = new Uint8Array(0);
      return {
        async write(data: Uint8Array | string | ArrayBuffer) {
          staged =
            typeof data === 'string'
              ? new TextEncoder().encode(data)
              : data instanceof Uint8Array
                ? data
                : new Uint8Array(data);
        },
        async close() {
          bytes = staged;
        },
      };
    },
  };
}

/** No `move()` on purpose: this exercises the copy, verify, then delete path. */
function makeDir(name: string, tree: Tree): FsDirectoryHandle {
  const children = new Map<string, FsFileHandle | FsDirectoryHandle>();
  for (const [key, value] of Object.entries(tree)) {
    children.set(key, typeof value === 'string' ? makeFile(key, value) : makeDir(key, value));
  }
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const pair of [...children]) yield pair;
    },
    async getFileHandle(child: string, options?: { create?: boolean }) {
      const found = children.get(child);
      if (found && found.kind === 'file') return found as FsFileHandle;
      if (found) throw new Error(`${child} is a directory`);
      if (options?.create) {
        const created = makeFile(child, '');
        children.set(child, created);
        return created;
      }
      throw new Error(`NotFoundError: ${child}`);
    },
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      const found = children.get(child);
      if (found && found.kind === 'directory') return found as FsDirectoryHandle;
      if (found) throw new Error(`${child} is a file`);
      if (options?.create) {
        const created = makeDir(child, {});
        children.set(child, created);
        return created;
      }
      throw new Error(`NotFoundError: ${child}`);
    },
    async removeEntry(child: string) {
      if (!children.delete(child)) throw new Error(`NotFoundError: ${child}`);
    },
  };
}

async function readAll(dir: FsDirectoryHandle, path: string): Promise<string> {
  const parts = path.split('/');
  let cursor = dir;
  for (const part of parts.slice(0, -1)) cursor = await cursor.getDirectoryHandle(part);
  const file = await cursor.getFileHandle(parts[parts.length - 1] as string);
  return new TextDecoder().decode(new Uint8Array(await (await file.getFile()).arrayBuffer()));
}

const NOW = new Date('2026-08-07T12:00:00.000Z');

function scanOf(paths: string[]): FsScan {
  return {
    rootName: 'photos',
    entries: paths.map((path) => ({
      kind: 'file',
      name: baseName(path),
      path,
      size: 10,
      lastModified: 0,
    })),
    directories: [],
    totalBytes: 10 * paths.length,
    fileCount: paths.length,
    truncated: false,
    depthCapped: false,
  };
}

/* ------------------------------------------------------------------ */

describe('paths', () => {
  it('normalizes separators and stray slashes', () => {
    expect(normalizePath('a\\b//c.txt')).toBe('a/b/c.txt');
    expect(normalizePath('/leading/./trailing/')).toBe('leading/trailing');
  });

  it('refuses to resolve a path out of the chosen folder', () => {
    expect(() => normalizePath('../secrets.txt')).toThrow(/outside the chosen folder/);
    expect(() => normalizePath('a/../../b')).toThrow();
    expect(() => normalizePath('   ')).not.toThrow();
    expect(() => normalizePath('')).toThrow(/empty/);
    expect(isSafeRelativePath('../x')).toBe(false);
    expect(isSafeRelativePath('x/y.txt')).toBe(true);
  });

  it('splits paths', () => {
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(parentPath('a/b/c.txt')).toBe('a/b');
    expect(parentPath('c.txt')).toBe('');
    expect(extensionOf('a/b/photo.JPEG')).toBe('jpeg');
    expect(extensionOf('.gitignore')).toBe('');
    expect(joinPath('a/', '/b', 'c.txt')).toBe('a/b/c.txt');
  });
});

describe('planWrites', () => {
  it('reverses a rename batch in undo order', () => {
    const plan = planWrites(
      [
        { op: 'rename', from: 'a.txt', to: 'b.txt' },
        { op: 'rename', from: 'c.txt', to: 'd.txt' },
      ],
      { scan: scanOf(['a.txt', 'c.txt']), now: NOW, tool: 'bulk-rename' },
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.undoManifest.ops).toEqual([
      { op: 'rename', from: 'd.txt', to: 'c.txt' },
      { op: 'rename', from: 'b.txt', to: 'a.txt' },
    ]);
    expect(plan.undoManifest.createdAt).toBe('2026-08-07T12:00:00.000Z');
    expect(plan.undoManifest.root).toBe('photos');
  });

  it('allows a chained rename but catches a collision', () => {
    const chained = planWrites(
      [
        { op: 'rename', from: 'a.txt', to: 'b.txt' },
        { op: 'rename', from: 'b.txt', to: 'c.txt' },
      ],
      { scan: scanOf(['a.txt']), now: NOW },
    );
    expect(chained.conflicts).toEqual([]);

    const collide = planWrites(
      [
        { op: 'rename', from: 'a.txt', to: 'same.txt' },
        { op: 'rename', from: 'b.txt', to: 'same.txt' },
      ],
      { scan: scanOf(['a.txt', 'b.txt']), now: NOW },
    );
    expect(collide.conflicts).toHaveLength(1);
    expect(collide.conflicts[0]?.index).toBe(1);
    expect(collide.conflicts[0]?.reason).toMatch(/already exists/);
    expect(runnableOps(collide)).toHaveLength(1);
  });

  it('never plans a rename over a file that is already there', () => {
    const plan = planWrites([{ op: 'rename', from: 'a.txt', to: 'b.txt' }], {
      scan: scanOf(['a.txt', 'b.txt']),
      now: NOW,
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.undoManifest.ops).toEqual([]);
  });

  it('flags a no-op rename and a missing source', () => {
    const plan = planWrites(
      [
        { op: 'rename', from: 'a.txt', to: 'a.txt' },
        { op: 'rename', from: 'ghost.txt', to: 'x.txt' },
      ],
      { scan: scanOf(['a.txt']), now: NOW },
    );
    expect(plan.conflicts).toHaveLength(2);
  });

  it('undoes a new file with a delete, and admits when it cannot undo', () => {
    const plan = planWrites(
      [
        { op: 'writeFile', path: 'out/new.txt', data: 'hello' },
        { op: 'writeFile', path: 'kept.txt', data: 'replaced' },
        { op: 'delete', path: 'old.txt' },
      ],
      { scan: scanOf(['kept.txt', 'old.txt']), now: NOW },
    );

    expect(plan.undoManifest.ops).toEqual([{ op: 'delete', path: 'out/new.txt' }]);
    expect(plan.irreversible.map((issue) => issue.op.op)).toEqual(['writeFile', 'delete']);
    expect(plan.undoManifest.notes.join(' ')).toMatch(/Deleted files are not in this manifest/);
    expect(plan.undoManifest.notes.join(' ')).toMatch(/overwritten/);
  });

  it('normalizes every op it accepts and rejects an escape', () => {
    const plan = planWrites([{ op: 'rename', from: '/a\\b.txt', to: './c.txt' }], { now: NOW });
    expect(plan.ops[0]).toEqual({ op: 'rename', from: 'a/b.txt', to: 'c.txt' });
    expect(() => planWrites([{ op: 'delete', path: '../boot.ini' }])).toThrow(/outside/);
  });
});

describe('undo manifest serialization', () => {
  it('base64 encodes bytes and keeps text readable', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
    expect(bytesToBase64(new Uint8Array([0]))).toBe('AA==');
    expect(bytesToBase64(new Uint8Array(0))).toBe('');

    const manifest = planWrites([{ op: 'writeFile', path: 'a.bin', data: 'text' }], {
      now: NOW,
      root: 'My Photos!',
    }).undoManifest;
    const json = JSON.parse(undoManifestToJson(manifest)) as { version: number; ops: unknown[] };
    expect(json.version).toBe(1);
    expect(json.ops).toEqual([{ op: 'delete', path: 'a.bin' }]);
    expect(undoManifestFileName(manifest)).toBe('undo-my-photos-2026-08-07.json');
  });
});

describe('hashBytes', () => {
  it('renders a digest as lowercase hex through an injected subtle', async () => {
    const subtle: SubtleLike = {
      digest: async () => new Uint8Array([0x0a, 0xff, 0x10]).buffer,
    };
    expect(await hashBytes(new Uint8Array([1]), 'SHA-256', subtle)).toBe('0aff10');
  });
});

describe('scanDirectory', () => {
  it('walks a folder into sorted plain data', async () => {
    const dir = makeDir('photos', {
      'b.txt': 'bb',
      'a.txt': 'a',
      sub: { 'c.txt': 'ccc', deeper: { 'd.txt': 'dddd' } },
    });

    const ticks: number[] = [];
    const scan = await scanDirectory(dir, { onProgress: (n) => ticks.push(n) });

    expect(scan.rootName).toBe('photos');
    expect(scan.entries.map((entry) => entry.path)).toEqual([
      'a.txt',
      'b.txt',
      'sub/c.txt',
      'sub/deeper/d.txt',
    ]);
    expect(scan.directories.map((entry) => entry.path)).toEqual(['sub', 'sub/deeper']);
    expect(scan.totalBytes).toBe(10);
    expect(scan.fileCount).toBe(4);
    expect(scan.truncated).toBe(false);
    expect(scan.depthCapped).toBe(false);
    expect(ticks.at(-1)).toBe(6);
  });

  it('stops at maxEntries and says so', async () => {
    const dir = makeDir('big', { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
    const scan = await scanDirectory(dir, { maxEntries: 2 });
    expect(scan.entries).toHaveLength(2);
    expect(scan.truncated).toBe(true);
  });
});

describe('executeWriteOps', () => {
  it('changes nothing on a dry run', async () => {
    const dir = makeDir('photos', { 'a.txt': 'first' });
    const plan = planWrites([{ op: 'rename', from: 'a.txt', to: 'b.txt' }], {
      scan: scanOf(['a.txt']),
      now: NOW,
    });

    const result = await executeWriteOps(dir, plan, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.done).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(await readAll(dir, 'a.txt')).toBe('first');
  });

  it('renames by copying, verifying, then deleting when move() is absent', async () => {
    const dir = makeDir('photos', { 'a.txt': 'first', sub: {} });
    const plan = planWrites(
      [
        { op: 'rename', from: 'a.txt', to: 'sub/b.txt' },
        { op: 'writeFile', path: 'notes.txt', data: 'written' },
      ],
      { scan: scanOf(['a.txt']), now: NOW },
    );

    const seen: number[] = [];
    const result = await executeWriteOps(dir, plan, { onProgress: (done) => seen.push(done) });

    expect(result.failed).toEqual([]);
    expect(result.done).toHaveLength(2);
    expect(seen).toEqual([1, 2]);
    expect(await readAll(dir, 'sub/b.txt')).toBe('first');
    expect(await readAll(dir, 'notes.txt')).toBe('written');
    await expect(readAll(dir, 'a.txt')).rejects.toThrow();
  });

  it('refuses to overwrite even when the plan did not know the target existed', async () => {
    const dir = makeDir('photos', { 'a.txt': 'source', 'b.txt': 'keep me' });
    // No scan, so planWrites cannot see the collision: the executor is the
    // second line of defence and has to catch it on its own.
    const plan = planWrites([{ op: 'rename', from: 'a.txt', to: 'b.txt' }], { now: NOW });
    expect(plan.conflicts).toEqual([]);

    const result = await executeWriteOps(dir, plan);
    expect(result.done).toEqual([]);
    expect(result.failed[0]?.error).toMatch(/already exists/);
    expect(await readAll(dir, 'b.txt')).toBe('keep me');
    expect(await readAll(dir, 'a.txt')).toBe('source');
  });

  it('reports a conflicted op as a failure and still runs the rest', async () => {
    const dir = makeDir('photos', { 'a.txt': 'one', 'b.txt': 'two' });
    const plan = planWrites(
      [
        { op: 'rename', from: 'a.txt', to: 'b.txt' },
        { op: 'rename', from: 'b.txt', to: 'c.txt' },
      ],
      { scan: scanOf(['a.txt', 'b.txt']), now: NOW },
    );

    const result = await executeWriteOps(dir, plan);
    expect(result.failed).toHaveLength(1);
    expect(result.done).toEqual([{ op: 'rename', from: 'b.txt', to: 'c.txt' }]);
    expect(await readAll(dir, 'c.txt')).toBe('two');
  });

  it('stops partway when the signal is aborted', async () => {
    const dir = makeDir('photos', { 'a.txt': 'one', 'b.txt': 'two' });
    const plan = planWrites(
      [
        { op: 'rename', from: 'a.txt', to: 'x.txt' },
        { op: 'rename', from: 'b.txt', to: 'y.txt' },
      ],
      { scan: scanOf(['a.txt', 'b.txt']), now: NOW },
    );

    const signal = { aborted: false };
    const result = await executeWriteOps(dir, plan, {
      signal,
      onProgress: () => {
        signal.aborted = true;
      },
    });

    expect(result.stopped).toBe(true);
    expect(result.done).toHaveLength(1);
    expect(result.undoManifest.ops).toHaveLength(2);
  });
});
