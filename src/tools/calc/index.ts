import { all, create } from "mathjs";
import { ToolError, type ToolLogic } from "../types";
import { FX_BASE, FX_DATE, FX_RATES } from "./rates";

export interface CalcOpts {
  /** Significant digits in the formatted result (1-15). */
  precision?: number;
  [key: string]: unknown;
}

export interface CalcResult {
  [label: string]: string;
}

/** Demo expressions the panel can render as one-click chips. */
export const EXAMPLES: string[] = [
  "20 miles to km",
  "3 ft + 4 in to cm",
  "100 USD to EUR",
  "5 GBP + 3 EUR in USD",
  "sin(45 deg)",
  "2^16 bytes to MB",
  "3 kg * 9.81 m/s^2 to N",
  "(120 km/h) * 45 minutes to miles",
];

/**
 * A scoped mathjs instance. Created once per module load (the registry lazy
 * loads this file per page), so the library's global config is never touched
 * and the currency units only exist inside this calculator.
 *
 * Number type is the mathjs default "number", not BigNumber: BigNumber breaks
 * expressions that mix in plain floats (random(), several statistics helpers)
 * with "cannot implicitly convert a number with >15 significant digits", while
 * unit arithmetic works identically under both.
 */
const math = create(all, {});

/** Register FX_BASE plus one unit per snapshot currency. Runs once. */
function registerCurrencies(): void {
  try {
    math.createUnit(FX_BASE);
  } catch {
    // Already defined (double module evaluation) or colliding with a built-in.
  }
  for (const [code, perBase] of Object.entries(FX_RATES)) {
    if (code === FX_BASE) continue;
    if (!Number.isFinite(perBase) || perBase <= 0) continue;
    try {
      // FX_RATES holds units of `code` per 1 FX_BASE, so 1 code = 1/rate base.
      math.createUnit(code, { definition: `${1 / perBase} ${FX_BASE}` });
    } catch {
      // A code that collides with an existing mathjs unit stays unregistered
      // rather than breaking every other currency.
    }
  }
}

registerCurrencies();

const CURRENCY_CODES = Object.keys(FX_RATES);
const CURRENCY_RE = new RegExp(`\\b(?:${CURRENCY_CODES.join("|")})\\b`, "i");

/** True when the expression names any currency from the snapshot. */
export function mentionsCurrency(input: string): boolean {
  return CURRENCY_RE.test(input);
}

function resolvePrecision(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return 6;
  return Math.min(15, Math.max(1, Math.round(n)));
}

export function run(input: string, opts: CalcOpts = {}): CalcResult {
  const expr = (input ?? "").trim();
  if (!expr) {
    throw new ToolError(
      "empty-input",
      "Enter something to calculate.",
      'Try "20 miles to km" or "sin(45 deg)".',
    );
  }

  const precision = resolvePrecision(opts.precision);

  let value: unknown;
  try {
    value = math.evaluate(expr);
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).trim();
    throw new ToolError(
      "bad-expression",
      message || "That expression could not be evaluated.",
      'Check the units and syntax. Example: "3 ft + 4 in to cm".',
    );
  }

  if (value === undefined) {
    throw new ToolError(
      "bad-expression",
      "That expression did not produce a result.",
      'Check the units and syntax. Example: "3 ft + 4 in to cm".',
    );
  }

  const formatted = math.format(value, { precision });
  const out: CalcResult = { Result: formatted };

  if (math.isUnit(value)) {
    const units = value.formatUnits();
    const suffix = ` ${units}`;
    if (units && formatted.endsWith(suffix)) {
      out.Value = formatted.slice(0, formatted.length - suffix.length);
      out.Unit = units;
    }
  }

  if (mentionsCurrency(expr)) out["Rates as of"] = FX_DATE;

  return out;
}

export default { run } satisfies ToolLogic<string, CalcResult, CalcOpts>;
