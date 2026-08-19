import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "css-anchor-positioning-builder",
  matrixSlug: "anchor",
  icon: "Anchor",
  name: "CSS Anchor Positioning Builder",
  description: "Build CSS anchor-positioned tooltips, menus, and popovers with flip fallbacks and a plain-CSS fallback.",
  category: "Dev",
  keywords: [
    "css anchor positioning",
    "anchor-name",
    "position-anchor",
    "position-area",
    "position-try-fallbacks",
    "css tooltip without javascript",
    "popover anchor",
  ],
  searchTerms: [
    "inset-area",
    "@position-try",
    "position-visibility",
    "anchor-size",
    "anchor() function css",
    "tether element to another element css",
    "dropdown menu no js",
    "floating ui alternative css",
    "popovertarget",
    "flip-block flip-inline",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "pattern",
      label: "Pattern",
      default: "tooltip",
      options: [
        {
          value: "tooltip",
          label: "Tooltip",
          synonyms: ["hint", "tip", "hover label", "title replacement", "balloon"],
        },
        {
          value: "dropdown-menu",
          label: "Dropdown menu",
          synonyms: ["menu", "select menu", "combobox", "listbox", "context menu", "flyout"],
        },
        {
          value: "popover",
          label: "Popover panel",
          synonyms: ["popup", "dialog", "panel", "card", "disclosure"],
        },
        {
          value: "custom",
          label: "Custom element",
          synonyms: ["blank", "bare", "start from scratch", "generic", "plain"],
        },
      ],
    },
    {
      kind: "select",
      id: "area",
      label: "Placement",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Auto: follow the pattern",
          synonyms: ["default", "pattern default", "recommended"],
        },
        {
          value: "top",
          label: "Top: above the anchor",
          synonyms: ["above", "over", "north", "block-start", "up"],
        },
        {
          value: "bottom",
          label: "Bottom: below the anchor",
          synonyms: ["below", "under", "south", "block-end", "down"],
        },
        {
          value: "left",
          label: "Left: beside the anchor",
          synonyms: ["west", "inline-start", "start side", "before"],
        },
        {
          value: "right",
          label: "Right: beside the anchor",
          synonyms: ["east", "inline-end", "end side", "after"],
        },
        {
          value: "top-left",
          label: "Top left corner",
          synonyms: ["above left", "north west", "upper left", "top start"],
        },
        {
          value: "top-right",
          label: "Top right corner",
          synonyms: ["above right", "north east", "upper right", "top end"],
        },
        {
          value: "bottom-left",
          label: "Bottom left corner",
          synonyms: ["below left", "south west", "lower left", "bottom start"],
        },
        {
          value: "bottom-right",
          label: "Bottom right corner",
          synonyms: ["below right", "south east", "lower right", "bottom end"],
        },
        {
          value: "center",
          label: "Center: over the anchor",
          synonyms: ["middle", "on top of", "centered", "overlay"],
        },
      ],
    },
    {
      kind: "number",
      id: "gap",
      label: "Gap from the anchor (px)",
      default: 8,
      min: 0,
      max: 200,
      step: 1,
    },
    {
      kind: "boolean",
      id: "flip",
      label: "Flip to the other side when it would overflow",
      default: true,
    },
    {
      kind: "boolean",
      id: "popoverApi",
      label: "Use the popover attribute so it opens with no JavaScript",
      default: true,
    },
    {
      kind: "boolean",
      id: "hideWhenDetached",
      label: "Hide it when the anchor scrolls out of view",
      default: true,
    },
    {
      kind: "boolean",
      id: "arrow",
      label: "Add an arrow pointed at the anchor",
      default: false,
    },
    {
      kind: "boolean",
      id: "logical",
      label: "Use logical keywords (block-start, inline-end)",
      default: false,
    },
  ],
  copy: {
    what: "Generates the HTML and CSS for an element tethered to another element with CSS anchor positioning, the browser feature that replaces a JavaScript positioning library for tooltips, dropdown menus, and popovers. The output wires up anchor-name on the trigger, position-anchor and position-area on the positioned element, position-try-fallbacks so it flips instead of overflowing the viewport, and position-visibility so it disappears when the anchor scrolls away. Optional extras include an arrow drawn with the anchor() function, a named @position-try rule, anchor-size() sizing for menus, and the popover attribute so the whole thing works without a line of script. Every result ends with an @supports guard holding a plain-CSS fallback for browsers that do not understand anchor positioning yet.",
    how: "Pick a pattern, then a placement on the nine region grid around the anchor. Type an anchor name in the input if you want something other than --anchor: a bare name like tip becomes --tip, since CSS anchor names must start with two dashes. Turn on the arrow, the flip fallbacks, or the logical keywords as needed, then copy the HTML block into your markup and the CSS block into your stylesheet.",
    why: "Most anchor positioning examples online were written against the pre-Chrome 129 syntax and still say inset-area, which no current browser accepts, so copying them silently does nothing. This builder emits the current property names, keeps the popover user agent styles from fighting your placement, and always ships the @supports fallback that tutorials leave out. It also runs entirely in the page, so your files and inputs never leave your device.",
    faq: [
      {
        q: "Which browsers support CSS anchor positioning?",
        a: "Chrome and Edge 125 and later have it, with the position-area spelling from version 129 on. Safari 26 has partial support, and Firefox is still behind a flag as of 2025. Because the numbers move every few months, check caniuse.com/css-anchor-positioning before you ship, and keep the @supports fallback that this tool generates so unsupporting browsers still place the element somewhere sensible.",
      },
      {
        q: "Why does my example use inset-area instead of position-area?",
        a: "inset-area was the original name while the feature was being developed. The CSS Working Group renamed it to position-area, and Chrome made the switch in version 129, dropping inset-area entirely. Articles and Stack Overflow answers written in 2024 still use the old name, so a copied snippet does nothing at all in a current browser. This tool only emits position-area.",
      },
      {
        q: "How do I add an arrow that points at the anchor?",
        a: "Turn on the arrow option. It emits an ::after pseudo-element drawn as a CSS triangle, positioned with anchor() so one edge sits exactly on the anchor's edge, and with anchor-center so it lines up with the middle of the anchor rather than the middle of the box. It also sets overflow: visible on the positioned element, because the popover user agent stylesheet sets overflow: auto and would otherwise clip the arrow away.",
      },
    ],
  },
};
