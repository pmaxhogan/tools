import { ToolError, type ToolLogic } from '../types';

export interface EscapeOpts {
  /** Which encoding/format to apply — see the `format` select choices in meta.ts. */
  format: string;
  /** 'escape' (encode) | 'unescape' (decode) */
  direction: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Shared byte helpers. UTF-8 in, UTF-8 out; invalid UTF-8 on decode becomes a
// ToolError instead of the mojibake replacement character.
// ---------------------------------------------------------------------------

function strToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bytesToStr(bytes: Uint8Array, code: string, message: string, fix: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError(code, message, fix);
  }
}

// ---------------------------------------------------------------------------
// JSON — string-literal escaping (no outer quotes).
// ---------------------------------------------------------------------------

function jsonEscape(str: string): string {
  // JSON.stringify always wraps in quotes; strip them to get the raw
  // escaped-content form the "json" format promises.
  return JSON.stringify(str).slice(1, -1);
}

function jsonUnescape(str: string): string {
  try {
    const parsed: unknown = JSON.parse(`"${str}"`);
    if (typeof parsed !== 'string') throw new Error('not a string');
    return parsed;
  } catch {
    throw new ToolError(
      'invalid-json-escape',
      `"${str}" is not valid JSON string-escaped text.`,
      'Check for unescaped quotes, raw control characters, or invalid \\ escape sequences.',
    );
  }
}

// ---------------------------------------------------------------------------
// HTML — named entities for the common set, numeric (decimal) fallback for
// everything else non-ASCII. Hand-rolled, no DOM.
// ---------------------------------------------------------------------------

/** name -> character, for the common HTML entities. Source of truth for both directions. */
const ENTITY_TO_CHAR: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  eacute: '\u00E9',
  egrave: '\u00E8',
  ecirc: '\u00EA',
  agrave: '\u00E0',
  acirc: '\u00E2',
  ccedil: '\u00E7',
  ntilde: '\u00F1',
  uuml: '\u00FC',
  ouml: '\u00F6',
  auml: '\u00E4',
  szlig: '\u00DF',
  euro: '\u20AC',
  pound: '\u00A3',
  yen: '\u00A5',
  cent: '\u00A2',
  deg: '\u00B0',
  plusmn: '\u00B1',
  times: '\u00D7',
  divide: '\u00F7',
  frac12: '\u00BD',
  frac14: '\u00BC',
  frac34: '\u00BE',
  sect: '\u00A7',
  para: '\u00B6',
  middot: '\u00B7',
  bull: '\u2022',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  hearts: '\u2665',
  spades: '\u2660',
  clubs: '\u2663',
  diams: '\u2666',
  alpha: '\u03B1',
  beta: '\u03B2',
  gamma: '\u03B3',
  pi: '\u03C0',
  sum: '\u2211',
  infin: '\u221E',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  radic: '\u221A',
};

/** character -> entity name, derived from ENTITY_TO_CHAR (last writer wins on dupes, none expected). */
const CHAR_TO_ENTITY: Record<string, string> = {};
for (const [name, ch] of Object.entries(ENTITY_TO_CHAR)) {
  CHAR_TO_ENTITY[ch] = `&${name};`;
}

function htmlEscape(str: string): string {
  let out = '';
  for (const ch of str) {
    const named = CHAR_TO_ENTITY[ch];
    if (named) {
      out += named;
    } else if (ch.codePointAt(0)! > 127) {
      out += `&#${ch.codePointAt(0)};`;
    } else {
      out += ch;
    }
  }
  return out;
}

const HTML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

function htmlUnescape(str: string): string {
  return str.replace(HTML_ENTITY_RE, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const ch = ENTITY_TO_CHAR[body];
    return ch !== undefined ? ch : match;
  });
}

// ---------------------------------------------------------------------------
// XML — only the five predefined general entities, plus numeric refs. Unlike
// HTML, an unrecognized named entity is a real error: XML has no built-in
// named-entity table beyond these five.
// ---------------------------------------------------------------------------

const XML_NAMED_TO_CHAR: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function xmlEscape(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

function xmlUnescape(str: string): string {
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) {
        throw new ToolError(
          'invalid-xml-escape',
          `"${match}" is not a valid numeric character reference.`,
          'Use decimal (&#233;) or hex (&#xE9;) digits only.',
        );
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        throw new ToolError(
          'invalid-xml-escape',
          `"${match}" is not a valid Unicode code point.`,
          'Numeric character references must be between 0 and 10FFFF.',
        );
      }
    }
    const ch = XML_NAMED_TO_CHAR[body];
    if (ch === undefined) {
      throw new ToolError(
        'invalid-xml-escape',
        `"${match}" is not one of the five predefined XML entities.`,
        'XML only defines &amp; &lt; &gt; &quot; and &apos; by default; use a numeric reference for anything else.',
      );
    }
    return ch;
  });
}

// ---------------------------------------------------------------------------
// URL — three flavors of percent-encoding, plus a raw every-byte variant.
// ---------------------------------------------------------------------------

function urlEscape(str: string): string {
  return encodeURIComponent(str);
}

function urlUnescape(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    throw new ToolError(
      'invalid-url-escape',
      `"${str}" contains a malformed percent-encoding sequence.`,
      'Make sure every % is followed by two hex digits and the encoded bytes form valid UTF-8.',
    );
  }
}

function urlFullEscape(str: string): string {
  return encodeURI(str);
}

function urlFullUnescape(str: string): string {
  try {
    return decodeURI(str);
  } catch {
    throw new ToolError(
      'invalid-url-escape',
      `"${str}" contains a malformed percent-encoding sequence.`,
      'Make sure every % is followed by two hex digits and the encoded bytes form valid UTF-8.',
    );
  }
}

