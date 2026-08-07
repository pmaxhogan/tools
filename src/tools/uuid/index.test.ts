import { describe, expect, it } from 'vitest';
import { run, v4, v7 } from './index';
import { ToolError } from '../types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('uuid', () => {
  it('generates valid v4 UUIDs', () => {
    const u = v4();
    expect(u).toMatch(UUID_RE);
    expect(u[14]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(u[19]);
  });

  it('generates time-ordered v7 UUIDs', () => {
    const a = v7(1754521200000);
    const b = v7(1754521200001);
    expect(a).toMatch(UUID_RE);
    expect(a[14]).toBe('7');
    expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true);
  });

  it('generates the requested count', () => {
    const out = run(undefined, { version: 'v4', count: 5, uppercase: false });
    expect(out.split('\n')).toHaveLength(5);
  });

  it('uppercases when asked', () => {
    const out = run(undefined, { version: 'v4', count: 1, uppercase: true });
    expect(out).toBe(out.toUpperCase());
  });

  it('rejects out-of-range counts with a typed error', () => {
    expect(() => run(undefined, { version: 'v4', count: 0, uppercase: false })).toThrowError(
      ToolError
    );
    expect(() => run(undefined, { version: 'v4', count: 5000, uppercase: false })).toThrowError(
      /between 1 and 1000/
    );
  });
});
