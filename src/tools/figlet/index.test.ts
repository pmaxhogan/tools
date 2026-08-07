import { describe, expect, it } from 'vitest';
import { FONTS, LAYOUTS, MAX_LENGTH, run } from './index';
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
});
