import { optimize, type Config } from "svgo/browser";
import { ToolError, type ToolLogic } from "../types";

export interface SvgoOpts {
  /** Run SVGO passes repeatedly (up to 10) until no further shrinkage. */
  multipass: boolean;
  /** Decimal places kept for numbers (path data, coordinates, etc). */
  precision: number;
  /** Keep the viewBox attribute so the SVG still scales responsively. */
  keepViewBox: boolean;
  /** Pretty-print the output with two-space indentation. */
  pretty: boolean;
  /** Strip unused ids and minify the ones that remain in use. */
  removeIds: boolean;
  [key: string]: unknown;
}

export type SvgoResult = Record<string, string>;

/** Loosened shape: some SVGO versions return `{ error }` instead of throwing. */
interface OptimizeResult {
  data?: string;
  error?: string;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function humanSize(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes} B`;
  if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatBytes(n: number): string {
  return `${n.toLocaleString()} bytes (${humanSize(n)})`;
}

function formatSaved(before: number, after: number): string {
  if (after <= before) {
    const saved = before - after;
    const percent = before > 0 ? (saved / before) * 100 : 0;
    return `${saved.toLocaleString()} bytes (${percent.toFixed(1)}%)`;
  }
  const grew = after - before;
  return `Grew by ${grew.toLocaleString()} bytes (pretty printing adds whitespace)`;
}

function buildConfig(opts: SvgoOpts): Config {
  return {
    multipass: opts.multipass,
    floatPrecision: opts.precision,
    plugins: [
      {
        name: "preset-default",
        params: {
          overrides: opts.removeIds ? {} : { cleanupIds: false },
        },
      },
      // removeViewBox is not part of preset-default in this SVGO version, so
      // it has to be added explicitly when the "keep viewBox" toggle is off.
      ...(opts.keepViewBox ? [] : (["removeViewBox"] as const)),
    ],
    js2svg: opts.pretty ? { pretty: true, indent: 2 } : undefined,
  };
}

export function run(input: string, opts: SvgoOpts): SvgoResult {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new ToolError("empty-input", "Paste or drop an SVG file to optimize.");
  }

  if (!/<svg[\s>]/i.test(trimmed)) {
    throw new ToolError(
      "not-svg",
      "This does not look like SVG markup.",
      "Paste an SVG file's contents, starting with an <svg> tag (an XML prolog or comments before it are fine).",
    );
  }

  let result: OptimizeResult;
  try {
    result = optimize(trimmed, buildConfig(opts));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ToolError(
      "invalid-svg",
      message.split("\n")[0],
      "Check for unclosed tags or a missing xmlns attribute.",
    );
  }

  if (result.error != null) {
    throw new ToolError(
      "invalid-svg",
      String(result.error).split("\n")[0],
      "Check for unclosed tags or a missing xmlns attribute.",
    );
  }

  const optimized = result.data ?? "";
  const beforeBytes = byteLength(trimmed);
  const afterBytes = byteLength(optimized);

  return {
    "Optimized SVG": optimized,
    Before: formatBytes(beforeBytes),
    After: formatBytes(afterBytes),
    Saved: formatSaved(beforeBytes, afterBytes),
    Passes: opts.multipass ? "Multipass (on)" : "Single pass (off)",
  };
}

export default { run } satisfies ToolLogic<string, SvgoResult, SvgoOpts>;
