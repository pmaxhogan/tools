import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

// Contains quotes, HTML-significant chars, unicode (BMP + surrogate-pair
// emoji), and backslashes — nasty enough to exercise every format.
const nasty = `She said "hi" <b>bold</b> & 'lonely' — π 🎉 C:\\path\\to\\file`;

describe('escape-unescape', () => {
  describe('json', () => {
    it('escapes control/quote characters (happy path)', () => {
      const out = run('line1\nline2\t"quoted"', { format: 'json', direction: 'escape' });
      expect(out).toBe('line1\\nline2\\t\\"quoted\\"');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      const escaped = run(nasty, { format: 'json', direction: 'escape' });
      const back = run(escaped, { format: 'json', direction: 'unescape' });
      expect(back).toBe(nasty);
    });

    it('throws ToolError on an invalid escape sequence', () => {
      expect(() => run('\\q', { format: 'json', direction: 'unescape' })).toThrowError(ToolError);
    });

    it('throws ToolError on an unterminated / unbalanced quote', () => {
      expect(() => run('say "hi', { format: 'json', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('html', () => {
    it('escapes the five HTML-significant characters (happy path)', () => {
      const out = run(`<a href="x">it's & fun</a>`, { format: 'html', direction: 'escape' });
      expect(out).toBe('&lt;a href=&quot;x&quot;&gt;it&apos;s &amp; fun&lt;/a&gt;');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      const escaped = run(nasty, { format: 'html', direction: 'escape' });
      const back = run(escaped, { format: 'html', direction: 'unescape' });
      expect(back).toBe(nasty);
    });

    it('unescapes named entities', () => {
      expect(run('caf&eacute;', { format: 'html', direction: 'unescape' })).toBe('café');
    });

    it('unescapes decimal numeric entities', () => {
      expect(run('caf&#233;', { format: 'html', direction: 'unescape' })).toBe('café');
    });

    it('unescapes hex numeric entities, including astral codepoints', () => {
      expect(run('&#x1F389;', { format: 'html', direction: 'unescape' })).toBe('🎉');
    });

    it('leaves unrecognized entities untouched instead of throwing', () => {
      expect(run('&notreal;', { format: 'html', direction: 'unescape' })).toBe('&notreal;');
    });
  });

  describe('url', () => {
    it('percent-encodes reserved characters (happy path)', () => {
      expect(run('a b&c=d', { format: 'url', direction: 'escape' })).toBe('a%20b%26c%3Dd');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      const escaped = run(nasty, { format: 'url', direction: 'escape' });
      const back = run(escaped, { format: 'url', direction: 'unescape' });
      expect(back).toBe(nasty);
    });

    it('throws ToolError on a truncated percent sequence', () => {
      expect(() => run('100%', { format: 'url', direction: 'unescape' })).toThrowError(ToolError);
    });

    it('throws ToolError on invalid hex digits after %', () => {
      expect(() => run('%zz', { format: 'url', direction: 'unescape' })).toThrowError(ToolError);
    });
  });

  describe('regex', () => {
    it('escapes regex metacharacters (happy path)', () => {
      expect(run('a.b*c?', { format: 'regex', direction: 'escape' })).toBe('a\\.b\\*c\\?');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      const escaped = run(nasty, { format: 'regex', direction: 'escape' });
      const back = run(escaped, { format: 'regex', direction: 'unescape' });
      expect(back).toBe(nasty);
    });

    it('produces a pattern that literally matches the original string', () => {
      const escaped = run('1+1=2? (maybe)', { format: 'regex', direction: 'escape' });
      const re = new RegExp(escaped);
      expect(re.test('1+1=2? (maybe)')).toBe(true);
    });
  });

  describe('shell', () => {
    it('wraps in single quotes and escapes embedded quotes (happy path)', () => {
      expect(run(`it's fine`, { format: 'shell', direction: 'escape' })).toBe(`'it'\\''s fine'`);
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      const escaped = run(nasty, { format: 'shell', direction: 'escape' });
      const back = run(escaped, { format: 'shell', direction: 'unescape' });
      expect(back).toBe(nasty);
    });

    it('leaves a string with no single quotes merely quoted', () => {
      expect(run('plain text', { format: 'shell', direction: 'escape' })).toBe("'plain text'");
    });
  });

  describe('shared behavior', () => {
    it('returns empty string for empty input on escape', () => {
      expect(run('', { format: 'json', direction: 'escape' })).toBe('');
    });

    it('returns empty string for empty input on unescape', () => {
      expect(run('', { format: 'shell', direction: 'unescape' })).toBe('');
    });

    it('throws ToolError for an unknown format', () => {
      expect(() => run('x', { format: 'yaml', direction: 'escape' })).toThrowError(ToolError);
    });

    it('throws ToolError for an unknown direction', () => {
      expect(() => run('x', { format: 'json', direction: 'sideways' })).toThrowError(ToolError);
    });
  });
});
