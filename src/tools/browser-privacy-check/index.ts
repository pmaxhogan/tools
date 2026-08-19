import { ToolError, type ToolLogic } from "../types";
import { formatBytes } from "../../lib/format";

/**
 * Browser Privacy Check analyzes a fingerprint probe report gathered by the
 * (not yet built) custom panel. The panel runs each probe in PROBES against
 * the real browser (navigator, screen, canvas, webgl, webrtc, permissions,
 * ...), serializes the results to { probeId: value }, and hands the JSON
 * string to run(). This file never touches the DOM itself (rule 27): it only
 * knows the shape of values the panel promises to send.
 */

export type ProbeCategory =
  | "Identity"
  | "Locale"
  | "Display"
  | "Hardware"
  | "Privacy signals"
  | "Storage"
  | "Automation"
  | "Fingerprinting"
  | "Network"
  | "Preferences";

export interface ProbeSpec {
  /** Key the panel writes into the report object. */
  id: string;
  /** Short human label for this row. */
  label: string;
  category: ProbeCategory;
  /** What the panel should measure and how, shown to whoever builds the panel. */
  hint: string;
}

/**
 * The full probe list the custom panel is expected to implement. Order here
 * is the order rows render in.
 */
export const PROBES: ProbeSpec[] = [
  {
    id: "userAgent",
    label: "User agent string",
    category: "Identity",
    hint: "navigator.userAgent, verbatim.",
  },
  {
    id: "uaData",
    label: "Client hints (brands / platform)",
    category: "Identity",
    hint: "navigator.userAgentData: { brands: {brand,version}[], platform, mobile }.",
  },
  {
    id: "language",
    label: "Language",
    category: "Locale",
    hint: "{ language: navigator.language, languages: [...navigator.languages] }.",
  },
  {
    id: "timezone",
    label: "Time zone",
    category: "Locale",
    hint: "Intl.DateTimeFormat().resolvedOptions().timeZone, as an IANA name.",
  },
  {
    id: "screen",
    label: "Screen",
    category: "Display",
    hint: "{ width: screen.width, height: screen.height, colorDepth: screen.colorDepth, pixelRatio: devicePixelRatio }.",
  },
  {
    id: "hardwareConcurrency",
    label: "CPU cores reported",
    category: "Hardware",
    hint: "navigator.hardwareConcurrency.",
  },
  {
    id: "deviceMemory",
    label: "Device memory reported",
    category: "Hardware",
    hint: "navigator.deviceMemory, in gigabytes (Chromium only).",
  },
  {
    id: "maxTouchPoints",
    label: "Max touch points",
    category: "Hardware",
    hint: "navigator.maxTouchPoints.",
  },
  {
    id: "cookieEnabled",
    label: "Cookies enabled",
    category: "Privacy signals",
    hint: "navigator.cookieEnabled.",
  },
  {
    id: "doNotTrack",
    label: "Do Not Track",
    category: "Privacy signals",
    hint: 'navigator.doNotTrack, as sent ("1", "0", "unspecified", or null).',
  },
  {
    id: "globalPrivacyControl",
    label: "Global Privacy Control",
    category: "Privacy signals",
    hint: "navigator.globalPrivacyControl, boolean.",
  },
  {
    id: "storageEstimate",
    label: "Storage estimate",
    category: "Storage",
    hint: "navigator.storage.estimate(): { usage, quota } in bytes.",
  },
  {
    id: "webdriver",
    label: "Automation (webdriver) flag",
    category: "Automation",
    hint: "navigator.webdriver, boolean.",
  },
  {
    id: "plugins",
    label: "Plugins / MIME types",
    category: "Fingerprinting",
    hint: "{ plugins: navigator.plugins.length, mimeTypes: navigator.mimeTypes.length }.",
  },
  {
    id: "canvasHash",
    label: "Canvas fingerprint",
    category: "Fingerprinting",
    hint: "Short hash of pixel data from a standard 2D canvas text/shape draw.",
  },
  {
    id: "webglRenderer",
    label: "WebGL renderer",
    category: "Fingerprinting",
    hint: "{ vendor, renderer } read via the WEBGL_debug_renderer_info extension (UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL).",
  },
  {
    id: "audioSampleRate",
    label: "Audio context sample rate",
    category: "Fingerprinting",
    hint: "new AudioContext().sampleRate, in Hz.",
  },
  {
    id: "fontsCount",
    label: "Fonts detected",
    category: "Fingerprinting",
    hint: "Count of fonts from a fixed reference list found by measuring text width deltas against fallback fonts.",
  },
  {
    id: "batteryApi",
    label: "Battery API availability",
    category: "Hardware",
    hint: "Whether navigator.getBattery exists.",
  },
  {
    id: "webrtcLeak",
    label: "WebRTC local IP leak",
    category: "Network",
    hint: "Whether an RTCPeerConnection host ICE candidate exposed a private (RFC 1918 / link local) IP address.",
  },
  {
    id: "permissionNotifications",
    label: "Notifications permission",
    category: "Privacy signals",
    hint: 'navigator.permissions.query({name:"notifications"}).state.',
  },
  {
    id: "permissionGeolocation",
    label: "Geolocation permission",
    category: "Privacy signals",
    hint: 'navigator.permissions.query({name:"geolocation"}).state.',
  },
  {
    id: "prefersColorScheme",
    label: "Prefers color scheme",
    category: "Preferences",
    hint: 'matchMedia("(prefers-color-scheme: dark)"), resolved to "dark" / "light" / "no-preference".',
  },
  {
    id: "prefersReducedMotion",
    label: "Prefers reduced motion",
    category: "Preferences",
    hint: 'matchMedia("(prefers-reduced-motion: reduce)").matches.',
  },
];

