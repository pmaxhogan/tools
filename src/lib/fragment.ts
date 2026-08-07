/**
 * Shareable state lives in the URL fragment, never the query string (rule 6).
 * Fragments are not sent to the server, so shared links cannot leak content
 * into request logs.
 *
 * Format: #i=<input>&<optionId>=<value>  (URLSearchParams-encoded)
 */

/** Inputs larger than this are not written to the URL. */
const MAX_FRAGMENT_INPUT = 2000;

export interface FragmentState {
  input?: string;
  opts: Record<string, string>;
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
