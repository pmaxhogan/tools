/**
 * Shareable state lives in the URL fragment, never the query string (rule 6).
 * Fragments are not sent to the server, so shared links cannot leak content
 * into request logs.
 *
 * Format: #i=<input>&<optionId>=<value>  (URLSearchParams-encoded)
 */
import type { OptionSpec } from "../tools/types";

/** Inputs larger than this are not written to the URL. */
const MAX_FRAGMENT_INPUT = 2000;

export interface FragmentState {
  input?: string;
  opts: Record<string, string>;
}

/**
 * Turns one option value back from its string form into the type the control
 * and the tool's `run()` expect. The string form is what the fragment carries
 * and what `ToolExample.opts` is written in, so both paths coerce identically.
 * Selects and text options keep the raw string, which is already their type.
 */
export function coerceOptValue(spec: OptionSpec, raw: string): unknown {
  if (spec.kind === "number" || spec.kind === "slider") return Number(raw);
  if (spec.kind === "boolean") return raw === "true";
  return raw;
}

/**
 * Coerces a whole bag of string values against a tool's option specs. Ids the
 * tool does not declare are dropped, so a stale link or a mistyped example
 * cannot inject unknown keys into the options object.
 */
export function coerceOpts(
  specs: OptionSpec[] | undefined,
  raw: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs ?? []) {
    const value = raw[spec.id];
    if (value === undefined) continue;
    out[spec.id] = coerceOptValue(spec, value);
  }
  return out;
}

export function readFragment(): FragmentState {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return { opts: {} };
  const params = new URLSearchParams(hash);
  const opts: Record<string, string> = {};
  let input: string | undefined;
  for (const [k, v] of params) {
    if (k === "i") input = v;
    else opts[k] = v;
  }
  return { input, opts };
}

export function writeFragment(state: FragmentState): void {
  const params = new URLSearchParams();
  if (state.input && state.input.length <= MAX_FRAGMENT_INPUT) params.set("i", state.input);
  for (const [k, v] of Object.entries(state.opts)) params.set(k, v);
  const next = params.toString();
  // replaceState keeps back-button behavior sane while typing.
  history.replaceState(null, "", next ? `#${next}` : window.location.pathname);
}
