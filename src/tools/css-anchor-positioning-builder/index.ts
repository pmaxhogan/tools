import { ToolError, type ToolLogic } from "../types";

export interface AnchorPositioningOpts {
  /** "tooltip" (default), "dropdown-menu", "popover", or "custom". */
  pattern?: string;
  /** "auto" (default, follows the pattern) or one of the nine placement regions. */
  area?: string;
  /** Distance between the anchor and the positioned element, in px. */
  gap?: number;
  /** Emit position-try-fallbacks so the element flips when it would overflow. */
  flip?: boolean;
  /** Emit logical keywords (block-start, inline-end) instead of physical ones. */
  logical?: boolean;
  /** Emit the popover and popovertarget attributes so it opens with no JavaScript. */
  popoverApi?: boolean;
  /** Emit an ::after triangle pointed at the anchor with anchor(). */
  arrow?: boolean;
  /** Emit position-visibility: anchors-visible. */
  hideWhenDetached?: boolean;
  [key: string]: unknown;
}

/**
 * Browser support for CSS anchor positioning, for the panel and the FAQ.
 * Support is still moving, so every line is written to be checked, not trusted.
 */
export const SUPPORT_NOTES: readonly string[] = [
  "Chrome 125 and later: anchor-name, position-anchor, position-area, position-try-fallbacks, and @position-try all work. The property was called inset-area before Chrome 129.",
  "Edge 125 and later: same engine as Chrome, so the same support.",
  "Safari 26: partial support. Test the newer pieces (position-visibility, position-try-order) on a real device before you rely on them.",
  "Firefox: still behind a flag as of 2025, so treat anchor positioning as progressive enhancement rather than a hard dependency.",
  "Support numbers move every few months. Check caniuse.com/css-anchor-positioning before you ship.",
];

/* ------------------------------ option tables ------------------------------ */

const PATTERNS = ["tooltip", "dropdown-menu", "popover", "custom"] as const;
type Pattern = (typeof PATTERNS)[number];

const AREAS = [
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center",
] as const;
type Area = (typeof AREAS)[number];

const PHYSICAL_AREA: Record<Area, string> = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  "top-left": "top left",
  "top-right": "top right",
  "bottom-left": "bottom left",
  "bottom-right": "bottom right",
  center: "center",
};

const LOGICAL_AREA: Record<Area, string> = {
  top: "block-start",
  bottom: "block-end",
  left: "inline-start",
  right: "inline-end",
  "top-left": "block-start inline-start",
  "top-right": "block-start inline-end",
  "bottom-left": "block-end inline-start",
  "bottom-right": "block-end inline-end",
  center: "center",
};

/** Which axis the element sits on relative to the anchor. Drives flip order and the arrow. */
type Side = "block-start" | "block-end" | "inline-start" | "inline-end" | "center";

const AREA_SIDE: Record<Area, Side> = {
  top: "block-start",
  bottom: "block-end",
  left: "inline-start",
  right: "inline-end",
  "top-left": "block-start",
  "top-right": "block-start",
  "bottom-left": "block-end",
  "bottom-right": "block-end",
  center: "center",
};

interface PatternSpec {
  /** Class and id suffix for the positioned element. */
  suffix: string;
  /** Default placement when the area option is left on auto. */
  area: Area;
  triggerText: string;
  /** Inner HTML of the positioned element, one entry per line. */
  body: string[];
  headline: string;
}

const PATTERN_SPECS: Record<Pattern, PatternSpec> = {
  tooltip: {
    suffix: "tooltip",
    area: "top",
    triggerText: "Show tooltip",
    body: ["Tooltip text"],
    headline: "tooltip",
  },
  "dropdown-menu": {
    suffix: "menu",
    area: "bottom",
    triggerText: "Menu",
    body: ["<button type=\"button\">Profile</button>", "<button type=\"button\">Settings</button>", "<button type=\"button\">Sign out</button>"],
    headline: "dropdown menu",
  },
  popover: {
    suffix: "panel",
    area: "bottom",
    triggerText: "Open panel",
    body: ["<p>Popover content</p>"],
    headline: "popover panel",
  },
  custom: {
    suffix: "target",
    area: "bottom",
    triggerText: "Anchor",
    body: ["Positioned element"],
    headline: "positioned element",
  },
};

