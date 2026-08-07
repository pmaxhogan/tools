import { ToolError, type ToolLogic } from "../types";

export interface DurationResult {
  [label: string]: string;
}

const FIX_EXAMPLE =
  'Use a clock time like "1:30:00", a unit duration like "2h 30m" or "90m", or a bare number of minutes like "45".';

/** Unit suffix -> milliseconds per unit. Matched case-insensitively. */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/**
 * Parses a whitespace-separated run of number+unit pairs (e.g. "2h 30m",
 * "500ms", "1.5h"). Returns null if the text isn't fully consumed by such
 * pairs.
 */
function parseUnitComposite(text: string): number | null {
  const re = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/y;
  let idx = 0;
  let total = 0;
  let matchedAny = false;

  while (idx < text.length) {
    while (idx < text.length && /\s/.test(text[idx]!)) idx++;
    if (idx >= text.length) break;

    re.lastIndex = idx;
    const m = re.exec(text);
    if (!m || m.index !== idx) return null;

    const unit = m[2]!.toLowerCase();
    const unitMs = UNIT_MS[unit];
    if (unitMs === undefined) return null;

    total += Number(m[1]) * unitMs;
    matchedAny = true;
    idx = re.lastIndex;
  }

  return matchedAny ? total : null;
}

/** Parses one duration literal (a single term, no top-level + or -) into milliseconds. */
function parseTerm(rawText: string): number | null {
  const text = rawText.trim();
  if (!text) return null;

  const noSpace = text.replace(/\s+/g, "");

  // Clock forms: hh:mm or hh:mm:ss (minutes/seconds 0-59).
  const clockMatch = /^(\d+):([0-5]?\d)(?::([0-5]?\d(?:\.\d+)?))?$/.exec(noSpace);
  if (clockMatch) {
    const h = Number(clockMatch[1]);
    const min = Number(clockMatch[2]);
    const sec = clockMatch[3] ? Number(clockMatch[3]) : 0;
    return ((h * 60 + min) * 60 + sec) * 1000;
  }

  // Bare number -> minutes.
  if (/^\d+(?:\.\d+)?$/.test(noSpace)) {
    return Number(noSpace) * 60_000;
  }

  // Unit shorthand, possibly composite ("2h 30m").
  const compact = text.replace(/\s+/g, " ").trim();
  return parseUnitComposite(compact);
}

/** Evaluates a single-line "term + term - term" expression into signed milliseconds. */
function evaluateExpression(expr: string): number {
  const trimmed = expr.trim();
  const re = /([+-])?\s*([^+-]+)/g;
  let m: RegExpExecArray | null;
  let total = 0;
  let found = false;

  while ((m = re.exec(trimmed))) {
    const signStr = m[1];
    const rawGroup = m[2]!;
    const text = rawGroup.trim();
    if (!text) continue;
    found = true;

    const sign = signStr === "-" ? -1 : 1;
    const ms = parseTerm(text);
    if (ms === null) {
      const leadingWs = rawGroup.length - rawGroup.trimStart().length;
      const position = m.index + (signStr ? signStr.length : 0) + leadingWs + 1;
      throw new ToolError(
        "unparseable-token",
        `Could not parse duration "${text}" at position ${position}.`,
        FIX_EXAMPLE,
      );
    }
    total += sign * ms;
  }

  if (!found) {
    throw new ToolError("unparseable-token", `Could not parse duration "${trimmed}".`, FIX_EXAMPLE);
  }

  return total;
}

/**
 * Evaluates the full input: either a single "+/-" expression, or (when
 * multiple non-blank lines are present with no operators) one duration
 * literal per line, all summed.
 */
function evaluateInput(raw: string): number {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length > 1) {
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      try {
        total += evaluateExpression(lines[i]!);
      } catch (e) {
        if (e instanceof ToolError) {
          throw new ToolError(e.code, `Line ${i + 1}: ${e.message}`, e.fix);
        }
        throw e;
      }
    }
    return total;
  }

  return evaluateExpression(lines[0] ?? raw.trim());
}

function formatClock(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function humanizeDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const totalMinutes = Math.floor(Math.abs(ms) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);

  return sign + parts.join(" ");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function run(input: string, _opts: Record<string, unknown>): DurationResult {
  const raw = input ?? "";
  if (!raw.trim()) {
    throw new ToolError(
      "empty-input",
      "Enter a duration expression to calculate.",
      'e.g. "1:30:00 + 45m" or "90m"',
    );
  }

  const totalMs = evaluateInput(raw);

  return {
    "Total (hh:mm:ss)": formatClock(totalMs),
    "Days hours minutes": humanizeDuration(totalMs),
    "Total seconds": String(Number((totalMs / 1000).toFixed(3))),
    "Total minutes": (totalMs / 60_000).toFixed(2),
    "Total hours": (totalMs / 3_600_000).toFixed(3),
  };
}

export default { run } satisfies ToolLogic<string, DurationResult, Record<string, unknown>>;
