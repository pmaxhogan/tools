import { ToolError, type ToolLogic } from "../types";

/**
 * The W3C "standard gamepad" button layout: 17 buttons at fixed indices,
 * regardless of what a controller's face buttons are printed with. See
 * https://www.w3.org/TR/gamepad/#dfn-standard-gamepad-layout
 */
export type ButtonId =
  | "face-bottom"
  | "face-right"
  | "face-left"
  | "face-top"
  | "shoulder-left"
  | "shoulder-right"
  | "trigger-left"
  | "trigger-right"
  | "select"
  | "start"
  | "stick-left"
  | "stick-right"
  | "dpad-up"
  | "dpad-down"
  | "dpad-left"
  | "dpad-right"
  | "home";

/** Button ids in index order (0..16). */
export const STANDARD_BUTTON_IDS: ButtonId[] = [
  "face-bottom",
  "face-right",
  "face-left",
  "face-top",
  "shoulder-left",
  "shoulder-right",
  "trigger-left",
  "trigger-right",
  "select",
  "start",
  "stick-left",
  "stick-right",
  "dpad-up",
  "dpad-down",
  "dpad-left",
  "dpad-right",
  "home",
];

/** Axis ids in index order (0..3). */
export type AxisId = "left-x" | "left-y" | "right-x" | "right-y";
export const STANDARD_AXIS_IDS: AxisId[] = ["left-x", "left-y", "right-x", "right-y"];

/** The standard gamepad layout: 17 buttons, 4 axes, with a vendor-neutral id per slot. */
export const STANDARD_MAPPING = {
  buttons: STANDARD_BUTTON_IDS.map((id, index) => ({ index, id })),
  axes: STANDARD_AXIS_IDS.map((id, index) => ({ index, id })),
};

export type VendorId = "xbox" | "playstation" | "switch" | "generic";

const VENDOR_NAMES: Record<VendorId, string> = {
  xbox: "Xbox controller",
  playstation: "PlayStation controller",
  switch: "Nintendo Switch controller",
  generic: "Generic or unrecognized controller",
};

/** Face/shoulder/menu/stick/dpad/home labels, in STANDARD_BUTTON_IDS order, per vendor family. */
const BUTTON_LABELS: Record<VendorId, string[]> = {
  xbox: [
    "A",
    "B",
    "X",
    "Y",
    "LB",
    "RB",
    "LT",
    "RT",
    "View",
    "Menu",
    "Left stick click (L3)",
    "Right stick click (R3)",
    "D-pad up",
    "D-pad down",
    "D-pad left",
    "D-pad right",
    "Xbox button",
  ],
  playstation: [
    "Cross",
    "Circle",
    "Square",
    "Triangle",
    "L1",
    "R1",
    "L2",
    "R2",
    "Share",
    "Options",
    "L3",
    "R3",
    "D-pad up",
    "D-pad down",
    "D-pad left",
    "D-pad right",
    "PS button",
  ],
  switch: [
    "B",
    "A",
    "Y",
    "X",
    "L",
    "R",
    "ZL",
    "ZR",
    "Minus",
    "Plus",
    "Left stick click",
    "Right stick click",
    "D-pad up",
    "D-pad down",
    "D-pad left",
    "D-pad right",
    "Home button",
  ],
  generic: STANDARD_BUTTON_IDS.map((_, index) => `Button ${index}`),
};

const AXIS_LABELS: Record<VendorId, string[]> = {
  xbox: ["Left stick X", "Left stick Y", "Right stick X", "Right stick Y"],
  playstation: ["Left stick X", "Left stick Y", "Right stick X", "Right stick Y"],
  switch: ["Left stick X", "Left stick Y", "Right stick X", "Right stick Y"],
  generic: ["Axis 0", "Axis 1", "Axis 2", "Axis 3"],
};

function buttonLabel(vendor: VendorId, index: number): string {
  return BUTTON_LABELS[vendor][index] ?? `Button ${index}`;
}

function axisLabel(vendor: VendorId, index: number): string {
  return AXIS_LABELS[vendor][index] ?? `Axis ${index}`;
}

