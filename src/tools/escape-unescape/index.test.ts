import { describe, expect, it } from 'vitest';
import { run } from './index';
import { ToolError } from '../types';

// Contains quotes, HTML-significant chars, unicode (BMP + surrogate-pair
// emoji), and backslashes — nasty enough to exercise every format.
const nasty = `She said "hi" <b>bold</b> & 'lonely' — π 🎉 C:\\path\\to\\file`;

/** Round-trips `value` through escape -> unescape for `format` and asserts it matches. */
function expectRoundTrip(format: string, value: string): void {
  const escaped = run(value, { format, direction: 'escape' });
  const back = run(escaped, { format, direction: 'unescape' });
  expect(back).toBe(value);
}

describe('escape-unescape', () => {
  describe('json', () => {
    it('escapes control/quote characters (happy path)', () => {
      const out = run('line1\nline2\t"quoted"', { format: 'json', direction: 'escape' });
      expect(out).toBe('line1\\nline2\\t\\"quoted\\"');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('json', nasty);
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
      expectRoundTrip('html', nasty);
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

  describe('xml', () => {
    it('escapes the five predefined entities (happy path)', () => {
      expect(run(`<a href="x">it's & fun</a>`, { format: 'xml', direction: 'escape' })).toBe(
        '&lt;a href=&quot;x&quot;&gt;it&apos;s &amp; fun&lt;/a&gt;'
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('xml', nasty);
    });

    it('unescapes decimal and hex numeric references', () => {
      expect(run('caf&#233;', { format: 'xml', direction: 'unescape' })).toBe('café');
      expect(run('&#x1F389;', { format: 'xml', direction: 'unescape' })).toBe('🎉');
    });

    it('throws ToolError on a named entity outside the predefined five', () => {
      expect(() => run('&eacute;', { format: 'xml', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('url (component)', () => {
    it('percent-encodes reserved characters (happy path)', () => {
      expect(run('a b&c=d', { format: 'url', direction: 'escape' })).toBe('a%20b%26c%3Dd');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('url', nasty);
    });

    it('throws ToolError on a truncated percent sequence', () => {
      expect(() => run('100%', { format: 'url', direction: 'unescape' })).toThrowError(ToolError);
    });

    it('throws ToolError on invalid hex digits after %', () => {
      expect(() => run('%zz', { format: 'url', direction: 'unescape' })).toThrowError(ToolError);
    });
  });

  describe('url-full', () => {
    it('leaves URL structure characters alone (happy path)', () => {
      const out = run('https://a.com/x y?q=1', { format: 'url-full', direction: 'escape' });
      expect(out).toBe('https://a.com/x%20y?q=1');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('url-full', nasty);
    });

    it('throws ToolError on a malformed percent sequence', () => {
      expect(() => run('%zz', { format: 'url-full', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('url-form', () => {
    it('encodes a space as + (happy path)', () => {
      expect(run('a b+c', { format: 'url-form', direction: 'escape' })).toBe('a+b%2Bc');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('url-form', nasty);
    });

    it('decodes + back to a space', () => {
      expect(run('a+b', { format: 'url-form', direction: 'unescape' })).toBe('a b');
    });
  });

  describe('url-bytes', () => {
    it('percent-encodes every byte, including plain ASCII (happy path)', () => {
      expect(run('AB', { format: 'url-bytes', direction: 'escape' })).toBe('%41%42');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('url-bytes', nasty);
    });

    it('throws ToolError on a string that is not pure %XX groups', () => {
      expect(() => run('%41x', { format: 'url-bytes', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('regex', () => {
    it('escapes regex metacharacters (happy path)', () => {
      expect(run('a.b*c?', { format: 'regex', direction: 'escape' })).toBe('a\\.b\\*c\\?');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('regex', nasty);
    });

    it('produces a pattern that literally matches the original string', () => {
      const escaped = run('1+1=2? (maybe)', { format: 'regex', direction: 'escape' });
      const re = new RegExp(escaped);
      expect(re.test('1+1=2? (maybe)')).toBe(true);
    });
  });

  describe('c', () => {
    it('escapes control characters and quotes (happy path)', () => {
      expect(run('line1\nline2\t"q"\x1b', { format: 'c', direction: 'escape' })).toBe(
        'line1\\nline2\\t\\"q\\"\\x1b'
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('c', nasty);
    });

    it('throws ToolError on an unrecognized escape sequence', () => {
      expect(() => run('\\q', { format: 'c', direction: 'unescape' })).toThrowError(ToolError);
    });
  });

  describe('python', () => {
    it('escapes non-ASCII as \\u and control chars as named escapes (happy path)', () => {
      expect(run("it's café\n", { format: 'python', direction: 'escape' })).toBe(
        "it\\'s caf\\u00e9\\n"
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('python', nasty);
    });

    it('round-trips an astral character via \\U', () => {
      expectRoundTrip('python', '🎉');
    });

    it('throws ToolError on a truncated \\u escape', () => {
      expect(() => run('\\u12', { format: 'python', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('java', () => {
    it('escapes non-ASCII and control characters as \\uXXXX (happy path)', () => {
      expect(run('café\n', { format: 'java', direction: 'escape' })).toBe('caf\\u00e9\\n');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('java', nasty);
    });

    it('round-trips an astral character as a surrogate pair', () => {
      expectRoundTrip('java', '🎉');
    });

    it('throws ToolError on a truncated \\u escape', () => {
      expect(() => run('\\u12', { format: 'java', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('unicode-brace', () => {
    it('escapes non-ASCII with \\u{...} (happy path)', () => {
      expect(run('café', { format: 'unicode-brace', direction: 'escape' })).toBe('caf\\u{e9}');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('unicode-brace', nasty);
    });

    it('round-trips an astral character as one code point escape', () => {
      const escaped = run('🎉', { format: 'unicode-brace', direction: 'escape' });
      expect(escaped).toBe('\\u{1f389}');
      expectRoundTrip('unicode-brace', '🎉');
    });

    it('throws ToolError on an unclosed \\u{ escape', () => {
      expect(() => run('\\u{41', { format: 'unicode-brace', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('whitespace visualizer', () => {
    it('visualizes newlines and tabs (happy path)', () => {
      expect(run('a\nb\tc', { format: 'whitespace', direction: 'escape' })).toBe('a\\nb\\tc');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('whitespace', nasty);
    });

    it('throws ToolError on an unrecognized escape', () => {
      expect(() => run('\\q', { format: 'whitespace', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('hex-bytes', () => {
    it('escapes every byte as \\xHH (happy path)', () => {
      expect(run('AB', { format: 'hex-bytes', direction: 'escape' })).toBe('\\x41\\x42');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('hex-bytes', nasty);
    });

    it('throws ToolError on malformed input', () => {
      expect(() => run('\\x4', { format: 'hex-bytes', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('octal-bytes', () => {
    it('escapes every byte as \\NNN (happy path)', () => {
      expect(run('AB', { format: 'octal-bytes', direction: 'escape' })).toBe('\\101\\102');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('octal-bytes', nasty);
    });

    it('throws ToolError on malformed input', () => {
      expect(() => run('\\9', { format: 'octal-bytes', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('shell (POSIX single-quote)', () => {
    it('wraps in single quotes and escapes embedded quotes (happy path)', () => {
      expect(run(`it's fine`, { format: 'shell', direction: 'escape' })).toBe(`'it'\\''s fine'`);
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('shell', nasty);
    });

    it('leaves a string with no single quotes merely quoted', () => {
      expect(run('plain text', { format: 'shell', direction: 'escape' })).toBe("'plain text'");
    });
  });

  describe('shell-double (POSIX double-quote)', () => {
    it('wraps in double quotes and escapes $, ` and " (happy path)', () => {
      expect(run('$HOME `cmd` "q"', { format: 'shell-double', direction: 'escape' })).toBe(
        '"\\$HOME \\`cmd\\` \\"q\\""'
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('shell-double', nasty);
    });
  });

  describe('batch', () => {
    it('caret-escapes metacharacters and doubles percent signs (happy path)', () => {
      expect(run('a&b%c', { format: 'batch', direction: 'escape' })).toBe('a^&b%%c');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('batch', nasty);
    });
  });

  describe('powershell', () => {
    it('wraps in single quotes and doubles embedded quotes (happy path)', () => {
      expect(run(`it's fine`, { format: 'powershell', direction: 'escape' })).toBe(
        "'it''s fine'"
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('powershell', nasty);
    });
  });

  describe('sql', () => {
    it('wraps in single quotes and doubles embedded quotes (happy path)', () => {
      expect(run(`O'Brien`, { format: 'sql', direction: 'escape' })).toBe("'O''Brien'");
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('sql', nasty);
    });
  });

  describe('csv', () => {
    it('wraps in double quotes and doubles embedded quotes (happy path)', () => {
      expect(run('a,"b",c', { format: 'csv', direction: 'escape' })).toBe('"a,""b"",c"');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('csv', nasty);
    });
  });

  describe('ldap', () => {
    it('escapes * ( ) and \\ (happy path)', () => {
      expect(run('(a=b*)\\', { format: 'ldap', direction: 'escape' })).toBe(
        '\\28a=b\\2a\\29\\5c'
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('ldap', nasty);
    });

    it('throws ToolError on a backslash not followed by two hex digits', () => {
      expect(() => run('\\2', { format: 'ldap', direction: 'unescape' })).toThrowError(ToolError);
    });
  });

  describe('base64', () => {
    it('matches the well-known "Hello, World!" vector', () => {
      expect(run('Hello, World!', { format: 'base64', direction: 'escape' })).toBe(
        'SGVsbG8sIFdvcmxkIQ=='
      );
      expect(run('SGVsbG8sIFdvcmxkIQ==', { format: 'base64', direction: 'unescape' })).toBe(
        'Hello, World!'
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('base64', nasty);
    });

    it('throws ToolError on an invalid character', () => {
      expect(() => run('abc!', { format: 'base64', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('base64url', () => {
    it('uses - and _ with no padding (happy path)', () => {
      expect(run('any carnal pleasure.', { format: 'base64url', direction: 'escape' })).not.toMatch(
        /[+/=]/
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('base64url', nasty);
    });
  });

  describe('base32', () => {
    it('matches a known vector (happy path)', () => {
      expect(run('foobar', { format: 'base32', direction: 'escape' })).toBe(
        'MZXW6YTBOI======'
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('base32', nasty);
    });

    it('throws ToolError on an invalid character', () => {
      expect(() => run('1', { format: 'base32', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('base58', () => {
    it('matches a known vector (happy path)', () => {
      expect(run('Hello, World!', { format: 'base58', direction: 'escape' })).toBe(
        '72k1wXWG59fYdySNnA'
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('base58', nasty);
    });

    it('preserves leading zero bytes as leading 1s', () => {
      expectRoundTrip('base58', '\u0000\u0000abc');
    });

    it('throws ToolError on an excluded character like 0', () => {
      expect(() => run('0', { format: 'base58', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('ascii85', () => {
    it('matches the classic "Man " vector', () => {
      expect(run('Man ', { format: 'ascii85', direction: 'escape' })).toBe('<~9jqo^~>');
      expect(run('<~9jqo^~>', { format: 'ascii85', direction: 'unescape' })).toBe('Man ');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('ascii85', nasty);
    });

    it('uses the z shortcut for an all-zero group', () => {
      expect(run('\u0000\u0000\u0000\u0000', { format: 'ascii85', direction: 'escape' })).toBe(
        '<~z~>'
      );
    });
  });

  describe('uuencode', () => {
    it('round-trips a short string', () => {
      expectRoundTrip('uuencode', 'Cat');
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('uuencode', nasty);
    });

    it('throws ToolError on a truncated line', () => {
      expect(() => run('#QQ', { format: 'uuencode', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('quoted-printable', () => {
    it('escapes an equals sign and high bytes (happy path)', () => {
      expect(run('100% = café', { format: 'quoted-printable', direction: 'escape' })).toBe(
        '100% =3D caf=C3=A9'
      );
    });

    it('round-trips a nasty string through escape -> unescape', () => {
      expectRoundTrip('quoted-printable', nasty);
    });

    it('throws ToolError on a malformed escape', () => {
      expect(() =>
        run('=zz', { format: 'quoted-printable', direction: 'unescape' })
      ).toThrowError(ToolError);
    });
  });

  describe('rot13', () => {
    it('matches the well-known vector', () => {
      expect(run('Hello, World!', { format: 'rot13', direction: 'escape' })).toBe(
        'Uryyb, Jbeyq!'
      );
    });

    it('is self-inverse: applying it twice returns the original', () => {
      const once = run(nasty, { format: 'rot13', direction: 'escape' });
      const twice = run(once, { format: 'rot13', direction: 'escape' });
      expect(twice).toBe(nasty);
    });

    it('escape and unescape produce the same result', () => {
      expect(run('abc', { format: 'rot13', direction: 'escape' })).toBe(
        run('abc', { format: 'rot13', direction: 'unescape' })
      );
    });
  });

  describe('rot47', () => {
    it('is self-inverse: applying it twice returns the original', () => {
      const once = run('Hello, World! 123', { format: 'rot47', direction: 'escape' });
      const twice = run(once, { format: 'rot47', direction: 'escape' });
      expect(twice).toBe('Hello, World! 123');
    });
  });

  describe('morse', () => {
    it('matches the well-known SOS vector', () => {
      expect(run('SOS', { format: 'morse', direction: 'escape' })).toBe('... --- ...');
    });

    it('round-trips uppercase text through escape -> unescape', () => {
      expectRoundTrip('morse', 'HELLO WORLD');
    });

    it('throws ToolError on a character with no Morse representation', () => {
      expect(() => run('🎉', { format: 'morse', direction: 'escape' })).toThrowError(ToolError);
    });

    it('throws ToolError on an unrecognized code', () => {
      expect(() => run('.......', { format: 'morse', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('nato', () => {
    it('spells out a word (happy path)', () => {
      expect(run('SOS', { format: 'nato', direction: 'escape' })).toBe(
        'Sierra Oscar Sierra'
      );
    });

    it('round-trips uppercase text through escape -> unescape', () => {
      expectRoundTrip('nato', 'HELLO WORLD');
    });

    it('throws ToolError on an unrecognized word', () => {
      expect(() => run('Sierra Nope', { format: 'nato', direction: 'unescape' })).toThrowError(
        ToolError
      );
    });
  });

  describe('punycode', () => {
    it('matches the well-known münchen.de vector', () => {
      expect(run('münchen.de', { format: 'punycode', direction: 'escape' })).toBe(
        'xn--mnchen-3ya.de'
      );
      expect(run('xn--mnchen-3ya.de', { format: 'punycode', direction: 'unescape' })).toBe(
        'münchen.de'
      );
    });

    it('leaves an ASCII-only domain untouched', () => {
      expect(run('example.com', { format: 'punycode', direction: 'escape' })).toBe(
        'example.com'
      );
    });

    it('round-trips a single non-ASCII label', () => {
      expectRoundTrip('punycode', 'café');
    });

    it('throws ToolError on an invalid punycode digit', () => {
      expect(() => run('xn--a!', { format: 'punycode', direction: 'unescape' })).toThrowError(
        ToolError
      );
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
