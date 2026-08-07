import { ToolError, type ToolLogic } from '../types';

export interface InvisiblesOpts {
  /** 'annotate' | 'strip' | 'report' */
  mode: string;
  /** When stripping, keep line breaks as LF instead of removing them too. */
  keepNewlines: boolean;
  [key: string]: unknown;
}

interface CharInfo {
  tag: string;
  name: string;
}

interface Finding {
  line: number;
  col: number;
  cp: number;
  tag: string;
  name: string;
}

/** Exotic Unicode space characters (category Zs) beyond the plain ASCII space. */
const SPACE_LIKE = new Map<number, [string, string]>([
  [0x00a0, ['NBSP', 'Non-breaking space']],
  [0x202f, ['NNBSP', 'Narrow no-break space']],
  [0x2000, ['EN-QUAD', 'En quad']],
  [0x2001, ['EM-QUAD', 'Em quad']],
  [0x2002, ['EN-SP', 'En space']],
  [0x2003, ['EM-SP', 'Em space']],
  [0x2004, ['3-EM-SP', 'Three-per-em space']],
  [0x2005, ['4-EM-SP', 'Four-per-em space']],
  [0x2006, ['6-EM-SP', 'Six-per-em space']],
  [0x2007, ['FIG-SP', 'Figure space']],
  [0x2008, ['PUNCT-SP', 'Punctuation space']],
  [0x2009, ['THIN-SP', 'Thin space']],
  [0x200a, ['HAIR-SP', 'Hair space']],
  [0x3000, ['IDEO-SP', 'Ideographic space']],
]);

/** Zero-width and formatting characters that render as nothing at all. */
const ZERO_WIDTH = new Map<number, [string, string]>([
  [0x200b, ['ZWSP', 'Zero-width space']],
  [0x200c, ['ZWNJ', 'Zero-width non-joiner']],
  [0x200d, ['ZWJ', 'Zero-width joiner']],
  [0x2060, ['WJ', 'Word joiner']],
  [0xfeff, ['BOM', 'Byte order mark (zero-width no-break space)']],
  [0x00ad, ['SHY', 'Soft hyphen']],
  [0x200e, ['LRM', 'Left-to-right mark']],
  [0x200f, ['RLM', 'Right-to-left mark']],
  [0x202a, ['LRE', 'Left-to-right embedding']],
  [0x202b, ['RLE', 'Right-to-left embedding']],
  [0x202c, ['PDF', 'Pop directional formatting']],
  [0x202d, ['LRO', 'Left-to-right override']],
  [0x202e, ['RLO', 'Right-to-left override']],
  [0x2066, ['LRI', 'Left-to-right isolate']],
  [0x2067, ['RLI', 'Right-to-left isolate']],
  [0x2068, ['FSI', 'First strong isolate']],
  [0x2069, ['PDI', 'Pop directional isolate']],
  [0xfe0e, ['VS15', 'Variation selector-15 (text style)']],
  [0xfe0f, ['VS16', 'Variation selector-16 (emoji style)']],
  [0x034f, ['CGJ', 'Combining grapheme joiner']],
  [0x3164, ['HANGUL-FILLER', 'Hangul filler']],
]);

function hex(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

/** Classify one codepoint: is it a character this tool cares about, and how. */
function classify(cp: number): CharInfo | null {
  if (cp === 0x09) return { tag: 'TAB', name: 'Tab' };
  if (cp === 0x0d) return { tag: 'CR', name: 'Carriage return' };
  if (cp === 0x2028) return { tag: 'LSEP', name: 'Line separator' };
  if (cp === 0x2029) return { tag: 'PSEP', name: 'Paragraph separator' };

  const sp = SPACE_LIKE.get(cp);
  if (sp) return { tag: sp[0], name: sp[1] };

  const zw = ZERO_WIDTH.get(cp);
  if (zw) return { tag: zw[0], name: zw[1] };

  // Catch-all: any other Unicode "format" (Cf) codepoint we did not name above.
  const ch = String.fromCodePoint(cp);
  if (/\p{Cf}/u.test(ch)) return { tag: 'CF', name: `Format character U+${hex(cp)}` };

  return null;
}

/** Walk the string codepoint-by-codepoint, recording line/column for every match. */
function scanFindings(input: string): Finding[] {
  const findings: Finding[] = [];
  let line = 1;
  let col = 1;
  let i = 0;
  while (i < input.length) {
    const cp = input.codePointAt(i)!;
    const chLen = cp > 0xffff ? 2 : 1;

    if (cp === 0x0a) {
      line++;
      col = 1;
      i += chLen;
      continue;
    }

    const info = classify(cp);
    if (info) findings.push({ line, col, cp, tag: info.tag, name: info.name });

    if (cp === 0x2028 || cp === 0x2029) {
      line++;
      col = 1;
      i += chLen;
      continue;
    }

    col++;
    i += chLen;
  }
  return findings;
}

/** Replace every flagged character inline with a visible bracketed tag. */
function annotate(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const cp = input.codePointAt(i)!;
    const chLen = cp > 0xffff ? 2 : 1;
    const ch = input.slice(i, i + chLen);

    if (cp === 0x0a) {
      out += ch;
      i += chLen;
      continue;
    }

    const info = classify(cp);
    out += info ? `⟦${info.tag}⟧` : ch;
    i += chLen;
  }
  return out;
}

