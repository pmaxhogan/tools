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

/**
 * Every +/- line the diff emitted must be accounted for by the summary line,
 * and vice versa. Guards against hunks that print more edits than they count.
 */
function expectCountsMatchOutput(out: string): void {
  const lines = out.split('\n');
  const emittedAdds = lines.filter((line) => line.startsWith('+ ')).length;
  const emittedRemoves = lines.filter((line) => line.startsWith('- ')).length;
  const match = /(\d+) additions?, (\d+) removals?\./.exec(out);
  expect(match, `no summary line in:\n${out}`).not.toBeNull();
  expect(Number(match![1])).toBe(emittedAdds);
  expect(Number(match![2])).toBe(emittedRemoves);
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

  it('lines mode: keeps a trailing insertion minimal when the new side is longer', () => {
    const out = run(doc('A\nB\nC', 'A\nX\nC\nD'), opts());

    expect(out).toBe(['  A', '- B', '+ X', '  C', '+ D', '', '2 additions, 1 removal.'].join('\n'));
    expectCountsMatchOutput(out);
  });

  it('lines mode: keeps a trailing deletion minimal when the old side is longer', () => {
    const out = run(doc('A\nB\nC\nD', 'A\nX\nC'), opts());

    expect(out).toBe(['  A', '- B', '+ X', '  C', '- D', '', '1 addition, 2 removals.'].join('\n'));
    expectCountsMatchOutput(out);
  });

  it('lines mode: reports a change on the very last line once', () => {
    const out = run(doc('A\nB', 'A\nC'), opts());

    expect(out).toBe(['  A', '- B', '+ C', '', '1 addition, 1 removal.'].join('\n'));
    expectCountsMatchOutput(out);
  });

  it('lines mode: gives the same diff with or without trailing newlines', () => {
    const expected = ['  A', '- B', '+ X', '  C', '+ D', '', '2 additions, 1 removal.'].join('\n');

    expect(run(doc('A\nB\nC', 'A\nX\nC\nD'), opts())).toBe(expected);
    expect(run(doc('A\nB\nC\n', 'A\nX\nC\nD\n'), opts())).toBe(expected);
    expect(run(doc('A\nB\nC\n', 'A\nX\nC\nD'), opts())).toBe(expected);
    expect(run(doc('A\nB\nC', 'A\nX\nC\nD\n'), opts())).toBe(expected);
  });

  it('lines mode: a trailing newline alone is not a difference', () => {
    expect(run(doc('A', 'A\n'), opts())).toBe('No differences.');
    expect(run(doc('A\nB\n', 'A\nB'), opts())).toBe('No differences.');
  });

  it('lines mode: a blank line added at the end is still reported', () => {
    const out = run(doc('A\nB', 'A\nB\n\n'), opts());

    expect(out).toBe(['  A', '  B', '+ ', '', '1 addition, 0 removals.'].join('\n'));
    expectCountsMatchOutput(out);
  });

  it('lines mode: handles single-line inputs', () => {
    const changed = run(doc('only', 'only changed'), opts());
    expect(changed).toBe(['- only', '+ only changed', '', '1 addition, 1 removal.'].join('\n'));
    expectCountsMatchOutput(changed);

    const added = run(doc('', 'first line'), opts());
    expect(added).toBe(['+ first line', '', '1 addition, 0 removals.'].join('\n'));
    expectCountsMatchOutput(added);

    const removed = run(doc('gone', ''), opts());
    expect(removed).toBe(['- gone', '', '0 additions, 1 removal.'].join('\n'));
    expectCountsMatchOutput(removed);
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
