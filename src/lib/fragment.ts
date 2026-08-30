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

/**
 * True for an option whose value is a secret (see `TextOptionSpec.sensitive`).
 * The flag lives on text options only, because a password, a shared secret and
 * a PEM key are all free text; a select or a slider cannot hold one.
 */
export function isSensitiveOption(spec: OptionSpec): boolean {
  return spec.kind === "text" && spec.sensitive === true;
}

/** The ids a tool declares sensitive, for filtering an options bag either way. */
export function sensitiveOptionIds(specs: OptionSpec[] | undefined): Set<string> {
  return new Set((specs ?? []).filter(isSensitiveOption).map((spec) => spec.id));
}

/**
 * Drops every sensitive id from a bag of option values.
 *
 * Used in both directions by the generic shell: on the way out so a secret is
 * never written to the URL, and on the way in so a crafted link cannot
 * pre-fill one. `coerceOpts` cannot do this itself, because an example is
 * allowed to carry a sensitive value and have it applied to the control.
 */
export function withoutSensitiveOpts<T>(
  specs: OptionSpec[] | undefined,
  raw: Record<string, T>,
): Record<string, T> {
  const secret = sensitiveOptionIds(specs);
  if (secret.size === 0) return raw;
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !secret.has(key)));
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