/** The mirror of each placement, used by the named @position-try fallback. */
const OPPOSITE_AREA: Record<Area, Area> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
  "top-left": "bottom-left",
  "top-right": "bottom-right",
  "bottom-left": "top-left",
  "bottom-right": "top-right",
  center: "center",
};

/** Plain-CSS placement used inside the @supports fallback, keyed by area. */
const FALLBACK_OFFSETS: Record<Area, string[]> = {
  top: ["bottom: 100%;", "left: 50%;", "translate: -50% 0;"],
  bottom: ["top: 100%;", "left: 50%;", "translate: -50% 0;"],
  left: ["right: 100%;", "top: 50%;", "translate: 0 -50%;"],
  right: ["left: 100%;", "top: 50%;", "translate: 0 -50%;"],
  "top-left": ["bottom: 100%;", "right: 100%;"],
  "top-right": ["bottom: 100%;", "left: 100%;"],
  "bottom-left": ["top: 100%;", "right: 100%;"],
  "bottom-right": ["top: 100%;", "left: 100%;"],
  center: ["top: 50%;", "left: 50%;", "translate: -50% -50%;"],
};

/* -------------------------------- helpers --------------------------------- */

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function readGap(value: unknown): number {
  if (value === undefined || value === null || value === "") return 8;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 200) {
    throw new ToolError(
      "bad-option",
      `Gap must be a number between 0 and 200 pixels, not ${JSON.stringify(value)}.`,
      "Set the gap to a whole number of pixels, for example 8.",
    );
  }
  return Math.round(n * 100) / 100;
}

function readPattern(value: unknown): Pattern {
  if (value === undefined || value === null || value === "") return "tooltip";
  const key = String(value).trim().toLowerCase();
  if ((PATTERNS as readonly string[]).includes(key)) return key as Pattern;
  throw new ToolError(
    "bad-option",
    `Unknown pattern "${String(value)}".`,
    `Pick one of: ${PATTERNS.join(", ")}.`,
  );
}

function readArea(value: unknown, pattern: Pattern): Area {
  if (value === undefined || value === null || value === "" || value === "auto") {
    return PATTERN_SPECS[pattern].area;
  }
  const key = String(value).trim().toLowerCase().replace(/\s+/g, "-");
  if ((AREAS as readonly string[]).includes(key)) return key as Area;
  throw new ToolError(
    "bad-option",
    `Unknown placement "${String(value)}".`,
    `Pick one of: ${AREAS.join(", ")}, or leave it on auto.`,
  );
}

/**
 * Turn user text into a valid CSS dashed-ident. "tip" and "--tip" both give
 * "--tip". Anything that is not an identifier is rejected rather than mangled.
 */
