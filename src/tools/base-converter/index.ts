import { ToolError, type ToolLogic } from "../types";

export interface BaseConverterOpts {
  /** 'auto' | '2' | '8' | '10' | '16' | '36' — ignored when a prefix is detected. */
  inputBase: string;
  [key: string]: unknown;
}

export interface BaseConverterResult {
  [label: string]: string;
}

interface Parsed {
  value: bigint;
}

/** Value of a single digit character (0-9, a-z / A-Z -> 10-35), or -1 if not a digit char at all. */
function digitValue(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 122) return code - 97 + 10; // a-z
  if (code >= 65 && code <= 90) return code - 65 + 10; // A-Z
  return -1;
}

function digitChar(v: number): string {
  return v < 10 ? String(v) : String.fromCharCode(97 + v - 10);
}

function maxDigitDescription(base: number): string {
  if (base <= 10) return `0-${base - 1}`;
  return `0-9 and a-${digitChar(base - 1)} (case-insensitive)`;
}

/** Parse a signed integer string in the given/auto-detected base into a BigInt. */
function parse(raw: string, inputBaseOpt: string): Parsed {
  const trimmed = raw.trim();
  if (!trimmed) throw new ToolError("empty-input", "Enter a number to convert.");

  let offset = 0;
  let negative = false;
  let s = trimmed;
  if (s[0] === "-" || s[0] === "+") {
    negative = s[0] === "-";
    s = s.slice(1);
    offset = 1;
  }

  if (s.includes("."))
    throw new ToolError(
      "non-integer",
      `"${trimmed}" has a decimal point: only integers are supported.`,
      "Remove the fractional part or round to the nearest integer first.",
    );

  let base: number;
  let digits = s;
  let prefixLen = 0;
  if (/^0x/i.test(s)) {
    base = 16;
    digits = s.slice(2);
    prefixLen = 2;
  } else if (/^0b/i.test(s)) {
    base = 2;
    digits = s.slice(2);
    prefixLen = 2;
  } else if (/^0o/i.test(s)) {
    base = 8;
    digits = s.slice(2);
    prefixLen = 2;
  } else if (!inputBaseOpt || inputBaseOpt === "auto") {
    base = 10;
  } else {
    const parsedBase = parseInt(inputBaseOpt, 10);
    if (!Number.isFinite(parsedBase) || parsedBase < 2 || parsedBase > 36)
      throw new ToolError("bad-base", `Unsupported input base "${inputBaseOpt}".`);
    base = parsedBase;
  }

  if (!digits.length)
    throw new ToolError(
      "empty-input",
      `Enter digits after the "${trimmed.slice(offset, offset + prefixLen)}" prefix.`,
    );

  let value = 0n;
  const bigBase = BigInt(base);
  for (let i = 0; i < digits.length; i++) {
    const ch = digits[i]!;
    const v = digitValue(ch);
    if (v === -1 || v >= base) {
      const position = offset + prefixLen + i + 1; // 1-indexed, within the original input
      throw new ToolError(
        "invalid-digit",
        `Character '${ch}' at position ${position} is not valid for base ${base}.`,
        `Use only digits ${maxDigitDescription(base)} for base ${base}.`,
      );
    }
    value = value * bigBase + BigInt(v);
  }

  return { value: negative ? -value : value };
}

function groupNibbles(bin: string): string {
  const pad = (4 - (bin.length % 4)) % 4;
  const padded = "0".repeat(pad) + bin;
  const groups = padded.match(/.{4}/g) ?? [padded];
  return groups.join(" ");
}

function groupThousands(decimal: string): string {
  return decimal.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function toBytesHex(abs: bigint): string {
  let hex = abs.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const pairs = hex.match(/.{2}/g) ?? [hex];
  return pairs.join(" ");
}

export function run(input: string, opts: BaseConverterOpts): BaseConverterResult {
  const { value } = parse(input ?? "", opts.inputBase);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const sign = negative ? "-" : "";

  const binStr = abs.toString(2);
  const bits = abs === 0n ? 1 : binStr.length;

  const result: BaseConverterResult = {
    Binary: sign + groupNibbles(binStr),
    Octal: sign + abs.toString(8),
    Decimal: value.toString(),
    "Decimal (grouped)": sign + groupThousands(abs.toString(10)),
    Hex: sign + "0x" + abs.toString(16),
    Base36: sign + abs.toString(36),
    Bits: String(bits),
  };

  if (bits <= 64) {
    result.Bytes = sign + toBytesHex(abs);
  }

  return result;
}

export default { run } satisfies ToolLogic<string, BaseConverterResult, BaseConverterOpts>;
