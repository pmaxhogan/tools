import { ToolError, type ToolLogic } from "../types";

/** Fields we recognize from a serialized KeyboardEvent. Every field is optional. */
export interface KeycodeEvent {
  key?: unknown;
  code?: unknown;
  keyCode?: unknown;
  which?: unknown;
  shiftKey?: unknown;
  ctrlKey?: unknown;
  altKey?: unknown;
  metaKey?: unknown;
  repeat?: unknown;
  location?: unknown;
}

export type KeycodeResult = Record<string, string>;

const SAMPLE =
  '{"key":"k","code":"KeyK","keyCode":75,"which":75,"shiftKey":true,"ctrlKey":true,"altKey":false,"metaKey":false,"repeat":false,"location":0}';

/** Renders the raw `key` field, with a friendly label for the space bar. */
function keyField(key: unknown): string {
  if (typeof key !== "string" || key === "") return "(none)";
  if (key === " ") return "Space (' ')";
  return key;
}

function codeField(code: unknown): string {
  if (typeof code !== "string" || code === "") return "(none)";
  return code;
}

/** `keyCode`/`which` are legacy numeric fields — tolerate missing/non-numeric input. */
function numField(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "(none)";
}

function locationName(loc: unknown): string {
  switch (loc) {
    case 1:
      return "left";
    case 2:
      return "right";
    case 3:
      return "numpad";
    case 0:
    default:
      return "standard";
  }
}

/** Modifiers in a conventional reading order: Ctrl, Alt, Shift, Meta. */
function activeModifiers(ev: KeycodeEvent): string[] {
  const mods: string[] = [];
  if (ev.ctrlKey === true) mods.push("Ctrl");
  if (ev.altKey === true) mods.push("Alt");
  if (ev.shiftKey === true) mods.push("Shift");
  if (ev.metaKey === true) mods.push("Meta");
  return mods;
}

/** Label used in the shortcut-style event summary: single chars uppercase, named keys as-is. */
function summaryKeyLabel(key: unknown): string {
  if (typeof key !== "string" || key === "") return "?";
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function run(input: string, _opts: Record<string, unknown>): KeycodeResult {
  const raw = (input ?? "").trim();
  if (!raw)
    throw new ToolError(
      "empty-input",
      "Enter a keyboard event as JSON.",
      `Provide a JSON object with key/code/modifier fields, e.g. ${SAMPLE}`,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "invalid-json",
      "Could not parse input as JSON.",
      `Provide a valid JSON keyboard event, e.g. ${SAMPLE}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError(
      "invalid-json",
      "Expected a JSON object describing a keyboard event.",
      `Provide a valid JSON keyboard event, e.g. ${SAMPLE}`,
    );
  }

  const ev = parsed as KeycodeEvent;
  const mods = activeModifiers(ev);
  const summary = [...mods, summaryKeyLabel(ev.key)].join("+");

  return {
    Key: keyField(ev.key),
    Code: codeField(ev.code),
    "keyCode (deprecated)": numField(ev.keyCode),
    "which (deprecated)": numField(ev.which),
    Modifiers: mods.length ? mods.join(" + ") : "none",
    Location: locationName(ev.location),
    Repeat: ev.repeat === true ? "yes" : "no",
    "Event summary": summary,
  };
}

export default { run } satisfies ToolLogic<string, KeycodeResult, Record<string, unknown>>;
