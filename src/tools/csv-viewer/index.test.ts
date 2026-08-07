import { describe, expect, it } from 'vitest';
import { run, type CsvOpts } from './index';
import { ToolError } from '../types';

const base: CsvOpts = { header: true, sort: '', filter: '', view: 'table', limit: 100 };
const o = (patch: Partial<CsvOpts> = {}): CsvOpts => ({ ...base, ...patch });

const BASIC = 'name,age,city\nalice,30,Paris\nbob,7,Rome\ncarol,42,Oslo\n';
const PRICES = 'item,price,due\nwidget,9.99,2026-01-02\ngadget,240,2025-11-30\nwidget,15,2026-03-15\n';

describe('csv-viewer', () => {
  it('renders an aligned table with a summary line', () => {
    expect(run(BASIC, o())).toBe(
      [
        '3 rows x 3 columns (delimiter: comma)',
        '',
        '| name  | age | city  |',
        '| ----- | --- | ----- |',
        '| alice | 30  | Paris |',
        '| bob   | 7   | Rome  |',
        '| carol | 42  | Oslo  |',
      ].join('\n'),
    );
  });

  it('auto-detects tab-separated input', () => {
    const out = run('name\tage\nalice\t30\nbob\t7\n', o());
    expect(out.split('\n')[0]).toBe('2 rows x 2 columns (delimiter: tab)');
    expect(out).toContain('| alice | 30  |');
  });

  it('auto-detects semicolon-separated input', () => {
    const out = run('name;age\nalice;30\nbob;7\n', o());
    expect(out.split('\n')[0]).toBe('2 rows x 2 columns (delimiter: semicolon)');
  });

  it('sorts a numeric column descending with -column', () => {
    const out = run(BASIC, o({ sort: '-age' }));
    const ages = out
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.includes('---') && !l.includes('name'))
      .map((l) => l.split('|')[2]?.trim());
    expect(ages).toEqual(['42', '30', '7']);
  });

  it('sorts a text column alphabetically', () => {
    const out = run('name\ncarol\nalice\nbob\n', o({ sort: 'name' }));
    const names = out
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.includes('---') && !l.includes('name'))
      .map((l) => l.split('|')[1]?.trim());
    expect(names).toEqual(['alice', 'bob', 'carol']);
  });

  it('filters numerically with price>100', () => {
    const out = run(PRICES, o({ filter: 'price>100' }));
    expect(out.split('\n')[0]).toBe('1 row x 3 columns (delimiter: comma)');
    expect(out).toContain('gadget');
    expect(out).not.toContain('9.99');
  });

  it('filters by substring with col~text', () => {
    const out = run(BASIC, o({ filter: 'name~ali' }));
    expect(out).toContain('alice');
    expect(out).not.toContain('bob');
    expect(out).not.toContain('carol');
  });

  it('filters with case-insensitive equals', () => {
    const out = run(BASIC, o({ filter: 'city=paris' }));
    expect(out.split('\n')[0]).toBe('1 row x 3 columns (delimiter: comma)');
    expect(out).toContain('alice');
  });

  it('infers column types with min and max in the stats view', () => {
    const out = run(PRICES, o({ view: 'stats' }));
    expect(out).toContain('price\n  type: number\n  non-empty: 3 of 3\n  distinct: 3\n  min: 9.99\n  max: 240');
    expect(out).toContain('due\n  type: date\n  non-empty: 3 of 3\n  distinct: 3\n  min: 2025-11-30\n  max: 2026-03-15');
    expect(out).toContain('item\n  type: text\n  non-empty: 3 of 3\n  distinct: 2\n  top value: widget (2 rows)');
  });

  it('keeps every value a string in the json view', () => {
    expect(run('code,qty\n007,30\n', o({ view: 'json' }))).toBe(
      ['[', '  {', '    "code": "007",', '    "qty": "30"', '  }', ']'].join('\n'),
    );
  });

  it('re-emits normalized comma-delimited CSV after a sort', () => {
    expect(run('name;age\nbob;7\nalice;30\n', o({ view: 'csv', sort: 'name' }))).toBe(
      'name,age\nalice,30\nbob,7',
    );
  });

  it('appends a truncation line when the limit cuts rows off', () => {
    const rows = ['n', '1', '2', '3', '4', '5'].join('\n');
    const out = run(rows, o({ limit: 2 }));
    expect(out.split('\n').at(-1)).toBe('... 3 more rows (5 total)');
    expect(run(rows, o({ limit: 2, view: 'json' })).split('\n').at(-1)).toBe(
      '... 3 more rows (5 total)',
    );
  });

  it('treats the first row as data when header is off', () => {
    const out = run('alice,30\nbob,7\n', o({ header: false }));
    expect(out.split('\n')[0]).toBe('2 rows x 2 columns (delimiter: comma)');
    expect(out).toContain('| col1  | col2 |');
  });

  it('pads rows with an inconsistent field count instead of crashing', () => {
    const out = run('a,b,c\n1,2\n3,4,5\n', o());
    expect(out).toContain('1 row has a different field count');
    expect(out).toContain('| 1   | 2   |     |');
  });

  it('throws unknown-column for a sort on a missing column', () => {
    try {
      run(BASIC, o({ sort: 'salary' }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('unknown-column');
      expect((e as ToolError).fix).toBe('Available columns: name, age, city.');
    }
  });

  it('throws bad-filter for a condition with no operator', () => {
    try {
      run(BASIC, o({ filter: 'city' }));
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('bad-filter');
      expect((e as ToolError).fix).toContain('col~text');
    }
  });

  it('throws invalid-csv on mismatched quotes', () => {
    try {
      run('a,b\n"unclosed,2\nz,3\n', o());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('invalid-csv');
      expect((e as ToolError).message).toContain('line 2');
    }
  });

  it('throws empty-input on blank input', () => {
    expect(() => run('   \n', o())).toThrowError(ToolError);
    try {
      run('', o());
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });
});
