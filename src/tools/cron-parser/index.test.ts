import { describe, expect, it } from 'vitest';
import { describeExpression, isoInZone, nextRuns, run } from './index';
import { ToolError } from '../types';

const FROM = new Date('2026-08-06T00:00:00Z');

describe('cron-parser', () => {
  it('reads a weekday expression in English and previews ten runs', () => {
    const out = run('*/15 9-17 * * 1-5', { tz: 'UTC', seconds: false });
    expect(out.Description).toBe(
      'Every 15 minutes, between 09:00 AM and 05:59 PM, Monday through Friday',
    );
    expect(Object.keys(out)).toHaveLength(11);
    expect(out['Next run 1']).toBeDefined();
    expect(out['Next run 10']).toBeDefined();
  });

  it('returns strictly increasing next-run times', () => {
    const out = run('*/15 9-17 * * 1-5', { tz: 'UTC', seconds: false });
    const times = Array.from({ length: 10 }, (_, i) => Date.parse(out[`Next run ${i + 1}`]!));
    expect(times.every((t) => Number.isFinite(t))).toBe(true);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });

  it('computes exact runs from an injected start time', () => {
    expect(
      nextRuns('0 0 * * *', { tz: 'UTC', from: FROM, count: 3 }).map((d) => d.toISOString()),
    ).toEqual(['2026-08-07T00:00:00.000Z', '2026-08-08T00:00:00.000Z', '2026-08-09T00:00:00.000Z']);
    expect(describeExpression('0 0 * * *')).toBe('At 12:00 AM');
  });

  it('applies the time zone to the preview', () => {
    const utc = nextRuns('0 9 * * *', { tz: 'UTC', from: FROM, count: 1 })[0]!;
    const ny = nextRuns('0 9 * * *', { tz: 'America/New_York', from: FROM, count: 1 })[0]!;
    expect(utc.toISOString()).toBe('2026-08-06T09:00:00.000Z');
    expect(ny.toISOString()).toBe('2026-08-06T13:00:00.000Z');
    expect(isoInZone(ny, 'America/New_York')).toBe('2026-08-06T09:00:00-04:00');
    expect(isoInZone(utc, 'UTC')).toBe('2026-08-06T09:00:00+00:00');
  });

  it('handles a six-field expression when the seconds option is on', () => {
    const out = run('30 0 9 * * 1-5', { tz: 'UTC', seconds: true });
    expect(out.Description).toBe('At 09:00:30 AM, Monday through Friday');
    expect(
      nextRuns('*/30 * * * * *', { tz: 'UTC', seconds: true, from: FROM, count: 2 }).map((d) =>
        d.toISOString(),
      ),
    ).toEqual(['2026-08-06T00:00:30.000Z', '2026-08-06T00:01:00.000Z']);
  });

  it('rejects a five-field expression when seconds are expected', () => {
    expect(() => run('*/15 9-17 * * 1-5', { tz: 'UTC', seconds: true })).toThrowError(ToolError);
    try {
      run('*/15 9-17 * * 1-5', { tz: 'UTC', seconds: true });
    } catch (e) {
      expect((e as ToolError).fix).toContain('0 */15 9-17 * * 1-5');
      expect((e as ToolError).fix).toMatch(/seconds/);
    }
  });

  it('rejects an invalid expression with the parse reason and an example fix', () => {
    expect(() => run('99 * * * *', { tz: 'UTC', seconds: false })).toThrowError(ToolError);
    try {
      run('99 * * * *', { tz: 'UTC', seconds: false });
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe('invalid-cron');
      expect(err.message).toMatch(/Invalid value for minute/i);
      expect(err.message).not.toMatch(/^Error:/);
      expect(err.fix).toContain('*/15 9-17 * * 1-5');
    }
    expect(() => run('not a cron', { tz: 'UTC', seconds: false })).toThrowError(/Could not parse/);
  });

  it('rejects empty input with an actionable error', () => {
    expect(() => run('', { tz: 'UTC', seconds: false })).toThrowError(ToolError);
    expect(() => run('   ', { tz: 'UTC', seconds: false })).toThrowError(/Enter a cron expression/);
  });

  it('rejects an unknown time zone', () => {
    expect(() => run('0 0 * * *', { tz: 'Mars/Olympus', seconds: false })).toThrowError(
      /Unknown time zone/,
    );
  });

  it('explains expressions that never match instead of showing an empty list', () => {
    const out = run('0 0 30 2 *', { tz: 'UTC', seconds: false });
    expect(out['Next runs']).toMatch(/never matches/);
    expect(out['Next run 1']).toBeUndefined();
  });

  it('tolerates ragged whitespace and defaults the zone to UTC', () => {
    const out = run('  0   9  *  *  1 ', { tz: '', seconds: false });
    expect(out.Description).toBe('At 09:00 AM, only on Monday');
    expect(out['Next run 1']).toMatch(/T09:00:00\+00:00$/);
  });
});