const PROBES_BY_ID = new Map(PROBES.map((p) => [p.id, p]));

/**
 * Rough entropy weight per probe, in bits, loosely based on published
 * fingerprinting studies (Panopticlick / AmIUnique style surveys). These are
 * estimates for relative ranking, not measurements of any real population.
 */
const ENTROPY_BITS: Record<string, number> = {
  userAgent: 8,
  uaData: 4,
  language: 2,
  timezone: 3,
  screen: 5,
  hardwareConcurrency: 2,
  deviceMemory: 2,
  maxTouchPoints: 1,
  cookieEnabled: 1,
  doNotTrack: 1,
  globalPrivacyControl: 1,
  storageEstimate: 3,
  webdriver: 1,
  plugins: 2,
  canvasHash: 10,
  webglRenderer: 8,
  audioSampleRate: 1,
  fontsCount: 7,
  batteryApi: 1,
  webrtcLeak: 2,
  permissionNotifications: 1,
  permissionGeolocation: 1,
  prefersColorScheme: 1,
  prefersReducedMotion: 1,
};

/** Total bits if every probe in PROBES were collected. */
export const MAX_ENTROPY_BITS = PROBES.reduce((sum, p) => sum + (ENTROPY_BITS[p.id] ?? 0), 0);

export type FingerprintClass = "low" | "moderate" | "high";

function classify(bits: number): FingerprintClass {
  if (bits > 30) return "high";
  if (bits >= 15) return "moderate";
  return "low";
}

/* ------------------------------------------------------------------ *
 * value shapes the panel is expected to send
 * ------------------------------------------------------------------ */

interface UaDataValue {
  brands?: { brand: string; version: string }[];
  platform?: string;
  mobile?: boolean;
}

interface LanguageValue {
  language?: string;
  languages?: string[];
}

interface ScreenValue {
  width?: number;
  height?: number;
  colorDepth?: number;
  pixelRatio?: number;
}

interface StorageEstimateValue {
  usage?: number;
  quota?: number;
}

interface PluginsValue {
  plugins?: number;
  mimeTypes?: number;
}

interface WebglRendererValue {
  vendor?: string;
  renderer?: string;
}

/* ------------------------------------------------------------------ *
 * per-probe plain-English descriptions
 * ------------------------------------------------------------------ */

const NOT_COLLECTED = "Not collected.";

