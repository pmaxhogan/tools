import { ToolError, type ToolLogic } from "../types";

export interface VswrOpts {
  /** "vswr" | "return-loss" | "reflection-coefficient" | "mismatch-loss" | "power-ratio" */
  quantity: string;
  [key: string]: unknown;
}

export type VswrResult = Record<string, string>;

/** Reflection coefficient magnitude from VSWR. */
function gammaFromVswr(vswr: number): number {
  return (vswr - 1) / (vswr + 1);
}

function vswrFromGamma(gamma: number): number {
  return (1 + gamma) / (1 - gamma);
}

function returnLossFromGamma(gamma: number): number {
  return -20 * Math.log10(gamma);
}

function gammaFromReturnLoss(rlDb: number): number {
  return Math.pow(10, -rlDb / 20);
}

/** Fraction of incident power reflected (Pref / Pinc). */
function reflectedFraction(gamma: number): number {
  return gamma * gamma;
}

/** Mismatch loss in dB: how much less power reaches the load than a matched line, in dB. */
function mismatchLossDb(gamma: number): number {
  return -10 * Math.log10(1 - gamma * gamma);
}

function parseNumber(raw: string, label: string): number {
  const s = (raw ?? "").trim();
  const num = Number(s.replace(/:1$/i, "").replace(/db$/i, "").replace(/%$/, ""));
  if (s === "" || !Number.isFinite(num)) {
    throw new ToolError(
      "bad-value",
      `Could not parse "${s}" as ${label}.`,
      `Enter a plain number for ${label}.`,
    );
  }
  return num;
}

function formatGamma(gamma: number): string {
  return gamma.toFixed(4);
}

function referenceTable(): string {
  const rows = [1.0, 1.1, 1.2, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0];
  return rows
    .map((v) => {
      const gamma = gammaFromVswr(v);
      const rl = v === 1 ? Infinity : returnLossFromGamma(gamma);
      const ml = mismatchLossDb(gamma);
      const refl = reflectedFraction(gamma) * 100;
      return `${v.toFixed(2)}:1 -> RL ${rl === Infinity ? "inf" : rl.toFixed(2)} dB, gamma ${formatGamma(gamma)}, reflected ${refl.toFixed(2)}%, mismatch loss ${ml.toFixed(3)} dB`;
    })
    .join(" | ");
}

export function run(input: string, opts: VswrOpts): VswrResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      'Enter a value to convert, like "1.5" for VSWR or "20" for return loss in dB.',
      'Try "1.5", "1.5:1", "20dB", or "0.2" depending on the quantity selected.',
    );
  }

  const quantity = opts.quantity || "vswr";
  const value = parseNumber(raw, quantity.replace(/-/g, " "));

  let vswr: number;
  let gamma: number;

  if (quantity === "vswr") {
    vswr = value;
    if (vswr < 1) {
      throw new ToolError(
        "impossible",
        `VSWR must be 1.0 or greater, got ${vswr}.`,
        "A VSWR of 1.0 means a perfect match; it cannot go below 1.",
      );
    }
    gamma = gammaFromVswr(vswr);
  } else if (quantity === "return-loss") {
    if (value < 0) {
      throw new ToolError(
        "impossible",
        `Return loss must be 0 dB or greater, got ${value} dB.`,
        "Return loss is expressed as a positive number of dB (higher is better).",
      );
    }
    gamma = gammaFromReturnLoss(value);
    vswr = vswrFromGamma(gamma);
  } else if (quantity === "reflection-coefficient") {
    if (value < 0 || value >= 1) {
      throw new ToolError(
        "impossible",
        `Reflection coefficient magnitude must be between 0 and 1 (exclusive of 1), got ${value}.`,
        "Use a value like 0.2, or convert from VSWR or return loss instead.",
      );
    }
    gamma = value;
    vswr = vswrFromGamma(gamma);
  } else if (quantity === "mismatch-loss") {
    if (value < 0) {
      throw new ToolError(
        "impossible",
        `Mismatch loss must be 0 dB or greater, got ${value} dB.`,
        "Mismatch loss is a positive number of dB.",
      );
    }
    const reflectedPowerFraction = 1 - Math.pow(10, -value / 10);
    if (reflectedPowerFraction < 0 || reflectedPowerFraction >= 1) {
      throw new ToolError(
        "impossible",
        `A mismatch loss of ${value} dB is not physically achievable.`,
        "Mismatch loss approaches infinity only as the match approaches total reflection; use a smaller value.",
      );
    }
    gamma = Math.sqrt(reflectedPowerFraction);
    vswr = vswrFromGamma(gamma);
  } else {
    // power-ratio: value is the forward-to-reflected power ratio (Pfwd / Pref), or reflected power percent.
    if (value <= 0) {
      throw new ToolError(
        "impossible",
        `Reflected power percent must be greater than 0 and less than 100, got ${value}.`,
        "Enter the reflected power as a percent of forward power, like 4 for 4%.",
      );
    }
    if (value >= 100) {
      throw new ToolError(
        "impossible",
        `Reflected power percent must be less than 100, got ${value}.`,
        "100% reflected power is a total mismatch (open or short); use a smaller value.",
      );
    }
    gamma = Math.sqrt(value / 100);
    vswr = vswrFromGamma(gamma);
  }

  const rl = vswr === 1 ? Infinity : returnLossFromGamma(gamma);
  const ml = mismatchLossDb(gamma);
  const reflPct = reflectedFraction(gamma) * 100;
  const fwdPct = 100 - reflPct;

  const out: VswrResult = {};
  out["VSWR"] = `${vswr.toFixed(3)}:1`;
  out["Return loss"] = rl === Infinity ? "infinite (perfect match)" : `${rl.toFixed(2)} dB`;
  out["Reflection coefficient (gamma)"] = formatGamma(gamma);
  out["Mismatch loss"] = `${ml.toFixed(3)} dB`;
  out["Reflected power"] = `${reflPct.toFixed(3)}% of forward power`;
  out["Power delivered to the load"] = `${fwdPct.toFixed(3)}% of forward power`;
  out["Reference table (VSWR -> RL, gamma, reflected %, mismatch loss)"] = referenceTable();

  return out;
}

export default { run } satisfies ToolLogic<string, VswrResult, VswrOpts>;

// Exported for tests only; not part of the tool's public logic surface.
export const __test__ = {
  gammaFromVswr,
  vswrFromGamma,
  returnLossFromGamma,
  gammaFromReturnLoss,
  mismatchLossDb,
  reflectedFraction,
};
