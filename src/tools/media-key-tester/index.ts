import { ToolError, type ToolLogic } from "../types";

/**
 * Media Key Tester checks whether hardware media keys (play/pause, track
 * skip, volume, headset buttons) reach this page through the Media Session
 * API, through raw KeyboardEvents, or not at all. The (not yet built) custom
 * panel plays a silent looping audio element so the OS assigns the page a
 * media session, registers a try/catch-wrapped setActionHandler for every
 * action in MEDIA_ACTIONS, sets session metadata so the OS overlay shows the
 * page, and listens for keydown on the keys in KEYBOARD_MEDIA_KEYS. It then
 * serializes what happened to { caps, events } and hands the JSON string to
 * run(). This file never touches navigator/window/DOM (rule 27): it only
 * knows the shape of values the panel promises to send.
 */

/** One MediaSessionAction the panel is expected to register a handler for. */
export interface MediaActionSpec {
  /** The MediaSessionAction string passed to navigator.mediaSession.setActionHandler. */
  action: string;
  label: string;
  /** What hardware key or OS control typically triggers this action. */
  keyHint: string;
  /** True for actions with spotty real-world browser support. */
  mayBeUnsupported?: boolean;
}

/** Every MediaSessionAction the panel should attempt to register, in registration order. */
export const MEDIA_ACTIONS: MediaActionSpec[] = [
  { action: "play", label: "Play", keyHint: "Play/Pause media key, or the OS overlay's play button." },
  { action: "pause", label: "Pause", keyHint: "Play/Pause media key, or the OS overlay's pause button." },
  { action: "stop", label: "Stop", keyHint: "Stop media key (rare on modern keyboards)." },
  {
    action: "seekbackward",
    label: "Seek backward",
    keyHint: "Rewind key, or holding the previous-track button.",
  },
  {
    action: "seekforward",
    label: "Seek forward",
    keyHint: "Fast-forward key, or holding the next-track button.",
  },
  { action: "seekto", label: "Seek to", keyHint: "Dragging the OS media overlay's progress bar." },
  { action: "previoustrack", label: "Previous track", keyHint: "Previous track media key." },
  { action: "nexttrack", label: "Next track", keyHint: "Next track media key." },
  {
    action: "skipad",
    label: "Skip ad",
    keyHint: "A skip-ad control in a supporting app's OS overlay.",
    mayBeUnsupported: true,
  },
  {
    action: "togglemicrophone",
    label: "Toggle microphone",
    keyHint: "The mute-mic control in a video call's OS overlay.",
    mayBeUnsupported: true,
  },
  {
    action: "togglecamera",
    label: "Toggle camera",
    keyHint: "The camera control in a video call's OS overlay.",
    mayBeUnsupported: true,
  },
  {
    action: "hangup",
    label: "Hang up",
    keyHint: "The hang-up control in a video call's OS overlay.",
    mayBeUnsupported: true,
  },
  {
    action: "previousslide",
    label: "Previous slide",
    keyHint: "The back button on a presentation remote.",
    mayBeUnsupported: true,
  },
  {
    action: "nextslide",
    label: "Next slide",
    keyHint: "The forward button on a presentation remote.",
    mayBeUnsupported: true,
  },
  {
    action: "enterpictureinpicture",
    label: "Enter picture in picture",
    keyHint: "The picture-in-picture control in the OS media overlay.",
    mayBeUnsupported: true,
  },
];

/** One KeyboardEvent.key value worth listening for as a fallback signal. */
export interface KeyboardMediaKeySpec {
  /** The exact KeyboardEvent.key string. */
  key: string;
  label: string;
}

/** Keyboard-level media keys the panel listens for, in case Media Session never fires. */
export const KEYBOARD_MEDIA_KEYS: KeyboardMediaKeySpec[] = [
  { key: "MediaPlayPause", label: "Play/Pause" },
  { key: "MediaPlay", label: "Play" },
  { key: "MediaPause", label: "Pause" },
  { key: "MediaStop", label: "Stop" },
  { key: "MediaTrackNext", label: "Next track" },
  { key: "MediaTrackPrevious", label: "Previous track" },
  { key: "AudioVolumeUp", label: "Volume up" },
  { key: "AudioVolumeDown", label: "Volume down" },
  { key: "AudioVolumeMute", label: "Mute" },
];

