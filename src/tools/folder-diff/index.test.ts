import { describe, expect, it } from 'vitest';
import type { FsFileEntry, FsScan } from '@/lib/fs-access';
import { ToolError } from '../types';
import {
  diffScans,
  diffTextPair,
  formatReport,
  looksBinary,
  makeIgnoreMatcher,
  normalizeIgnore,
  planHashCompare,
  reportRows,
  run,
  summarize,
} from './index';

/* ------------------------------------------------------------------ *
 * hand-built scans
 * ------------------------------------------------------------------ */

function file(path: string, size: number, lastModified = 1_700_000_000_000): FsFileEntry {
  const parts = path.split('/');
  return {
    kind: 'file',
    name: parts[parts.length - 1] as string,
    path,
    size,
    lastModified,
  };
}

function scan(rootName: string, files: FsFileEntry[], dirs: string[] = []): FsScan {
  const entries = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    rootName,
    entries,
    directories: dirs
      .map((path) => ({
        kind: 'directory' as const,
        name: path.split('/').pop() as string,
        path,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    fileCount: entries.length,
    truncated: false,
    depthCapped: false,
  };
}

const emptyScan = scan('empty', []);

function statusOf(diff: ReturnType<typeof diffScans>, path: string) {
  return diff.common.find((pair) => pair.path === path)?.status;
}

/* ------------------------------------------------------------------ *
 * partitioning
 * ------------------------------------------------------------------ */

describe('diffScans partitioning', () => {
  const a = scan('before', [file('keep.txt', 10), file('gone.txt', 4), file('src/app.ts', 100)], [
    'src',
    'old',
  ]);
  const b = scan('after', [file('keep.txt', 10), file('new.txt', 7), file('src/app.ts', 120)], [
    'src',
    'vendor',
  ]);

  it('splits files into only-in-A, only-in-B and common', () => {
    const diff = diffScans(a, b);
    expect(diff.onlyInA.map((entry) => entry.path)).toEqual(['gone.txt']);
    expect(diff.onlyInB.map((entry) => entry.path)).toEqual(['new.txt']);
    expect(diff.common.map((pair) => pair.path)).toEqual(['keep.txt', 'src/app.ts']);
    expect(diff.rootA).toBe('before');
    expect(diff.rootB).toBe('after');
  });

  it('reports directories that exist on one side only', () => {
    const diff = diffScans(a, b);
    expect(diff.dirsOnlyInA.map((dir) => dir.path)).toEqual(['old']);
    expect(diff.dirsOnlyInB.map((dir) => dir.path)).toEqual(['vendor']);
  });

  it('treats an empty folder against a populated one as all added', () => {
    const diff = diffScans(emptyScan, b);
    expect(diff.onlyInA).toEqual([]);
    expect(diff.common).toEqual([]);
    expect(diff.onlyInB).toHaveLength(3);
    const counts = summarize(diff);
    expect(counts.added).toBe(3);
    expect(counts.removed).toBe(0);
    expect(counts.bytesAdded).toBe(137);
  });

  it('treats a populated folder against an empty one as all removed', () => {
    const diff = diffScans(a, emptyScan);
    expect(diff.onlyInA).toHaveLength(3);
    expect(diff.onlyInB).toEqual([]);
    expect(summarize(diff).bytesRemoved).toBe(114);
  });

  it('is empty on both sides for two empty folders', () => {
    const diff = diffScans(emptyScan, emptyScan);
    expect(reportRows(diff)).toEqual([]);
    expect(formatReport(diff, 'flat')).toContain('No differences.');
  });

  it('refuses to compare when a scan is missing', () => {
    expect(() => diffScans(undefined as unknown as FsScan, emptyScan)).toThrow(ToolError);
    try {
      diffScans(emptyScan, null as unknown as FsScan);
    } catch (error) {
      expect((error as ToolError).code).toBe('missing-scan');
    }
  });
});

/* ------------------------------------------------------------------ *
 * status logic
 * ------------------------------------------------------------------ */

describe('diffScans status', () => {
  const a = scan('a', [file('same-size.bin', 500), file('resized.bin', 10)]);
  const b = scan('b', [file('same-size.bin', 500), file('resized.bin', 11)]);

  it('calls a size mismatch different without any hash', () => {
    const diff = diffScans(a, b);
    expect(statusOf(diff, 'resized.bin')).toBe('different');
  });

  it('leaves a same-size pair as maybe-different until it is read', () => {
    const diff = diffScans(a, b);
    expect(statusOf(diff, 'same-size.bin')).toBe('maybe-different');
  });

  it('promotes a same-size pair with matching hashes to identical', () => {
    const diff = diffScans(a, b, {
      hashesA: { 'same-size.bin': 'aa11' },
      hashesB: { 'same-size.bin': 'aa11' },
    });
    expect(statusOf(diff, 'same-size.bin')).toBe('identical');
  });

  it('promotes a same-size pair with differing hashes to different', () => {
    const diff = diffScans(a, b, {
      hashesA: { 'same-size.bin': 'aa11' },
      hashesB: { 'same-size.bin': 'bb22' },
    });
    expect(statusOf(diff, 'same-size.bin')).toBe('different');
  });

  it('stays maybe-different when only one side has been hashed', () => {
    const diff = diffScans(a, b, { hashesA: { 'same-size.bin': 'aa11' } });
    expect(statusOf(diff, 'same-size.bin')).toBe('maybe-different');
  });

  it('does not assume two zero-byte files match', () => {
    const diff = diffScans(scan('a', [file('empty.log', 0)]), scan('b', [file('empty.log', 0)]));
    expect(statusOf(diff, 'empty.log')).toBe('maybe-different');
  });

  it('never asks for a hash where the sizes already differ', () => {
    const plan = planHashCompare(diffScans(a, b));
    expect(plan.map((candidate) => candidate.path)).toEqual(['same-size.bin']);
    expect(plan[0]).toMatchObject({ pathA: 'same-size.bin', pathB: 'same-size.bin', size: 500 });
  });

  it('drops a pair from the hash plan once it is resolved', () => {
    const resolved = diffScans(a, b, {
      hashesA: { 'same-size.bin': 'aa11' },
      hashesB: { 'same-size.bin': 'aa11' },
    });
    expect(planHashCompare(resolved)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * ignore globs
 * ------------------------------------------------------------------ */

describe('ignore globs', () => {
  it('normalizes a comma or newline separated string into patterns', () => {
    expect(normalizeIgnore('node_modules, .git\n*.log\n\n')).toEqual([
      'node_modules',
      '.git',
      '*.log',
    ]);
    expect(normalizeIgnore(['./build/', 'dist\\assets'])).toEqual(['build', 'dist/assets']);
    expect(normalizeIgnore(undefined)).toEqual([]);
  });

  it('matches a bare pattern against any path segment', () => {
    const ignored = makeIgnoreMatcher(['node_modules', '*.log']);
    expect(ignored('node_modules/react/index.js')).toBe(true);
    expect(ignored('app/node_modules/x.js')).toBe(true);
    expect(ignored('logs/build.log')).toBe(true);
    expect(ignored('src/app.ts')).toBe(false);
  });

  it('matches a scoped pattern against the path and its parent folders', () => {
    const ignored = makeIgnoreMatcher(['build/**', 'src/generated']);
    expect(ignored('build/main.js')).toBe(true);
    expect(ignored('src/generated/api.ts')).toBe(true);
    expect(ignored('src/app.ts')).toBe(false);
  });

  it('excludes ignored files and directories from the diff', () => {
    const a = scan(
      'a',
      [file('src/app.ts', 10), file('node_modules/react/index.js', 900), file('debug.log', 5)],
      ['src', 'node_modules', 'node_modules/react'],
    );
    const b = scan('b', [file('src/app.ts', 10)], ['src']);

    const noisy = diffScans(a, b);
    expect(noisy.onlyInA).toHaveLength(2);
    expect(noisy.dirsOnlyInA).toHaveLength(2);

    const clean = diffScans(a, b, { ignore: ['node_modules', '*.log'] });
    expect(clean.onlyInA).toEqual([]);
    expect(clean.dirsOnlyInA).toEqual([]);
    expect(clean.common.map((pair) => pair.path)).toEqual(['src/app.ts']);
  });
});

/* ------------------------------------------------------------------ *
 * case-insensitive matching
 * ------------------------------------------------------------------ */

describe('case-insensitive matching', () => {
  const a = scan('a', [file('Foo.txt', 12), file('Docs/Read.md', 3)]);
  const b = scan('b', [file('foo.txt', 12), file('docs/read.md', 4)]);

  it('treats Foo.txt and foo.txt as two different files by default', () => {
    const diff = diffScans(a, b);
    expect(diff.common).toEqual([]);
    expect(diff.onlyInA).toHaveLength(2);
    expect(diff.onlyInB).toHaveLength(2);
  });

  it('pairs them when case-insensitive matching is on', () => {
    const diff = diffScans(a, b, { caseInsensitive: true });
    expect(diff.onlyInA).toEqual([]);
    expect(diff.onlyInB).toEqual([]);
    expect(diff.common.map((pair) => pair.path)).toEqual(['Docs/Read.md', 'Foo.txt']);
    const pair = diff.common.find((entry) => entry.path === 'Foo.txt');
    expect(pair?.a.path).toBe('Foo.txt');
    expect(pair?.b.path).toBe('foo.txt');
    expect(statusOf(diff, 'Docs/Read.md')).toBe('different');
  });

  it('keys hashes by the path each side actually has when the case differs', () => {
    const diff = diffScans(a, b, {
      caseInsensitive: true,
      hashesA: { 'Foo.txt': 'cc33' },
      hashesB: { 'foo.txt': 'cc33' },
    });
    expect(statusOf(diff, 'Foo.txt')).toBe('identical');
  });

  it('ignores patterns without regard to case as well', () => {
    const diff = diffScans(scan('a', [file('Logs/Build.LOG', 2)]), emptyScan, {
      caseInsensitive: true,
      ignore: '*.log',
    });
    expect(diff.onlyInA).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * reports
 * ------------------------------------------------------------------ */

describe('formatReport', () => {
  const a = scan('before', [file('gone.txt', 4), file('src/app.ts', 100), file('src/util.ts', 8)], [
    'src',
  ]);
  const b = scan(
    'after',
    [file('src/app.ts', 120), file('src/util.ts', 8), file('vendor/lib.js', 30)],
    ['src', 'vendor'],
  );
  const diff = diffScans(a, b, {
    hashesA: { 'src/util.ts': 'dd44' },
    hashesB: { 'src/util.ts': 'dd44' },
  });

  it('marks every row in flat format', () => {
    const flat = formatReport(diff, 'flat');
    expect(flat).toContain('A: before');
    expect(flat).toContain('B: after');
    expect(flat).toContain('- gone.txt');
    expect(flat).toContain('~ src/app.ts');
    expect(flat).toContain('= src/util.ts');
    expect(flat).toContain('+ vendor/');
    expect(flat).toContain('+ vendor/lib.js');
  });

  it('drops identical rows when asked', () => {
    const flat = formatReport(diff, 'flat', { includeIdentical: false });
    expect(flat).not.toContain('src/util.ts');
    expect(flat).toContain('~ src/app.ts');
  });

  it('nests the tree format by folder and prints base names', () => {
    const lines = formatReport(diff, 'tree').split('\n');
    expect(lines).toContain('  src/');
    expect(lines).toContain('  ~ app.ts');
    expect(lines).toContain('  = util.ts');
    expect(lines).toContain('+ vendor/');
    expect(lines).toContain('  + lib.js');
    expect(lines).toContain('- gone.txt');
  });

  it('writes a CSV with both sizes and a header row', () => {
    const rows = formatReport(diff, 'csv').split('\n');
    expect(rows[0]).toBe('path,status,sizeA,sizeB');
    expect(rows).toContain('gone.txt,removed,4,');
    expect(rows).toContain('src/app.ts,different,100,120');
    expect(rows).toContain('src/util.ts,identical,8,8');
    expect(rows).toContain('vendor/lib.js,added,,30');
    expect(rows).toContain('vendor,dir-added,,');
  });

  it('quotes a CSV path that holds a comma or a quote', () => {
    const odd = diffScans(scan('a', [file('re,port "final".txt', 3)]), emptyScan);
    expect(formatReport(odd, 'csv')).toContain('"re,port ""final"".txt",removed,3,');
  });

  it('rejects a format it does not know', () => {
    expect(() => formatReport(diff, 'pdf')).toThrow(ToolError);
    try {
      formatReport(diff, 'pdf');
    } catch (error) {
      expect((error as ToolError).code).toBe('unknown-format');
      expect((error as ToolError).fix).toContain('tree, flat, csv');
    }
  });
});

describe('summarize', () => {
  it('counts each bucket and the bytes on either side', () => {
    const a = scan('a', [file('gone.txt', 40), file('same.txt', 5), file('grew.txt', 1)], ['old']);
    const b = scan('b', [file('new.txt', 60), file('same.txt', 5), file('grew.txt', 9)], ['fresh']);
    const counts = summarize(
      diffScans(a, b, { hashesA: { 'same.txt': 'ee' }, hashesB: { 'same.txt': 'ee' } }),
    );
    expect(counts).toMatchObject({
      added: 1,
      removed: 1,
      changed: 1,
      identical: 1,
      unresolved: 0,
      dirsAdded: 1,
      dirsRemoved: 1,
      bytesAdded: 60,
      bytesRemoved: 40,
      totalFiles: 4,
    });
  });

  it('counts same-size pairs as unresolved before they are read', () => {
    const counts = summarize(
      diffScans(scan('a', [file('x.bin', 12)]), scan('b', [file('x.bin', 12)])),
    );
    expect(counts.unresolved).toBe(1);
    expect(counts.identical).toBe(0);
    expect(counts.changed).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * text pairs
 * ------------------------------------------------------------------ */

describe('diffTextPair', () => {
  it('marks added and removed lines', () => {
    const out = diffTextPair('one\ntwo\nthree\n', 'one\n2\nthree\n');
    expect(out).toContain('- two');
    expect(out).toContain('+ 2');
    expect(out).toContain('1 addition, 1 removal.');
  });

  it('reports no differences for two identical strings', () => {
    expect(diffTextPair('same\n', 'same\n')).toBe('No differences.');
  });

  it('sees a line ending change unless it is told not to', () => {
    expect(diffTextPair('a\r\nb\r\n', 'a\nb\n')).not.toBe('No differences.');
    expect(diffTextPair('a\r\nb\r\n', 'a\nb\n', { ignoreLineEndings: true })).toBe(
      'No differences.',
    );
  });

  it('collapses a long unchanged run', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const out = diffTextPair(`${long}\nend`, `${long}\nEND`, { context: 2 });
    expect(out).toContain('... 26 unchanged lines ...');
    expect(out).toContain('- end');
    expect(out).toContain('+ END');
  });
});

describe('looksBinary', () => {
  it('is true for bytes holding a NUL', () => {
    expect(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x00, 0x41]))).toBe(true);
  });

  it('is false for plain text bytes', () => {
    expect(looksBinary(new TextEncoder().encode('hello\nworld\n'))).toBe(false);
  });

  it('only looks at the sample it is given', () => {
    const bytes = new Uint8Array(200);
    bytes.fill(0x41);
    bytes[150] = 0;
    expect(looksBinary(bytes, 100)).toBe(false);
    expect(looksBinary(bytes)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

describe('run', () => {
  it('returns usage rows that point at the panel', () => {
    const rows = run(null, {});
    expect(rows['How it works']).toContain('your files and inputs never leave your device');
    expect(rows['Ignore list']).toBe('nothing ignored');
    expect(rows['Path matching']).toBe('case-sensitive');
  });

  it('reflects the options it was given', () => {
    const rows = run(null, {
      ignore: 'node_modules, .git',
      caseInsensitive: true,
      ignoreLineEndings: true,
      format: 'csv',
    });
    expect(rows['Ignore list']).toBe('node_modules, .git');
    expect(rows['Path matching']).toBe('case-insensitive');
    expect(rows['Report format']).toBe('csv');
    expect(rows['Line endings']).toContain('CRLF');
  });
});
