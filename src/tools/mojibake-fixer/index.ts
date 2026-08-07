import { ToolError, type ToolLogic } from '../types';

export interface MojibakeOpts {
  /** 'auto' or an explicit chain id. */
  chain: string;
  [key: string]: unknown;
}

/**
 * Mojibake is UTF-8 bytes that were decoded with a legacy single byte
 * encoding. Undoing it means re-encoding the visible characters back to the
 * bytes that legacy encoding would have produced, then decoding those bytes
 * as UTF-8. The only two legacy encodings that matter in practice are
 * Windows-1252 and Latin-1 (ISO 8859-1).
 */

/**
 * WHATWG windows-1252 index for bytes 0x80 to 0x9F, as codepoints. The five
 * slots that are undefined in the original vendor table (0x81, 0x8D, 0x8F,
 * 0x90, 0x9D) map to the matching C1 control codepoints, which is what real
 * decoders do and what real mojibake therefore contains.
 */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** codepoint -> byte, for Windows-1252. */
const CP1252_REVERSE: ReadonlyMap<number, number> = (() => {
  const m = new Map<number, number>();
  for (let b = 0x00; b <= 0x7f; b++) m.set(b, b);
  for (let b = 0xa0; b <= 0xff; b++) m.set(b, b);
  CP1252_HIGH.forEach((cp, i) => m.set(cp, 0x80 + i));
  return m;
})();

/** codepoint -> byte, for Latin-1. Every byte is its own codepoint. */
const LATIN1_REVERSE: ReadonlyMap<number, number> = (() => {
  const m = new Map<number, number>();
  for (let b = 0x00; b <= 0xff; b++) m.set(b, b);
  return m;
})();

/**
 * Characters that can stand for a UTF-8 continuation byte (0x80 to 0xBF)
 * under either legacy encoding. Used to spot mojibake signatures.
 */
const CONTINUATION_CHARS: ReadonlySet<number> = (() => {
  const s = new Set<number>();
  for (let cp = 0x80; cp <= 0xbf; cp++) s.add(cp);
  for (let b = 0x80; b <= 0x9f; b++) s.add(CP1252_HIGH[b - 0x80]);
  return s;
})();

const LEAD_MIN = 0xc2;
const LEAD_MAX = 0xf4;
const REPLACEMENT = 0xfffd;
/** U+FEFF, the real byte order mark. */
const BOM = '\uFEFF';
/** The same BOM after its bytes EF BB BF were read as Windows-1252 or Latin-1. */
const BOM_MOJIBAKE = '\u00EF\u00BB\u00BF';

/** Share of characters allowed to survive a step unmapped before it is rejected. */
const PASSTHROUGH_TOLERANCE = 0.02;

const utf8Encoder = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type Legacy = 'cp1252' | 'latin1';

const REVERSE_MAPS: Record<Legacy, ReadonlyMap<number, number>> = {
  cp1252: CP1252_REVERSE,
  latin1: LATIN1_REVERSE,
};

interface ChainSpec {
  id: string;
  steps: Legacy[];
  label: string;
}

const CHAINS: readonly ChainSpec[] = [
  { id: 'cp1252-once', steps: ['cp1252'], label: 'UTF-8 was read as Windows-1252 once' },
  { id: 'latin1-once', steps: ['latin1'], label: 'UTF-8 was read as Latin-1 once' },
  {
    id: 'cp1252-twice',
    steps: ['cp1252', 'cp1252'],
    label: 'UTF-8 was read as Windows-1252 twice, so the text was double encoded',
  },
  {
    id: 'latin1-twice',
    steps: ['latin1', 'latin1'],
    label: 'UTF-8 was read as Latin-1 twice, so the text was double encoded',
  },
  {
    id: 'cp1252-latin1',
    steps: ['cp1252', 'latin1'],
    label: 'UTF-8 was read as Windows-1252, then the result was read as Latin-1',
  },
  {
    id: 'latin1-cp1252',
    steps: ['latin1', 'cp1252'],
    label: 'UTF-8 was read as Latin-1, then the result was read as Windows-1252',
  },
];

