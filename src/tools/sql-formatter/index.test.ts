import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

const baseOpts = { dialect: 'sql', keywordCase: 'upper' as const, tabWidth: 2, linesBetweenQueries: 1 };

describe('sql-formatter', () => {
  it('formats a select statement with uppercase keywords', () => {
    const out = run('select id, name from users where id=1;', baseOpts);
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out).toContain('WHERE');
    expect(out).toMatch(/id,\s*\n\s*name/);
  });

  it('formats postgres-specific cast syntax under the postgresql dialect', () => {
    const out = run('SELECT a::int FROM foo;', { ...baseOpts, dialect: 'postgresql' });
    expect(out).toContain('a::int');
  });

  it('respects keywordCase lower', () => {
    const out = run('SELECT id FROM users;', { ...baseOpts, keywordCase: 'lower' });
    expect(out).toContain('select');
    expect(out).toContain('from');
    expect(out).not.toContain('SELECT');
  });

  it('respects tabWidth for indentation', () => {
    const out = run('SELECT id FROM users;', { ...baseOpts, tabWidth: 4 });
    const indentedLine = out.split('\n').find((line) => line.trim() === 'id');
    expect(indentedLine).toBe('    id');
  });

  it('throws ToolError("invalid-sql") on malformed input', () => {
    expect(() => run('SELECT * FROM (', baseOpts)).toThrowError(ToolError);
    try {
      run('SELECT * FROM (', baseOpts);
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-sql');
      expect((e as ToolError).fix).toMatch(/dialect/);
    }
  });

  it('throws ToolError("empty-input") on empty input', () => {
    expect(() => run('', baseOpts)).toThrowError(ToolError);
    try {
      run('   ', baseOpts);
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });
});