/**
 * Guesses the controller family from a `Gamepad.id` string. Browsers embed the
 * USB vendor/product codes and often the model name directly in `id`, e.g.
 * `"Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)"`.
 * Falls back to "generic" when nothing matches.
 */
export function detectVendor(id: string | null | undefined): VendorId {
  const s = (id ?? "").toLowerCase();
  if (s.includes("xbox") || s.includes("xinput") || s.includes("vendor: 045e") || s.includes("045e")) {
    return "xbox";
  }
  if (
    s.includes("dualsense") ||
    s.includes("dualshock") ||
    s.includes("playstation") ||
    s.includes("vendor: 054c") ||
    s.includes("054c")
  ) {
    return "playstation";
  }
  if (
    s.includes("pro controller") ||
    s.includes("joy-con") ||
    s.includes("switch") ||
    s.includes("vendor: 057e") ||
    s.includes("057e")
  ) {
    return "switch";
  }
  return "generic";
}

/** Minimal shape of a `Gamepad` needed to describe it. */
export interface GamepadInfo {
  id: string;
  mapping?: string;
  buttons: number;
  axes: number;
}

/** Labeled, copyable rows identifying the connected controller. */
export function describeGamepad(gp: GamepadInfo, vendor: VendorId = detectVendor(gp.id)): Record<string, string> {
  const isStandardMapping = gp.mapping === "standard";
  const isStandardCounts = gp.buttons === STANDARD_MAPPING.buttons.length && gp.axes === STANDARD_MAPPING.axes.length;
  return {
    Controller: gp.id || "(no id reported)",
    "Detected type": VENDOR_NAMES[vendor],
    Mapping: gp.mapping ? gp.mapping : "(none reported)",
    "Buttons reported": String(gp.buttons),
    "Axes reported": String(gp.axes),
    "Standard layout": isStandardMapping && isStandardCounts ? "yes" : "no, labels below are best guesses",
  };
}

/** One button's live state, as reported by `Gamepad.buttons[i]`. */
export interface ButtonState {
  index: number;
  value: number;
  pressed: boolean;
  touched?: boolean;
}

/** Labeled rows for every reported button, using vendor-appropriate names. */
export function describeButtons(pressed: ButtonState[], vendor: VendorId = "generic"): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const b of pressed) {
    if (typeof b?.index !== "number" || !Number.isFinite(b.index)) continue;
    const label = buttonLabel(vendor, b.index);
    const value = typeof b.value === "number" && Number.isFinite(b.value) ? b.value : b.pressed ? 1 : 0;
    if (b.pressed) rows[label] = `pressed (${value.toFixed(2)})`;
    else if (b.touched) rows[label] = "touched, not pressed";
    else rows[label] = "released";
  }
  return rows;
}

/** Analog value stats for one trigger sampled over time (e.g. LT/RT, L2/R2). */
export interface TriggerRangeResult {
  min: number;
  max: number;
  range: number;
  reachesZero: boolean;
  reachesFull: boolean;
}

/** Summarizes a series of analog trigger readings: does it hit both ends of its travel. */
export function triggerRange(values: number[]): TriggerRangeResult {
  if (values.length === 0) {
    return { min: 0, max: 0, range: 0, reachesZero: false, reachesFull: false };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max, range: max - min, reachesZero: min <= 0.02, reachesFull: max >= 0.98 };
}

/** One resting or moving sample of a stick's analog axes, timestamped in ms. */
export interface StickSample {
  t: number;
  x: number;
  y: number;
}

export interface DriftAnalysisOptions {
  deadzone?: number;
}

export type DriftVerdict = "no drift" | "minor drift" | "noticeable drift" | "severe drift";

export interface DriftAnalysis {
  meanX: number;
  meanY: number;
  /** Magnitude of the mean offset from center: how far the stick's resting point has wandered. */
  magnitude: number;
  /** Largest single-sample magnitude observed (captures noisy spikes the mean would hide). */
  maxMagnitude: number;
  /** Standard deviation of per-sample magnitude: how noisy the resting reading is. */
  stdDev: number;
  /** Percent of samples whose magnitude exceeds the configured deadzone. */
  percentOutsideDeadzone: number;
  verdict: DriftVerdict;
  /** A deadzone, rounded to 0.01, that would absorb the observed drift with a small margin. */
  suggestedDeadzone: number;
}

