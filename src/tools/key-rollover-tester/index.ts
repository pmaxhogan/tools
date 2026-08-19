import { ToolError, type ToolLogic } from "../types";

/**
 * One key on the visual layout. `code` is a `KeyboardEvent.code` value, or
 * `null` for a blank spacer used to align adjacent key blocks (function-key
 * gaps, the navigation/numpad clusters). `width` is in key units where 1 is
 * one standard keycap.
 */
export interface KeyLayoutKey {
  code: string | null;
  label: string;
  width: number;
}

export type KeyLayoutRow = KeyLayoutKey[];

function key(code: string, label: string, width = 1): KeyLayoutKey {
  return { code, label, width };
}

function gap(width: number): KeyLayoutKey {
  return { code: null, label: "", width };
}

/**
 * A visual ANSI 104-key layout (full size, with numpad) for the panel to
 * draw. Every non-spacer key carries the `KeyboardEvent.code` it reports so
 * the panel can light it up on keydown/keyup. Row order is top to bottom,
 * left to right; widths approximate a real keyboard, not pixel-exact.
 */
export const KEY_LAYOUT: KeyLayoutRow[] = [
  [
    key("Escape", "Esc"),
    gap(1),
    key("F1", "F1"),
    key("F2", "F2"),
    key("F3", "F3"),
    key("F4", "F4"),
    gap(0.5),
    key("F5", "F5"),
    key("F6", "F6"),
    key("F7", "F7"),
    key("F8", "F8"),
    gap(0.5),
    key("F9", "F9"),
    key("F10", "F10"),
    key("F11", "F11"),
    key("F12", "F12"),
    gap(0.5),
    key("PrintScreen", "PrtSc"),
    key("ScrollLock", "ScrLk"),
    key("Pause", "Pause"),
  ],
  [
    key("Backquote", "`"),
    key("Digit1", "1"),
    key("Digit2", "2"),
    key("Digit3", "3"),
    key("Digit4", "4"),
    key("Digit5", "5"),
    key("Digit6", "6"),
    key("Digit7", "7"),
    key("Digit8", "8"),
    key("Digit9", "9"),
    key("Digit0", "0"),
    key("Minus", "-"),
    key("Equal", "="),
    key("Backspace", "Backspace", 2),
    gap(0.5),
    key("Insert", "Ins"),
    key("Home", "Home"),
    key("PageUp", "PgUp"),
    gap(0.5),
    key("NumLock", "Num"),
    key("NumpadDivide", "/"),
    key("NumpadMultiply", "*"),
    key("NumpadSubtract", "-"),
  ],
  [
    key("Tab", "Tab", 1.5),
    key("KeyQ", "Q"),
    key("KeyW", "W"),
    key("KeyE", "E"),
    key("KeyR", "R"),
    key("KeyT", "T"),
    key("KeyY", "Y"),
    key("KeyU", "U"),
    key("KeyI", "I"),
    key("KeyO", "O"),
    key("KeyP", "P"),
    key("BracketLeft", "["),
    key("BracketRight", "]"),
    key("Backslash", "\\", 1.5),
    gap(0.5),
    key("Delete", "Del"),
    key("End", "End"),
    key("PageDown", "PgDn"),
    gap(0.5),
    key("Numpad7", "7"),
    key("Numpad8", "8"),
    key("Numpad9", "9"),
    key("NumpadAdd", "+"),
  ],
  [
    key("CapsLock", "Caps", 1.75),
    key("KeyA", "A"),
    key("KeyS", "S"),
    key("KeyD", "D"),
    key("KeyF", "F"),
    key("KeyG", "G"),
    key("KeyH", "H"),
    key("KeyJ", "J"),
    key("KeyK", "K"),
    key("KeyL", "L"),
    key("Semicolon", ";"),
    key("Quote", "'"),
    key("Enter", "Enter", 2.25),
    gap(4),
    key("Numpad4", "4"),
    key("Numpad5", "5"),
    key("Numpad6", "6"),
  ],
  [
    key("ShiftLeft", "Shift", 2.25),
    key("KeyZ", "Z"),
    key("KeyX", "X"),
    key("KeyC", "C"),
    key("KeyV", "V"),
    key("KeyB", "B"),
    key("KeyN", "N"),
    key("KeyM", "M"),
    key("Comma", ","),
    key("Period", "."),
    key("Slash", "/"),
    key("ShiftRight", "Shift", 2.75),
    gap(1),
    key("ArrowUp", "Up"),
    gap(1),
    key("Numpad1", "1"),
    key("Numpad2", "2"),
    key("Numpad3", "3"),
    key("NumpadEnter", "Enter"),
  ],
  [
    key("ControlLeft", "Ctrl", 1.25),
    key("MetaLeft", "Win", 1.25),
    key("AltLeft", "Alt", 1.25),
    key("Space", "Space", 6.25),
    key("AltRight", "Alt", 1.25),
    key("MetaRight", "Win", 1.25),
    key("ContextMenu", "Menu", 1.25),
    key("ControlRight", "Ctrl", 1.25),
    gap(0.5),
    key("ArrowLeft", "Left"),
    key("ArrowDown", "Down"),
    key("ArrowRight", "Right"),
    gap(0.5),
    key("Numpad0", "0", 2),
    key("NumpadDecimal", "."),
  ],
];

