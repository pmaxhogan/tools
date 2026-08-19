import { ToolError, type ToolLogic } from "../types";

export interface PrintCostOpts {
  grams: number;
  meters: number;
  material: string; // pla | petg | abs | tpu | asa | nylon | pc | resin | custom
  customDensity: number; // g/cm3, used when material === "custom"
  filamentDiameter: number; // mm
  spoolPrice: number;
  spoolGrams: number;
  hours: number;
  minutes: number;
  printerWatts: number;
  kwhPrice: number;
  currency: string; // USD | EUR | GBP | CAD | AUD
  markupPercent: number;
  failureRatePercent: number;
  laborRate: number;
  laborMinutes: number;
  printerPrice: number;
  printerLifeHours: number;
  postProcessingCost: number;
  [key: string]: unknown;
}

export type PrintCostResult = Record<string, string>;

/** Numbers pulled out of a pasted slicer summary, when recognizable. */
export interface ParsedSlicerSummary {
  grams?: number;
  meters?: number;
  hours?: number;
  minutes?: number;
}

interface MaterialInfo {
  label: string;
  /** Density in g/cm3 (resin is g/ml, numerically identical). */
  density: number;
  synonyms: string[];
}

export const MATERIALS: Record<string, MaterialInfo> = {
  pla: { label: "PLA", density: 1.24, synonyms: ["polylactic acid"] },
  petg: { label: "PETG", density: 1.27, synonyms: ["polyethylene terephthalate glycol"] },
  abs: { label: "ABS", density: 1.04, synonyms: ["acrylonitrile butadiene styrene"] },
  tpu: { label: "TPU", density: 1.21, synonyms: ["thermoplastic polyurethane", "flexible filament"] },
  asa: { label: "ASA", density: 1.07, synonyms: ["acrylonitrile styrene acrylate"] },
  nylon: { label: "Nylon", density: 1.14, synonyms: ["polyamide", "pa"] },
  pc: { label: "PC", density: 1.2, synonyms: ["polycarbonate"] },
  resin: { label: "Resin", density: 1.1, synonyms: ["sla", "msla", "dlp", "photopolymer"] },
  custom: { label: "Custom", density: 0, synonyms: ["other filament", "unknown material"] },
};

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CAD: "CA$",
  AUD: "AU$",
};

/** Density in g/cm3 for a material id, resolving "custom" to the user-supplied density. */
export function materialDensity(material: string, customDensity: number): number {
  const info = MATERIALS[material];
  if (!info) throw new ToolError("bad-option", "Unknown material.", "Pick a material from the list.");
  return material === "custom" ? customDensity : info.density;
}

/** Grams of filament for a length in meters, from its diameter (mm) and density (g/cm3). */
export function metersToGrams(meters: number, diameterMm: number, densityGPerCm3: number): number {
  const radiusCm = diameterMm / 20;
  const areaCm2 = Math.PI * radiusCm * radiusCm;
  const lengthCm = meters * 100;
  const volumeCm3 = areaCm2 * lengthCm;
  return volumeCm3 * densityGPerCm3;
}

/** Format a money amount with a currency symbol, always two decimals. */
export function formatMoney(value: number, symbol: string): string {
  const v = Math.abs(value) < 1e-9 ? 0 : value;
  return `${symbol}${v.toFixed(2)}`;
}

/** Raw numeric cost breakdown, before currency formatting. */
export interface PrintCostBreakdown {
  grams: number;
  meters: number;
  totalHours: number;
  pricePerGram: number;
  materialCost: number;
  kwh: number;
  electricityCost: number;
  perHourWear: number;
  machineWearCost: number;
  laborHours: number;
  laborCost: number;
  postProcessingCost: number;
  subtotal: number;
  failureMultiplier: number;
  failureAllowance: number;
  markup: number;
  total: number;
  totalPerGram: number;
}

/**
 * Pure cost math from an already-resolved filament amount (grams, and meters
 * if the amount came from a length) and print time. Does no validation and
 * no currency formatting; `run` handles both around this.
 */
export function priceBreakdown(
  grams: number,
  meters: number,
  totalHours: number,
  opts: Pick<
    PrintCostOpts,
    | "spoolPrice"
    | "spoolGrams"
    | "printerWatts"
    | "kwhPrice"
    | "printerPrice"
    | "printerLifeHours"
    | "laborRate"
    | "laborMinutes"
    | "postProcessingCost"
    | "failureRatePercent"
    | "markupPercent"
  >,
): PrintCostBreakdown {
  const pricePerGram = opts.spoolPrice / opts.spoolGrams;
  const materialCost = grams * pricePerGram;

  const kwh = (opts.printerWatts * totalHours) / 1000;
  const electricityCost = kwh * opts.kwhPrice;

  const perHourWear = opts.printerPrice / opts.printerLifeHours;
  const machineWearCost = perHourWear * totalHours;

  const laborHours = opts.laborMinutes / 60;
  const laborCost = opts.laborRate * laborHours;

  const postProcessingCost = opts.postProcessingCost;

  const subtotal = materialCost + electricityCost + machineWearCost + laborCost + postProcessingCost;

  const failureMultiplier = 1 / (1 - opts.failureRatePercent / 100);
  const withFailure = subtotal * failureMultiplier;
  const failureAllowance = withFailure - subtotal;

  const markup = withFailure * (opts.markupPercent / 100);
  const total = withFailure + markup;
  const totalPerGram = total / grams;

  return {
    grams,
    meters,
    totalHours,
    pricePerGram,
    materialCost,
    kwh,
    electricityCost,
    perHourWear,
    machineWearCost,
    laborHours,
    laborCost,
    postProcessingCost,
    subtotal,
    failureMultiplier,
    failureAllowance,
    markup,
    total,
    totalPerGram,
  };
}

