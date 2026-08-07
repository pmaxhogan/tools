/**
 * The tool contract (PROJECT.md §3, rule 27).
 *
 * Every tool is a pure transform function with declared input and output
 * types, kept separate from its UI. The function is the tool; the page is
 * one surface on it. Logic files must not import Vue, touch the DOM, or
 * make network requests.
 */

/** MIME-ish type tags. Drive pipeline connectivity and the curl API. */
export type TypeSpec =
  | 'text/plain'
  | 'application/json'
  | 'text/csv'
  | 'text/html'
  | 'image/*'
  | 'image/png'
  | 'image/svg+xml'
  | 'audio/*'
  | 'video/*'
  | 'application/octet-stream'
  | 'File'
  | 'none';

export type Capability =
  | 'webgpu'
  | 'webcodecs'
  | 'serial'
  | 'hid'
  | 'bluetooth'
  | 'fs-access'
  | 'clipboard-read'
  | 'camera'
  | 'desktop'
  | 'chromium';

/** Schema-driven options — the generic tool panel renders these controls. */
export type OptionSpec =
  | {
      kind: 'select';
      id: string;
      label: string;
      default: string;
      choices: { value: string; label: string }[];
    }
  | { kind: 'text'; id: string; label: string; default: string; placeholder?: string }
  | {
      kind: 'number';
      id: string;
      label: string;
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | { kind: 'boolean'; id: string; label: string; default: boolean }
  | {
      kind: 'slider';
      id: string;
      label: string;
      default: number;
      min: number;
      max: number;
      step?: number;
    };

export interface FaqEntry {
  q: string;
  a: string;
}

/**
 * Static, cheap metadata for a tool. Lives in `src/tools/<slug>/meta.ts` and
 * is imported eagerly by the registry (homepage grid, palette, sitemap, SEO).
 * Must stay tiny: no logic imports, no heavy strings beyond page copy.
 */
export interface ToolMeta {
  /** URL segment, keyword-shaped for SEO (rule 22), e.g. "epoch-converter". */
  slug: string;
  /** Slug used in tool-matrix.csv when it differs from the URL slug. */
  matrixSlug?: string;
  name: string;
  /** One-liner: tool cards, meta description seed. */
  description: string;
  category: string;
  keywords: string[];
  /**
   * Hidden synonyms and aliases for in-app search only. Never rendered and not
   * part of SEO; exists so a search for "regex", "colour", "gif to mp4", etc.
   * finds the right tool even when those words are not in the name or copy.
   */
  searchTerms?: string[];
  /**
   * Name of the lucide-vue-next icon for this tool (e.g. "QrCode", "Clock").
   * Rendered on tool cards, the sidebar, and the tool page header. Resolved
   * through the curated map in src/lib/tool-icons.ts so only used icons ship.
   */
  icon?: string;
  input: TypeSpec;
  output: TypeSpec;
  options?: OptionSpec[];
  /** Exposed as a stateless curl endpoint. Cheap, pure runs only. */
  http?: { method: 'GET' | 'POST'; contentType: string };
  /** Gates the UI with an honest message instead of breaking (rule 15). */
  requires?: Capability[];
  /** Page copy (rule 23): real, thin, collapsed. */
  copy: {
    /** "What it does" — 2-4 sentences. */
    what: string;
    /** "How to use" — 2-4 sentences. */
    how: string;
    /** "Why this one" — what beats the incumbent. */
    why: string;
    faq: FaqEntry[];
  };
}

/**
 * A tool's runnable logic. Lives in `src/tools/<slug>/index.ts`, loaded
 * lazily per page (rule 14) — never imported by the registry.
 *
 * `run` must be pure and deterministic where the domain allows; randomness
 * takes a seed via opts. No DOM, no `window`, no fetch. Throws `ToolError`
 * with actionable messages.
 */
export interface ToolLogic<In = unknown, Out = unknown, Opts = Record<string, unknown>> {
  run(input: In, opts: Opts): Promise<Out> | Out;
}

/** Typed, actionable errors (PROJECT.md §3): what went wrong and how to fix it. */
export class ToolError extends Error {
  /** Short machine-readable code, e.g. "invalid-json". */
  code: string;
  /** Human suggestion: how to fix the input. */
  fix?: string;

  constructor(code: string, message: string, fix?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.fix = fix;
  }
}
