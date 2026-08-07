import { describe, expect, it } from "vitest";
import {
  classifyPixelDensity,
  computeAspectRatio,
  describeColorGamut,
  describeColorScheme,
  describeConnectionType,
  describeContrastPreference,
  describeHoverCapability,
  describeMotionPreference,
  describeMultiMonitor,
  describeOrientation,
  describePointerAccuracy,
  describeSaveData,
  describeDynamicRange,
  formatDeviceMemory,
  formatDownlink,
  formatHardwareConcurrency,
  formatRefreshRate,
  formatRoundTripTime,
  physicalResolution,
  run,
} from "./index";
import { ToolError } from "../types";
import type { DisplaySnapshot } from "./index";

function baseSnapshot(overrides: Partial<DisplaySnapshot> = {}): DisplaySnapshot {
  return {
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
    window: { innerWidth: 1200, innerHeight: 900, devicePixelRatio: 2 },
    orientation: { type: "landscape-primary", angle: 0 },
    media: {
      colorGamut: "p3",
      dynamicRange: "high",
      prefersColorScheme: "dark",
      prefersContrast: "no-preference",
      prefersReducedMotion: false,
      pointer: "fine",
      anyPointer: "fine",
      hover: "hover",
      anyHover: "hover",
    },
    hardware: { hardwareConcurrency: 8, deviceMemory: 8 },
    network: { effectiveType: "4g", downlinkMbps: 10, rttMs: 50, saveData: false },
    refreshRateHz: 120,
    screens: [{ width: 1920, height: 1080, left: 0, top: 0, isPrimary: true }],
    ...overrides,
  };
}

describe("computeAspectRatio", () => {
  it("matches common named ratios within tolerance", () => {
    expect(computeAspectRatio(1920, 1080)).toBe("16:9");
    expect(computeAspectRatio(1366, 768)).toBe("16:9");
    expect(computeAspectRatio(1024, 768)).toBe("4:3");
    expect(computeAspectRatio(2520, 1080)).toBe("21:9");
  });

  it("falls back to a reduced fraction with a decimal ratio when no common match", () => {
    const out = computeAspectRatio(1000, 333);
    expect(out).toMatch(/^\d+:\d+ \(\d\.\d{2}:1\)$/);
  });

  it("returns Unknown for non-positive or non-finite dimensions", () => {
    expect(computeAspectRatio(0, 1080)).toBe("Unknown");
    expect(computeAspectRatio(1920, -1)).toBe("Unknown");
    expect(computeAspectRatio(NaN, 1080)).toBe("Unknown");
  });
});

describe("classifyPixelDensity", () => {
  it("labels standard, retina, and fractional densities", () => {
    expect(classifyPixelDensity(1)).toMatch(/standard density/);
    expect(classifyPixelDensity(2)).toMatch(/Retina/);
    expect(classifyPixelDensity(3)).toMatch(/HiDPI/);
    expect(classifyPixelDensity(1.5)).toMatch(/fractional scaling/);
  });

  it("returns Unknown for zero or non-finite ratios", () => {
    expect(classifyPixelDensity(0)).toBe("Unknown");
    expect(classifyPixelDensity(NaN)).toBe("Unknown");
  });
});

describe("physicalResolution", () => {
  it("multiplies CSS pixels by the device pixel ratio", () => {
    expect(physicalResolution(1920, 1080, 2)).toBe("3840 x 2160 px");
    expect(physicalResolution(1200, 900, 1)).toBe("1200 x 900 px");
  });

  it("returns Unknown when any input is invalid", () => {
    expect(physicalResolution(1920, 1080, 0)).toBe("Unknown");
    expect(physicalResolution(NaN, 1080, 2)).toBe("Unknown");
  });
});