/**
 * Analyzes resting-stick samples (collected while the user does not touch the
 * stick) for drift: a nonzero resting position that keeps a character moving
 * or a cursor creeping even with no input.
 */
export function analyzeDrift(samples: StickSample[], opts: DriftAnalysisOptions = {}): DriftAnalysis {
  const deadzone = opts.deadzone ?? 0.05;
  if (samples.length === 0) {
    return {
      meanX: 0,
      meanY: 0,
      magnitude: 0,
      maxMagnitude: 0,
      stdDev: 0,
      percentOutsideDeadzone: 0,
      verdict: "no drift",
      suggestedDeadzone: deadzone,
    };
  }

  const n = samples.length;
  const meanX = samples.reduce((sum, s) => sum + s.x, 0) / n;
  const meanY = samples.reduce((sum, s) => sum + s.y, 0) / n;
  const magnitude = Math.hypot(meanX, meanY);

  const magnitudes = samples.map((s) => Math.hypot(s.x, s.y));
  const maxMagnitude = Math.max(...magnitudes);
  const variance = magnitudes.reduce((sum, m) => sum + (m - magnitude) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  const outside = magnitudes.filter((m) => m > deadzone).length;
  const percentOutsideDeadzone = (outside / n) * 100;

  let verdict: DriftVerdict;
  if (magnitude < 0.02) verdict = "no drift";
  else if (magnitude < 0.06) verdict = "minor drift";
  else if (magnitude < 0.15) verdict = "noticeable drift";
  else verdict = "severe drift";

  const suggestedDeadzoneRaw = Math.max(deadzone, maxMagnitude + 0.015);
  const suggestedDeadzone = Math.min(0.3, Math.round(suggestedDeadzoneRaw * 100) / 100);

  return { meanX, meanY, magnitude, maxMagnitude, stdDev, percentOutsideDeadzone, verdict, suggestedDeadzone };
}

export interface CircularityResult {
  minRadius: number;
  maxRadius: number;
  meanRadius: number;
  /** How far min/max radius spread from the mean, as a percent: 0 is a perfect circle. */
  errorPercent: number;
}

/**
 * Analyzes samples collected while the user rotates a stick through its full
 * range of motion. A healthy stick traces a circle of roughly constant
 * radius; a worn or poorly calibrated one traces an oval or lopsided shape.
 */
export function circularityTest(samples: StickSample[]): CircularityResult {
  if (samples.length === 0) {
    return { minRadius: 0, maxRadius: 0, meanRadius: 0, errorPercent: 0 };
  }
  const radii = samples.map((s) => Math.hypot(s.x, s.y));
  const minRadius = Math.min(...radii);
  const maxRadius = Math.max(...radii);
  const meanRadius = radii.reduce((sum, r) => sum + r, 0) / radii.length;
  const errorPercent = meanRadius === 0 ? 0 : ((maxRadius - minRadius) / meanRadius) * 100;
  return { minRadius, maxRadius, meanRadius, errorPercent };
}

/** One button transition, or a device connect/disconnect, logged with a timestamp. */
export interface SessionEvent {
  type: "buttondown" | "buttonup" | "connect" | "disconnect";
  index?: number;
  t: number;
}

/** Labeled, copyable summary of a button-log session. */
export function summarizeSession(events: SessionEvent[]): Record<string, string> {
  if (events.length === 0) {
    return {
      "Total presses": "0",
      "Distinct buttons pressed": "0",
      "Connect events": "0",
      "Disconnect events": "0",
      "Session length": "0ms",
    };
  }
  const presses = events.filter((e) => e.type === "buttondown");
  const distinct = new Set(presses.map((e) => e.index)).size;
  const connects = events.filter((e) => e.type === "connect").length;
  const disconnects = events.filter((e) => e.type === "disconnect").length;
  const times = events.map((e) => e.t);
  const length = Math.max(...times) - Math.min(...times);
  return {
    "Total presses": String(presses.length),
    "Distinct buttons pressed": String(distinct),
    "Connect events": String(connects),
    "Disconnect events": String(disconnects),
    "Session length": `${Math.round(length)}ms`,
  };
}

/** Minimal shape needed to report on vibration/haptics support. */
export interface VibrationLike {
  vibrationActuator?: { type?: string } | null;
  hapticActuators?: unknown[] | null;
}

/** Describes whether the controller reports rumble or haptic actuator support. */
export function vibrationSupport(gp: VibrationLike): string {
  if (gp.vibrationActuator && typeof gp.vibrationActuator.type === "string" && gp.vibrationActuator.type) {
    return `Supported (${gp.vibrationActuator.type})`;
  }
  if (Array.isArray(gp.hapticActuators) && gp.hapticActuators.length > 0) {
    const n = gp.hapticActuators.length;
    return `Supported (${n} haptic actuator${n === 1 ? "" : "s"})`;
  }
  return "Not supported by this browser or controller";
}

function normalizeStickSamples(raw: unknown[]): StickSample[] {
  const out: StickSample[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== "object" || item === null) return;
    const s = item as Record<string, unknown>;
    const x = typeof s.x === "number" && Number.isFinite(s.x) ? s.x : null;
    const y = typeof s.y === "number" && Number.isFinite(s.y) ? s.y : null;
    if (x === null || y === null) return;
    const t = typeof s.t === "number" && Number.isFinite(s.t) ? s.t : i;
    out.push({ t, x, y });
  });
  return out;
}

