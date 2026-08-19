import { describe, expect, it } from "vitest";
import { formatBytes } from "../../lib/format";
import { analyzeProbes, MAX_ENTROPY_BITS, PROBES, run } from "./index";
import { ToolError } from "../types";

/** Every probe id populated, chosen to exercise each describe() branch. */
const fullReport = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  uaData: {
    brands: [
      { brand: "Chromium", version: "128" },
      { brand: "Not=A?Brand", version: "24" },
    ],
    platform: "Windows",
    mobile: false,
  },
  language: { language: "en-US", languages: ["en-US", "en"] },
  timezone: "America/Chicago",
  screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 2 },
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  cookieEnabled: true,
  doNotTrack: "1",
  globalPrivacyControl: true,
  storageEstimate: { usage: 52428800, quota: 1073741824 },
  webdriver: true,
  plugins: { plugins: 5, mimeTypes: 4 },
  canvasHash: "a1b2c3d4",
  webglRenderer: {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0)",
  },
  audioSampleRate: 48000,
  fontsCount: 42,
  batteryApi: false,
  webrtcLeak: true,
  permissionNotifications: "prompt",
  permissionGeolocation: "denied",
  prefersColorScheme: "dark",
  prefersReducedMotion: false,
};

describe("PROBES", () => {
  it("has an entry for every id fullReport exercises", () => {
    const ids = new Set(PROBES.map((p) => p.id));
    for (const key of Object.keys(fullReport)) {
      expect(ids.has(key)).toBe(true);
    }
    expect(PROBES.length).toBe(Object.keys(fullReport).length);
  });
});

describe("analyzeProbes - full report", () => {
  const rows = analyzeProbes(fullReport);

  it("summarizes identity, locale, and display probes in plain English", () => {
    expect(rows["Identity: User agent string"]).toContain("Chrome/128.0");
    expect(rows["Identity: Client hints (brands / platform)"]).toBe(
      "Reports brands Chromium 128, Not=A?Brand 24, platform Windows, not mobile through the Client Hints API.",
    );
    expect(rows["Locale: Language"]).toBe("Preferred language is en-US, with en also accepted.");
    expect(rows["Locale: Time zone"]).toContain("America/Chicago");
    expect(rows["Display: Screen"]).toBe("1920x1080, 24-bit color, device pixel ratio 2.");
  });

  it("summarizes hardware and storage probes", () => {
    expect(rows["Hardware: CPU cores reported"]).toBe("Reports 8 logical CPU cores.");
    expect(rows["Hardware: Device memory reported"]).toBe(
      "Reports approximately 8 GB of device memory.",
    );
    expect(rows["Hardware: Max touch points"]).toBe(
      "Reports no touch points, indicating a mouse and keyboard device.",
    );
    expect(rows["Hardware: Battery API availability"]).toBe(
      "The Battery Status API is not available (removed from most browsers).",
    );
    expect(rows["Storage: Storage estimate"]).toBe(
      `Using ${formatBytes(52428800)} of an estimated ${formatBytes(1073741824)} quota for this site.`,
    );
  });

  it("summarizes fingerprinting probes", () => {
    expect(rows["Fingerprinting: Plugins / MIME types"]).toBe(
      "Reports 5 plugins and 4 MIME types.",
    );
    expect(rows["Fingerprinting: Canvas fingerprint"]).toContain("a1b2c3d4");
    expect(rows["Fingerprinting: WebGL renderer"]).toContain("RTX 3080");
    expect(rows["Fingerprinting: Audio context sample rate"]).toBe(
      "AudioContext reports a 48000 Hz sample rate.",
    );
    expect(rows["Fingerprinting: Fonts detected"]).toBe(
      "Detected 42 fonts from the reference list installed on this device.",
    );
  });

  it("summarizes privacy signals and preferences", () => {
    expect(rows["Privacy signals: Cookies enabled"]).toBe("Cookies are enabled.");
    expect(rows["Privacy signals: Do Not Track"]).toBe("Do Not Track is turned on.");
    expect(rows["Privacy signals: Global Privacy Control"]).toBe(
      "Global Privacy Control is turned on.",
    );
    expect(rows["Privacy signals: Notifications permission"]).toBe(
      'Notifications permission state is "prompt".',
    );
    expect(rows["Privacy signals: Geolocation permission"]).toBe(
      'Geolocation permission state is "denied".',
    );
    expect(rows["Preferences: Prefers color scheme"]).toBe("Prefers a dark color scheme.");
    expect(rows["Preferences: Prefers reduced motion"]).toBe(
      "Has no reduced-motion preference set.",
    );
  });

  it("computes the exact total entropy and classifies it high", () => {
    expect(MAX_ENTROPY_BITS).toBe(69);
    expect(rows["Fingerprint surface: probes collected"]).toBe(
      `${PROBES.length} of ${PROBES.length} probes.`,
    );
    expect(rows["Fingerprint surface: estimated entropy"]).toBe(
      "69 bits (out of a possible 69).",
    );
    expect(rows["Fingerprint surface: assessment"]).toContain("High fingerprint surface.");
    expect(rows["Fingerprint surface: assessment"]).toContain("rough estimate");
  });

  it("raises the automation, privacy-signal-irony, and WebRTC-leak flags", () => {
    expect(rows["Flag: automation detected"]).toContain("automation");
    expect(rows["Flag: privacy signal irony"]).toContain("easier to pick out of a crowd");
    expect(rows["Flag: WebRTC IP leak"]).toContain("private local IP address");
  });
});