/** Chains a user can force from the options panel. */
const MANUAL_CHAIN_IDS = ['cp1252-once', 'cp1252-twice', 'latin1-once', 'latin1-twice'];

interface StepResult {
  text: string;
  /** Characters with no byte in the legacy encoding, kept as their own UTF-8 bytes. */
  passthrough: number;
  total: number;
}

/**
 * Re-encode `text` with a legacy encoding, then decode the bytes as strict
 * UTF-8. Characters the legacy encoding cannot represent are emitted as their
 * own UTF-8 bytes, so they round-trip to themselves; too many of those means
 * the chain does not describe this text and it is rejected. Returns null when
 * the chain does not apply.
 */
function applyStep(text: string, encoding: Legacy): StepResult | null {
  const map = REVERSE_MAPS[encoding];
  const bytes: number[] = [];
  let passthrough = 0;
  let total = 0;

  for (const ch of text) {
    total++;
    const byte = map.get(ch.codePointAt(0) as number);
    if (byte === undefined) {
      passthrough++;
      for (const b of utf8Encoder.encode(ch)) bytes.push(b);
    } else {
      bytes.push(byte);
    }
  }

  if (total > 0 && passthrough / total >= PASSTHROUGH_TOLERANCE) return null;

  try {
    return { text: strictUtf8.decode(new Uint8Array(bytes)), passthrough, total };
  } catch {
    return null;
  }
}

function applyChain(text: string, steps: readonly Legacy[]): StepResult | null {
  let current = text;
  let passthrough = 0;
  let total = 0;
  for (const step of steps) {
    const out = applyStep(current, step);
    if (!out) return null;
    current = out.text;
    passthrough += out.passthrough;
    total += out.total;
  }
  return { text: current, passthrough, total };
}

/**
 * Count mojibake signatures: a UTF-8 lead byte character followed by one to
 * three continuation byte characters, plus any replacement characters.
 */
export function countSignatures(text: string): number {
  const chars = [...text];
  let count = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0) as number;
    if (cp === REPLACEMENT) {
      count++;
      continue;
    }
    if (cp < LEAD_MIN || cp > LEAD_MAX) continue;
    let run = 0;
    while (
      run < 3 &&
      i + 1 + run < chars.length &&
      CONTINUATION_CHARS.has(chars[i + 1 + run].codePointAt(0) as number)
    ) {
      run++;
    }
    if (run > 0) {
      count++;
      i += run;
    }
  }
  return count;
}

interface Shape {
  nonAscii: number;
  runs: number;
  c1: number;
}