/** Most operating systems intercept hardware media keys before a web page ever sees a KeyboardEvent for them. */
export const KEYBOARD_KEYS_NOTE =
  "Most operating systems intercept these keys system-wide (to control whatever app is playing audio) before a web page's KeyboardEvent listeners ever run, so several of these may never appear here even on a keyboard that has the keys.";

/** One event the panel observed, either a Media Session action firing or a raw keyboard event. */
export interface MediaKeyEvent {
  source: "mediasession" | "keyboard";
  /** Set when source is "mediasession": the MediaSessionAction that fired. */
  action?: string;
  /** Set when source is "keyboard": KeyboardEvent.key. */
  key?: string;
  /** Set when source is "keyboard": KeyboardEvent.code. */
  code?: string;
  /** Milliseconds since the epoch when the event was observed. */
  timestamp: number;
  /** Extra details the handler received, e.g. seekOffset or seekTime for seek actions. */
  details?: Record<string, unknown>;
}

/** What the panel discovered about Media Session support in this browser. */
export interface MediaSessionCaps {
  mediaSession: boolean;
  /** Actions from MEDIA_ACTIONS that setActionHandler accepted without throwing. */
  supportedActions: string[];
  /** Actions from MEDIA_ACTIONS that setActionHandler rejected (threw, usually TypeError). */
  unsupportedActions: string[];
}

/** Renders one observed event as a single readable log line. */
export function describeEvent(e: MediaKeyEvent): string {
  const ts = new Date(e.timestamp).toISOString();

  if (e.source === "mediasession") {
    const action = e.action || "(unknown action)";
    const details =
      e.details && Object.keys(e.details).length > 0 ? ` ${JSON.stringify(e.details)}` : "";
    return `[${ts}] Media Session action fired: ${action}${details}`;
  }

  const key = e.key || "(unknown key)";
  const code = e.code ? ` (code: ${e.code})` : "";
  return `[${ts}] Keyboard event: key="${key}"${code}`;
}

function sortByTimestamp(events: MediaKeyEvent[]): MediaKeyEvent[] {
  return [...events].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Summarizes an observed event log: which registered actions actually fired,
 * which never did, event counts by source, the first/last event, and a
 * verdict on how (or whether) hardware media keys are reaching the page.
 */
export function summarizeLog(events: MediaKeyEvent[]): Record<string, string> {
  const mediaSessionEvents = events.filter((e) => e.source === "mediasession");
  const keyboardEvents = events.filter((e) => e.source === "keyboard");

  const firedActions = new Set(
    mediaSessionEvents.map((e) => e.action).filter((a): a is string => !!a),
  );
  const neverFired = MEDIA_ACTIONS.map((a) => a.action).filter((a) => !firedActions.has(a));

  const rows: Record<string, string> = {
    "Media Session events": String(mediaSessionEvents.length),
    "Keyboard events": String(keyboardEvents.length),
    "Actions fired": firedActions.size > 0 ? [...firedActions].join(", ") : "none",
    "Handlers that never fired":
      neverFired.length > 0
        ? neverFired.join(", ")
        : "none: every registered handler fired at least once",
  };

  if (events.length > 0) {
    const sorted = sortByTimestamp(events);
    rows["First event"] = describeEvent(sorted[0]);
    rows["Last event"] = describeEvent(sorted[sorted.length - 1]);
  } else {
    rows["First event"] = "(none received)";
    rows["Last event"] = "(none received)";
  }

  let verdict: string;
  if (mediaSessionEvents.length > 0) {
    verdict =
      "Hardware keys reach the page via Media Session: the browser is routing key presses through navigator.mediaSession action handlers, which is the reliable way to build a media integration.";
  } else if (keyboardEvents.length > 0) {
    verdict =
      "Keys reach the page as KeyboardEvents only: Media Session handlers never fired, so this browser or OS is delivering hardware media keys as ordinary key events instead of routing them through the Media Session API.";
  } else {
    verdict =
      "Nothing received: the OS or another app is capturing media keys before they reach this page. Click play first, and close other music or video apps that may be claiming the media session.";
  }
  rows["Verdict"] = verdict;

  return rows;
}

/** Renders what the panel discovered about Media Session support as labeled rows. */
export function describeSupport(caps: MediaSessionCaps): Record<string, string> {
  const total = caps.supportedActions.length + caps.unsupportedActions.length;

  return {
    "Media Session API": caps.mediaSession
      ? "Supported by this browser."
      : "Not supported by this browser: navigator.mediaSession is undefined, so only raw KeyboardEvents can be tested.",
    "Supported actions":
      caps.supportedActions.length > 0 ? caps.supportedActions.join(", ") : "none reported",
    "Unsupported actions":
      caps.unsupportedActions.length > 0 ? caps.unsupportedActions.join(", ") : "none reported",
    "Action coverage":
      total > 0
        ? `${caps.supportedActions.length} of ${total} attempted actions registered successfully.`
        : "No actions were attempted.",
  };
}

function coerceStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function coerceCaps(v: unknown): MediaSessionCaps {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    mediaSession: o.mediaSession === true,
    supportedActions: coerceStringArray(o.supportedActions),
    unsupportedActions: coerceStringArray(o.unsupportedActions),
  };
}