function describe(id: string, value: unknown): string {
  switch (id) {
    case "userAgent": {
      const ua = String(value);
      return ua ? `Sends the full string "${ua}" on every request.` : NOT_COLLECTED;
    }

    case "uaData": {
      const v = (value ?? {}) as UaDataValue;
      const brands = (v.brands ?? []).map((b) => `${b.brand} ${b.version}`).join(", ");
      const parts: string[] = [];
      if (brands) parts.push(`brands ${brands}`);
      if (v.platform) parts.push(`platform ${v.platform}`);
      if (typeof v.mobile === "boolean") parts.push(v.mobile ? "mobile" : "not mobile");
      return parts.length
        ? `Reports ${parts.join(", ")} through the Client Hints API.`
        : "Client Hints API not supported by this browser.";
    }

    case "language": {
      const v = (value ?? {}) as LanguageValue;
      if (!v.language) return NOT_COLLECTED;
      const rest = (v.languages ?? []).filter((l) => l !== v.language);
      return rest.length
        ? `Preferred language is ${v.language}, with ${rest.join(", ")} also accepted.`
        : `Preferred language is ${v.language}.`;
    }

    case "timezone": {
      const tz = value ? String(value) : "";
      return tz
        ? `Reports the ${tz} time zone, which narrows down your rough geographic region.`
        : NOT_COLLECTED;
    }

    case "screen": {
      const v = (value ?? {}) as ScreenValue;
      if (v.width == null || v.height == null) return NOT_COLLECTED;
      const depth = v.colorDepth != null ? `, ${v.colorDepth}-bit color` : "";
      const ratio = v.pixelRatio != null ? `, device pixel ratio ${v.pixelRatio}` : "";
      return `${v.width}x${v.height}${depth}${ratio}.`;
    }

    case "hardwareConcurrency": {
      if (value == null) return NOT_COLLECTED;
      return `Reports ${value} logical CPU cores.`;
    }

    case "deviceMemory": {
      if (value == null) return NOT_COLLECTED;
      return `Reports approximately ${value} GB of device memory.`;
    }

    case "maxTouchPoints": {
      if (value == null) return NOT_COLLECTED;
      const n = Number(value);
      return n > 0
        ? `Supports up to ${n} simultaneous touch points, indicating a touchscreen.`
        : "Reports no touch points, indicating a mouse and keyboard device.";
    }

    case "cookieEnabled": {
      if (value == null) return NOT_COLLECTED;
      return value ? "Cookies are enabled." : "Cookies are disabled.";
    }

    case "doNotTrack": {
      if (value == null || value === "unspecified") return "Not sent (no preference expressed).";
      const on = value === "1" || value === true || value === "yes";
      return on
        ? "Do Not Track is turned on."
        : "Do Not Track is explicitly turned off.";
    }

    case "globalPrivacyControl": {
      if (value == null) return "Not sent (no preference expressed).";
      return value ? "Global Privacy Control is turned on." : "Global Privacy Control is off.";
    }

    case "storageEstimate": {
      const v = (value ?? {}) as StorageEstimateValue;
      if (v.usage == null || v.quota == null) return NOT_COLLECTED;
      return `Using ${formatBytes(v.usage)} of an estimated ${formatBytes(v.quota)} quota for this site.`;
    }

    case "webdriver": {
      if (value == null) return NOT_COLLECTED;
      return value
        ? "navigator.webdriver is true, meaning the browser is under automation control."
        : "navigator.webdriver is false; no automation flag set.";
    }

    case "plugins": {
      const v = (value ?? {}) as PluginsValue;
      if (v.plugins == null && v.mimeTypes == null) return NOT_COLLECTED;
      return `Reports ${v.plugins ?? 0} plugins and ${v.mimeTypes ?? 0} MIME types.`;
    }

    case "canvasHash": {
      const hash = value ? String(value) : "";
      return hash
        ? `Canvas draw hashes to ${hash}, one of the strongest fingerprint signals available.`
        : NOT_COLLECTED;
    }

    case "webglRenderer": {
      const v = (value ?? {}) as WebglRendererValue;
      if (!v.vendor && !v.renderer) return NOT_COLLECTED;
      return `GPU exposed as vendor "${v.vendor ?? "unknown"}", renderer "${v.renderer ?? "unknown"}".`;
    }

    case "audioSampleRate": {
      if (value == null) return NOT_COLLECTED;
      return `AudioContext reports a ${value} Hz sample rate.`;
    }

    case "fontsCount": {
      if (value == null) return NOT_COLLECTED;
      return `Detected ${value} fonts from the reference list installed on this device.`;
    }

    case "batteryApi": {
      if (value == null) return NOT_COLLECTED;
      return value
        ? "The Battery Status API is available."
        : "The Battery Status API is not available (removed from most browsers).";
    }

    case "webrtcLeak": {
      if (value == null) return NOT_COLLECTED;
      return value
        ? "A WebRTC host candidate exposed a private local IP address."
        : "No private IP address was exposed through WebRTC candidates.";
    }

    case "permissionNotifications": {
      const s = value ? String(value) : "";
      return s ? `Notifications permission state is "${s}".` : NOT_COLLECTED;
    }

    case "permissionGeolocation": {
      const s = value ? String(value) : "";
      return s ? `Geolocation permission state is "${s}".` : NOT_COLLECTED;
    }

    case "prefersColorScheme": {
      const s = value ? String(value) : "";
      return s ? `Prefers a ${s} color scheme.` : NOT_COLLECTED;
    }

    case "prefersReducedMotion": {
      if (value == null) return NOT_COLLECTED;
      return value ? "Prefers reduced motion." : "Has no reduced-motion preference set.";
    }

    default:
      return NOT_COLLECTED;
  }
}