/** A single keydown/keyup as reported by the panel's live listeners. */
export interface RolloverEvent {
  type: "keydown" | "keyup";
  code: string;
  key: string;
  /** ms timestamp from the source event; kept for panel/UI use, not read here. */
  timestamp: number;
}

/** Immutable tracker for a rollover test session. */
export interface RolloverState {
  /** Codes currently held, in the order they were pressed. */
  heldOrder: string[];
  /** code -> `key` label, for currently held keys. */
  heldKeys: Record<string, string>;
  /** Highest number of simultaneously held keys ever observed. */
  maxSimultaneous: number;
  /** Key labels, in press order, of the largest chord observed. */
  maxChordKeys: string[];
  /** Total keydown presses recorded (auto-repeat while already held does not recount). */
  totalPresses: number;
  /** code -> number of keydown presses for that code. */
  pressCounts: Record<string, number>;
}

/** A fresh session with nothing pressed yet. */
export const initialState: RolloverState = {
  heldOrder: [],
  heldKeys: {},
  maxSimultaneous: 0,
  maxChordKeys: [],
  totalPresses: 0,
  pressCounts: {},
};

/**
 * Folds one keydown/keyup into the state, returning a new state (the input
 * is never mutated). A keydown for a code already held is treated as
 * browser auto-repeat and is a no-op. A keyup for a code that is not held
 * (missed keydown, or a key that was already released) is tolerated as a
 * no-op rather than throwing.
 */
export function recordEvent(state: RolloverState, ev: RolloverEvent): RolloverState {
  const alreadyHeld = state.heldOrder.includes(ev.code);

  if (ev.type === "keydown") {
    if (alreadyHeld) return state;

    const heldOrder = [...state.heldOrder, ev.code];
    const heldKeys = { ...state.heldKeys, [ev.code]: ev.key };
    const pressCounts = { ...state.pressCounts, [ev.code]: (state.pressCounts[ev.code] ?? 0) + 1 };
    const totalPresses = state.totalPresses + 1;
    const simultaneous = heldOrder.length;

    const grew = simultaneous > state.maxSimultaneous;
    return {
      heldOrder,
      heldKeys,
      pressCounts,
      totalPresses,
      maxSimultaneous: grew ? simultaneous : state.maxSimultaneous,
      maxChordKeys: grew ? heldOrder.map((code) => heldKeys[code]) : state.maxChordKeys,
    };
  }

  // keyup
  if (!alreadyHeld) return state;

  const heldOrder = state.heldOrder.filter((code) => code !== ev.code);
  const heldKeys = { ...state.heldKeys };
  delete heldKeys[ev.code];
  return { ...state, heldOrder, heldKeys };
}

