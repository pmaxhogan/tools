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
  | "text/plain"
  | "application/json"
  | "text/csv"
  | "text/html"
  | "image/*"
  | "image/png"
  | "image/svg+xml"
  | "audio/*"
  | "video/*"
  | "application/octet-stream"
  | "File"
  | "none";

export type Capability =
  | "webgpu"
  | "webcodecs"
  | "serial"
  | "hid"
  | "bluetooth"
  | "fs-access"
  | "clipboard-read"
  | "camera"
  | "desktop"
  | "chromium"
  | "nfc";

/**
 * One selectable value in a dropdown.
 *
 * `synonyms` are extra search aliases that the shared searchable-select filters
 * on in addition to the visible `label` (for example ["hex", "base16"] on a
 * "Hexadecimal" option). They are never rendered. Every option must carry them,
 * even on a select too small to show the search field today.
 */
export interface SelectOption {
  value: string;
  label: string;
  /** Search aliases (required). Never rendered; only the searchable-select reads them. */
  synonyms: string[];
}

/**
 * A hierarchical category of options for a dropdown. Groups nest recursively:
 * a group may hold leaf `options`, child `groups`, or both. A group carries its
 * own `synonyms`, and the searchable-select matches on the group label and its
 * synonyms too, so matching a category surfaces every option beneath it.
 */
export interface SelectGroup {
  label: string;
  /** Search aliases for the category (required). */
  synonyms: string[];
  options?: SelectOption[];
  groups?: SelectGroup[];
}

/**
 * The dropdown option. Two ways to supply the options, checked in this order by
 * `flattenSelectOptions`:
 *
 * - `groups` — hierarchical categories (the preferred model for larger selects).
 * - `options` — a flat list of {value,label,synonyms} (the preferred model for
 *   small selects with no useful grouping).
 *
 * Every option and group carries search `synonyms`. The shared searchable-select
 * shows a search field automatically once the flat leaf-option count is greater
 * than 6, and filters on option labels, option synonyms, group labels, and group
 * synonyms.
 */
export interface SelectOptionSpec {
  kind: "select";
  id: string;
  label: string;
  default: string;
  /** Flat option list. Every option carries search synonyms. */
  options?: SelectOption[];
  /** Hierarchical category groups, recursively nestable. */
  groups?: SelectGroup[];
  /**
   * Rendering override. The generic panel renders a select with 4 or fewer
   * leaf options as a segmented button group and anything larger as the
   * searchable dropdown; set "select" to force the dropdown on a small list
   * (long labels, a placeholder-like default) or "segmented" to force buttons
   * on a larger one that still reads well as a row.
   */
  ui?: "segmented" | "select";
}

/** Schema-driven options — the generic tool panel renders these controls. */
export type OptionSpec =
  | SelectOptionSpec
  | { kind: "text"; id: string; label: string; default: string; placeholder?: string }
  | {
      kind: "number";
      id: string;
      label: string;
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | { kind: "boolean"; id: string; label: string; default: boolean }
  | {
      kind: "slider";
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
 * A worked example the generic panel can load so a first visit shows the tool
 * doing something. Text tools pre-fill `input` (flagged with a dismissable
 * "Example input" chip) when the URL fragment is empty; file tools show a
 * "Try a sample" button that fetches `file` from /samples/. `opts` presets
 * options alongside. An example never overrides a shared link's fragment.
 */
export interface ToolExample {
  label: string;
  /** Text to place in the main input (text/JSON/CSV/HTML tools). */
  input?: string;
  /** Path under public/samples/ for File, image, audio and video tools. */
  file?: string;
  /** Option values to apply with the example (stringified like the fragment). */
  opts?: Record<string, string>;
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
   * part of SEO; exists so a search for "regex", "color", "gif to mp4", etc.
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
  /**
   * Worked examples for the generic panel (see ToolExample). The first one is
   * the default. Omit on tools whose input is "none" or that have no sensible
   * sample.
   */
  examples?: ToolExample[];
  /**
   * The main input is a secondary shorthand (a one-line "6x4TB raidz2", a
   * pasted slicer summary) and the options alone are a complete UI. The
   * generic panel collapses the input box under a "Quick entry" toggle with
   * `label` on the toggle and `hint` explaining what the box accepts.
   */
  inputOptional?: { label: string; hint: string };
  /** Exposed as a stateless curl endpoint. Cheap, pure runs only. */
  http?: { method: "GET" | "POST"; contentType: string };
  /** Gates the UI with an honest message instead of breaking (rule 15). */
  requires?: Capability[];
  /**
   * The input is a secret (a password, a signing key). The generic shell then
   * keeps it out of the URL fragment, so it never lands in browser history or
   * a shared link; options still sync as usual.
   */
  sensitiveInput?: boolean;
  /**
   * Replaces the footer's default privacy sentence ("Your files and inputs
   * never leave your device") on the rare tool where that exact claim would be
   * false, such as one that hands files to another device on purpose. Must
   * still be honest and specific; never used to soften the default.
   */
  privacyNote?: string;
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
    this.name = "ToolError";
    this.code = code;
    this.fix = fix;
  }
}
