import { describe, expect, it } from "vitest";
import { describeSnapshot, formatLimits, run, type GpuSnapshot } from "./index";

const SNAPSHOT: GpuSnapshot = {
  available: true,
  adapterInfo: {
    vendor: "nvidia",
    architecture: "ampere",
    device: "",
    description: "NVIDIA GeForce RTX 3080",
  },
  isFallbackAdapter: false,
  features: ["texture-compression-bc", "depth-clip-control"],
  limits: {
    maxTextureDimension2D: 8192,
    maxBufferSize: 268435456,
    maxComputeWorkgroupSizeX: 256,
    maxTextureDimension1D: 8192,
  },
  preferredCanvasFormat: "bgra8unorm",
  wgslLanguageFeatures: ["readonly_and_readwrite_storage_textures"],
};

describe("run", () => {
  it("describes an available adapter with key limits by default", () => {
    const out = run(SNAPSHOT, {});
    expect(out["WebGPU"]).toBe("Supported");
    expect(out["Vendor"]).toBe("nvidia");
    expect(out["Architecture"]).toBe("ampere");
    expect(out["Description"]).toBe("NVIDIA GeForce RTX 3080");
    expect(out["Device"]).toBeUndefined();
    expect(out["Fallback adapter"]).toBe("No");
    expect(out["Features"]).toBe("2: depth-clip-control, texture-compression-bc");
    expect(out["Preferred canvas format"]).toBe("bgra8unorm");
    expect(out["Max texture dimension 2D"]).toBe("8,192");
    expect(out["Max buffer size"]).toBe("268,435,456");
    expect(out["Max compute workgroup size X"]).toBe("256");
    expect(out["WGSL language features"]).toBe("readonly_and_readwrite_storage_textures");
  });

  it("omits limits not in the curated key set when detail is 'key'", () => {
    const out = run(SNAPSHOT, { detail: "key" });
    expect(out["Max texture dimension 1D"]).toBeUndefined();
  });

  it("includes every reported limit when detail is 'all'", () => {
    const out = run(SNAPSHOT, { detail: "all" });
    expect(out["Max texture dimension 1D"]).toBe("8,192");
    expect(out["Max texture dimension 2D"]).toBe("8,192");
    expect(out["Max buffer size"]).toBe("268,435,456");
  });

  it("reports 'Not available' when the snapshot says so", () => {
    const out = run({ available: false }, {});
    expect(out["WebGPU"]).toBe("Not available");
    expect(out["Note"]).toBeTruthy();
  });

  it("parses a JSON string input the same as the object form", () => {
    const fromObject = run(SNAPSHOT, { detail: "all" });
    const fromString = run(JSON.stringify(SNAPSHOT), { detail: "all" });
    expect(fromString).toEqual(fromObject);
  });

  it("returns a friendly waiting message for empty input, without throwing", () => {
    expect(() => run("", {})).not.toThrow();
    const out = run("", {});
    expect(out["WebGPU"]).toMatch(/waiting/i);
  });

  it("throws ToolError on invalid JSON string input", () => {
    expect(() => run("not json", {})).toThrow(/not valid JSON/);
  });

  it("throws ToolError when the parsed JSON is missing 'available'", () => {
    expect(() => run(JSON.stringify({ foo: "bar" }), {})).toThrow(/GPU snapshot object/);
  });

  it("throws ToolError when a non-string, non-snapshot object is passed", () => {
    // @ts-expect-error deliberately malformed input for the runtime guard
    expect(() => run({ foo: "bar" }, {})).toThrow(/available/);
  });
});

describe("formatLimits", () => {
  it("returns an empty record when limits is undefined", () => {
    expect(formatLimits(undefined, "key")).toEqual({});
  });

  it("formats large numbers with thousands separators", () => {
    const out = formatLimits({ maxBufferSize: 1073741824 }, "all");
    expect(out["Max buffer size"]).toBe("1,073,741,824");
  });
});

describe("describeSnapshot", () => {
  it("does not include vendor/device rows when adapterInfo is absent", () => {
    const out = describeSnapshot({ available: true });
    expect(out["WebGPU"]).toBe("Supported");
    expect(out["Vendor"]).toBeUndefined();
    expect(out["Features"]).toBe("None reported");
  });
});