function decomposeMinutes(totalMinutesRaw: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, totalMinutesRaw);
  let hours = Math.floor(totalMinutes / 60);
  let minutes = Math.round(totalMinutes - hours * 60);
  if (minutes === 60) {
    minutes = 0;
    hours += 1;
  }
  return { hours, minutes };
}

/**
 * Parse a pasted slicer summary or G-code comment block for filament weight,
 * filament length, and print time. Recognizes plain "Filament used: 23.4g"
 * style lines, PrusaSlicer's "; filament used [g] = 23.4" and
 * "; estimated printing time (normal mode) = 3h 12m 5s" comments, Cura's
 * ";Filament used: 12.3m" and ";TIME:11520" comments, and a bare "45.2m".
 * Returns an empty object when nothing recognizable is found.
 */
export function parseSlicerSummary(text: string): ParsedSlicerSummary {
  const result: ParsedSlicerSummary = {};
  let remaining = text;

  const timeMatch = remaining.match(
    /(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*(\d+(?:\.\d+)?)\s*m(?:in(?:utes)?)?(?:\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds)?)?)?/i,
  );
  if (timeMatch && typeof timeMatch.index === "number") {
    const h = parseFloat(timeMatch[1]);
    const m = parseFloat(timeMatch[2]);
    const s = timeMatch[3] ? parseFloat(timeMatch[3]) : 0;
    const totalMinutes = h * 60 + m + s / 60;
    const { hours, minutes } = decomposeMinutes(totalMinutes);
    result.hours = hours;
    result.minutes = minutes;
    remaining = remaining.slice(0, timeMatch.index) + remaining.slice(timeMatch.index + timeMatch[0].length);
  } else {
    const secMatch = remaining.match(/TIME\s*:\s*(\d+(?:\.\d+)?)/i);
    if (secMatch && typeof secMatch.index === "number") {
      const totalSeconds = parseFloat(secMatch[1]);
      const { hours, minutes } = decomposeMinutes(totalSeconds / 60);
      result.hours = hours;
      result.minutes = minutes;
      remaining = remaining.slice(0, secMatch.index) + remaining.slice(secMatch.index + secMatch[0].length);
    }
  }

  const gramsBracket = remaining.match(/filament\s+used\s*\[\s*g\s*\]\s*=\s*(\d+(?:\.\d+)?)/i);
  const gramsSimple = remaining.match(/filament\s+used\s*:?\s*(\d+(?:\.\d+)?)\s*g\b/i);
  if (gramsBracket) {
    result.grams = parseFloat(gramsBracket[1]);
  } else if (gramsSimple) {
    result.grams = parseFloat(gramsSimple[1]);
  }

  if (result.grams === undefined) {
    const metersLabeled = remaining.match(
      /filament\s+used\s*(?:\[\s*m\s*\])?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*m\b/i,
    );
    const metersBare = remaining.trim().match(/^(\d+(?:\.\d+)?)\s*m$/i);
    const metersMatch = metersLabeled || metersBare;
    if (metersMatch) {
      result.meters = parseFloat(metersMatch[1]);
    }
  }

  return result;
}

function assertRange(
  value: number,
  min: number,
  max: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ToolError(
      "bad-option",
      `${label} must be between ${min} and ${max}.`,
      `Enter a value between ${min} and ${max}.`,
    );
  }
}

