import { describe, expect, it } from 'vitest';
import { ToolError } from '../types';
import type { FsFileEntry, FsScan } from '@/lib/fs-access';
import {
  applyOperation,
  BATCH_OPERATION_LIST,
  BATCH_OPERATIONS,
  buildWriteOps,
  compileFilter,
  detectEol,
  globToRegExp,
  planBatch,
  run,
  suffixedPath,
  type BatchOperationId,
  type OperationResult,
} from './index';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const BOM = '\uFEFF';

/** The transformed text, or a failure if the operation skipped the file. */
function text(result: OperationResult): string {
  if (!result.ok) throw new Error(`expected a transform, got a skip: ${result.reason}`);
  return result.text;
}

function file(path: string, size = 100): FsFileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { kind: 'file', name, path, size, lastModified: 0 };
}

function scanOf(paths: (string | FsFileEntry)[]): FsScan {
  const entries = paths.map((p) => (typeof p === 'string' ? file(p) : p));
  return {
    rootName: 'notes',
    entries,
    directories: [],
    totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
    fileCount: entries.length,
    truncated: false,
    depthCapped: false,
  };
}

function apply(op: BatchOperationId, input: string, opts = {}): string {
  return text(applyOperation(input, op, opts));
}

/* ------------------------------------------------------------------ */
/* find and replace                                                    */
/* ------------------------------------------------------------------ */