export function normalizeAnchorName(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "--anchor";
  if (/\s/.test(trimmed)) {
    throw new ToolError(
      "bad-anchor-name",
      `Anchor names cannot contain spaces: "${trimmed}".`,
      "Use hyphens instead of spaces, for example --tip-anchor.",
    );
  }
  const body = trimmed.replace(/^-+/, "");
  if (!body) {
    throw new ToolError(
      "bad-anchor-name",
      "An anchor name needs a name after the leading dashes.",
      "Type something like --tip-anchor.",
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(body)) {
    throw new ToolError(
      "bad-anchor-name",
      `"${trimmed}" is not a valid CSS identifier.`,
      "Start with a letter or underscore and use only letters, digits, hyphens, and underscores, for example --tip-anchor.",
    );
  }
  return `--${body}`;
}

/* ------------------------------- generation -------------------------------- */

interface BuildContext {
  anchorName: string;
  base: string;
  pattern: Pattern;
  spec: PatternSpec;
  area: Area;
  areaValue: string;
  side: Side;
  gap: number;
  flip: boolean;
  logical: boolean;
  popoverApi: boolean;
  arrow: boolean;
  hideWhenDetached: boolean;
}

function rule(selector: string, lines: string[]): string {
  const body = lines.map((l) => (l === "" ? "" : `  ${l}`)).join("\n");
  return `${selector} {\n${body}\n}`;
}

/** The dropdown menu is the pattern that ships a named @position-try fallback. */
function usesNamedFallback(ctx: BuildContext): boolean {
  return ctx.flip && ctx.pattern === "dropdown-menu" && ctx.side !== "center";
}

function buildHtml(ctx: BuildContext): string {
  const { base, spec, popoverApi } = ctx;
  const elementId = `${base}-${spec.suffix}`;
  const elementClass = `${base}-${spec.suffix}`;
  const body = spec.body.map((line) => `  ${line}`).join("\n");

  if (popoverApi) {
    return [
      `<!-- HTML: the anchor comes first, the positioned element second. -->`,
      `<button type="button" class="${base}-trigger" popovertarget="${elementId}">${spec.triggerText}</button>`,
      `<div id="${elementId}" class="${elementClass}" popover>`,
      body,
      `</div>`,
    ].join("\n");
  }

  const isTooltip = ctx.pattern === "tooltip";
  const triggerAttrs = isTooltip ? ` aria-describedby="${elementId}"` : "";
  const elementAttrs = isTooltip ? ' role="tooltip"' : "";

  return [
    `<!-- HTML: the anchor comes first, the positioned element second. -->`,
    `<div class="${base}-wrap">`,
    `  <button type="button" class="${base}-trigger"${triggerAttrs}>${spec.triggerText}</button>`,
    `  <div id="${elementId}" class="${elementClass}"${elementAttrs}>`,
    body
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
    `  </div>`,
    `</div>`,
  ].join("\n");
}

function fallbackList(ctx: BuildContext): string[] {
  const blockFirst = ["flip-block", "flip-inline", "flip-block flip-inline"];
  const inlineFirst = ["flip-inline", "flip-block", "flip-inline flip-block"];
  const order = ctx.side === "inline-start" || ctx.side === "inline-end" ? inlineFirst : blockFirst;
  if (usesNamedFallback(ctx)) {
    return [`--${ctx.base}-menu-flip`, ...order.slice(1)];
  }
  return order;
}

function sizingLines(ctx: BuildContext): string[] {
  switch (ctx.pattern) {
    case "tooltip":
      return ["width: max-content;", "max-width: 30ch;"];
    case "dropdown-menu":
      return [
        "/* anchor-size() reads the anchor's own box, so the menu is never narrower than its trigger. */",
        "min-width: anchor-size(width);",
        "width: max-content;",
        "max-height: 60vh;",
      ];
    case "popover":
      return ["width: max-content;", "max-width: 40ch;"];
    default:
      return ["width: max-content;"];
  }
}

function buildPositionedRule(ctx: BuildContext): string {
  const lines: string[] = [];

  lines.push(ctx.popoverApi ? "position: fixed;" : "position: absolute;");
  lines.push(`position-anchor: ${ctx.anchorName};`);
  lines.push(`position-area: ${ctx.areaValue};`);

  if (ctx.popoverApi) {
    lines.push("/* The popover UA styles set inset: 0 and margin: auto. Both have to go. */");
  }
  lines.push("inset: auto;");
  lines.push(`margin: ${ctx.gap}px;`);
  lines.push(...sizingLines(ctx));

  if (ctx.arrow && ctx.side !== "center") {
    lines.push("/* The arrow is drawn outside the box, so it must not be clipped. */");
    lines.push("overflow: visible;");
  } else if (ctx.pattern === "dropdown-menu") {
    lines.push("overflow: auto;");
  }

  if (ctx.flip) {
    lines.push(`position-try-fallbacks: ${fallbackList(ctx).join(", ")};`);
    if (ctx.pattern === "dropdown-menu") {
      lines.push("/* Take the fallback that leaves the most room instead of the first that fits. */");
      lines.push("position-try-order: most-height;");
    }
  }

  if (ctx.hideWhenDetached) {
    lines.push("/* Hide the element once the anchor scrolls out of view. Newer than the rest, so check support. */");
    lines.push("position-visibility: anchors-visible;");
  }

  if (!ctx.popoverApi) {
    lines.push("display: none;");
  }

  lines.push("");
  lines.push("/* Cosmetics only. Replace these with your own styles. */");
  lines.push("--anchor-surface: #1f2937;");
  lines.push("background: var(--anchor-surface);");
  lines.push("color: #ffffff;");
  lines.push("border: 0;");
  lines.push("border-radius: 6px;");
  lines.push("padding: 6px 10px;");
  lines.push("font: inherit;");

  return rule(`.${ctx.base}-${ctx.spec.suffix}`, lines);
}

function buildArrowRule(ctx: BuildContext): string | null {
  if (!ctx.arrow) return null;
  if (ctx.side === "center") {
    return `/* An element centered on its anchor has no edge to point at, so no arrow is emitted. */`;
  }

  const size = 6;
  const lines = [
    'content: "";',
    "position: absolute;",
    `position-anchor: ${ctx.anchorName};`,
    "width: 0;",
    "height: 0;",
    `border: ${size}px solid transparent;`,
  ];

  if (ctx.side === "block-start") {
    lines.push("border-top-color: var(--anchor-surface);");
    lines.push(ctx.logical ? "inset-block-end: anchor(start);" : "bottom: anchor(top);");
    lines.push("justify-self: anchor-center;");
  } else if (ctx.side === "block-end") {
    lines.push("border-bottom-color: var(--anchor-surface);");
    lines.push(ctx.logical ? "inset-block-start: anchor(end);" : "top: anchor(bottom);");
    lines.push("justify-self: anchor-center;");
  } else if (ctx.side === "inline-start") {
    lines.push("border-left-color: var(--anchor-surface);");
    lines.push(ctx.logical ? "inset-inline-end: anchor(start);" : "right: anchor(left);");
    lines.push("align-self: anchor-center;");
  } else {
    lines.push("border-right-color: var(--anchor-surface);");
    lines.push(ctx.logical ? "inset-inline-start: anchor(end);" : "left: anchor(right);");
    lines.push("align-self: anchor-center;");
  }

  const note =
    ctx.area === "top" || ctx.area === "bottom" || ctx.area === "left" || ctx.area === "right"
      ? "/* The arrow: anchor() reads one edge of the anchor, anchor-center lines it up with the middle. */"
      : "/* The arrow: corner placements often need a nudge here, since the arrow points at the anchor, not at the box. */";

  return `${note}\n${rule(`.${ctx.base}-${ctx.spec.suffix}::after`, lines)}`;
}

function buildPositionTryRule(ctx: BuildContext): string | null {
  if (!usesNamedFallback(ctx)) return null;
  const opposite = OPPOSITE_AREA[ctx.area];
  const flipped = ctx.logical ? LOGICAL_AREA[opposite] : PHYSICAL_AREA[opposite];
  return [
    "/* A named fallback. Only inset, margin, sizing, self-alignment, position-anchor,",
    "   and position-area descriptors are allowed inside @position-try. */",
    rule(`@position-try --${ctx.base}-menu-flip`, [
      `position-area: ${flipped};`,
      `margin: ${ctx.gap}px;`,
      "max-height: 40vh;",
    ]),
  ].join("\n");
}

function buildRevealRule(ctx: BuildContext): string | null {
  if (ctx.popoverApi) return null;
  return [
    "/* Show it on hover or keyboard focus. Swap this for your own show and hide logic. */",
    rule(
      `.${ctx.base}-wrap:hover .${ctx.base}-${ctx.spec.suffix},\n.${ctx.base}-wrap:focus-within .${ctx.base}-${ctx.spec.suffix}`,
      ["display: block;"],
    ),
  ].join("\n");
}

function buildSupportsBlock(ctx: BuildContext): string {
  const selector = `.${ctx.base}-${ctx.spec.suffix}`;
  const inner: string[] = [];

  if (ctx.popoverApi) {
    inner.push(
      "  /* A popover lives in the top layer, so no ancestor can position it.",
      "     Without anchor positioning the honest fallback is the browser's own",
      "     centered placement, or a JavaScript positioner such as Floating UI. */",
      `  ${selector} {`,
      "    inset: 0;",
      "    margin: auto;",
      "  }",
    );
  } else {
    const offsets = FALLBACK_OFFSETS[ctx.area];
    inner.push(
      "  /* Plain absolute positioning inside the wrapper. Assumes a horizontal writing mode. */",
      `  .${ctx.base}-wrap {`,
      "    position: relative;",
      "    display: inline-block;",
      "  }",
      `  ${selector} {`,
      ...offsets.map((o) => `    ${o}`),
      `    margin: ${ctx.gap}px;`,
      "  }",
    );
  }

  if (ctx.arrow && ctx.side !== "center") {
    inner.push(
      "  /* The arrow is placed with anchor(), which has nothing to fall back to. */",
      `  ${selector}::after {`,
      "    display: none;",
      "  }",
    );
  }

  return [
    "/* Fallback for browsers without CSS anchor positioning. The guard is true",
    "   only where anchor-name is understood, so this block is the else branch. */",
    "@supports not (anchor-name: --a) {",
    ...inner,
    "}",
  ].join("\n");
}

function buildNotes(ctx: BuildContext): string {
  const lines: string[] = [
    "/* Notes",
    `   Pattern: ${ctx.spec.headline}. Placement: position-area: ${ctx.areaValue}.`,
    "   A single position-area keyword such as top or bottom spans the whole other",
    "   axis, so the element stays centered on the anchor even when it is wider than it.",
  ];

  if (ctx.pattern === "tooltip" && ctx.popoverApi) {
    lines.push(
      "   popover=\"auto\" toggles on click. Newer Chromium also has popover=\"hint\",",
      "   which is aimed at tooltips and does not close other open popovers.",
    );
  }

  lines.push(
    "   anchor() reads one edge of the anchor and anchor-size() reads its box, so",
    "   things like top: anchor(bottom) or min-width: anchor-size(width) work anywhere",
    "   a length is allowed.",
    "   Repeating this component in a list? Add anchor-scope to keep each copy's",
    "   anchor-name from leaking to its siblings.",
  );

  for (const note of SUPPORT_NOTES) {
    lines.push(`   ${note}`);
  }
  lines.push("*/");
  return lines.join("\n");
}

export function run(input: string, opts: AnchorPositioningOpts = {}): string {
  const anchorName = normalizeAnchorName(typeof input === "string" ? input : "");
  const pattern = readPattern(opts?.pattern);
  const spec = PATTERN_SPECS[pattern];
  const area = readArea(opts?.area, pattern);
  const logical = readBool(opts?.logical, false);

  const ctx: BuildContext = {
    anchorName,
    base: anchorName.slice(2),
    pattern,
    spec,
    area,
    areaValue: logical ? LOGICAL_AREA[area] : PHYSICAL_AREA[area],
    side: AREA_SIDE[area],
    gap: readGap(opts?.gap),
    flip: readBool(opts?.flip, true),
    logical,
    popoverApi: readBool(opts?.popoverApi, true),
    arrow: readBool(opts?.arrow, false),
    hideWhenDetached: readBool(opts?.hideWhenDetached, true),
  };

  const blocks: (string | null)[] = [
    buildHtml(ctx),
    "/* ============================== CSS ============================== */",
    `/* 1. Name the anchor. Any element can carry an anchor name. */\n${rule(`.${ctx.base}-trigger`, [
      `anchor-name: ${ctx.anchorName};`,
    ])}`,
    `/* 2. Tether the ${ctx.spec.headline} to that anchor. */\n${buildPositionedRule(ctx)}`,
    buildPositionTryRule(ctx),
    buildRevealRule(ctx),
    buildArrowRule(ctx),
    buildSupportsBlock(ctx),
    buildNotes(ctx),
  ];

  return blocks.filter((b): b is string => b !== null).join("\n\n");
}

export default { run } satisfies ToolLogic<string, string, AnchorPositioningOpts>;
