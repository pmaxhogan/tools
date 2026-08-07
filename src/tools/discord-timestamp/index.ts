import { ToolError, type ToolLogic } from "../types";

export interface DiscordTimestampResult {
  [label: string]: string;
}

/**
 * Parse a timestamp: unix seconds, unix millis, ISO 8601, or empty (= now).
 * Same heuristic as the epoch-converter tool, implemented locally — tools
 * must not import each other.
 */
function parse(raw: string): Date {
  const s = raw.trim();
  if (!s) return new Date();

  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    // Heuristic: |n| >= 1e12 is millis, otherwise seconds. Covers 1973–33658.
    const ms = Math.abs(n) >= 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime()))
      throw new ToolError("out-of-range", `"${s}" is outside the representable date range.`);
    return d;
  }

  const d = new Date(s);
  if (isNaN(d.getTime()))
    throw new ToolError(
      "unparseable-date",
      `Could not parse "${s}" as a date.`,
      "Use a unix timestamp in seconds (1754521200), milliseconds (1754521200000), or an ISO 8601 date like 2026-08-06T21:00:00Z. Leave blank for now.",
    );
  return d;
}

/** The seven Discord timestamp styles, in the order Discord documents them. */
const STYLES: { code: string; label: string }[] = [
  { code: "t", label: "short time (e.g. 9:41 PM)" },
  { code: "T", label: "long time" },
  { code: "d", label: "short date" },
  { code: "D", label: "long date" },
  { code: "f", label: "short date/time (default)" },
  { code: "F", label: "long date/time" },
  { code: "R", label: "relative (e.g. in 2 hours)" },
];

function tag(seconds: number, code: string): string {
  return `<t:${seconds}:${code}>`;
}

function fmt(d: Date): DiscordTimestampResult {
  const seconds = Math.floor(d.getTime() / 1000);
  const out: DiscordTimestampResult = { "Unix seconds": String(seconds) };
  for (const { code, label } of STYLES) {
    out[`${tag(seconds, code)} (${label})`] = tag(seconds, code);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function run(input: string, _opts: Record<string, unknown>): DiscordTimestampResult {
  return fmt(parse(input ?? ""));
}

export default { run } satisfies ToolLogic<string, DiscordTimestampResult, Record<string, unknown>>;