/** The highest number of keys ever held down at once in this session. */
export function maxRollover(state: RolloverState): number {
  return state.maxSimultaneous;
}

/**
 * We cannot detect ghosting from here: a keydown event only fires for keys
 * the keyboard and OS actually report, so a phantom key that lights up
 * without a physical press is indistinguishable, from JavaScript, from a
 * real press. This is guidance text for the panel to display, not a
 * detector: watch the live diagram while holding several keys instead.
 */
export const GHOSTING_GUIDANCE =
  "Ghosting is a key appearing to activate when you did not press it, usually because the keyboard's internal wiring matrix cannot tell that combination of physically held keys apart from a different one that includes it. Blocking is the opposite: a key you are pressing simply never registers. Watch the diagram while holding several keys at once. A key lighting up that you are not touching is ghosting. A key that stays dark no matter how hard you press it is blocking.";

/** 1-2 held: 2KRO or blocked. 3-5: limited. 6: USB boot protocol. 7+: NKRO. */
export function classifyRollover(max: number): string {
  if (max >= 7) return "NKRO";
  if (max === 6) return "6KRO (USB boot protocol)";
  if (max >= 3) return "limited";
  if (max >= 1) return "2KRO or blocked";
  return "No keys pressed yet";
}

/** Labeled, copyable summary rows for the current session. */
export function summarize(state: RolloverState): Record<string, string> {
  const heldNow = state.heldOrder.map((code) => state.heldKeys[code]);
  return {
    "Max simultaneous": String(state.maxSimultaneous),
    "Held now": heldNow.length ? heldNow.join(" + ") : "none",
    "Total presses": String(state.totalPresses),
    "Distinct keys pressed": String(Object.keys(state.pressCounts).length),
    Verdict: classifyRollover(state.maxSimultaneous),
    "Largest chord press order": state.maxChordKeys.length ? state.maxChordKeys.join(" then ") : "none",
  };
}

function normalizeEvent(raw: unknown, index: number): RolloverEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const type = e.type === "keydown" || e.type === "keyup" ? e.type : null;
  const code = typeof e.code === "string" && e.code !== "" ? e.code : null;
  if (!type || !code) return null;
  const eventKey = typeof e.key === "string" && e.key !== "" ? e.key : code;
  const timestamp = typeof e.timestamp === "number" && Number.isFinite(e.timestamp) ? e.timestamp : index;
  return { type, code, key: eventKey, timestamp };
}

const SAMPLE = '{"events":[{"type":"keydown","code":"KeyA","key":"a","timestamp":0}]}';

export function run(input: string, _opts: Record<string, unknown>): Record<string, string> {
  const raw = (input ?? "").trim();

  if (!raw) {
    return {
      Instructions: "Press as many keys as you can at once. The verdict updates live.",
      Note: "Your browser and operating system swallow some combinations before this page ever sees them, such as Win+L, Alt+Tab, and Ctrl+Alt+Delete. Those will never register here, even on a full NKRO keyboard.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "bad-json",
      "Could not parse input as JSON.",
      `Provide a JSON object with an events array, e.g. ${SAMPLE}`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("events" in (parsed as Record<string, unknown>))
  ) {
    throw new ToolError(
      "bad-json",
      "Expected a JSON object with an events array.",
      `Provide a JSON object with an events array, e.g. ${SAMPLE}`,
    );
  }

  const events = (parsed as { events: unknown }).events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new ToolError(
      "not-a-report",
      "No key events were recorded.",
      "Press some keys in the panel first, then run the report.",
    );
  }

  let state = initialState;
  events.forEach((rawEvent, index) => {
    const ev = normalizeEvent(rawEvent, index);
    if (ev) state = recordEvent(state, ev);
  });

  return summarize(state);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Record<string, unknown>>;
