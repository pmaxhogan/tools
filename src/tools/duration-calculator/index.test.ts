import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

describe('duration-calculator', () => {
  it('evaluates a mixed-format expression left to right', () => {
    const out = run('1:30:00 + 45min - 20s', {});
    expect(out['Total (hh:mm:ss)']).toBe('02:14:40');
    expect(out['Days hours minutes']).toBe('2 hours 14 minutes');
    expect(out['Total seconds']).toBe('8080');
    expect(out['Total minutes']).toBe('134.67');
    expect(out['Total hours']).toBe('2.244');
  });

  it('sums one-duration-per-line input with no operators', () => {
    const out = run('1h\n30m\n15s', {});
    expect(out['Total (hh:mm:ss)']).toBe('01:30:15');
    expect(out['Days hours minutes']).toBe('1 hour 30 minutes');
    expect(out['Total seconds']).toBe('5415');
    expect(out['Total minutes']).toBe('90.25');
    expect(out['Total hours']).toBe('1.504');
  });

  it('parses decimal-hour unit shorthand', () => {
    const out = run('1.5h', {});
    expect(out['Total (hh:mm:ss)']).toBe('01:30:00');
    expect(out['Days hours minutes']).toBe('1 hour 30 minutes');
    expect(out['Total minutes']).toBe('90.00');
    expect(out['Total hours']).toBe('1.500');
  });

  it('renders negative totals with a leading minus sign on every field', () => {
    const out = run('30m - 1h', {});
    expect(out['Total (hh:mm:ss)']).toBe('-00:30:00');
    expect(out['Days hours minutes']).toBe('-30 minutes');
    expect(out['Total seconds']).toBe('-1800');
    expect(out['Total minutes']).toBe('-30.00');
    expect(out['Total hours']).toBe('-0.500');
  });

  it('preserves millisecond precision in the totals', () => {
    const out = run('1:00:00 + 500ms', {});
    expect(out['Total seconds']).toBe('3600.5');
    expect(out['Total (hh:mm:ss)']).toBe('01:00:00');
  });

  it('rejects an unparseable token, naming the exact token and a fix example', () => {
    expect(() => run('1h + xyz', {})).toThrowError(ToolError);
    try {
      run('1h + xyz', {});
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('unparseable-token');
      expect(err.message).toContain('"xyz"');
      expect(err.message).toMatch(/position/);
      expect(err.fix).toMatch(/1:30:00/);
    }
  });

  it('rejects empty input with a clear ToolError', () => {
    expect(() => run('', {})).toThrowError(ToolError);
    try {
      run('', {});
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });
});
