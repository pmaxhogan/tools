import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

describe('discord-timestamp', () => {
  it('converts unix seconds', () => {
    const out = run('1754521200', {});
    expect(out['Unix seconds']).toBe('1754521200');
    expect(out['<t:1754521200:F> — long date/time']).toBe('<t:1754521200:F>');
  });

  it('parses ISO 8601 input', () => {
    const out = run('2026-01-02T03:04:05Z', {});
    const expectedSeconds = String(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000);
    expect(out['Unix seconds']).toBe(expectedSeconds);
  });

  it('treats 13+ digit numbers as milliseconds (heuristic)', () => {
    const out = run('1754521200000', {});
    expect(out['Unix seconds']).toBe('1754521200');
  });

  it('includes all seven Discord tag styles with correct style letters', () => {
    const out = run('1754521200', {});
    const seconds = '1754521200';
    for (const code of ['t', 'T', 'd', 'D', 'f', 'F', 'R']) {
      const tag = `<t:${seconds}:${code}>`;
      const row = Object.entries(out).find(([, v]) => v === tag);
      expect(row, `missing tag for style ${code}`).toBeDefined();
      expect(row?.[0].startsWith(tag)).toBe(true);
    }
    // Unix seconds row plus the 7 style rows.
    expect(Object.keys(out).length).toBe(8);
  });

  it('defaults empty input to now', () => {
    const out = run('', {});
    expect(Number(out['Unix seconds'])).toBeGreaterThan(1_700_000_000);
  });

  it('rejects garbage with an actionable error', () => {
    expect(() => run('not a date', {})).toThrowError(ToolError);
    try {
      run('not a date', {});
    } catch (e) {
      expect((e as ToolError).fix).toMatch(/ISO 8601/);
    }
  });
});
