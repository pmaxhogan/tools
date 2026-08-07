import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

describe('week-number', () => {
  it('computes a full happy-path breakdown (2026-08-06, a Thursday)', () => {
    const out = run('2026-08-06', {});
    expect(out['ISO week']).toBe('W32');
    expect(out['ISO week-year']).toBe('2026');
    expect(out['Day of year']).toBe('218');
    expect(out['Day of week']).toBe('Thursday (4)');
    expect(out.Quarter).toBe('Q3');
    expect(out['Days remaining in year']).toBe('147');
    expect(out['Week range']).toBe('2026-08-03 - 2026-08-09');
  });

  it('handles 2026-01-01: ISO week W01 of 2026 (Jan 1 is a Thursday)', () => {
    const out = run('2026-01-01', {});
    expect(out['ISO week']).toBe('W01');
    expect(out['ISO week-year']).toBe('2026');
    expect(out['Day of year']).toBe('1');
    expect(out['Week range']).toBe('2025-12-29 - 2026-01-04');
  });

  it('handles 2027-01-01: it belongs to W53 of 2026, not W01 of 2027', () => {
    const out = run('2027-01-01', {});
    expect(out['ISO week']).toBe('W53');
    expect(out['ISO week-year']).toBe('2026');
  });

  it('handles 2024-12-30: it already belongs to W01 of 2025', () => {
    const out = run('2024-12-30', {});
    expect(out['ISO week']).toBe('W01');
    expect(out['ISO week-year']).toBe('2025');
  });

  it('handles 2021-01-01: it belongs to W53 of 2020', () => {
    const out = run('2021-01-01', {});
    expect(out['ISO week']).toBe('W53');
    expect(out['ISO week-year']).toBe('2020');
  });

  it('computes day-of-year 366 for the last day of a leap year', () => {
    const out = run('2024-12-31', {});
    expect(out['Day of year']).toBe('366');
    expect(out['Days remaining in year']).toBe('0');
  });

  it('accepts a full ISO datetime and uses only the date portion (UTC)', () => {
    const out = run('2026-08-06T23:59:59.999Z', {});
    expect(out['Day of week']).toBe('Thursday (4)');
    expect(out['Day of year']).toBe('218');
  });

  it('defaults empty input to today', () => {
    const out = run('', {});
    const doy = Number(out['Day of year']);
    expect(doy).toBeGreaterThanOrEqual(1);
    expect(doy).toBeLessThanOrEqual(366);
    expect(Number(out['ISO week-year'])).toBeGreaterThanOrEqual(2024);
  });

  it('rejects unparseable input with an actionable error', () => {
    expect(() => run('not a date', {})).toThrowError(ToolError);
    try {
      run('not a date', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('unparseable-date');
      expect((e as ToolError).fix).toMatch(/ISO 8601/);
    }
  });

  it('rejects a calendar date that does not exist', () => {
    expect(() => run('2026-02-30', {})).toThrowError(ToolError);
    try {
      run('2026-02-30', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid-date');
    }
  });
});