describe("formatRefreshRate", () => {
  it("snaps a measured rate close to a common panel rate", () => {
    expect(formatRefreshRate(59.94)).toBe("~60 Hz");
    expect(formatRefreshRate(143.2)).toBe("~144 Hz (high refresh rate)");
  });

  it("rounds without snapping when far from any common rate", () => {
    expect(formatRefreshRate(101)).toBe("~101 Hz (high refresh rate)");
  });

  it("reports not measured for null, undefined, or non-positive values", () => {
    expect(formatRefreshRate(null)).toBe("Not measured yet");
    expect(formatRefreshRate(undefined)).toBe("Not measured yet");
    expect(formatRefreshRate(0)).toBe("Not measured yet");
  });
});

describe("media feature describers", () => {
  it("describeColorGamut", () => {
    expect(describeColorGamut("rec2020")).toMatch(/Rec\. 2020/);
    expect(describeColorGamut("p3")).toMatch(/Display P3/);
    expect(describeColorGamut("srgb")).toMatch(/sRGB/);
    expect(describeColorGamut(null)).toBe("Not supported in this browser");
  });

  it("describeDynamicRange", () => {
    expect(describeDynamicRange("high")).toMatch(/HDR/);
    expect(describeDynamicRange("standard")).toMatch(/SDR/);
    expect(describeDynamicRange(undefined)).toBe("Not supported in this browser");
  });

  it("describeColorScheme", () => {
    expect(describeColorScheme("dark")).toBe("Dark");
    expect(describeColorScheme("light")).toBe("Light");
    expect(describeColorScheme(null)).toBe("Not supported in this browser");
  });

  it("describeContrastPreference", () => {
    expect(describeContrastPreference("more")).toMatch(/More contrast/);
    expect(describeContrastPreference("less")).toMatch(/Less contrast/);
    expect(describeContrastPreference("custom")).toMatch(/Custom/);
    expect(describeContrastPreference("no-preference")).toBe("No preference");
    expect(describeContrastPreference(null)).toBe("Not supported in this browser");
  });

  it("describeMotionPreference", () => {
    expect(describeMotionPreference(true)).toMatch(/Reduced motion/);
    expect(describeMotionPreference(false)).toMatch(/No preference/);
    expect(describeMotionPreference(null)).toBe("Not supported in this browser");
  });

  it("describePointerAccuracy", () => {
    expect(describePointerAccuracy("fine")).toMatch(/Fine pointer/);
    expect(describePointerAccuracy("coarse")).toMatch(/Coarse pointer/);
    expect(describePointerAccuracy("none")).toMatch(/No pointing device/);
    expect(describePointerAccuracy(null)).toBe("Not supported in this browser");
  });

  it("describeHoverCapability", () => {
    expect(describeHoverCapability("hover")).toBe("Can hover");
    expect(describeHoverCapability("none")).toMatch(/touch only/);
    expect(describeHoverCapability(null)).toBe("Not supported in this browser");
  });
});

describe("hardware and network formatters", () => {
  it("formatHardwareConcurrency", () => {
    expect(formatHardwareConcurrency(8)).toBe("8 logical cores");
    expect(formatHardwareConcurrency(1)).toBe("1 logical core");
    expect(formatHardwareConcurrency(undefined)).toBe("Not supported in this browser");
  });

  it("formatDeviceMemory", () => {
    expect(formatDeviceMemory(8)).toMatch(/~8 GB/);
    expect(formatDeviceMemory(undefined)).toMatch(/Chromium only/);
  });

  it("describeConnectionType", () => {
    expect(describeConnectionType("4g")).toMatch(/4G/);
    expect(describeConnectionType("slow-2g")).toBe("Slow 2G");
    expect(describeConnectionType(null)).toBe("Not supported in this browser");
  });

  it("formatDownlink and formatRoundTripTime", () => {
    expect(formatDownlink(10)).toMatch(/10 Mbps/);
    expect(formatDownlink(null)).toBe("Not supported in this browser");
    expect(formatRoundTripTime(50)).toMatch(/50 ms/);
    expect(formatRoundTripTime(undefined)).toBe("Not supported in this browser");
  });

  it("describeSaveData", () => {
    expect(describeSaveData(true)).toMatch(/Enabled/);
    expect(describeSaveData(false)).toBe("Disabled");
    expect(describeSaveData(undefined)).toBe("Not supported in this browser");
  });
});