/**
 * Remove invisible/format characters, normalize exotic spaces to a plain
 * space, and (optionally) fold every line ending to a single LF.
 */
function strip(input: string, keepNewlines: boolean): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const cp = input.codePointAt(i)!;
    const chLen = cp > 0xffff ? 2 : 1;

    if (cp === 0x0a) {
      out += keepNewlines ? '\n' : '';
      i += chLen;
      continue;
    }

    if (cp === 0x0d) {
      out += keepNewlines ? '\n' : '';
      // Swallow a paired LF so CRLF collapses to a single line break.
      if (input.codePointAt(i + chLen) === 0x0a) {
        i += chLen + 1;
      } else {
        i += chLen;
      }
      continue;
    }

    if (cp === 0x2028 || cp === 0x2029) {
      out += keepNewlines ? '\n' : '';
      i += chLen;
      continue;
    }

    const sp = SPACE_LIKE.get(cp);
    if (sp) {
      out += ' ';
      i += chLen;
      continue;
    }

    const zw = ZERO_WIDTH.get(cp);
    if (zw) {
      i += chLen;
      continue;
    }

    const ch = input.slice(i, i + chLen);
    if (cp !== 0x09 && /\p{Cf}/u.test(ch)) {
      i += chLen;
      continue;
    }

    out += ch;
    i += chLen;
  }
  return out;
}

/** Human-readable, line-by-line findings report plus a count summary. */
function buildReport(input: string, findings: Finding[]): string {
  if (findings.length === 0) {
    return `No invisible characters found in ${input.length} characters.`;
  }

  const lines: string[] = findings.map(
    (f) => `Line ${f.line}, Col ${f.col}: ${f.tag} (${f.name}) U+${hex(f.cp)}`,
  );

  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.tag, (counts.get(f.tag) ?? 0) + 1);
  const summary = [...counts.entries()].map(([tag, n]) => `${tag} x${n}`).join(', ');

  const crlf = (input.match(/\r\n/g) ?? []).length;
  const crAlone = (input.match(/\r(?!\n)/g) ?? []).length;
  const lfAlone = (input.match(/(?<!\r)\n/g) ?? []).length;
  const eolTypes = [crlf > 0 && 'CRLF', crAlone > 0 && 'lone CR', lfAlone > 0 && 'LF'].filter(
    Boolean,
  );

  lines.push('');
  lines.push(
    `Summary: ${findings.length} invisible character(s) in ${input.length} characters. ${summary}.`,
  );
  if (eolTypes.length > 1) {
    lines.push(`Line endings are mixed: ${eolTypes.join(', ')}.`);
  }

  return lines.join('\n');
}

export function run(input: string, opts: InvisiblesOpts): string {
  if (!input || input.length === 0) {
    throw new ToolError(
      'empty-input',
      'Enter or paste text to scan for invisible characters.',
      'Paste text into the input, the tool checks it for zero-width spaces, BOMs, bidi controls, and other invisible Unicode characters.',
    );
  }

  const mode = opts.mode || 'annotate';
  const keepNewlines = opts.keepNewlines !== false;

  if (mode === 'strip') return strip(input, keepNewlines);

  const findings = scanFindings(input);

  if (mode === 'report') return buildReport(input, findings);

  if (findings.length === 0) {
    return `No invisible characters found in ${input.length} characters.`;
  }
  return annotate(input);
}

export default { run } satisfies ToolLogic<string, string, InvisiblesOpts>;
