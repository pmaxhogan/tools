import { describe, expect, it } from "vitest";
import { SUPPORT_NOTES, normalizeAnchorName, run, type AnchorPositioningOpts } from "./index";
import { ToolError } from "../types";

describe("css-anchor-positioning-builder: default tooltip", () => {
  const out = run("", {});

  it("names the anchor and tethers the tooltip to it", () => {
    expect(out).toContain("anchor-name: --anchor;");
    expect(out).toContain("position-anchor: --anchor;");
  });

  it("places the tooltip above the anchor", () => {
    expect(out).toContain("position-area: top;");
  });

  it("emits flip fallbacks with the block axis first", () => {
    expect(out).toContain("position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;");
  });

  it("expresses the gap as a margin", () => {
    expect(out).toContain("margin: 8px;");
  });

  it("guards the plain-CSS fallback with @supports", () => {
    expect(out).toContain("@supports not (anchor-name: --a) {");
  });

  it("pairs the popover attribute with popovertarget in the HTML section", () => {
    expect(out).toContain('<button type="button" class="anchor-trigger" popovertarget="anchor-tooltip">');
    expect(out).toContain('<div id="anchor-tooltip" class="anchor-tooltip" popover>');
  });

  it("separates the HTML and CSS sections with a comment line", () => {
    const html = out.indexOf("<!-- HTML");
    const separator = out.indexOf("/* ============================== CSS");
    const css = out.indexOf(".anchor-trigger {");
    expect(html).toBeGreaterThanOrEqual(0);
    expect(separator).toBeGreaterThan(html);
    expect(css).toBeGreaterThan(separator);
  });

  it("hides the tooltip when the anchor scrolls away", () => {
    expect(out).toContain("position-visibility: anchors-visible;");
  });

  it("is deterministic across runs", () => {
    expect(run("", {})).toBe(out);
    expect(run("", { pattern: "tooltip" })).toBe(out);
  });
});

describe("css-anchor-positioning-builder: patterns", () => {
  it("defaults the dropdown menu to the bottom of the anchor", () => {
    const out = run("", { pattern: "dropdown-menu" });
    expect(out).toContain("position-area: bottom;");
    expect(out).toContain('<div id="anchor-menu" class="anchor-menu" popover>');
  });

  it("gives the dropdown menu a named @position-try fallback and an order", () => {
    const out = run("", { pattern: "dropdown-menu" });
    expect(out).toContain("@position-try --anchor-menu-flip {");
    expect(out).toContain("position-try-fallbacks: --anchor-menu-flip, flip-inline, flip-block flip-inline;");
    expect(out).toContain("position-try-order: most-height;");
    expect(out).toContain("min-width: anchor-size(width);");
  });

  it("defaults the popover pattern to the bottom of the anchor", () => {
    const out = run("", { pattern: "popover" });
    expect(out).toContain("position-area: bottom;");
    expect(out).toContain('class="anchor-panel"');
  });

  it("lets an explicit placement override the pattern default", () => {
    const out = run("", { pattern: "tooltip", area: "bottom-right" });
    expect(out).toContain("position-area: bottom right;");
  });

  it("accepts the spec spelling of a corner placement as well as the hyphenated one", () => {
    expect(run("", { area: "top left" })).toBe(run("", { area: "top-left" }));
  });

  it("orders the flip fallbacks inline first for a side placement", () => {
    const out = run("", { area: "right" });
    expect(out).toContain("position-try-fallbacks: flip-inline, flip-block, flip-inline flip-block;");
  });
});