function urlFormEscape(str: string): string {
  return encodeURIComponent(str).replace(/%20/g, '+');
}

function urlFormUnescape(str: string): string {
  try {
    return decodeURIComponent(str.replace(/\+/g, '%20'));
  } catch {
    throw new ToolError(
      'invalid-url-escape',
      `"${str}" contains a malformed percent-encoding sequence.`,
      'Make sure every % is followed by two hex digits and the encoded bytes form valid UTF-8.',
    );
  }
}

function urlBytesEscape(str: string): string {
  const bytes = strToBytes(str);
  let out = '';
  for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  return out;
}

function urlBytesUnescape(str: string): string {
  if (!/^(%[0-9a-fA-F]{2})+$/.test(str)) {
    throw new ToolError(
      'invalid-url-bytes-escape',
      `"${str}" is not a sequence of %XX byte escapes.`,
      'Every byte must be written as a percent sign followed by two hex digits, with nothing else in the string.',
    );
  }
  const hexPairs = str.match(/[0-9a-fA-F]{2}/g)!;
  const bytes = new Uint8Array(hexPairs.length);
  hexPairs.forEach((h, i) => (bytes[i] = parseInt(h, 16)));
  return bytesToStr(
    bytes,
    'invalid-url-bytes-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that the byte sequence represents complete UTF-8 characters.',
  );
}

// ---------------------------------------------------------------------------
// Regex — escape metacharacters so the string matches itself literally.
// ---------------------------------------------------------------------------

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;
const REGEX_ESCAPED = /\\([.*+?^${}()|[\]\\])/g;

function regexEscape(str: string): string {
  return str.replace(REGEX_METACHARS, '\\$&');
}

function regexUnescape(str: string): string {
  return str.replace(REGEX_ESCAPED, '$1');
}

// ---------------------------------------------------------------------------
// C / C++ string-literal escapes. Non-ASCII characters pass through as raw
// UTF-8 (as real C source usually does); only control characters, the
// backslash and the double quote are escaped. \xHH here is always exactly
// two hex digits (unlike real C's variable-width \x) so encode/decode stay
// unambiguous and reversible.
// ---------------------------------------------------------------------------

const C_NAMED_ESCAPES: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
  0x0b: '\\v',
  0x00: '\\0',
};
const C_NAMED_UNESCAPE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

