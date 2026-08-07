import { describe, expect, it } from 'vitest';
import { run, SEPARATOR, type DiffOpts } from './index';
import { ToolError } from '../types';

function opts(overrides: Partial<DiffOpts> = {}): DiffOpts {
  return {
    mode: 'lines',
    ignoreWhitespace: false,
    ignoreCase: false,
    context: 3,
    ...overrides,
  };
}

function doc(a: string, b: string): string {
  return `${a}\n${SEPARATOR}\n${b}`;
}

describe('diff-checker', () => {
  it('lines mode: reports additions and removals with correct prefixes and a summary', () => {
    const a = 'keep\nold';
    const b = 'keep\nnew1\nnew2';
    const out = run(doc(a, b), opts());

    expect(out).toContain('  keep');
    expect(out).toContain('- old');
    expect(out).toContain('+ new1');
    expect(out).toContain('+ new2');
    expect(out.trim().endsWith('2 additions, 1 removal.')).toBe(true);
  });

  it('lines mode: collapses a long run of unchanged lines into a marker, keeping context', () => {
    const common = Array.from({ length: 20 }, (_, i) => `common${i}`).join('\n');
    const a = `A0\n${common}\nZ`;
    const b = `A1\n${common}\nZ`;
    const out = run(doc(a, b), opts({ context: 3 }));

    // Run of unchanged lines is common(20) + Z(1) = 21; 21 - 2*3 = 15 collapsed.
    expect(out).toMatch(/\.\.\. 15 unchanged lines \.\.\./);
    expect(out).toContain('- A0');
    expect(out).toContain('+ A1');
    expect(out).toContain('  common0');
    expect(out).toContain('  common1');
    expect(out).toContain('  common2');
    expect(out).not.toContain('common5');
  });

  it('words mode: wraps insertions and deletions inline', () => {
    const a = 'The quick brown fox';
    const b = 'The quick red fox';
    const out = run(doc(a, b), opts({ mode: 'words' }));

    expect(out).toContain('[-brown-]');
    expect(out).toContain('[+red+]');
    expect(out).toMatch(/\d+ additions?, \d+ removals?\./);
  });

  it('chars mode: wraps single-character edits inline', () => {
    const out = run(doc('cat', 'car'), opts({ mode: 'chars' }));
    expect(out).toContain('[-t-]');
    expect(out).toContain('[+r+]');
  });

  it('json mode: catches a changed value but ignores key order', () => {
    const a = '{"user": {"name": "a", "id": 1}}';
    const b = '{"user": {"id": 1, "name": "b"}}';
    const out = run(doc(a, b), opts({ mode: 'json' }));

    expect(out).toBe('changed  user.name: "a" -> "b"');
  });

  it('json mode: reports added and removed keys', () => {
    const a = '{"a": 1, "old": true}';
    const b = '{"a": 1, "new": 2}';
    const out = run(doc(a, b), opts({ mode: 'json' }));

    expect(out).toContain('removed  old');
    expect(out).toContain('added    new: 2');
  });

  it('json mode: throws naming the invalid side', () => {
    expect(() => run(doc('{"a":1}', '{invalid'), opts({ mode: 'json' }))).toThrowError(
      ToolError,
    );
    try {
      run(doc('{"a":1}', '{invalid'), opts({ mode: 'json' }));
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-json');
      expect((e as ToolError).message).toMatch(/Side B/);
    }
  });

  it('yaml mode: throws naming the invalid side', () => {
    try {
      run(doc('a: 1', 'a:\n  - b\n b'), opts({ mode: 'yaml' }));
      expect.unreachable('expected a ToolError');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('invalid-yaml');
      expect((e as ToolError).message).toMatch(/Side B/);
    }
  });

  it('throws a missing-separator error when ===== is absent', () => {
    expect(() => run('just one text, no separator', opts())).toThrowError(ToolError);
    try {
      run('just one text, no separator', opts());
    } catch (e) {
      expect((e as ToolError).code).toBe('missing-separator');
      expect((e as ToolError).fix).toMatch(/=====/);
    }
  });

  it('rejects an unknown mode', () => {
    expect(() => run(doc('a', 'a'), opts({ mode: 'bogus' }))).toThrowError(ToolError);
  });

  it('returns "No differences." for identical inputs', () => {
    const text = 'same text\nline two';
    expect(run(doc(text, text), opts())).toBe('No differences.');
    expect(run(doc(text, text), opts({ mode: 'words' }))).toBe('No differences.');
  });

  it('returns "No semantic differences." for JSON that differs only in formatting', () => {
    const a = '{"a": 1, "b": [1, 2, 3]}';
    const b = '{\n  "b": [1, 2, 3],\n  "a": 1\n}';
    expect(run(doc(a, b), opts({ mode: 'json' }))).toBe('No semantic differences.');
  });
});
