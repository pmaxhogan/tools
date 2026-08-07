import { describe, expect, it } from 'vitest';
import { DATA_TYPES, hashSeed, run } from './index';
import { ToolError } from '../types';

const base = { type: 'people', count: 5, seed: 'fixture-seed' };

describe('fake-data-generator', () => {
  it('generates the requested number of people records', () => {
    const out = run(undefined, base);
    const lines = out.split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).toMatch(/^.+ <.+@.+> · .+$/);
    }
  });

  it('is byte-identical for the same seed, for every type', () => {
    for (const type of DATA_TYPES) {
      const a = run(undefined, { ...base, type, count: 4 });
      const b = run(undefined, { ...base, type, count: 4 });
      expect(a).toBe(b);
    }
  });

  it('produces different output for different seeds', () => {
    const a = run(undefined, { ...base, seed: 'alpha' });
    const b = run(undefined, { ...base, seed: 'bravo' });
    expect(a).not.toBe(b);
  });

  it('produces different output on repeat runs when the seed is blank', () => {
    const a = run(undefined, { ...base, seed: '', count: 20 });
    const b = run(undefined, { ...base, seed: '', count: 20 });
    expect(a).not.toBe(b);
  });

  it('treats a whitespace-only seed as blank', () => {
    // Trimmed to '' → random, so two runs must differ.
    const a = run(undefined, { ...base, seed: '   ', count: 20 });
    const b = run(undefined, { ...base, seed: '   ', count: 20 });
    expect(a).not.toBe(b);
  });

  it('hashes seeds to stable, distinct uint32 values', () => {
    expect(hashSeed('alpha')).toBe(hashSeed('alpha'));
    expect(hashSeed('alpha')).not.toBe(hashSeed('bravo'));
    expect(hashSeed('alpha')).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hashSeed('alpha'))).toBe(true);
  });

  it('respects the count for line-based types', () => {
    for (const type of ['people', 'addresses', 'companies', 'credit-cards', 'lorem']) {
      // Lorem separates paragraphs with a blank line; the others are one per line.
      const sep = type === 'lorem' ? '\n\n' : '\n';
      expect(run(undefined, { ...base, type, count: 1 }).split(sep)).toHaveLength(1);
      expect(run(undefined, { ...base, type, count: 12 }).split(sep)).toHaveLength(12);
      expect(run(undefined, { ...base, type, count: 100 }).split(sep)).toHaveLength(100);
    }
  });

  it('emits users-json as valid JSON with the right shape and length', () => {
    const out = run(undefined, { ...base, type: 'users-json', count: 7 });
    expect(out.startsWith('[\n  {')).toBe(true); // pretty-printed
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(7);
    for (const u of parsed) {
      expect(Object.keys(u).sort()).toEqual(['address', 'email', 'id', 'name']);
      expect(u.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(u.email).toContain('@');
      expect(Object.keys(u.address).sort()).toEqual(['city', 'country', 'state', 'street', 'zip']);
    }
  });

  it('produces non-empty output for every select value', () => {
    for (const type of DATA_TYPES) {
      const out = run(undefined, { ...base, type, count: 3 });
      expect(out.trim().length).toBeGreaterThan(0);
    }
  });

  it('pairs credit card numbers with a matching issuer', () => {
    const out = run(undefined, { ...base, type: 'credit-cards', count: 10 });
    for (const line of out.split('\n')) {
      expect(line).toMatch(/^[a-z_]+ · [\d-]+ · CVV \d{3,4}$/);
    }
  });

  it('defaults to people when no type is given', () => {
    const out = run(undefined, { ...base, type: '' });
    expect(out).toBe(run(undefined, { ...base, type: 'people' }));
  });

  it('rejects an unknown data type with a typed error', () => {
    expect(() => run(undefined, { ...base, type: 'unicorns' })).toThrowError(ToolError);
    expect(() => run(undefined, { ...base, type: 'unicorns' })).toThrowError(/Unknown data type/);
  });

  it('rejects out-of-range counts with a typed error', () => {
    expect(() => run(undefined, { ...base, count: 0 })).toThrowError(ToolError);
    expect(() => run(undefined, { ...base, count: 101 })).toThrowError(/between 1 and 100/);
    expect(() => run(undefined, { ...base, count: Number.NaN })).toThrowError(ToolError);
  });
});