describe("css-anchor-positioning-builder: options", () => {
  it("emits logical keywords when logical is on", () => {
    const out = run("", { logical: true });
    expect(out).toContain("position-area: block-start;");
    expect(out).not.toContain("position-area: top;");
  });

  it("emits logical keywords for corners too", () => {
    const out = run("", { logical: true, area: "bottom-right" });
    expect(out).toContain("position-area: block-end inline-end;");
  });

  it("emits an ::after triangle placed with anchor()", () => {
    const out = run("", { arrow: true });
    expect(out).toContain(".anchor-tooltip::after {");
    expect(out).toContain("bottom: anchor(top);");
    expect(out).toContain("justify-self: anchor-center;");
    expect(out).toContain("overflow: visible;");
  });

  it("points the arrow at the correct edge for a side placement", () => {
    const out = run("", { arrow: true, area: "right" });
    expect(out).toContain("left: anchor(right);");
    expect(out).toContain("align-self: anchor-center;");
  });

  it("skips the arrow for a centered placement", () => {
    const out = run("", { arrow: true, area: "center" });
    expect(out).not.toContain("::after {");
    expect(out).toContain("no arrow is emitted");
  });

  it("drops position-visibility when hideWhenDetached is off", () => {
    const out = run("", { hideWhenDetached: false });
    expect(out).not.toContain("position-visibility: anchors-visible;");
    expect(run("", {})).toContain("position-visibility: anchors-visible;");
  });

  it("drops position-try-fallbacks when flip is off", () => {
    const out = run("", { flip: false });
    expect(out).not.toContain("position-try-fallbacks:");
    expect(run("", { flip: false, pattern: "dropdown-menu" })).not.toContain("@position-try --");
  });

  it("writes the gap into the margin and the fallback block", () => {
    const out = run("", { gap: 0 });
    expect(out).toContain("margin: 0px;");
    expect(run("", { gap: 24 })).toContain("margin: 24px;");
  });

  it("swaps the popover attributes for a wrapper and a hover reveal when popoverApi is off", () => {
    const out = run("", { popoverApi: false });
    expect(out).not.toContain("popovertarget");
    expect(out).not.toContain(" popover>");
    expect(out).toContain('<div class="anchor-wrap">');
    expect(out).toContain(".anchor-wrap:focus-within .anchor-tooltip {");
    expect(out).toContain("position: absolute;");
    expect(out).toContain("bottom: 100%;");
  });

  it("reads booleans sent as strings by the URL state", () => {
    const asOpts = (o: Record<string, unknown>) => o as AnchorPositioningOpts;
    expect(run("", asOpts({ arrow: "true" }))).toBe(run("", { arrow: true }));
    expect(run("", asOpts({ flip: "false" }))).toBe(run("", { flip: false }));
  });
});

describe("css-anchor-positioning-builder: anchor names", () => {
  it("adds the leading dashes to a bare name", () => {
    const out = run("tip", {});
    expect(out).toContain("anchor-name: --tip;");
    expect(out).toContain("position-anchor: --tip;");
    expect(out).toContain(".tip-trigger {");
    expect(out).toContain(".tip-tooltip {");
  });

  it("leaves an already dashed name alone", () => {
    expect(normalizeAnchorName("--tip-anchor")).toBe("--tip-anchor");
    expect(normalizeAnchorName("  tip-anchor  ")).toBe("--tip-anchor");
  });

  it("falls back to --anchor on empty input", () => {
    expect(normalizeAnchorName("")).toBe("--anchor");
    expect(normalizeAnchorName("   ")).toBe("--anchor");
  });
});

describe("css-anchor-positioning-builder: errors", () => {
  it("throws bad-anchor-name for invalid identifier characters", () => {
    expect(() => run("--tip.anchor", {})).toThrow(ToolError);
    try {
      run("--tip.anchor", {});
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-anchor-name");
      expect((e as ToolError).fix).toContain("letter");
    }
  });

  it("throws bad-anchor-name for a name with spaces", () => {
    expect(() => run("tip anchor", {})).toThrowError(/spaces/);
  });

  it("throws bad-anchor-name for a name that starts with a digit", () => {
    try {
      run("1tip", {});
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-anchor-name");
    }
  });

  it("throws bad-anchor-name when only dashes were typed", () => {
    try {
      run("--", {});
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-anchor-name");
    }
  });

  it("throws bad-option for an unknown pattern", () => {
    try {
      run("", { pattern: "sidebar" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-option");
      expect((e as ToolError).fix).toContain("dropdown-menu");
    }
  });

  it("throws bad-option for an unknown placement", () => {
    try {
      run("", { area: "north" });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-option");
    }
  });

  it("throws bad-option for a gap outside the allowed range", () => {
    for (const gap of [-1, 5000, Number.NaN]) {
      try {
        run("", { gap });
        expect.unreachable();
      } catch (e) {
        expect((e as ToolError).code).toBe("bad-option");
      }
    }
  });
});

describe("css-anchor-positioning-builder: support notes", () => {
  it("names the engines and tells the reader to check caniuse", () => {
    expect(SUPPORT_NOTES.length).toBeGreaterThan(3);
    const all = SUPPORT_NOTES.join(" ");
    expect(all).toContain("Chrome 125");
    expect(all).toContain("Edge 125");
    expect(all).toContain("Safari 26");
    expect(all).toContain("Firefox");
    expect(all).toContain("caniuse");
  });

  it("ships the notes inside the generated comment block", () => {
    const out = run("", {});
    expect(out).toContain("caniuse.com/css-anchor-positioning");
  });

  it("uses no em or en dashes anywhere in the output", () => {
    const out = run("", { arrow: true, pattern: "dropdown-menu", popoverApi: false });
    expect(out).not.toMatch(/[–—]/);
    expect(SUPPORT_NOTES.join(" ")).not.toMatch(/[–—]/);
  });
});