/** Non-ASCII characters, maximal non-ASCII runs, and stray C1 controls. */
function shapeOf(text: string): Shape {
  let nonAscii = 0;
  let runs = 0;
  let c1 = 0;
  let inRun = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0x80 && cp <= 0x9f) c1++;
    if (cp > 0x7f) {
      nonAscii++;
      if (!inRun) {
        runs++;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  return { nonAscii, runs, c1 };
}

interface Candidate {
  id: string;
  label: string;
  text: string;
  steps: number;
  passthrough: number;
  score: number;
  signatures: number;
}

function scoreCandidate(
  id: string,
  label: string,
  text: string,
  steps: number,
  passthrough: number,
  total: number,
): Candidate {
  const signatures = countSignatures(text);
  const { nonAscii, runs, c1 } = shapeOf(text);
  const partialRatio = total > 0 ? passthrough / total : 0;
  const score =
    -signatures * 10 - c1 * 3 - runs * 0.1 - nonAscii * 0.05 - steps * 0.2 - partialRatio * 50;
  return { id, label, text, steps, passthrough, score, signatures };
}

/** Strip a leading byte order mark, whether it survived as bytes or as mojibake. */
function stripBom(text: string): { text: string; removed: boolean } {
  if (text.startsWith(BOM)) return { text: text.slice(BOM.length), removed: true };
  if (text.startsWith(BOM_MOJIBAKE))
    return { text: text.slice(BOM_MOJIBAKE.length), removed: true };
  return { text, removed: false };
}

function confidenceOf(before: number, after: number, partial: boolean): string {
  if (after === 0 && !partial)
    return 'High. Every mojibake signature is gone and every character mapped cleanly.';
  if (after === 0)
    return 'Medium. The signatures are gone, but some characters had to be passed through unchanged.';
  if (after < before)
    return 'Medium. Some mojibake was undone, but signatures remain, so the text was probably damaged more than once.';
  return 'Low. The chain applied, but the result still looks garbled.';
}

const CLEAN_MESSAGE =
  'No mojibake signatures were found. This text already looks like correct UTF-8, so nothing was changed.';

function present(
  candidate: Candidate,
  beforeSignatures: number,
  input: string,
): Record<string, string> {
  const stripped = stripBom(candidate.text);
  const partial = candidate.passthrough > 0;

  if (candidate.id === 'none') {
    if (stripped.removed) {
      return {
        'Fixed text': stripped.text,
        'Applied fix': 'Removed a leading byte order mark. Nothing else needed changing.',
        Confidence: 'High. The only problem was a stray byte order mark.',
        'Byte order mark': 'A leading UTF-8 byte order mark was found and removed.',
      };
    }
    return {
      'Fixed text': input,
      'Applied fix':
        'None. This text has mojibake signatures, but no encoding chain decoded cleanly, so nothing was changed.',
      Confidence: 'Low. The original bytes were probably lost before this text was saved.',
    };
  }

  const note = partial
    ? ` ${candidate.passthrough} character${candidate.passthrough === 1 ? ' was' : 's were'} passed through unchanged because the legacy encoding has no byte for ${candidate.passthrough === 1 ? 'it' : 'them'}.`
    : '';

  const rows: Record<string, string> = {
    'Fixed text': stripped.text,
    'Applied fix': `${candidate.label}.${note}`,
    Confidence: confidenceOf(beforeSignatures, countSignatures(stripped.text), partial),
  };
  if (stripped.removed)
    rows['Byte order mark'] = 'A leading UTF-8 byte order mark was found and removed.';
  return rows;
}

export function run(input: string, opts: MojibakeOpts): Record<string, string> {
  const text = input ?? '';
  if (!text.trim())
    throw new ToolError(
      'empty-input',
      'Enter some text to repair.',
      'Paste the garbled text, for example a line containing \u00C3\u00A9 or \u00E2\u20AC\u2122.',
    );

  const chainId = (opts?.chain || 'auto').trim() || 'auto';
  const beforeSignatures = countSignatures(text);

  if (chainId !== 'auto') {
    const spec = CHAINS.find((c) => c.id === chainId);
    if (!spec || !MANUAL_CHAIN_IDS.includes(chainId))
      throw new ToolError(
        'unknown-chain',
        `"${chainId}" is not a chain this tool knows.`,
        `Pick auto, or one of: ${MANUAL_CHAIN_IDS.join(', ')}.`,
      );

    const applied = applyChain(text, spec.steps);
    if (!applied) {
      return {
        'Fixed text': text,
        'Applied fix': `None. ${spec.label}, but that chain does not fit this text: re-encoding it produced bytes that are not valid UTF-8, or characters the legacy encoding cannot represent.`,
        Confidence: 'Low. The forced chain was not applied, so the text is unchanged.',
      };
    }
    return present(
      scoreCandidate(
        spec.id,
        spec.label,
        applied.text,
        spec.steps.length,
        applied.passthrough,
        applied.total,
      ),
      beforeSignatures,
      text,
    );
  }

  const bomOnly = beforeSignatures === 0 && stripBom(text).removed;
  if (beforeSignatures === 0 && !bomOnly) return { Result: CLEAN_MESSAGE };

  const candidates: Candidate[] = [scoreCandidate('none', 'No change', text, 0, 0, 0)];
  for (const spec of CHAINS) {
    const applied = applyChain(text, spec.steps);
    if (!applied) continue;
    candidates.push(
      scoreCandidate(
        spec.id,
        spec.label,
        applied.text,
        spec.steps.length,
        applied.passthrough,
        applied.total,
      ),
    );
  }

  let best = candidates[0];
  for (const c of candidates) if (c.score > best.score) best = c;

  return present(best, beforeSignatures, text);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, MojibakeOpts>;
