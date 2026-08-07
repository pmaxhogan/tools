/**
 * The curated node catalog for Composable Pipelines.
 *
 * A pipeline can only chain tools whose logic genuinely pipes: a source or
 * transform hands a plain string to the next step, and a terminal ends the
 * chain with labeled rows. Meta type tags alone cannot tell a real string
 * transform apart from a panel-first tool whose run() returns usage rows
 * (sqlite-viewer declares text/plain yet returns a Record), so membership is
 * hand curated here rather than swept from the registry.
 *
 * How each role was decided, by reading every candidate's run() signature:
 *   source    input is 'none' or undefined and run() returns a string, so it
 *             seeds a chain with pipeable text.
 *   transform string in, string out. run() returns a plain string.
 *   terminal  run() returns a Record<string, string> of labeled rows, which
 *             the next step cannot consume, so the chain stops here.
 *
 * Every slug below must exist in the registry `tools` array and `loaders` map;
 * index.test.ts asserts exactly that, so a renamed or removed tool fails loudly
 * instead of producing a dead node.
 */

export type NodeRole = "source" | "transform" | "terminal";

export interface PipelineNode {
  /** URL slug, matching the registry meta.slug and loaders key. */
  slug: string;
  role: NodeRole;
  /** Short human label for the picker. */
  label: string;
}

/**
 * The catalog. Ordered source, then transform, then terminal, and alphabetical
 * within each role so the picker groups read cleanly.
 */
export const NODES: PipelineNode[] = [
  // Sources: input 'none', run() returns a string.
  { slug: "fake-data-generator", role: "source", label: "Fake Data Generator" },
  { slug: "uuid-generator", role: "source", label: "UUID Generator" },

  // Transforms: string in, string out.
  { slug: "csv-viewer", role: "transform", label: "CSV Viewer" },
  { slug: "data-format-converter", role: "transform", label: "Data Format Converter" },
  { slug: "decode-anything", role: "transform", label: "Decode Anything" },
  { slug: "email-header-analyzer", role: "transform", label: "Email Header Analyzer" },
  { slug: "escape-unescape", role: "transform", label: "Escape and Unescape" },
  { slug: "factorio-blueprint-decoder", role: "transform", label: "Factorio Blueprint Decoder" },
  { slug: "figlet", role: "transform", label: "Figlet ASCII Art" },
  { slug: "html-to-markdown", role: "transform", label: "HTML to Markdown" },
  {
    slug: "invisible-character-detector",
    role: "transform",
    label: "Invisible Character Detector",
  },
  { slug: "json-formatter", role: "transform", label: "JSON Formatter" },
  { slug: "json-to-typescript", role: "transform", label: "JSON to TypeScript" },
  { slug: "line-sorter", role: "transform", label: "Line Sorter" },
  { slug: "smartctl-analyzer", role: "transform", label: "smartctl Analyzer" },
  { slug: "sql-formatter", role: "transform", label: "SQL Formatter" },
  { slug: "subtitle-editor", role: "transform", label: "Subtitle Editor" },

  // Terminals: run() returns a Record of labeled rows.
  { slug: "base-converter", role: "terminal", label: "Base Converter" },
  { slug: "case-converter", role: "terminal", label: "Case Converter" },
  { slug: "character-counter", role: "terminal", label: "Character Counter" },
  { slug: "discord-timestamp", role: "terminal", label: "Discord Timestamp" },
  { slug: "duration-calculator", role: "terminal", label: "Duration Calculator" },
  { slug: "epoch-converter", role: "terminal", label: "Epoch Converter" },
  { slug: "gam-command-builder", role: "terminal", label: "GAM Command Builder" },
  { slug: "hash-generator", role: "terminal", label: "Hash Generator" },
  { slug: "mojibake-fixer", role: "terminal", label: "Mojibake Fixer" },
  { slug: "oauth-scope-decoder", role: "terminal", label: "OAuth Scope Decoder" },
  { slug: "snowflake-decoder", role: "terminal", label: "Snowflake Decoder" },
  { slug: "svg-optimizer", role: "terminal", label: "SVG Optimizer" },
  { slug: "unicode-picker", role: "terminal", label: "Unicode Picker" },
  { slug: "url-parser", role: "terminal", label: "URL Parser" },
  { slug: "user-agent-parser", role: "terminal", label: "User Agent Parser" },
  { slug: "week-number", role: "terminal", label: "Week Number" },
];

/** Fast lookup by slug. */
export const NODE_BY_SLUG: Map<string, PipelineNode> = new Map(NODES.map((n) => [n.slug, n]));

/**
 * The data-integrity contract, asserted by index.test.ts: every slug here is a
 * real registered tool, so the catalog can never drift into referencing a node
 * that the builder cannot actually load and run.
 */
export const DATA_INTEGRITY_NOTE =
  "Every node slug in NODES must exist in the registry tools array (by meta.slug) and in the loaders map (by key). The test suite asserts both, so a renamed or deleted tool breaks the build rather than shipping a dead pipeline node.";

/** Roles in the order the builder shows them. */
export const ROLE_ORDER: NodeRole[] = ["source", "transform", "terminal"];
