import { ToolError, type ToolLogic } from "../types";

/**
 * A snapshot of the WebGPU adapter, assembled by the panel from live browser
 * APIs (navigator.gpu.requestAdapter(), adapter.info / requestAdapterInfo(),
 * adapter.features, adapter.limits) before being handed to run(). Every field
 * is optional except `available`, since a browser that lacks WebGPU, or a
 * requestAdapter() call that returned null, still needs to report something.
 */
export interface GpuSnapshot {
  available: boolean;
  adapterInfo?: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
  };
  isFallbackAdapter?: boolean;
  features?: string[];
  limits?: Record<string, number>;
  preferredCanvasFormat?: string;
  wgslLanguageFeatures?: string[];
}

export interface GpuInspectorOpts {
  detail?: string;
  [key: string]: unknown;
}

export type GpuInspectorResult = Record<string, string>;

const WAITING: GpuInspectorResult = {
  WebGPU: "Waiting for your browser to report its adapter.",
};

const INVALID_SNAPSHOT_FIX =
  'This panel builds the snapshot automatically from navigator.gpu. If pasting one by hand, it must be an object shaped like {"available":true,"adapterInfo":{"vendor":"...","device":"..."},"features":["..."],"limits":{"maxTextureDimension2D":8192}}.';

/**
 * Labels for the limits shown by default (detail: "key"). Curated to the
 * handful a developer actually checks first; every other reported limit is
 * still available via detail: "all".
 */
const KEY_LIMITS: Record<string, string> = {
  maxTextureDimension2D: "Max texture dimension 2D",
  maxTextureDimension3D: "Max texture dimension 3D",
  maxBufferSize: "Max buffer size",
  maxBindGroups: "Max bind groups",
  maxBindingsPerBindGroup: "Max bindings per bind group",
  maxComputeWorkgroupSizeX: "Max compute workgroup size X",
  maxComputeWorkgroupSizeY: "Max compute workgroup size Y",
  maxComputeWorkgroupSizeZ: "Max compute workgroup size Z",
  maxComputeInvocationsPerWorkgroup: "Max compute invocations per workgroup",
  maxComputeWorkgroupsPerDimension: "Max compute workgroups per dimension",
  maxVertexBuffers: "Max vertex buffers",
  maxColorAttachments: "Max color attachments",
};

/**
 * Splits a WebGPU limit's camelCase name into a readable fallback label, e.g.
 * "maxTextureDimension1D" -> "Max texture dimension 1D". Digit-bearing
 * tokens (dimension suffixes like "1D"/"2D"/"3D") are kept as-is rather than
 * lowercased, matching the style of the curated KEY_LIMITS labels.
 */
function humanizeLimitKey(key: string): string {
  const tokens = key.match(/[0-9]+[A-Z]|[A-Z][a-z]*|[a-z]+|[0-9]+/g) ?? [key];
  const words = tokens.map((token, i) => {
    if (/[0-9]/.test(token)) return token;
    const lower = token.toLowerCase();
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  });
  return words.join(" ");
}

function labelForLimit(key: string): string {
  return KEY_LIMITS[key] ?? humanizeLimitKey(key);
}

function formatLimitValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toLocaleString("en-US");
}

/**
 * Builds the labeled limit rows shown in the output. detail "key" (default)
 * shows only the curated KEY_LIMITS entries that are present in `limits`;
 * detail "all" shows every reported limit, sorted alphabetically by key.
 */
export function formatLimits(
  limits: Record<string, number> | undefined,
  detail: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!limits) return out;

  if (detail === "all") {
    for (const key of Object.keys(limits).sort((a, b) => a.localeCompare(b))) {
      out[labelForLimit(key)] = formatLimitValue(limits[key]!);
    }
    return out;
  }

  for (const key of Object.keys(KEY_LIMITS)) {
    if (key in limits) {
      out[labelForLimit(key)] = formatLimitValue(limits[key]!);
    }
  }
  return out;
}

function featuresLine(features: string[] | undefined): string {
  if (!features || features.length === 0) return "None reported";
  const sorted = [...features].sort((a, b) => a.localeCompare(b));
  return `${sorted.length}: ${sorted.join(", ")}`;
}

/**
 * Formats a GpuSnapshot into the labeled rows the generic output view
 * renders. Shared between run() (for text/JSON input) and the panel, which
 * may want to call it directly on a freshly-read snapshot object.
 */
export function describeSnapshot(
  snap: GpuSnapshot,
  opts: GpuInspectorOpts = {},
): GpuInspectorResult {
  const out: Record<string, string> = {};

  if (!snap.available) {
    out["WebGPU"] = "Not available";
    out["Note"] =
      "navigator.gpu is missing or requestAdapter() returned null. Needs a Chromium browser with WebGPU enabled, or a GPU/driver WebGPU supports.";
    return out;
  }

  out["WebGPU"] = "Supported";

  const info = snap.adapterInfo;
  if (info?.vendor) out["Vendor"] = info.vendor;
  if (info?.architecture) out["Architecture"] = info.architecture;
  if (info?.device) out["Device"] = info.device;
  if (info?.description) out["Description"] = info.description;

  out["Fallback adapter"] = snap.isFallbackAdapter ? "Yes" : "No";
  out["Features"] = featuresLine(snap.features);

  if (snap.preferredCanvasFormat) {
    out["Preferred canvas format"] = snap.preferredCanvasFormat;
  }

  const detail = opts.detail === "all" ? "all" : "key";
  Object.assign(out, formatLimits(snap.limits, detail));

  if (snap.wgslLanguageFeatures && snap.wgslLanguageFeatures.length > 0) {
    out["WGSL language features"] = [...snap.wgslLanguageFeatures]
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
  }

  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSnapshot(raw: string): GpuSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError("invalid-snapshot", "The input is not valid JSON.", INVALID_SNAPSHOT_FIX);
  }

  if (!isPlainObject(parsed) || typeof parsed.available !== "boolean") {
    throw new ToolError(
      "invalid-snapshot",
      "The JSON is not a GPU snapshot object (missing an 'available' boolean).",
      INVALID_SNAPSHOT_FIX,
    );
  }

  return parsed as unknown as GpuSnapshot;
}

export function run(input: string | GpuSnapshot, opts: GpuInspectorOpts = {}): GpuInspectorResult {
  if (typeof input === "string") {
    if (!input.trim()) return WAITING;
    return describeSnapshot(parseSnapshot(input), opts);
  }

  if (!isPlainObject(input) || typeof (input as GpuSnapshot).available !== "boolean") {
    throw new ToolError(
      "invalid-snapshot",
      "The snapshot is missing an 'available' boolean.",
      INVALID_SNAPSHOT_FIX,
    );
  }

  return describeSnapshot(input, opts);
}

export default { run } satisfies ToolLogic<
  string | GpuSnapshot,
  GpuInspectorResult,
  GpuInspectorOpts
>;