export function run(input: string, opts: PrintCostOpts): PrintCostResult {
  assertRange(opts.grams, 0, 5000, "Filament weight (g)");
  assertRange(opts.meters, 0, 100000, "Filament length (m)");
  assertRange(opts.filamentDiameter, 0.1, 10, "Filament diameter");
  assertRange(opts.spoolPrice, 0, 100000, "Spool price");
  assertRange(opts.spoolGrams, 1, 100000, "Spool weight");
  assertRange(opts.hours, 0, 2000, "Print time hours");
  assertRange(opts.minutes, 0, 59, "Print time minutes");
  assertRange(opts.printerWatts, 0, 20000, "Printer wattage");
  assertRange(opts.kwhPrice, 0, 100, "Electricity price");
  assertRange(opts.markupPercent, 0, 500, "Markup percent");
  assertRange(opts.failureRatePercent, 0, 50, "Failure rate percent");
  assertRange(opts.laborRate, 0, 100000, "Labor rate");
  assertRange(opts.laborMinutes, 0, 100000, "Labor minutes");
  assertRange(opts.printerPrice, 0, 1000000, "Printer price");
  assertRange(opts.printerLifeHours, 1, 1000000, "Printer life hours");
  assertRange(opts.postProcessingCost, 0, 1000000, "Post processing cost");
  if (opts.material === "custom") assertRange(opts.customDensity, 0.01, 30, "Custom density");

  const symbol = CURRENCY_SYMBOLS[opts.currency];
  if (!symbol)
    throw new ToolError(
      "bad-option",
      "Unknown currency.",
      "Pick USD, EUR, GBP, CAD, or AUD.",
    );

  const density = materialDensity(opts.material, opts.customDensity);
  const materialLabel = MATERIALS[opts.material]?.label ?? "Custom";

  const trimmedInput = (input ?? "").trim();
  let parsed: ParsedSlicerSummary = {};
  if (trimmedInput !== "") {
    parsed = parseSlicerSummary(trimmedInput);
    if (Object.keys(parsed).length === 0) {
      throw new ToolError(
        "bad-paste",
        "Could not find a filament weight, length, or print time in the pasted text.",
        "Paste the slicer summary or set grams.",
      );
    }
  }

  let effGrams: number;
  let effMeters: number;
  if (parsed.grams !== undefined) {
    effGrams = parsed.grams;
    effMeters = 0;
  } else if (parsed.meters !== undefined) {
    effGrams = 0;
    effMeters = parsed.meters;
  } else {
    effGrams = opts.grams;
    effMeters = opts.meters;
  }

  let effHours: number;
  let effMinutes: number;
  if (parsed.hours !== undefined || parsed.minutes !== undefined) {
    effHours = parsed.hours ?? 0;
    effMinutes = parsed.minutes ?? 0;
  } else {
    effHours = opts.hours;
    effMinutes = opts.minutes;
  }

  let grams = effGrams;
  let meters = effGrams > 0 ? 0 : effMeters;
  if (grams <= 0 && effMeters > 0) {
    grams = metersToGrams(effMeters, opts.filamentDiameter, density);
    meters = effMeters;
  }

  if (!(grams > 0)) {
    throw new ToolError(
      "nothing-to-price",
      "Enter a filament weight or length to price, or paste a slicer summary.",
      "Set grams or meters, or paste a slicer summary.",
    );
  }

  const totalHours = effHours + effMinutes / 60;

  const {
    pricePerGram,
    materialCost,
    kwh,
    electricityCost,
    perHourWear,
    machineWearCost,
    laborHours,
    laborCost,
    postProcessingCost,
    subtotal,
    failureAllowance,
    markup,
    total,
    totalPerGram,
  } = priceBreakdown(grams, meters, totalHours, opts);

  const filamentAmount =
    meters > 0
      ? `${grams.toFixed(2)} g (from ${meters.toFixed(2)} m ${materialLabel})`
      : `${grams.toFixed(2)} g ${materialLabel}`;

  const hoursLabel = `${Math.floor(totalHours)}h ${Math.round((totalHours - Math.floor(totalHours)) * 60)}m`;

  return {
    "Filament amount": filamentAmount,
    "Material cost": `${formatMoney(materialCost, symbol)} (${grams.toFixed(2)} g x ${symbol}${pricePerGram.toFixed(4)}/g)`,
    "Electricity cost": `${formatMoney(electricityCost, symbol)} (${kwh.toFixed(3)} kWh x ${symbol}${opts.kwhPrice.toFixed(2)}/kWh)`,
    "Machine wear": `${formatMoney(machineWearCost, symbol)} (${totalHours.toFixed(2)} h x ${symbol}${perHourWear.toFixed(4)}/h)`,
    Labor: `${formatMoney(laborCost, symbol)} (${laborHours.toFixed(2)} h x ${symbol}${opts.laborRate.toFixed(2)}/h)`,
    "Post processing": formatMoney(postProcessingCost, symbol),
    Subtotal: formatMoney(subtotal, symbol),
    "Failure allowance": `${formatMoney(failureAllowance, symbol)} (${opts.failureRatePercent}% failure rate)`,
    Markup: `${formatMoney(markup, symbol)} (${opts.markupPercent}% markup)`,
    Total: formatMoney(total, symbol),
    "Total per gram": `${symbol}${totalPerGram.toFixed(4)}/g`,
    Quote: `${formatMoney(total, symbol)} for ${grams.toFixed(1)} g of ${materialLabel}, about ${hoursLabel} print time`,
  };
}

export default { run } satisfies ToolLogic<string, PrintCostResult, PrintCostOpts>;
