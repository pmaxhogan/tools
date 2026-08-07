import { describe, expect, it } from 'vitest';
import { FONTS, LAYOUTS, MAX_LENGTH, MAX_WIDTH_UNLIMITED, run } from './index';
import { ToolError } from '../types';

// Captured from figlet.textSync('Hi', { font: 'Standard', horizontalLayout: 'default' }).
// Written with explicit \n escapes: every line has significant trailing spaces
// that a template literal would invite editors and formatters to strip.
const HI_STANDARD = '  _   _ _ \n | | | (_)\n | |_| | |\n |  _  | |\n |_| |_|_|\n          ';

describe('figlet', () => {
  it('renders known text in the Standard font exactly', () => {
    expect(run('Hi', { font: 'Standard', layout: 'default' })).toBe(HI_STANDARD);
  });

  it('renders non-empty multi-line output in every registered font', () => {
    expect(FONTS.length).toBeGreaterThanOrEqual(8);
    for (const font of FONTS) {
      const out = run('Ab', { font, layout: 'default' });
      expect(out.trim().length, `${font} produced no visible output`).toBeGreaterThan(0);
      expect(out.split('\n').length, `${font} produced a single line`).toBeGreaterThan(1);
    }
  });

  it('supports every horizontal layout', () => {
    for (const layout of LAYOUTS) {
      expect(run('Hi', { font: 'Standard', layout }).trim().length).toBeGreaterThan(0);
    }
    // 'full' never smushes letters, so it is at least as wide as 'fitted'.
    const width = (s: string) => Math.max(...s.split('\n').map((l) => l.length));
    expect(width(run('mm', { font: 'Standard', layout: 'full' }))).toBeGreaterThanOrEqual(
      width(run('mm', { font: 'Standard', layout: 'fitted' })),
    );
  });

  it('preserves leading spaces instead of trimming the input', () => {
    const padded = run('  Hi', { font: 'Standard', layout: 'default' });
    expect(padded.length).toBeGreaterThan(HI_STANDARD.length);
  });

  it('rejects empty and whitespace-only input', () => {
    expect(() => run('', { font: 'Standard', layout: 'default' })).toThrowError(ToolError);
    expect(() => run('   \n\t ', { font: 'Standard', layout: 'default' })).toThrowError(
      /Enter some text/,
    );
    try {
      run('', { font: 'Standard', layout: 'default' });
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });

  it('rejects input longer than the character limit', () => {
    const long = 'a'.repeat(MAX_LENGTH + 1);
    expect(() => run(long, { font: 'Standard', layout: 'default' })).toThrowError(/limit is 100/);
    // The boundary itself is allowed.
    expect(
      run('a'.repeat(MAX_LENGTH), { font: 'Standard', layout: 'default' }).length,
    ).toBeGreaterThan(0);
    try {
      run(long, { font: 'Standard', layout: 'default' });
    } catch (e) {
      expect((e as ToolError).code).toBe('input-too-long');
    }
  });

  it('rejects a font that is not registered', () => {
    expect(() => run('Hi', { font: 'Comic Sans', layout: 'default' })).toThrowError(ToolError);
    try {
      run('Hi', { font: 'Comic Sans', layout: 'default' });
    } catch (e) {
      expect((e as ToolError).code).toBe('unknown-font');
      expect((e as ToolError).fix).toMatch(/Standard/);
    }
  });

  it('rejects an invalid horizontal layout', () => {
    expect(() => run('Hi', { font: 'Standard', layout: 'sideways' })).toThrowError(
      /not a valid horizontal layout/,
    );
    try {
      run('Hi', { font: 'Standard', layout: 'sideways' });
    } catch (e) {
      expect((e as ToolError).code).toBe('unknown-layout');
    }
  });

  describe('maximum width', () => {
    it('never wraps at the unlimited sentinel, however long the input', () => {
      // A one-character banner is never wrapped by anything: its line count
      // is exactly the font's row height, the baseline every other case is
      // measured against.
      const height = run('H', { font: 'Standard', layout: 'default', maxWidth: MAX_WIDTH_UNLIMITED })
        .split('\n').length;

      const long = 'a'.repeat(MAX_LENGTH);
      const out = run(long, { font: 'Standard', layout: 'default', maxWidth: MAX_WIDTH_UNLIMITED });
      // Still exactly one banner block: unlimited width means no wrap ever
      // happens, so the row count cannot grow past the font's own height,
      // however many characters were rendered onto each of those rows.
      expect(out.split('\n').length).toBe(height);
    });

    it('treats a missing maxWidth the same as the unlimited sentinel', () => {
      const height = run('H', { font: 'Standard', layout: 'default' }).split('\n').length;
      const long = 'a'.repeat(MAX_LENGTH);
      expect(run(long, { font: 'Standard', layout: 'default' }).split('\n').length).toBe(height);
    });

    it('wraps at a set width into more than one banner block, every row within budget', () => {
      const height = run('H', { font: 'Standard', layout: 'default', maxWidth: MAX_WIDTH_UNLIMITED })
        .split('\n').length;

      const width = 20;
      const narrow = run('HiHiHiHiHiHiHiHi', { font: 'Standard', layout: 'default', maxWidth: width });
      const rows = narrow.split('\n');

      // A width tight enough to force a wrap produces more than one stacked
      // banner block (figlet's own wrapper only ever flushes the block it has
      // accumulated so far and starts a new one with the next character, so a
      // character is appended to a block whole or not at all: it is never cut
      // through the middle of its own rendered columns).
      expect(rows.length).toBeGreaterThan(height);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);
    });

    it('rejects a negative maximum width', () => {
      expect(() => run('Hi', { font: 'Standard', layout: 'default', maxWidth: -1 })).toThrowError(
        ToolError,
      );
      try {
        run('Hi', { font: 'Standard', layout: 'default', maxWidth: -1 });
      } catch (e) {
        expect((e as ToolError).code).toBe('invalid-max-width');
      }
    });
  });
});