function coerceEvent(v: unknown): MediaKeyEvent {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const source: MediaKeyEvent["source"] = o.source === "keyboard" ? "keyboard" : "mediasession";
  return {
    source,
    action: typeof o.action === "string" ? o.action : undefined,
    key: typeof o.key === "string" ? o.key : undefined,
    code: typeof o.code === "string" ? o.code : undefined,
    timestamp: typeof o.timestamp === "number" && Number.isFinite(o.timestamp) ? o.timestamp : 0,
    details:
      o.details && typeof o.details === "object" && !Array.isArray(o.details)
        ? (o.details as Record<string, unknown>)
        : undefined,
  };
}

function coerceEvents(v: unknown): MediaKeyEvent[] {
  return Array.isArray(v) ? v.map(coerceEvent) : [];
}

export interface MediaKeyTesterOpts {
  [key: string]: unknown;
}

const EMPTY_INPUT_NOTE =
  "The panel plays a silent looping audio clip when you click it, which is what lets the browser assign this page a media session, then registers a handler for every action in MEDIA_ACTIONS and listens for keyboard media-key events. Click play, then press play/pause, stop, track skip, or the volume and headset buttons you want to test, and the results will appear here.";

/**
 * Accepts the JSON string of { caps, events } the custom panel collects and
 * returns the analysis. caps and events are each optional so a report can
 * cover just support detection, just the live event log, or both.
 */
export function run(input: string, _opts: MediaKeyTesterOpts): Record<string, string> {
  const raw = (input ?? "").trim();
  if (!raw) {
    return { Note: EMPTY_INPUT_NOTE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "bad-json",
      "The input is not valid JSON.",
      'Paste the JSON report the panel produces, e.g. {"caps":{...},"events":[...]}.',
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "not-a-report",
      "The JSON is not a media key test report.",
      'Expected an object like {"caps":{"mediaSession":true,...},"events":[...]}.',
    );
  }

  const report = parsed as Record<string, unknown>;
  const hasCaps = "caps" in report && typeof report.caps === "object" && report.caps !== null;
  const hasEvents = Array.isArray(report.events);

  if (!hasCaps && !hasEvents) {
    throw new ToolError(
      "not-a-report",
      'Neither "caps" nor "events" was found in the JSON.',
      "Run the panel's key test first, or paste a JSON object with a caps and/or events field.",
    );
  }

  const rows: Record<string, string> = {};
  if (hasCaps) Object.assign(rows, describeSupport(coerceCaps(report.caps)));
  if (hasEvents) Object.assign(rows, summarizeLog(coerceEvents(report.events)));
  return rows;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, MediaKeyTesterOpts>;