describe('find-replace', () => {
  it('replaces every literal match, not just the first', () => {
    expect(apply('find-replace', 'cat cat cat', { find: 'cat', replace: 'dog' })).toBe(
      'dog dog dog',
    );
  });

  it('treats a literal find as literal, so regex characters are safe', () => {
    expect(apply('find-replace', 'a.b axb', { find: 'a.b', replace: 'Z' })).toBe('Z axb');
  });

  it('supports regex mode with capture groups', () => {
    expect(
      apply('find-replace', 'version 1.2.3 here', {
        find: '(\\d+)\\.(\\d+)\\.(\\d+)',
        replace: 'v$1-$2-$3',
        regex: true,
      }),
    ).toBe('version v1-2-3 here');
  });

  it('can ignore case', () => {
    expect(
      apply('find-replace', 'Cat CAT cat', { find: 'cat', replace: 'x', caseSensitive: false }),
    ).toBe('x x x');
  });

  it('throws for an empty find box', () => {
    expect(() => applyOperation('abc', 'find-replace', { find: '' })).toThrow(ToolError);
  });

  it('throws a fixable error for a broken regex', () => {
    try {
      applyOperation('abc', 'find-replace', { find: '([a-', replace: '', regex: true });
      throw new Error('expected a ToolError');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe('invalid-regex');
      expect((error as ToolError).fix).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ */
/* case                                                                */
/* ------------------------------------------------------------------ */

describe('case', () => {
  it('uppercases and lowercases', () => {
    expect(apply('case', 'Hello There', { caseMode: 'upper' })).toBe('HELLO THERE');
    expect(apply('case', 'Hello There', { caseMode: 'lower' })).toBe('hello there');
  });

  it('title cases each word', () => {
    expect(apply('case', 'the QUICK brown fox', { caseMode: 'title' })).toBe('The Quick Brown Fox');
  });

  it('sentence cases after full stops and line breaks', () => {
    expect(apply('case', 'one thing. TWO things\nthree things', { caseMode: 'sentence' })).toBe(
      'One thing. Two things\nThree things',
    );
  });

  it('throws for a casing it does not know', () => {
    expect(() =>
      applyOperation('abc', 'case', { caseMode: 'pascal' as unknown as 'upper' }),
    ).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* trim whitespace                                                     */
/* ------------------------------------------------------------------ */

describe('trim-whitespace', () => {
  it('strips trailing spaces and tabs and ensures one final newline', () => {
    expect(apply('trim-whitespace', 'one   \ntwo\t\t\nthree')).toBe('one\ntwo\nthree\n');
  });

  it('removes extra blank lines at the end rather than leaving a stack of them', () => {
    expect(apply('trim-whitespace', 'body\n\n\n\n')).toBe('body\n');
  });

  it('can strip the final newline instead of ensuring one', () => {
    expect(apply('trim-whitespace', 'body\n', { finalNewline: 'strip' })).toBe('body');
  });

  it('keeps the file line ending it found', () => {
    expect(apply('trim-whitespace', 'one  \r\ntwo  \r\n')).toBe('one\r\ntwo\r\n');
  });

  it('can collapse runs of blank lines', () => {
    expect(apply('trim-whitespace', 'a\n\n\n\nb\n', { collapseBlankLines: true })).toBe('a\n\nb\n');
  });

  it('leaves an empty file empty', () => {
    expect(apply('trim-whitespace', '')).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* line endings                                                        */
/* ------------------------------------------------------------------ */

describe('line-endings', () => {
  it('converts CRLF to LF', () => {
    expect(apply('line-endings', 'a\r\nb\r\nc', { eol: 'lf' })).toBe('a\nb\nc');
  });

  it('converts LF to CRLF without doubling an existing CR', () => {
    expect(apply('line-endings', 'a\nb\r\nc', { eol: 'crlf' })).toBe('a\r\nb\r\nc');
  });

  it('normalizes a lone CR too', () => {
    expect(apply('line-endings', 'a\rb', { eol: 'lf' })).toBe('a\nb');
  });
});

/* ------------------------------------------------------------------ */
/* encoding                                                            */
/* ------------------------------------------------------------------ */

describe('encoding-normalize', () => {
  it('strips a leading byte order mark', () => {
    expect(apply('encoding-normalize', `${BOM}{"a":1}`)).toBe('{"a":1}');
  });

  it('leaves a file with no mark alone', () => {
    expect(apply('encoding-normalize', 'plain')).toBe('plain');
  });

  it('only removes marks inside the file when asked', () => {
    expect(apply('encoding-normalize', `a${BOM}b`)).toBe(`a${BOM}b`);
    expect(apply('encoding-normalize', `a${BOM}b`, { stripInnerBom: true })).toBe('ab');
  });
});

/* ------------------------------------------------------------------ */
/* prefix and suffix                                                   */
/* ------------------------------------------------------------------ */

describe('prefix-suffix', () => {
  it('adds a header above and a footer below', () => {
    expect(apply('prefix-suffix', 'body\n', { prefix: '// top', suffix: '// end' })).toBe(
      '// top\nbody\n// end\n',
    );
  });

  it('adds a line break before a footer when the file has none', () => {
    expect(apply('prefix-suffix', 'body', { suffix: 'END' })).toBe('body\nEND\n');
  });

  it('uses the file existing CRLF endings', () => {
    expect(apply('prefix-suffix', 'body\r\n', { prefix: 'TOP' })).toBe('TOP\r\nbody\r\n');
  });

  it('throws when neither a header nor a footer was given', () => {
    expect(() => applyOperation('body', 'prefix-suffix', {})).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* sort and dedupe                                                     */
/* ------------------------------------------------------------------ */

describe('sort-lines', () => {
  it('sorts ascending and ignores case by default', () => {
    expect(apply('sort-lines', 'banana\nApple\ncherry\n')).toBe('Apple\nbanana\ncherry\n');
  });

  it('sorts descending on request', () => {
    expect(apply('sort-lines', 'a\nb\nc\n', { sortDirection: 'desc' })).toBe('c\nb\na\n');
  });

  it('sorts numerically when asked, so file10 lands after file9', () => {
    expect(apply('sort-lines', 'file10\nfile9\nfile1\n', { sortNumeric: true })).toBe(
      'file1\nfile9\nfile10\n',
    );
  });

  it('keeps CRLF endings and does not invent a trailing line', () => {
    expect(apply('sort-lines', 'b\r\na')).toBe('a\r\nb');
  });
});

describe('dedupe-lines', () => {
  it('keeps the first copy of each line', () => {
    expect(apply('dedupe-lines', 'a\nb\na\nc\nb\n')).toBe('a\nb\nc\n');
  });

  it('leaves blank lines alone by default', () => {
    expect(apply('dedupe-lines', 'a\n\nb\n\nc\n')).toBe('a\n\nb\n\nc\n');
  });

  it('can compare without case and ignoring surrounding spaces', () => {
    expect(
      apply('dedupe-lines', 'Apple\n  apple  \nBanana\n', {
        dedupeCaseSensitive: false,
        dedupeTrim: true,
      }),
    ).toBe('Apple\nBanana\n');
  });
});

/* ------------------------------------------------------------------ */
/* json                                                                */
/* ------------------------------------------------------------------ */

describe('json-format', () => {
  it('pretty prints with two spaces and a final newline', () => {
    expect(apply('json-format', '{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
  });

  it('honours a custom indent', () => {
    expect(apply('json-format', '{"a":1}', { jsonIndent: 4 })).toBe('{\n    "a": 1\n}\n');
  });

  it('minifies', () => {
    expect(apply('json-format', '{\n  "a": 1\n}\n', { jsonMode: 'minify' })).toBe('{"a":1}');
  });

  it('parses past a byte order mark instead of calling the file broken', () => {
    expect(apply('json-format', `${BOM}{"a":1}`, { jsonMode: 'minify' })).toBe('{"a":1}');
  });

  it('skips a file that is not JSON, with a reason', () => {
    const result = applyOperation('# A readme, not JSON', 'json-format', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/);
  });

  it('skips an empty file with its own reason', () => {
    const result = applyOperation('   \n', 'json-format', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/);
  });
});

/* ------------------------------------------------------------------ */
/* template                                                            */
/* ------------------------------------------------------------------ */

describe('template-wrap', () => {
  it('substitutes {content} and {name}', () => {
    expect(
      apply('template-wrap', 'hello', {
        template: '# {name}\n\n{content}\n',
        name: 'greeting.md',
      }),
    ).toBe('# greeting.md\n\nhello\n');
  });

  it('substitutes {path}, falling back to the name when no path was given', () => {
    expect(
      apply('template-wrap', 'x', { template: '[{path}] {content}', name: 'a.txt', path: 'docs/a.txt' }),
    ).toBe('[docs/a.txt] x');
    expect(apply('template-wrap', 'x', { template: '[{path}] {content}', name: 'a.txt' })).toBe(
      '[a.txt] x',
    );
  });

  it('replaces every occurrence of a placeholder', () => {
    expect(apply('template-wrap', 'x', { template: '{name}:{content}:{name}', name: 'n' })).toBe(
      'n:x:n',
    );
  });

  it('refuses a template with no {content}', () => {
    try {
      applyOperation('body', 'template-wrap', { template: 'just a header' });
      throw new Error('expected a ToolError');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe('template-missing-content');
    }
  });

  it('refuses an empty template', () => {
    expect(() => applyOperation('body', 'template-wrap', { template: '' })).toThrow(ToolError);
  });
});

/* ------------------------------------------------------------------ */
/* dispatch and registry                                               */
/* ------------------------------------------------------------------ */

describe('applyOperation', () => {
  it('throws for an operation that does not exist', () => {
    expect(() => applyOperation('x', 'shout' as BatchOperationId, {})).toThrow(ToolError);
  });

  it('lists every registered operation exactly once', () => {
    const ids = BATCH_OPERATION_LIST.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(Object.keys(BATCH_OPERATIONS).sort());
  });

  it('marks json-format as the one that can skip a file', () => {
    const skippers = BATCH_OPERATION_LIST.filter((spec) => spec.canSkip).map((spec) => spec.id);
    expect(skippers).toEqual(['json-format']);
  });
});

describe('detectEol', () => {
  it('reports CRLF only when the file uses it', () => {
    expect(detectEol('a\r\nb')).toBe('\r\n');
    expect(detectEol('a\nb')).toBe('\n');
    expect(detectEol('no breaks')).toBe('\n');
  });
});

/* ------------------------------------------------------------------ */
/* filters                                                             */
/* ------------------------------------------------------------------ */

describe('globToRegExp', () => {
  it('keeps a single star inside one path segment', () => {
    expect(globToRegExp('*.txt').test('notes.txt')).toBe(true);
    expect(globToRegExp('*.txt').test('sub/notes.txt')).toBe(false);
  });

  it('lets a double star cross folders', () => {
    expect(globToRegExp('**/*.txt').test('a/b/notes.txt')).toBe(true);
    expect(globToRegExp('**/*.txt').test('notes.txt')).toBe(true);
  });

  it('expands a brace group', () => {
    const pattern = globToRegExp('*.{js,ts}');
    expect(pattern.test('a.js')).toBe(true);
    expect(pattern.test('a.ts')).toBe(true);
    expect(pattern.test('a.css')).toBe(false);
  });

  it('matches one character for a question mark', () => {
    expect(globToRegExp('a?.txt').test('ab.txt')).toBe(true);
    expect(globToRegExp('a?.txt').test('abc.txt')).toBe(false);
  });
});

describe('compileFilter', () => {
  it('matches everything for an empty or star filter', () => {
    expect(compileFilter('').test('anything/at/all.bin')).toBe(true);
    expect(compileFilter('*').test('anything/at/all.bin')).toBe(true);
  });

  it('matches a name pattern against the file name at any depth', () => {
    const filter = compileFilter('*.md');
    expect(filter.test('docs/deep/readme.md')).toBe(true);
    expect(filter.test('docs/readme.txt')).toBe(false);
  });

  it('matches a pattern containing a slash against the whole path', () => {
    const filter = compileFilter('docs/*.md');
    expect(filter.test('docs/a.md')).toBe(true);
    expect(filter.test('src/a.md')).toBe(false);
  });

  it('takes several comma separated patterns', () => {
    const filter = compileFilter('*.md, *.txt');
    expect(filter.test('a.md')).toBe(true);
    expect(filter.test('a.txt')).toBe(true);
    expect(filter.test('a.json')).toBe(false);
  });

  it('excludes with a leading bang', () => {
    const filter = compileFilter('*.md,!draft-*.md');
    expect(filter.test('final.md')).toBe(true);
    expect(filter.test('draft-one.md')).toBe(false);
  });

  it('supports regex mode', () => {
    expect(compileFilter('^src/.*\\.ts$', 'regex').test('src/a.ts')).toBe(true);
    expect(compileFilter('^src/.*\\.ts$', 'regex').test('lib/a.ts')).toBe(false);
  });

  it('throws a fixable error for a broken filter regex', () => {
    try {
      compileFilter('([a-', 'regex');
      throw new Error('expected a ToolError');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe('invalid-filter-regex');
    }
  });
});

/* ------------------------------------------------------------------ */
/* planning                                                            */
/* ------------------------------------------------------------------ */

describe('planBatch', () => {
  const scan = scanOf(['notes.md', 'readme.md', 'data.json', 'docs/guide.md', 'logo.png']);

  it('matches the subset the filter names and reports the rest as unmatched', () => {
    const plan = planBatch(scan, { filter: '*.md', operation: 'trim-whitespace' });
    expect(plan.items.map((item) => item.path)).toEqual([
      'notes.md',
      'readme.md',
      'docs/guide.md',
    ]);
    expect(plan.matchedCount).toBe(3);
    expect(plan.unmatched).toEqual(['data.json', 'logo.png']);
    expect(plan.unmatchedCount).toBe(2);
  });

  it('covers every file when no filter is given', () => {
    const plan = planBatch(scan, { operation: 'trim-whitespace' });
    expect(plan.matchedCount).toBe(4);
    expect(plan.skipped.map((skip) => skip.path)).toEqual(['logo.png']);
    expect(plan.skipped[0]?.reason).toContain('not text');
  });

  it('writes in place by default, leaving outPath equal to path', () => {
    const plan = planBatch(scan, { filter: '*.md', operation: 'case' });
    expect(plan.inPlace).toBe(true);
    expect(plan.items.map((item) => item.outPath)).toEqual([
      'notes.md',
      'readme.md',
      'docs/guide.md',
    ]);
  });

  it('inserts the marker before the extension in suffix mode', () => {
    const plan = planBatch(scan, { filter: '*.md', operation: 'case', output: 'suffix' });
    expect(plan.inPlace).toBe(false);
    expect(plan.items.map((item) => item.outPath)).toEqual([
      'notes.processed.md',
      'readme.processed.md',
      'docs/guide.processed.md',
    ]);
  });

  it('honours a custom suffix marker', () => {
    const plan = planBatch(scanOf(['a.txt']), {
      operation: 'case',
      output: 'suffix',
      suffix: 'clean',
    });
    expect(plan.items[0]?.outPath).toBe('a.clean.txt');
  });

  it('appends the marker to a file with no extension', () => {
    expect(suffixedPath('LICENSE', 'processed')).toBe('LICENSE.processed');
    expect(suffixedPath('dir/.gitignore', 'processed')).toBe('dir/.gitignore.processed');
  });

  it('prefixes the subfolder and preserves the structure underneath it', () => {
    const plan = planBatch(scan, { filter: '*.md', operation: 'case', output: 'subfolder' });
    expect(plan.items.map((item) => item.outPath)).toEqual([
      'processed/notes.md',
      'processed/readme.md',
      'processed/docs/guide.md',
    ]);
  });

  it('does not reprocess its own output on a second subfolder run', () => {
    const second = scanOf(['a.md', 'processed/a.md']);
    const plan = planBatch(second, {
      operation: 'case',
      output: 'subfolder',
      subfolder: 'processed',
    });
    expect(plan.items.map((item) => item.path)).toEqual(['a.md']);
    expect(plan.skipped[0]?.path).toBe('processed/a.md');
  });

  it('does not reprocess its own output on a second suffix run', () => {
    const second = scanOf(['a.md', 'a.processed.md']);
    const plan = planBatch(second, { operation: 'case', output: 'suffix' });
    expect(plan.items.map((item) => item.path)).toEqual(['a.md']);
    expect(plan.skipped[0]?.reason).toContain('earlier run');
  });

  it('skips files past the size limit and adds up the bytes it will read', () => {
    const sized = scanOf([file('small.txt', 10), file('huge.txt', 20_000_000)]);
    const plan = planBatch(sized, { operation: 'case' });
    expect(plan.items.map((item) => item.path)).toEqual(['small.txt']);
    expect(plan.totalBytes).toBe(10);
    expect(plan.skipped[0]?.reason).toContain('MB per file limit');
  });

  it('can be told to include binary extensions anyway', () => {
    const plan = planBatch(scanOf(['a.png']), { operation: 'case', skipBinary: false });
    expect(plan.matchedCount).toBe(1);
  });

  it('returns an empty plan for an empty folder', () => {
    const plan = planBatch(scanOf([]), { operation: 'case' });
    expect(plan.items).toEqual([]);
    expect(plan.matchedCount).toBe(0);
    expect(plan.unmatchedCount).toBe(0);
    expect(plan.skippedCount).toBe(0);
    expect(plan.totalBytes).toBe(0);
  });

  it('throws for an operation it does not know', () => {
    expect(() => planBatch(scanOf(['a.txt']), { operation: 'shout' as BatchOperationId })).toThrow(
      ToolError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* write ops                                                           */
/* ------------------------------------------------------------------ */

describe('buildWriteOps', () => {
  it('writes one op per changed file', () => {
    expect(
      buildWriteOps([
        { outPath: 'a.txt', newText: 'A', changed: true },
        { outPath: 'b.txt', newText: 'B', changed: true },
      ]),
    ).toEqual([
      { op: 'writeFile', path: 'a.txt', data: 'A' },
      { op: 'writeFile', path: 'b.txt', data: 'B' },
    ]);
  });

  it('never writes a file whose text came out identical', () => {
    const ops = buildWriteOps([
      { outPath: 'a.txt', newText: 'same', changed: false },
      { outPath: 'b.txt', newText: 'new', changed: true },
    ]);
    expect(ops).toEqual([{ op: 'writeFile', path: 'b.txt', data: 'new' }]);
  });

  it('returns nothing when the whole batch was already in shape', () => {
    expect(buildWriteOps([{ outPath: 'a.txt', newText: 'x', changed: false }])).toEqual([]);
    expect(buildWriteOps([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* end to end, the way the panel drives it                             */
/* ------------------------------------------------------------------ */

describe('a whole run, as the panel performs it', () => {
  it('processes the JSON, skips the rest, and writes only what changed', () => {
    const scan = scanOf(['a.json', 'b.json', 'readme.md']);
    const contents: Record<string, string> = {
      'a.json': '{"z":1,"a":2}',
      'b.json': '{\n  "a": 1\n}\n',
      'readme.md': '# not json',
    };

    const plan = planBatch(scan, { operation: 'json-format', output: 'in-place' });
    expect(plan.matchedCount).toBe(3);

    const results: { outPath: string; newText: string; changed: boolean }[] = [];
    const skips: { path: string; reason: string }[] = [];

    for (const item of plan.items) {
      const original = contents[item.path] as string;
      const result = applyOperation(original, plan.operation, { name: item.name, path: item.path });
      if (!result.ok) {
        skips.push({ path: item.path, reason: result.reason });
        continue;
      }
      results.push({
        outPath: item.outPath,
        newText: result.text,
        changed: result.text !== original,
      });
    }

    expect(skips.map((skip) => skip.path)).toEqual(['readme.md']);
    // b.json is already pretty printed with two spaces, so it must not be written.
    expect(results.map((r) => r.changed)).toEqual([true, false]);

    const ops = buildWriteOps(results);
    expect(ops).toEqual([
      { op: 'writeFile', path: 'a.json', data: '{\n  "z": 1,\n  "a": 2\n}\n' },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

describe('run', () => {
  it('returns usage rows, because the tool needs a folder rather than pasted text', () => {
    const rows = run();
    expect(Object.keys(rows)).toContain('How this works');
    expect(rows.Privacy).toContain('your files and inputs never leave your device');
    expect(rows.Operations).toContain('Find and replace');
  });

  it('has no em dashes or en dashes in its copy', () => {
    for (const value of Object.values(run())) {
      expect(value).not.toMatch(/[–—]/);
    }
  });
});