function normalizeSessionEvents(raw: unknown[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== "object" || item === null) return;
    const e = item as Record<string, unknown>;
    const type = e.type;
    if (type !== "buttondown" && type !== "buttonup" && type !== "connect" && type !== "disconnect") return;
    const t = typeof e.t === "number" && Number.isFinite(e.t) ? e.t : i;
    const index = typeof e.index === "number" && Number.isFinite(e.index) ? e.index : undefined;
    out.push({ type, t, index });
  });
  return out;
}

export interface GamepadTesterOptions {
  /** Ignore analog movement below this magnitude when judging drift. */
  deadzone?: number;
  /** "auto" detects the vendor from the reported id; otherwise forces a label set. */
  labels?: "auto" | VendorId;
  [key: string]: unknown;
}

const SAMPLE =
  '{"gamepad":{"id":"Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)","mapping":"standard","buttons":17,"axes":4}}';

export function run(input: string, opts: GamepadTesterOptions = {}): Record<string, string> {
  const raw = (input ?? "").trim();

  if (!raw) {
    return {
      Status: "No controller connected yet",
      Instructions:
        "Connect a gamepad or controller, then press any button or move a stick on it. Browsers only expose a connected controller to a page after you interact with it, so nothing will appear here until you do.",
      "Next steps":
        "Once the panel detects your controller, hold each stick at rest for a few seconds to run the drift test, then rotate each stick through a full circle for the circularity test.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "bad-json",
      "Could not parse input as JSON.",
      `Provide a JSON gamepad report, e.g. ${SAMPLE}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("gamepad" in parsed)) {
    throw new ToolError(
      "not-a-report",
      "Expected a JSON object with a gamepad field.",
      `Provide a JSON gamepad report, e.g. ${SAMPLE}`,
    );
  }

  const body = parsed as {
    gamepad: unknown;
    driftSamples?: unknown;
    circularity?: unknown;
    buttonEvents?: unknown;
  };

  if (typeof body.gamepad !== "object" || body.gamepad === null || Array.isArray(body.gamepad)) {
    throw new ToolError(
      "not-a-report",
      "The gamepad field must be an object with id, buttons, and axes.",
      `Provide a JSON gamepad report, e.g. ${SAMPLE}`,
    );
  }

  const g = body.gamepad as Record<string, unknown>;
  const id = typeof g.id === "string" ? g.id : "";
  const buttonsCount = typeof g.buttons === "number" ? g.buttons : NaN;
  const axesCount = typeof g.axes === "number" ? g.axes : NaN;
  if (!id || !Number.isFinite(buttonsCount) || !Number.isFinite(axesCount)) {
    throw new ToolError(
      "not-a-report",
      "The gamepad field is missing id, buttons, or axes.",
      `Provide a JSON gamepad report, e.g. ${SAMPLE}`,
    );
  }

  const labelsOpt = opts.labels ?? "auto";
  const vendor: VendorId = labelsOpt === "auto" ? detectVendor(id) : labelsOpt;
  const mapping = typeof g.mapping === "string" ? g.mapping : "";

  const rows: Record<string, string> = describeGamepad(
    { id, mapping, buttons: buttonsCount, axes: axesCount },
    vendor,
  );

  if (Array.isArray(g.pressed) && g.pressed.length > 0) {
    const states = (g.pressed as unknown[]).filter(
      (b): b is ButtonState => typeof b === "object" && b !== null && typeof (b as ButtonState).index === "number",
    );
    const buttonRows = describeButtons(states, vendor);
    for (const [label, state] of Object.entries(buttonRows)) rows[`Button ${label}`] = state;
  }

  if (Array.isArray(g.axesValues) && g.axesValues.length > 0) {
    (g.axesValues as unknown[]).forEach((v, i) => {
      if (typeof v === "number" && Number.isFinite(v)) rows[`Axis ${axisLabel(vendor, i)}`] = v.toFixed(3);
    });
  }

  rows.Vibration = vibrationSupport({
    vibrationActuator: (g.vibrationActuator as { type?: string } | null | undefined) ?? null,
    hapticActuators: (g.hapticActuators as unknown[] | null | undefined) ?? null,
  });

  if (g.triggerSamples && typeof g.triggerSamples === "object" && !Array.isArray(g.triggerSamples)) {
    for (const [idx, values] of Object.entries(g.triggerSamples as Record<string, unknown>)) {
      if (!Array.isArray(values)) continue;
      const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (nums.length === 0) continue;
      const label = buttonLabel(vendor, Number(idx));
      const tr = triggerRange(nums);
      rows[`Trigger range: ${label}`] =
        `${tr.min.toFixed(2)} to ${tr.max.toFixed(2)} (reaches zero: ${tr.reachesZero ? "yes" : "no"}, reaches full: ${tr.reachesFull ? "yes" : "no"})`;
    }
  }

  const deadzone = typeof opts.deadzone === "number" && Number.isFinite(opts.deadzone) ? opts.deadzone : 0.05;

  if (Array.isArray(body.driftSamples) && body.driftSamples.length > 0) {
    const samples = normalizeStickSamples(body.driftSamples as unknown[]);
    if (samples.length > 0) {
      const drift = analyzeDrift(samples, { deadzone });
      rows["Drift: mean offset"] = `x=${drift.meanX.toFixed(4)}, y=${drift.meanY.toFixed(4)}`;
      rows["Drift: magnitude"] = drift.magnitude.toFixed(4);
      rows["Drift: max magnitude"] = drift.maxMagnitude.toFixed(4);
      rows["Drift: std deviation"] = drift.stdDev.toFixed(4);
      rows["Drift: percent outside deadzone"] = `${drift.percentOutsideDeadzone.toFixed(1)}%`;
      rows["Drift: verdict"] = drift.verdict;
      rows["Drift: suggested deadzone"] = drift.suggestedDeadzone.toFixed(2);
    }
  }

  if (Array.isArray(body.circularity) && body.circularity.length > 0) {
    const samples = normalizeStickSamples(body.circularity as unknown[]);
    if (samples.length > 0) {
      const circ = circularityTest(samples);
      rows["Circularity: min radius"] = circ.minRadius.toFixed(3);
      rows["Circularity: max radius"] = circ.maxRadius.toFixed(3);
      rows["Circularity: mean radius"] = circ.meanRadius.toFixed(3);
      rows["Circularity: error"] = `${circ.errorPercent.toFixed(1)}%`;
    }
  }

  if (Array.isArray(body.buttonEvents) && body.buttonEvents.length > 0) {
    const events = normalizeSessionEvents(body.buttonEvents as unknown[]);
    if (events.length > 0) {
      const session = summarizeSession(events);
      for (const [label, value] of Object.entries(session)) rows[`Session: ${label}`] = value;
    }
  }

  return rows;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, GamepadTesterOptions>;