describe("analyzeProbes - minimal report", () => {
  const rows = analyzeProbes({ cookieEnabled: true });

  it("reports every other probe as not collected", () => {
    expect(rows["Identity: User agent string"]).toBe("Not collected.");
    expect(rows["Fingerprinting: Canvas fingerprint"]).toBe("Not collected.");
    expect(rows["Network: WebRTC local IP leak"]).toBe("Not collected.");
  });

  it("classifies a near-empty report as low", () => {
    expect(rows["Fingerprint surface: probes collected"]).toBe(`1 of ${PROBES.length} probes.`);
    expect(rows["Fingerprint surface: estimated entropy"]).toBe(
      "1 bits (out of a possible 69).",
    );
    expect(rows["Fingerprint surface: assessment"]).toContain("Low fingerprint surface.");
  });

  it("raises no flags", () => {
    expect(rows["Flag: automation detected"]).toBeUndefined();
    expect(rows["Flag: privacy signal irony"]).toBeUndefined();
    expect(rows["Flag: WebRTC IP leak"]).toBeUndefined();
  });
});

describe("analyzeProbes - isolated flags", () => {
  it("raises only the automation flag when webdriver is true", () => {
    const rows = analyzeProbes({ webdriver: true, userAgent: "x" });
    expect(rows["Flag: automation detected"]).toBeDefined();
    expect(rows["Flag: privacy signal irony"]).toBeUndefined();
    expect(rows["Flag: WebRTC IP leak"]).toBeUndefined();
  });

  it("raises the irony flag from Global Privacy Control alone", () => {
    const rows = analyzeProbes({ globalPrivacyControl: true, userAgent: "x" });
    expect(rows["Flag: privacy signal irony"]).toBeDefined();
    expect(rows["Flag: automation detected"]).toBeUndefined();
  });

  it("raises only the WebRTC leak flag when a private IP is exposed", () => {
    const rows = analyzeProbes({ webrtcLeak: true, userAgent: "x" });
    expect(rows["Flag: WebRTC IP leak"]).toBeDefined();
    expect(rows["Flag: automation detected"]).toBeUndefined();
    expect(rows["Flag: privacy signal irony"]).toBeUndefined();
  });

  it("does not treat an explicit Do Not Track off as the irony flag", () => {
    const rows = analyzeProbes({ doNotTrack: "0", userAgent: "x" });
    expect(rows["Privacy signals: Do Not Track"]).toBe("Do Not Track is explicitly turned off.");
    expect(rows["Flag: privacy signal irony"]).toBeUndefined();
  });
});

describe("run", () => {
  it("parses a JSON report string end to end", () => {
    const rows = run(JSON.stringify(fullReport), {});
    expect(rows["Fingerprint surface: estimated entropy"]).toBe(
      "69 bits (out of a possible 69).",
    );
  });

  it("throws empty-input for an empty string", () => {
    expect(() => run("", {})).toThrow(ToolError);
    try {
      run("   ", {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("empty-input");
    }
  });

  it("throws bad-json for unparsable input", () => {
    try {
      run("{not valid json", {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("bad-json");
    }
  });

  it("throws not-a-report for JSON that is not an object", () => {
    for (const raw of ['"hello"', "42", "[1,2,3]", "null"]) {
      try {
        run(raw, {});
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe("not-a-report");
      }
    }
  });

  it("throws not-a-report when zero keys match a known probe id", () => {
    try {
      run('{"foo":"bar","baz":1}', {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("not-a-report");
    }
  });

  it("accepts a partial report with at least one recognized probe", () => {
    const rows = run('{"cookieEnabled": true, "unknownKey": 1}', {});
    expect(rows["Privacy signals: Cookies enabled"]).toBe("Cookies are enabled.");
  });
});