function cEscape(str: string): string {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (code in C_NAMED_ESCAPES) out += C_NAMED_ESCAPES[code];
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

function cUnescape(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = str[i + 1];
    if (next === 'x') {
      const hex = str.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new ToolError(
          'invalid-c-escape',
          `"\\x${hex}" is not a valid two-digit hex escape.`,
          '\\x must be followed by exactly two hex digits, like \\x1b.',
        );
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 3;
    } else if (next !== undefined && next in C_NAMED_UNESCAPE) {
      out += C_NAMED_UNESCAPE[next];
      i += 1;
    } else {
      throw new ToolError(
        'invalid-c-escape',
        `"\\${next ?? ''}" is not a recognized C escape sequence.`,
        'Valid escapes are \\\\, \\", \\\', \\n, \\t, \\r, \\a, \\b, \\f, \\v, \\0 and \\xHH.',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Python string-literal escapes. Targets a single-quoted literal (only '
// needs escaping; " is left alone). Non-ASCII code points become \uXXXX or
// \UXXXXXXXX, matching Python's repr() behavior for non-printable text.
// ---------------------------------------------------------------------------

const PY_NAMED_ESCAPES: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
  0x0b: '\\v',
};
const PY_NAMED_UNESCAPE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

function pythonEscape(str: string): string {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (code === 0x00) out += '\\x00';
    else if (code in PY_NAMED_ESCAPES) out += PY_NAMED_ESCAPES[code];
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else if (code > 0xffff) out += '\\U' + code.toString(16).padStart(8, '0');
    else if (code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out;
}

function pythonUnescape(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = str[i + 1];
    if (next === 'x') {
      const hex = str.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new ToolError(
          'invalid-python-escape',
          `"\\x${hex}" is not a valid two-digit hex escape.`,
          '\\x must be followed by exactly two hex digits, like \\x1b.',
        );
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 3;
    } else if (next === 'u') {
      const hex = str.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new ToolError(
          'invalid-python-escape',
          `"\\u${hex}" is not a valid four-digit unicode escape.`,
          '\\u must be followed by exactly four hex digits, like \\u00e9.',
        );
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else if (next === 'U') {
      const hex = str.slice(i + 2, i + 10);
      if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
        throw new ToolError(
          'invalid-python-escape',
          `"\\U${hex}" is not a valid eight-digit unicode escape.`,
          '\\U must be followed by exactly eight hex digits, like \\U0001f389.',
        );
      }
      const code = parseInt(hex, 16);
      try {
        out += String.fromCodePoint(code);
      } catch {
        throw new ToolError(
          'invalid-python-escape',
          `"\\U${hex}" is not a valid Unicode code point.`,
          'Eight-digit escapes must be between \\U00000000 and \\U0010FFFF.',
        );
      }
      i += 9;
    } else if (next !== undefined && next in PY_NAMED_UNESCAPE) {
      out += PY_NAMED_UNESCAPE[next];
      i += 1;
    } else {
      throw new ToolError(
        'invalid-python-escape',
        `"\\${next ?? ''}" is not a recognized Python escape sequence.`,
        'Valid escapes are \\\\, \\\', \\", \\n, \\t, \\r, \\a, \\b, \\f, \\v, \\xHH, \\uXXXX and \\UXXXXXXXX.',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Java / .NET style \uXXXX escapes. Java strings are UTF-16, so this walks
// UTF-16 code units directly (not code points) — astral characters become
// two consecutive \uXXXX surrogate escapes, exactly as javac would emit.
// ---------------------------------------------------------------------------

const JAVA_NAMED_ESCAPES: Record<number, string> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
};
const JAVA_NAMED_UNESCAPE: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

function javaEscape(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (str[i] === '\\') out += '\\\\';
    else if (str[i] === '"') out += '\\"';
    else if (code in JAVA_NAMED_ESCAPES) out += JAVA_NAMED_ESCAPES[code];
    else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += str[i];
  }
  return out;
}

function javaUnescape(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = str[i + 1];
    if (next === 'u') {
      const hex = str.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new ToolError(
          'invalid-java-escape',
          `"\\u${hex}" is not a valid four-digit unicode escape.`,
          '\\u must be followed by exactly four hex digits, like \\u00e9.',
        );
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else if (next !== undefined && next in JAVA_NAMED_UNESCAPE) {
      out += JAVA_NAMED_UNESCAPE[next];
      i += 1;
    } else {
      throw new ToolError(
        'invalid-java-escape',
        `"\\${next ?? ''}" is not a recognized Java escape sequence.`,
        'Valid escapes are \\\\, \\", \\\', \\n, \\t, \\r, \\b, \\f and \\uXXXX.',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ES2015 \u{...} code-point escapes (the brace form used in JS/TS string and
// regex literals). Escapes control characters, the backslash, and anything
// above ASCII; everything else, including quote characters, is left literal.
// ---------------------------------------------------------------------------

function unicodeBraceEscape(str: string): string {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f || code > 0x7e) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return out;
}

function unicodeBraceUnescape(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = str[i + 1];
    if (next === '\\') {
      out += '\\';
      i += 1;
    } else if (next === 'u' && str[i + 2] === '{') {
      const close = str.indexOf('}', i + 3);
      if (close === -1) {
        throw new ToolError(
          'invalid-unicode-brace-escape',
          `"\\u{" at position ${i} is never closed with a "}".`,
          'Every \\u{...} escape needs a matching closing brace.',
        );
      }
      const hex = str.slice(i + 3, close);
      if (!/^[0-9a-fA-F]+$/.test(hex)) {
        throw new ToolError(
          'invalid-unicode-brace-escape',
          `"\\u{${hex}}" is not valid hex.`,
          '\\u{...} must contain only hex digits, like \\u{1f389}.',
        );
      }
      const code = parseInt(hex, 16);
      if (code > 0x10ffff) {
        throw new ToolError(
          'invalid-unicode-brace-escape',
          `"\\u{${hex}}" is above the maximum Unicode code point.`,
          'Code points must be between 0 and 10FFFF.',
        );
      }
      out += String.fromCodePoint(code);
      i = close;
    } else {
      throw new ToolError(
        'invalid-unicode-brace-escape',
        `"\\${next ?? ''}" is not a recognized escape here.`,
        'Only \\\\ and \\u{...} are used by this format.',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whitespace / control-character visualizer — reveals invisible characters
// as backslash escapes without touching anything else, including quotes.
// ---------------------------------------------------------------------------

function whitespaceEscape(str: string): string {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

function whitespaceUnescape(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = str[i + 1];
    if (next === '\\') {
      out += '\\';
      i += 1;
    } else if (next === 'n') {
      out += '\n';
      i += 1;
    } else if (next === 't') {
      out += '\t';
      i += 1;
    } else if (next === 'r') {
      out += '\r';
      i += 1;
    } else if (next === 'x') {
      const hex = str.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new ToolError(
          'invalid-whitespace-escape',
          `"\\x${hex}" is not a valid two-digit hex escape.`,
          '\\x must be followed by exactly two hex digits.',
        );
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 3;
    } else {
      throw new ToolError(
        'invalid-whitespace-escape',
        `"\\${next ?? ''}" is not a recognized escape here.`,
        'Only \\\\, \\n, \\t, \\r and \\xHH are used by this format.',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full-string hex and octal byte dumps — every byte escaped, not just the
// non-printable ones. Useful for pasting arbitrary bytes into places that
// only accept \xHH / \NNN literals.
// ---------------------------------------------------------------------------

function hexBytesEscape(str: string): string {
  const bytes = strToBytes(str);
  let out = '';
  for (const b of bytes) out += '\\x' + b.toString(16).padStart(2, '0');
  return out;
}

function hexBytesUnescape(str: string): string {
  if (!/^(\\x[0-9a-fA-F]{2})+$/.test(str)) {
    throw new ToolError(
      'invalid-hex-bytes-escape',
      `"${str}" is not a sequence of \\xHH byte escapes.`,
      'Every byte must be written as \\x followed by two hex digits, with nothing else in the string.',
    );
  }
  const hexPairs = str.match(/[0-9a-fA-F]{2}/g)!;
  const bytes = new Uint8Array(hexPairs.length);
  hexPairs.forEach((h, i) => (bytes[i] = parseInt(h, 16)));
  return bytesToStr(
    bytes,
    'invalid-hex-bytes-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that the byte sequence represents complete UTF-8 characters.',
  );
}

function octalBytesEscape(str: string): string {
  const bytes = strToBytes(str);
  let out = '';
  for (const b of bytes) out += '\\' + b.toString(8).padStart(3, '0');
  return out;
}

function octalBytesUnescape(str: string): string {
  if (!/^(\\[0-7]{3})+$/.test(str)) {
    throw new ToolError(
      'invalid-octal-bytes-escape',
      `"${str}" is not a sequence of \\NNN byte escapes.`,
      'Every byte must be written as a backslash followed by exactly three octal digits (0-7), with nothing else in the string.',
    );
  }
  const groups = str.match(/[0-7]{3}/g)!;
  const bytes = new Uint8Array(groups.length);
  groups.forEach((g, i) => (bytes[i] = parseInt(g, 8)));
  return bytesToStr(
    bytes,
    'invalid-octal-bytes-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that the byte sequence represents complete UTF-8 characters.',
  );
}

// ---------------------------------------------------------------------------
// Shell escaping — POSIX single-quote (the classic '\'' dance) and
// POSIX double-quote (only \, $, ` and " are special inside).
// ---------------------------------------------------------------------------

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function shellUnescape(str: string): string {
  let s = str;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.replace(/'\\''/g, "'");
}

function shellDoubleEscape(str: string): string {
  return `"${str.replace(/[\\$`"]/g, '\\$&')}"`;
}

function shellDoubleUnescape(str: string): string {
  let s = str;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\([\\$`"])/g, '$1');
}

// ---------------------------------------------------------------------------
// Windows batch (cmd.exe) — unquoted-argument style: caret-escape the
// metacharacters, double up percent signs. Best-effort; cmd's real quoting
// rules are context-dependent and this covers the common case.
// ---------------------------------------------------------------------------

function batchEscape(str: string): string {
  return str.replace(/[\^&|<>()"]/g, '^$&').replace(/%/g, '%%');
}

function batchUnescape(str: string): string {
  return str.replace(/%%/g, '%').replace(/\^([\^&|<>()"])/g, '$1');
}

// ---------------------------------------------------------------------------
// PowerShell single-quoted string — embedded single quotes are doubled.
// ---------------------------------------------------------------------------

function singleQuoteDouble(str: string): string {
  return `'${str.replace(/'/g, "''")}'`;
}

function singleQuoteUndouble(str: string): string {
  let s = str;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.replace(/''/g, "'");
}

// ---------------------------------------------------------------------------
// SQL string literal — ANSI standard single-quote doubling.
// ---------------------------------------------------------------------------

// (shares the singleQuoteDouble / singleQuoteUndouble helpers above)

// ---------------------------------------------------------------------------
// CSV field quoting (RFC 4180) — always wrap in double quotes, double any
// embedded quotes.
// ---------------------------------------------------------------------------

function csvEscape(str: string): string {
  return `"${str.replace(/"/g, '""')}"`;
}

function csvUnescape(str: string): string {
  if (str.length >= 2 && str.startsWith('"') && str.endsWith('"')) {
    return str.slice(1, -1).replace(/""/g, '"');
  }
  return str;
}

// ---------------------------------------------------------------------------
// LDAP filter escaping (RFC 4515) — the five characters that are always
// unsafe in a filter: * ( ) \ and NUL, each written as a backslash and two
// hex digits.
// ---------------------------------------------------------------------------

const LDAP_ESCAPE_MAP: Record<string, string> = {
  '*': '\\2a',
  '(': '\\28',
  ')': '\\29',
  '\\': '\\5c',
  '\u0000': '\\00',
};

function ldapEscape(str: string): string {
  // The NUL character cannot appear as a literal inside a regex pattern
  // (flagged by the no-control-regex lint rule), so it is handled as a
  // plain string split/join instead of folding it into the character class.
  const escaped = str.replace(/[*()\\]/g, (ch) => LDAP_ESCAPE_MAP[ch]);
  return escaped.split('\u0000').join('\\00');
}

function ldapUnescape(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') {
      const hex = str.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new ToolError(
          'invalid-ldap-escape',
          `Backslash at position ${i} is not followed by two hex digits.`,
          'LDAP filter escapes are always a backslash followed by exactly two hex digits, like \\2a for *.',
        );
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else {
      out += ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base64 / Base64url — hand-rolled over bytes so both alphabets and padding
// behavior are explicit rather than relying on the deprecated btoa/atob
// binary-string APIs.
// ---------------------------------------------------------------------------

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64EncodeBytes(bytes: Uint8Array, chars: string, pad: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += chars[(triplet >> 18) & 63];
    out += chars[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(triplet >> 6) & 63] : pad ? '=' : '';
    out += i + 2 < bytes.length ? chars[triplet & 63] : pad ? '=' : '';
  }
  return out;
}

function base64DecodeToBytes(clean: string, chars: string, label: string): Uint8Array {
  const lookup: Record<string, number> = {};
  for (let i = 0; i < chars.length; i++) lookup[chars[i]] = i;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    if (!(ch in lookup)) {
      throw new ToolError(
        `invalid-${label}`,
        `"${ch}" is not a valid ${label} character.`,
        `Use only the ${label} alphabet (A-Z, a-z, 0-9, and the two symbol characters).`,
      );
    }
    buffer = (buffer << 6) | lookup[ch];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function base64Escape(str: string): string {
  return base64EncodeBytes(strToBytes(str), BASE64_CHARS, true);
}

function base64Unescape(str: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(str)) {
    throw new ToolError(
      'invalid-base64',
      `"${str}" is not valid base64.`,
      'Base64 only uses A-Z, a-z, 0-9, + and /, with optional = padding at the end.',
    );
  }
  const clean = str.replace(/=+$/, '');
  return bytesToStr(
    base64DecodeToBytes(clean, BASE64_CHARS, 'base64'),
    'invalid-base64-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that this is actually base64-encoded text and not binary data.',
  );
}

function base64urlEscape(str: string): string {
  return base64EncodeBytes(strToBytes(str), BASE64URL_CHARS, false);
}

function base64urlUnescape(str: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) {
    throw new ToolError(
      'invalid-base64url',
      `"${str}" is not valid base64url.`,
      'Base64url only uses A-Z, a-z, 0-9, - and _, with no padding.',
    );
  }
  return bytesToStr(
    base64DecodeToBytes(str, BASE64URL_CHARS, 'base64url'),
    'invalid-base64url-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that this is actually base64url-encoded text and not binary data.',
  );
}

// ---------------------------------------------------------------------------
// Base32 (RFC 4648).
// ---------------------------------------------------------------------------

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Escape(str: string): string {
  const bytes = strToBytes(str);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_CHARS[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  while (out.length % 8 !== 0) out += '=';
  return out;
}

function base32Unescape(str: string): string {
  const clean = str.replace(/=+$/, '').toUpperCase();
  const lookup: Record<string, number> = {};
  for (let i = 0; i < BASE32_CHARS.length; i++) lookup[BASE32_CHARS[i]] = i;
  for (const ch of clean) {
    if (!(ch in lookup)) {
      throw new ToolError(
        'invalid-base32',
        `"${ch}" is not a valid base32 character.`,
        'Base32 only uses A-Z and 2-7, with optional = padding at the end.',
      );
    }
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | lookup[ch];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return bytesToStr(
    new Uint8Array(bytes),
    'invalid-base32-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that this is actually base32-encoded text and not binary data.',
  );
}

// ---------------------------------------------------------------------------
// Base58 (Bitcoin alphabet — excludes 0, O, I, l to avoid visual confusion).
// Uses BigInt since it is a big-number base conversion, not a bit-packing.
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base58Escape(str: string): string {
  const bytes = strToBytes(str);
  if (bytes.length === 0) return '';
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = '';
  while (num > 0n) {
    const rem = num % 58n;
    num /= 58n;
    out = BASE58_ALPHABET[Number(rem)] + out;
  }
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }
  return '1'.repeat(leadingZeros) + out;
}

function base58Unescape(str: string): string {
  if (str === '') return '';
  const lookup: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) lookup[BASE58_ALPHABET[i]] = i;
  for (const ch of str) {
    if (!(ch in lookup)) {
      throw new ToolError(
        'invalid-base58',
        `"${ch}" is not a valid base58 character.`,
        'Base58 excludes 0, O, I and l to avoid visual confusion; check for those.',
      );
    }
  }
  let num = 0n;
  for (const ch of str) num = num * 58n + BigInt(lookup[ch]);
  let bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  let leadingOnes = 0;
  for (const ch of str) {
    if (ch === '1') leadingOnes++;
    else break;
  }
  bytes = new Array(leadingOnes).fill(0).concat(bytes);
  return bytesToStr(
    new Uint8Array(bytes),
    'invalid-base58-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that this is actually base58-encoded text and not binary data.',
  );
}

// ---------------------------------------------------------------------------
// Ascii85 (Adobe variant) — <~ ~> delimiters, 'z' shortcut for an all-zero
// group of four bytes.
// ---------------------------------------------------------------------------

function ascii85Escape(str: string): string {
  const bytes = strToBytes(str);
  let out = '<~';
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.slice(i, i + 4);
    const isFull = chunk.length === 4;
    const padded = new Uint8Array(4);
    padded.set(chunk);
    const value = ((padded[0] << 24) | (padded[1] << 16) | (padded[2] << 8) | padded[3]) >>> 0;
    if (isFull && value === 0) {
      out += 'z';
      continue;
    }
    const chars: string[] = new Array(5) as string[];
    let v = value;
    for (let j = 4; j >= 0; j--) {
      chars[j] = String.fromCharCode(33 + (v % 85));
      v = Math.floor(v / 85);
    }
    const numChars = isFull ? 5 : chunk.length + 1;
    out += chars.slice(0, numChars).join('');
  }
  out += '~>';
  return out;
}

function ascii85Unescape(str: string): string {
  let s = str.trim();
  if (s.startsWith('<~')) s = s.slice(2);
  if (s.endsWith('~>')) s = s.slice(0, -2);
  s = s.replace(/\s+/g, '');
  const bytes: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === 'z') {
      bytes.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const group = s.slice(i, i + 5);
    const groupLen = group.length;
    if (groupLen < 2) {
      throw new ToolError(
        'invalid-ascii85',
        'An ascii85 group must have at least two characters.',
        'Check that the encoded text was not truncated.',
      );
    }
    for (const ch of group) {
      const code = ch.charCodeAt(0);
      if (code < 33 || code > 117) {
        throw new ToolError(
          'invalid-ascii85',
          `"${ch}" is outside the ascii85 character range (! to u).`,
          'Ascii85 only uses printable ASCII 33 to 117; check for stray characters.',
        );
      }
    }
    const padded = group + 'u'.repeat(5 - groupLen);
    let value = 0;
    for (const ch of padded) value = value * 85 + (ch.charCodeAt(0) - 33);
    if (value > 0xffffffff) {
      throw new ToolError(
        'invalid-ascii85',
        'This group decodes to a value larger than 32 bits.',
        'Check the encoded text for corruption.',
      );
    }
    const groupBytes = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ].slice(0, groupLen - 1);
    bytes.push(...groupBytes);
    i += groupLen;
  }
  return bytesToStr(
    new Uint8Array(bytes),
    'invalid-ascii85-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that this is actually ascii85-encoded text and not binary data.',
  );
}

// ---------------------------------------------------------------------------
// Uuencode — classic Unix body encoding: length-prefixed 45-byte lines,
// 3 bytes packed into 4 printable characters (offset 32, backtick standing
// in for a literal space), terminated by a zero-length line.
// ---------------------------------------------------------------------------

function uuEncodeChar(sixBits: number): string {
  const v = (sixBits & 0x3f) + 32;
  return String.fromCharCode(v === 32 ? 96 : v);
}

function uuDecodeChar(ch: string): number {
  let code = ch.charCodeAt(0);
  if (code === 96) code = 32;
  const v = code - 32;
  if (v < 0 || v > 63) {
    throw new ToolError(
      'invalid-uuencode',
      `"${ch}" is not a valid uuencode character.`,
      'Uuencode characters are ASCII 32 (or the backtick standing in for it) through 95.',
    );
  }
  return v;
}

function uuencode(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 45) {
    const chunk = bytes.slice(i, i + 45);
    let lineChars = '';
    for (let j = 0; j < chunk.length; j += 3) {
      const b0 = chunk[j];
      const b1 = chunk[j + 1] ?? 0;
      const b2 = chunk[j + 2] ?? 0;
      lineChars += uuEncodeChar(b0 >> 2);
      lineChars += uuEncodeChar(((b0 << 4) | (b1 >> 4)) & 0x3f);
      lineChars += uuEncodeChar(((b1 << 2) | (b2 >> 6)) & 0x3f);
      lineChars += uuEncodeChar(b2 & 0x3f);
    }
    lines.push(uuEncodeChar(chunk.length) + lineChars);
  }
  lines.push(uuEncodeChar(0));
  return lines.join('\n');
}

function uudecode(text: string): Uint8Array {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const bytes: number[] = [];
  for (const line of lines) {
    const n = uuDecodeChar(line[0]);
    if (n === 0) break;
    const dataChars = line.slice(1);
    const neededChars = Math.ceil(n / 3) * 4;
    if (dataChars.length < neededChars) {
      throw new ToolError(
        'invalid-uuencode',
        `A line declares ${n} bytes but does not have enough encoded characters.`,
        'Check that the uuencoded text was not truncated or had characters removed.',
      );
    }
    const lineBytes: number[] = [];
    for (let j = 0; j < neededChars; j += 4) {
      const c0 = uuDecodeChar(dataChars[j]);
      const c1 = uuDecodeChar(dataChars[j + 1]);
      const c2 = uuDecodeChar(dataChars[j + 2]);
      const c3 = uuDecodeChar(dataChars[j + 3]);
      lineBytes.push((c0 << 2) | (c1 >> 4));
      lineBytes.push(((c1 << 4) | (c2 >> 2)) & 0xff);
      lineBytes.push(((c2 << 6) | c3) & 0xff);
    }
    bytes.push(...lineBytes.slice(0, n));
  }
  return new Uint8Array(bytes);
}

function uuencodeEscape(str: string): string {
  return uuencode(strToBytes(str));
}

function uuencodeUnescape(str: string): string {
  return bytesToStr(
    uudecode(str),
    'invalid-uuencode-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check that this is actually uuencoded text and not binary data.',
  );
}

// ---------------------------------------------------------------------------
// Quoted-printable (MIME). Printable ASCII stays literal; everything else,
// plus a literal =, becomes =XX. Soft line breaks (trailing "=" + newline)
// are understood on decode but never generated on encode.
// ---------------------------------------------------------------------------

function qpEscape(str: string): string {
  const bytes = strToBytes(str);
  let out = '';
  for (const b of bytes) {
    const isControl = b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d;
    if (b === 0x3d || isControl || b > 0x7e) {
      out += '=' + b.toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

function qpUnescape(str: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '=') {
      if (str[i + 1] === '\r' && str[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (str[i + 1] === '\n') {
        i += 1;
        continue;
      }
      const hex = str.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new ToolError(
          'invalid-quoted-printable',
          `"=${hex}" is not a valid quoted-printable escape.`,
          'A quoted-printable escape is an equals sign followed by two hex digits, or a trailing = for a soft line break.',
        );
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return bytesToStr(
    new Uint8Array(bytes),
    'invalid-quoted-printable-utf8',
    'The decoded bytes are not valid UTF-8.',
    'Check the input for corrupted quoted-printable escapes.',
  );
}

// ---------------------------------------------------------------------------
// ROT13 / ROT47 — self-inverse Caesar ciphers; escape and unescape are the
// same operation.
// ---------------------------------------------------------------------------

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function rot47(str: string): string {
  return str.replace(/[!-~]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String.fromCharCode(33 + ((code - 33 + 47) % 94));
  });
}

// ---------------------------------------------------------------------------
// Morse code. Uppercase-only; case is not preserved through a round trip.
// Letters within a word are space-separated, words are separated by " / ".
// ---------------------------------------------------------------------------

const MORSE_MAP: Record<string, string> = {
  A: '.-',
  B: '-...',
  C: '-.-.',
  D: '-..',
  E: '.',
  F: '..-.',
  G: '--.',
  H: '....',
  I: '..',
  J: '.---',
  K: '-.-',
  L: '.-..',
  M: '--',
  N: '-.',
  O: '---',
  P: '.--.',
  Q: '--.-',
  R: '.-.',
  S: '...',
  T: '-',
  U: '..-',
  V: '...-',
  W: '.--',
  X: '-..-',
  Y: '-.--',
  Z: '--..',
  '0': '-----',
  '1': '.----',
  '2': '..---',
  '3': '...--',
  '4': '....-',
  '5': '.....',
  '6': '-....',
  '7': '--...',
  '8': '---..',
  '9': '----.',
  '.': '.-.-.-',
  ',': '--..--',
  '?': '..--..',
  "'": '.----.',
  '!': '-.-.--',
  '/': '-..-.',
  '(': '-.--.',
  ')': '-.--.-',
  '&': '.-...',
  ':': '---...',
  ';': '-.-.-.',
  '=': '-...-',
  '+': '.-.-.',
  '-': '-....-',
  _: '..--.-',
  '"': '.-..-.',
  $: '...-..-',
  '@': '.--.-.',
};
const MORSE_REVERSE: Record<string, string> = {};
for (const [ch, code] of Object.entries(MORSE_MAP)) MORSE_REVERSE[code] = ch;

function morseEscape(str: string): string {
  const words = str.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  return words
    .map((word) =>
      Array.from(word.toUpperCase())
        .map((ch) => {
          const code = MORSE_MAP[ch];
          if (!code) {
            throw new ToolError(
              'unsupported-morse-char',
              `"${ch}" has no Morse code representation.`,
              'Morse code here covers A-Z, 0-9 and common punctuation; remove or replace other characters.',
            );
          }
          return code;
        })
        .join(' '),
    )
    .join(' / ');
}

function morseUnescape(str: string): string {
  const trimmed = str.trim();
  if (trimmed === '') return '';
  const words = trimmed
    .split('/')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  return words
    .map((word) =>
      word
        .split(/\s+/)
        .filter(Boolean)
        .map((code) => {
          const ch = MORSE_REVERSE[code];
          if (!ch) {
            throw new ToolError(
              'invalid-morse-code',
              `"${code}" is not a recognized Morse code sequence.`,
              'Use only dots (.) and dashes (-), separate letters with a space and words with a slash.',
            );
          }
          return ch;
        })
        .join(''),
    )
    .join(' ');
}

// ---------------------------------------------------------------------------
// NATO phonetic alphabet. Same word-boundary convention as Morse above.
// ---------------------------------------------------------------------------

const NATO_MAP: Record<string, string> = {
  A: 'Alpha',
  B: 'Bravo',
  C: 'Charlie',
  D: 'Delta',
  E: 'Echo',
  F: 'Foxtrot',
  G: 'Golf',
  H: 'Hotel',
  I: 'India',
  J: 'Juliett',
  K: 'Kilo',
  L: 'Lima',
  M: 'Mike',
  N: 'November',
  O: 'Oscar',
  P: 'Papa',
  Q: 'Quebec',
  R: 'Romeo',
  S: 'Sierra',
  T: 'Tango',
  U: 'Uniform',
  V: 'Victor',
  W: 'Whiskey',
  X: 'Xray',
  Y: 'Yankee',
  Z: 'Zulu',
  '0': 'Zero',
  '1': 'One',
  '2': 'Two',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Niner',
};
const NATO_REVERSE: Record<string, string> = {};
for (const [ch, word] of Object.entries(NATO_MAP)) NATO_REVERSE[word.toLowerCase()] = ch;

function natoEscape(str: string): string {
  const words = str.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  return words
    .map((word) =>
      Array.from(word.toUpperCase())
        .map((ch) => {
          const w = NATO_MAP[ch];
          if (!w) {
            throw new ToolError(
              'unsupported-nato-char',
              `"${ch}" has no NATO phonetic alphabet word.`,
              'The NATO alphabet here only covers A-Z and 0-9; remove or replace other characters.',
            );
          }
          return w;
        })
        .join(' '),
    )
    .join(' / ');
}

function natoUnescape(str: string): string {
  const trimmed = str.trim();
  if (trimmed === '') return '';
  const words = trimmed
    .split('/')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  return words
    .map((word) =>
      word
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => {
          const ch = NATO_REVERSE[tok.toLowerCase()];
          if (!ch) {
            throw new ToolError(
              'invalid-nato-word',
              `"${tok}" is not a recognized NATO phonetic alphabet word.`,
              'Use the standard words (Alpha, Bravo, Charlie...) and Zero through Niner for digits, space-separated, with a slash between original words.',
            );
          }
          return ch;
        })
        .join(''),
    )
    .join(' ');
}

// ---------------------------------------------------------------------------
// Punycode (RFC 3492 Bootstring) with the "xn--" ACE prefix, applied
// label-by-label across dot-separated domain names — exactly what browsers
// do to turn "münchen.de" into "xn--mnchen-3ya.de".
// ---------------------------------------------------------------------------

const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;
const PUNY_DELIMITER = '-';
const PUNYCODE_PREFIX = 'xn--';

function punycodeAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : Math.floor(delta / 2);
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) / 2) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

function punycodeDigitToChar(d: number): string {
  return d < 26 ? String.fromCharCode(d + 97) : String.fromCharCode(d - 26 + 48);
}

function punycodeCharToDigit(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48 + 26;
  if (code >= 97 && code <= 122) return code - 97;
  if (code >= 65 && code <= 90) return code - 65;
  return -1;
}

function punycodeEncodeLabel(input: string): string {
  const codePoints = Array.from(input).map((ch) => ch.codePointAt(0)!);
  const basicCodePoints = codePoints.filter((cp) => cp < 0x80);
  const output = basicCodePoints.map((cp) => String.fromCharCode(cp));
  const basicLength = basicCodePoints.length;
  let handled = basicLength;
  if (basicLength > 0) output.push(PUNY_DELIMITER);

  let n = PUNY_INITIAL_N;
  let delta = 0;
  let bias = PUNY_INITIAL_BIAS;
  const inputLength = codePoints.length;

  while (handled < inputLength) {
    let m = Infinity;
    for (const cp of codePoints) {
      if (cp >= n && cp < m) m = cp;
    }
    delta += (m - n) * (handled + 1);
    n = m;
    for (const cp of codePoints) {
      if (cp < n) delta++;
      if (cp === n) {
        let q = delta;
        for (let k = PUNY_BASE; ; k += PUNY_BASE) {
          const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
          if (q < t) break;
          output.push(punycodeDigitToChar(t + ((q - t) % (PUNY_BASE - t))));
          q = Math.floor((q - t) / (PUNY_BASE - t));
        }
        output.push(punycodeDigitToChar(q));
        bias = punycodeAdapt(delta, handled + 1, handled === basicLength);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return output.join('');
}

function punycodeDecodeLabel(input: string): string {
  let n = PUNY_INITIAL_N;
  let i = 0;
  let bias = PUNY_INITIAL_BIAS;
  const output: number[] = [];

  const lastDelim = input.lastIndexOf(PUNY_DELIMITER);
  const basic = lastDelim >= 0 ? input.slice(0, lastDelim) : '';
  for (const ch of basic) {
    const code = ch.charCodeAt(0);
    if (code >= 0x80) {
      throw new ToolError(
        'invalid-punycode',
        `"${ch}" in the basic-code-point part is not ASCII.`,
        'Everything before the last hyphen in a punycode label must be plain ASCII.',
      );
    }
    output.push(code);
  }
  let pos = lastDelim >= 0 ? lastDelim + 1 : 0;
  const inputLength = input.length;

  while (pos < inputLength) {
    const oldi = i;
    let w = 1;
    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (pos >= inputLength) {
        throw new ToolError(
          'invalid-punycode',
          'Unexpected end of punycode input.',
          'The encoded text looks truncated; make sure the full punycode label was pasted.',
        );
      }
      const digitChar = input[pos++];
      const digit = punycodeCharToDigit(digitChar);
      if (digit === -1) {
        throw new ToolError(
          'invalid-punycode',
          `"${digitChar}" is not a valid punycode digit.`,
          'Punycode digits are a-z and 0-9 only.',
        );
      }
      i += digit * w;
      const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
      if (digit < t) break;
      w *= PUNY_BASE - t;
    }
    bias = punycodeAdapt(i - oldi, output.length + 1, oldi === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    output.splice(i, 0, n);
    i++;
  }
  try {
    return output.map((cp) => String.fromCodePoint(cp)).join('');
  } catch {
    throw new ToolError(
      'invalid-punycode',
      'Decoded to an invalid Unicode code point.',
      'The encoded text may be corrupted.',
    );
  }
}

function punycodeEscape(str: string): string {
  return str
    .split('.')
    .map((label) => {
      if (Array.from(label).every((ch) => ch.codePointAt(0)! < 0x80)) return label;
      return PUNYCODE_PREFIX + punycodeEncodeLabel(label);
    })
    .join('.');
}

function punycodeUnescape(str: string): string {
  return str
    .split('.')
    .map((label) => {
      if (!label.toLowerCase().startsWith(PUNYCODE_PREFIX)) return label;
      return punycodeDecodeLabel(label.slice(PUNYCODE_PREFIX.length));
    })
    .join('.');
}

// ---------------------------------------------------------------------------

const FORMATS: Record<string, { escape: (s: string) => string; unescape: (s: string) => string }> =
  {
    json: { escape: jsonEscape, unescape: jsonUnescape },
    html: { escape: htmlEscape, unescape: htmlUnescape },
    xml: { escape: xmlEscape, unescape: xmlUnescape },
    url: { escape: urlEscape, unescape: urlUnescape },
    'url-full': { escape: urlFullEscape, unescape: urlFullUnescape },
    'url-form': { escape: urlFormEscape, unescape: urlFormUnescape },
    'url-bytes': { escape: urlBytesEscape, unescape: urlBytesUnescape },
    regex: { escape: regexEscape, unescape: regexUnescape },
    c: { escape: cEscape, unescape: cUnescape },
    python: { escape: pythonEscape, unescape: pythonUnescape },
    java: { escape: javaEscape, unescape: javaUnescape },
    'unicode-brace': { escape: unicodeBraceEscape, unescape: unicodeBraceUnescape },
    whitespace: { escape: whitespaceEscape, unescape: whitespaceUnescape },
    'hex-bytes': { escape: hexBytesEscape, unescape: hexBytesUnescape },
    'octal-bytes': { escape: octalBytesEscape, unescape: octalBytesUnescape },
    shell: { escape: shellEscape, unescape: shellUnescape },
    'shell-double': { escape: shellDoubleEscape, unescape: shellDoubleUnescape },
    batch: { escape: batchEscape, unescape: batchUnescape },
    powershell: { escape: singleQuoteDouble, unescape: singleQuoteUndouble },
    sql: { escape: singleQuoteDouble, unescape: singleQuoteUndouble },
    csv: { escape: csvEscape, unescape: csvUnescape },
    ldap: { escape: ldapEscape, unescape: ldapUnescape },
    base64: { escape: base64Escape, unescape: base64Unescape },
    base64url: { escape: base64urlEscape, unescape: base64urlUnescape },
    base32: { escape: base32Escape, unescape: base32Unescape },
    base58: { escape: base58Escape, unescape: base58Unescape },
    ascii85: { escape: ascii85Escape, unescape: ascii85Unescape },
    uuencode: { escape: uuencodeEscape, unescape: uuencodeUnescape },
    'quoted-printable': { escape: qpEscape, unescape: qpUnescape },
    rot13: { escape: rot13, unescape: rot13 },
    rot47: { escape: rot47, unescape: rot47 },
    morse: { escape: morseEscape, unescape: morseUnescape },
    nato: { escape: natoEscape, unescape: natoUnescape },
    punycode: { escape: punycodeEscape, unescape: punycodeUnescape },
  };

export function run(input: string, opts: EscapeOpts): string {
  const text = input ?? '';
  // Empty input is a no-op in both directions for every format — there is
  // nothing to escape or decode, and this keeps behavior consistent across
  // formats (rather than e.g. shell producing `''` for empty input).
  if (text === '') return '';

  const format = FORMATS[opts.format];
  if (!format)
    throw new ToolError(
      'bad-format',
      `Unknown format "${opts.format}".`,
      'Pick a format from the dropdown.',
    );

  if (opts.direction === 'unescape') return format.unescape(text);
  if (opts.direction === 'escape') return format.escape(text);
  throw new ToolError(
    'bad-direction',
    `Unknown direction "${opts.direction}".`,
    'Use "escape" or "unescape".',
  );
}

export default { run } satisfies ToolLogic<string, string, EscapeOpts>;
