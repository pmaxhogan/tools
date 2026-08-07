import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

describe('epoch-converter', () => {
  it('converts unix seconds', () => {
    const out = run('1754521200', { tz: 'UTC' });
    expect(out['Unix seconds']).toBe('1754521200');
    expect(out['ISO 8601 (UTC)']).toBe('2025-08-06T23:00:00.000Z');
  });

  it('converts unix milliseconds (heuristic)', () => {
    const out = run('1754521200000', { tz: 'UTC' });
    expect(out['Unix seconds']).toBe('1754521200');
  });

  it('parses ISO 8601 input', () => {
    const out = run('2026-01-02T03:04:05Z', { tz: 'UTC' });
    expect(out['Unix seconds']).toBe(String(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000));
  });

  it('rejects garbage with an actionable error', () => {
    expect(() => run('not a date', { tz: 'UTC' })).toThrowError(ToolError);
    try {
      run('not a date', { tz: 'UTC' });
    } catch (e) {
      expect((e as ToolError).fix).toMatch(/ISO 8601/);
    }
  });

  it('rejects unknown time zones with an actionable error', () => {
    expect(() => run('1754521200', { tz: 'Mars/Olympus' })).toThrowError(/Unknown time zone/);
  });

  it('defaults empty input to now', () => {
    const out = run('', { tz: 'UTC' });
    expect(Number(out['Unix seconds'])).toBeGreaterThan(1_700_000_000);
  });
});
