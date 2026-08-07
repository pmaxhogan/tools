import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

describe('snowflake-decoder', () => {
  it('decodes a real Discord snowflake to its documented timestamp', () => {
    // Documented example from Discord's developer docs.
    const out = run('175928847299117063', { platform: 'discord' });
    expect(out['Timestamp (UTC)']).toBe('2016-04-30T11:18:25.796Z');
    expect(out['Unix milliseconds']).toBe('1462015105796');
    expect(out['Worker ID']).toBe('1');
    expect(out['Process ID']).toBe('0');
    expect(out['Increment']).toBe('7');
    expect(out['Warning']).toBeUndefined();
  });

  it('decodes a Twitter/X snowflake', () => {
    // Synthetic ID built from a known timestamp, machine 42, sequence 7.
    const out = run('1272499091666018311', { platform: 'twitter' });
    expect(out['Timestamp (UTC)']).toBe('2020-06-15T12:00:00.000Z');
    expect(out['Machine ID']).toBe('42');
    expect(out['Sequence']).toBe('7');
    expect(out['Warning']).toBeUndefined();
  });

  it('decodes an Instagram snowflake', () => {
    // Synthetic ID: timestamp << 23 | shard << 10 | sequence.
    const targetMs = Date.UTC(2021, 2, 1, 0, 0, 0);
    const id = (BigInt(targetMs) << 23n) | (99n << 10n) | 5n;
    const out = run(id.toString(), { platform: 'instagram' });
    expect(out['Timestamp (UTC)']).toBe(new Date(targetMs).toISOString());
    expect(out['Shard ID']).toBe('99');
    expect(out['Sequence']).toBe('5');
  });

  it('rejects non-numeric input with an actionable error', () => {
    expect(() => run('not-a-snowflake', { platform: 'discord' })).toThrowError(ToolError);
    try {
      run('abc123', { platform: 'discord' });
    } catch (e) {
      expect((e as ToolError).code).toBe('not-numeric');
      expect((e as ToolError).fix).toMatch(/positive whole number/);
    }
  });

  it('rejects empty input', () => {
    expect(() => run('', { platform: 'discord' })).toThrowError(ToolError);
    try {
      run('   ', { platform: 'discord' });
    } catch (e) {
      expect((e as ToolError).code).toBe('empty-input');
    }
  });

  it('warns when the decoded date is implausible for the selected platform', () => {
    // An absurdly large ID decodes to a date far past year 2100 under the
    // Discord formula — a strong signal the wrong platform was chosen.
    const out = run('99999999999999999999', { platform: 'discord' });
    expect(out['Warning']).toMatch(/double-check/i);
    expect(new Date(out['Timestamp (UTC)']!).getUTCFullYear()).toBeGreaterThan(2100);
  });

  it('defaults to discord when an unknown platform is given', () => {
    const out = run('175928847299117063', { platform: 'bogus' });
    expect(out['Worker ID']).toBe('1');
  });
});