describe("describeOrientation", () => {
  it("labels known orientation types with an angle", () => {
    expect(describeOrientation("landscape-primary", 0)).toBe("Landscape (primary), 0 deg rotation");
    expect(describeOrientation("portrait-secondary", 180)).toMatch(/Portrait \(secondary/);
  });

  it("reports not supported when type is missing", () => {
    expect(describeOrientation(null, null)).toBe("Not supported in this browser");
  });
});

describe("describeMultiMonitor", () => {
  it("reports not supported when there are no screens", () => {
    expect(describeMultiMonitor(null)).toMatch(/Not supported/);
    expect(describeMultiMonitor([])).toMatch(/Not supported/);
  });

  it("describes a single display", () => {
    const out = describeMultiMonitor([{ width: 1920, height: 1080, left: 0, top: 0 }]);
    expect(out).toMatch(/1 display detected/);
    expect(out).toMatch(/1920 x 1080/);
  });

  it("describes multiple displays with the primary flagged", () => {
    const out = describeMultiMonitor([
      { width: 1920, height: 1080, left: 0, top: 0, isPrimary: true },
      { width: 2560, height: 1440, left: 1920, top: 0 },
    ]);
    expect(out).toMatch(/2 displays detected/);
    expect(out).toMatch(/primary/);
  });
});

describe("run", () => {
  it("produces a full labeled breakdown from a complete snapshot", () => {
    const out = run(JSON.stringify(baseSnapshot()), {});
    expect(out["Screen resolution"]).toBe("1920 x 1080 px");
    expect(out["Available screen area"]).toBe("1920 x 1040 px");
    expect(out["Window size"]).toBe("1200 x 900 px");
    expect(out["Device pixel ratio"]).toMatch(/Retina/);
    expect(out["Physical pixel resolution"]).toBe("3840 x 2160 px");
    expect(out["Aspect ratio"]).toBe("16:9");
    expect(out["Color depth"]).toBe("24-bit");
    expect(out["Orientation"]).toMatch(/Landscape/);
    expect(out["Refresh rate"]).toMatch(/120 Hz/);
    expect(out["Color gamut"]).toMatch(/Display P3/);
    expect(out["Dynamic range (HDR)"]).toMatch(/HDR/);
    expect(out["Connected displays"]).toMatch(/1 display detected/);
  });

  it("falls back to not-supported rows when optional fields are absent", () => {
    const minimal: DisplaySnapshot = {
      screen: { width: 800, height: 600, availWidth: 800, availHeight: 600, colorDepth: 24 },
      window: { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 },
      media: {},
    };
    const out = run(JSON.stringify(minimal), {});
    expect(out["Refresh rate"]).toBe("Not measured yet");
    expect(out["Color gamut"]).toBe("Not supported in this browser");
    expect(out["CPU logical cores"]).toBe("Not supported in this browser");
    expect(out["Connected displays"]).toMatch(/Not supported/);
  });

  it("throws empty-input on an empty string", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    try {
      run("   ", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws invalid-snapshot on malformed JSON", () => {
    expect(() => run("{not valid json", {})).toThrowError(ToolError);
    try {
      run("{not valid json", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-snapshot");
      expect((e as ToolError).fix).toBeDefined();
    }
  });

  it("throws invalid-snapshot when required screen or window fields are missing", () => {
    expect(() => run(JSON.stringify({ media: {} }), {})).toThrowError(ToolError);
    try {
      run(JSON.stringify({ screen: { width: 100 }, media: {} }), {});
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-snapshot");
    }
  });
});