/* ------------------------------------------------------------------ *
 * analysis
 * ------------------------------------------------------------------ */

/**
 * Analyzes a probe report (already parsed) into labeled rows. Exported
 * separately from run() so callers that already have an object, not a JSON
 * string, can use it directly.
 */
export function analyzeProbes(report: Record<string, unknown>): Record<string, string> {
  const rows: Record<string, string> = {};

  let collectedBits = 0;
  let collectedCount = 0;

  for (const probe of PROBES) {
    const has = Object.prototype.hasOwnProperty.call(report, probe.id);
    const key = `${probe.category}: ${probe.label}`;
    rows[key] = has ? describe(probe.id, report[probe.id]) : NOT_COLLECTED;
    if (has) {
      collectedBits += ENTROPY_BITS[probe.id] ?? 0;
      collectedCount += 1;
    }
  }

  const cls = classify(collectedBits);
  const classLabel = cls === "low" ? "Low" : cls === "moderate" ? "Moderate" : "High";

  rows["Fingerprint surface: probes collected"] = `${collectedCount} of ${PROBES.length} probes.`;
  rows["Fingerprint surface: estimated entropy"] = `${collectedBits} bits (out of a possible ${MAX_ENTROPY_BITS}).`;
  rows["Fingerprint surface: assessment"] =
    `${classLabel} fingerprint surface. This is a rough estimate built from published fingerprinting research, ` +
    "not a measurement of how unique your browser actually is among real visitors; your real uniqueness depends " +
    "on how many other people share every one of these values, which this page cannot know.";

  if (report.webdriver === true) {
    rows["Flag: automation detected"] =
      "The webdriver flag is set, meaning this browser is being driven by automation software such as Selenium or Playwright. Many sites treat this as a bot signal.";
  }

  const dntOn = report.doNotTrack === "1" || report.doNotTrack === true || report.doNotTrack === "yes";
  const gpcOn = report.globalPrivacyControl === true;
  if (dntOn || gpcOn) {
    rows["Flag: privacy signal irony"] =
      "Do Not Track and Global Privacy Control are enabled by only a small share of browsers, so turning them on can make this browser easier to pick out of a crowd even though the intent is more privacy.";
  }

  if (report.webrtcLeak === true) {
    rows["Flag: WebRTC IP leak"] =
      "A WebRTC host candidate exposed a private local IP address. Any site running a WebRTC connection could read your local network address, which a VPN alone does not hide.";
  }

  return rows;
}

export interface PrivacyCheckOpts {
  [key: string]: unknown;
}

/**
 * Accepts the JSON string of { probeId: value } that the custom panel
 * collects, and returns the analysis. Partial reports are fine; unrecognized
 * or missing probe ids are simply reported as not collected.
 */
export function run(input: string, _opts: PrivacyCheckOpts): Record<string, string> {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "No probe report was provided.",
      "Run the probes in the panel first, or paste a JSON object of probe results.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError(
      "bad-json",
      "The input is not valid JSON.",
      "Paste the exact JSON the panel's probe collector produces.",
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "not-a-report",
      "The JSON is not a probe report object.",
      'Expected an object like {"userAgent": "...", "timezone": "..."}.',
    );
  }

  const report = parsed as Record<string, unknown>;
  const recognizedCount = Object.keys(report).filter((k) => PROBES_BY_ID.has(k)).length;
  if (recognizedCount === 0) {
    throw new ToolError(
      "not-a-report",
      "None of the keys in this JSON match a known probe.",
      "Run the panel's probe collector, which fills in ids like userAgent, timezone, and canvasHash.",
    );
  }

  return analyzeProbes(report);
}

export default { run } satisfies ToolLogic<string, Record<string, string>, PrivacyCheckOpts>;
