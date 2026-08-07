import { describe, expect, it } from 'vitest';
import { run, AMBIGUOUS_CHARS, LOWER, SYMBOLS, type PasswordOpts } from './index';
import { words } from './wordlist';
import { ToolError } from '../types';

function passwordOpts(overrides: Partial<PasswordOpts> = {}): PasswordOpts {
  return {
    mode: 'password',
    length: 20,
    lowercase: true,
    uppercase: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: false,
    words: 6,
    separator: '-',
    capitalize: false,
    seed: '',
    ...overrides,
  };
}

function passphraseOpts(overrides: Partial<PasswordOpts> = {}): PasswordOpts {
  return passwordOpts({ mode: 'passphrase', ...overrides });
}

describe('password-generator', () => {
  it('vendors the full EFF large wordlist', () => {
    expect(words.length).toBe(7776);
  });

  it('generates a password of the requested length from the full pool', () => {
    const out = run(undefined, passwordOpts({ seed: 'orient-express' }));
    expect(out.Password).toHaveLength(20);
    expect(out.Entropy).toMatch(/bits$/);
    expect(out['Crack time @ 10¹⁰/s']).toBeTruthy();
  });

  it('is deterministic for a given seed and varies across seeds', () => {
    const a = run(undefined, passwordOpts({ seed: 'same-seed' }));
    const b = run(undefined, passwordOpts({ seed: 'same-seed' }));
    const c = run(undefined, passwordOpts({ seed: 'different-seed' }));
    expect(a.Password).toBe(b.Password);
    expect(a.Password).not.toBe(c.Password);
  });

  it('is deterministic for passphrases too', () => {
    const a = run(undefined, passphraseOpts({ seed: 'diceware-seed' }));
    const b = run(undefined, passphraseOpts({ seed: 'diceware-seed' }));
    expect(a.Passphrase).toBe(b.Passphrase);
  });

  it('computes exact entropy for a known passphrase config (6 words = 77.5 bits)', () => {
    const out = run(undefined, passphraseOpts({ words: 6, seed: 'entropy-check' }));
    expect(out.Entropy).toBe('77.5 bits');
  });

  it('computes exact entropy for a known password config (lowercase-only, length 10)', () => {
    const out = run(
      undefined,
      passwordOpts({
        length: 10,
        lowercase: true,
        uppercase: false,
        digits: false,
        symbols: false,
        seed: 'entropy-check-2',
      })
    );
    const expected = (Math.log2(LOWER.length) * 10).toFixed(1);
    expect(out.Entropy).toBe(`${expected} bits`);
  });

  it('excludes ambiguous characters when requested', () => {
    const out = run(
      undefined,
      passwordOpts({ length: 128, excludeAmbiguous: true, seed: 'ambiguous-check' })
    );
    for (const ch of out.Password as string) {
      expect(AMBIGUOUS_CHARS.includes(ch)).toBe(false);
    }
  });

  it('omits symbols when the symbols charset is disabled', () => {
    const out = run(
      undefined,
      passwordOpts({ length: 128, symbols: false, seed: 'no-symbols-check' })
    );
    for (const ch of out.Password as string) {
      expect(SYMBOLS.includes(ch)).toBe(false);
    }
  });

  it('capitalizes and joins passphrase words with the given separator', () => {
    const out = run(
      undefined,
      passphraseOpts({ words: 4, separator: '_', capitalize: true, seed: 'capitalize-check' })
    );
    const parts = (out.Passphrase as string).split('_');
    expect(parts).toHaveLength(4);
    for (const part of parts) {
      expect(part[0]).toBe(part[0]?.toUpperCase());
    }
  });

  it('throws when every character set is disabled', () => {
    expect(() =>
      run(
        undefined,
        passwordOpts({ lowercase: false, uppercase: false, digits: false, symbols: false })
      )
    ).toThrowError(ToolError);
  });

  it('rejects out-of-range password lengths with a typed error', () => {
    expect(() => run(undefined, passwordOpts({ length: 4 }))).toThrowError(ToolError);
    expect(() => run(undefined, passwordOpts({ length: 200 }))).toThrowError(/8 and 128/);
  });

  it('rejects out-of-range word counts with a typed error', () => {
    expect(() => run(undefined, passphraseOpts({ words: 2 }))).toThrowError(ToolError);
    expect(() => run(undefined, passphraseOpts({ words: 20 }))).toThrowError(/3 and 12/);
  });
});
