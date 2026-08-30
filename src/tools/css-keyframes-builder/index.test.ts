import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  DEFAULT_SETTINGS,
  IDENTITY_STOP,
  KEYFRAME_PRESETS,
  decodeStops,
  encodeStops,
  formatAnimationCss,
  formatKeyframes,
  formatShorthand,
  formatTransform,
  normalizeAnimationName,
  normalizeStops,
  presetStops,
  readIteration,
  run,
  trimNumber,
  type KeyframeStop,
} from "./index";

function stop(at: number, part: Partial<KeyframeStop> = {}): KeyframeStop {
  return { ...IDENTITY_STOP, at, ...part };
}

describe("normalizeAnimationName", () => {
  it("falls back to a usable default", () => {
    expect(normalizeAnimationName("")).toBe("my-animation");
    expect(normalizeAnimationName("   ")).toBe("my-animation");
  });

  it("keeps a valid identifier as it is", () => {
    expect(normalizeAnimationName("fade-in")).toBe("fade-in");
    expect(normalizeAnimationName("_private")).toBe("_private");
    expect(normalizeAnimationName("-webkit-thing")).toBe("-webkit-thing");
  });

  it("rejects the CSS-wide keywords, which would disable the animation", () => {
    for (const name of ["none", "initial", "INHERIT", "unset", "revert"]) {
      try {
        normalizeAnimationName(name);
        throw new Error(`expected a ToolError for ${name}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe("reserved-name");
      }
    }
  });

  it("rejects spaces and a leading digit", () => {
    for (const name of ["fade in", "3d-spin", "fade!"]) {
      try {
        normalizeAnimationName(name);
        throw new Error(`expected a ToolError for ${name}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe("bad-name");
      }
    }
  });
});

describe("normalizeStops", () => {
  it("sorts by position", () => {
    const sorted = normalizeStops([stop(100), stop(0), stop(50)]);
    expect(sorted.map((s) => s.at)).toEqual([0, 50, 100]);
  });

  it("rejects fewer than two stops", () => {
    try {
      normalizeStops([stop(0)]);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("too-few-stops");
    }
  });

  it("rejects a stop outside the timeline", () => {
    try {
      normalizeStops([stop(0), stop(120)]);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-stop");
    }
  });

  it("rejects two stops at the same percentage", () => {
    try {
      normalizeStops([stop(0), stop(50), stop(50)]);
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("duplicate-stop");
    }
  });
});

describe("formatTransform", () => {
  it("always writes the same function list, so the browser can interpolate", () => {
    expect(formatTransform(IDENTITY_STOP)).toBe("translate(0px, 0px) rotate(0deg) scale(1)");
    expect(formatTransform(stop(0, { translateY: -30, scale: 1.05, rotate: 45 }))).toBe(
      "translate(0px, -30px) rotate(45deg) scale(1.05)",
    );
  });
});

describe("formatKeyframes", () => {
  it("writes a stop per percentage with opacity always present", () => {
    const css = formatKeyframes([stop(0, { opacity: 0 }), stop(100)], "fade-in");
    expect(css).toBe(
      [
        "@keyframes fade-in {",
        "  0% {",
        "    opacity: 0;",
        "  }",
        "  100% {",
        "    opacity: 1;",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("adds the transform to every stop as soon as one stop needs it", () => {
    const css = formatKeyframes([stop(0, { translateY: 20 }), stop(100)], "slide");
    expect(css.match(/transform:/g)).toHaveLength(2);
    expect(css).toContain("transform: translate(0px, 20px) rotate(0deg) scale(1);");
    expect(css).toContain("transform: translate(0px, 0px) rotate(0deg) scale(1);");
  });

  it("writes a background only on the stops that set one", () => {
    const css = formatKeyframes(
      [stop(0, { background: "#5b4bd6" }), stop(50), stop(100, { background: "#8a79f5" })],
      "color-shift",
    );
    expect(css.match(/background-color:/g)).toHaveLength(2);
  });
});

describe("formatShorthand", () => {
  it("writes every longhand in the order the shorthand expects", () => {
    expect(formatShorthand({ ...DEFAULT_SETTINGS, name: "spin", duration: 900 })).toBe(
      "animation: spin 900ms ease 0ms 1 normal both;",
    );
  });
});

describe("formatAnimationCss", () => {
  it("wraps the rule in a no-preference query by default", () => {
    const css = formatAnimationCss([stop(0, { opacity: 0 }), stop(100)], {
      ...DEFAULT_SETTINGS,
      name: "fade-in",
    });
    expect(css).toContain("@keyframes fade-in {");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference) {");
    expect(css).toContain(".fade-in {");
  });

  it("emits a plain rule when the guard is turned off", () => {
    const css = formatAnimationCss([stop(0, { opacity: 0 }), stop(100)], {
      ...DEFAULT_SETTINGS,
      name: "fade-in",
      reducedMotion: false,
    });
    expect(css).not.toContain("prefers-reduced-motion");
    expect(css).toContain(".fade-in {\n  animation: fade-in 600ms ease 0ms 1 normal both;\n}");
  });
});

describe("presetStops", () => {
  it("returns a copy of the stops", () => {
    presetStops("bounce").stops[0].translateY = 999;
    expect(presetStops("bounce").stops[0].translateY).toBe(0);
  });

  it("every preset produces valid CSS", () => {
    for (const preset of KEYFRAME_PRESETS) {
      const css = formatKeyframes(preset.stops, preset.name);
      expect(css.startsWith(`@keyframes ${preset.name} {`)).toBe(true);
      expect(css.endsWith("}")).toBe(true);
    }
  });

  it("rejects an unknown preset", () => {
    try {
      presetStops("wiggle");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-preset");
    }
  });
});

describe("encodeStops and decodeStops", () => {
  it("round-trips every preset timeline", () => {
    for (const preset of KEYFRAME_PRESETS) {
      const encoded = encodeStops(preset.stops);
      const back = decodeStops(encoded);
      expect(back).toHaveLength(preset.stops.length);
      expect(encodeStops(back)).toBe(encoded);
    }
  });

  it("writes a short, link-safe string", () => {
    expect(encodeStops([stop(0, { opacity: 0, translateY: 8 }), stop(100)])).toBe(
      "0,0,8,1,0,0,;100,0,0,1,0,1,",
    );
  });

  it("keeps a background color and drops the hash", () => {
    const encoded = encodeStops([stop(0, { background: "#5B4BD6" }), stop(100)]);
    expect(encoded).toContain("5B4BD6");
    expect(decodeStops(encoded)[0].background).toBe("#5b4bd6");
  });

  it("rejects an empty or malformed timeline", () => {
    for (const [text, code] of [
      ["", "empty-timeline"],
      ["0,0,0,1,0,1", "bad-timeline"],
      ["0,0,0,1,0,x,;100,0,0,1,0,1,", "bad-timeline"],
      ["0,0,0,1,0,1,zzzzzz;100,0,0,1,0,1,", "bad-timeline"],
    ] as const) {
      try {
        decodeStops(text);
        throw new Error(`expected a ToolError for "${text}"`);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe(code);
      }
    }
  });

  it("still validates the timeline it decodes", () => {
    try {
      decodeStops("0,0,0,1,0,1,;0,0,0,1,0,1,");
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("duplicate-stop");
    }
  });
});

describe("readIteration", () => {
  it("takes a count or the infinite keyword", () => {
    expect(readIteration(undefined)).toBe("1");
    expect(readIteration("infinite")).toBe("infinite");
    expect(readIteration(3)).toBe("3");
    expect(readIteration("2.5")).toBe("2.5");
  });

  it("rejects anything else", () => {
    for (const value of ["forever", -1, 5000]) {
      try {
        readIteration(value);
        throw new Error(`expected a ToolError for ${String(value)}`);
      } catch (e) {
        expect((e as ToolError).code).toBe("bad-option");
      }
    }
  });
});

describe("run", () => {
  it("uses the preset name when no name is typed", () => {
    const out = run("", { preset: "spin" });
    expect(out).toContain("@keyframes spin {");
    expect(out).toContain("animation: spin 900ms linear 0ms infinite normal both;");
    expect(out).toContain("rotate(360deg)");
  });

  it("lets the input rename the animation", () => {
    const out = run("logo-turn", { preset: "spin" });
    expect(out).toContain("@keyframes logo-turn {");
    expect(out).toContain(".logo-turn {");
    expect(out).not.toContain("@keyframes spin");
  });

  it("honors the option overrides", () => {
    const out = run("", {
      preset: "pulse",
      duration: 2500,
      delay: 100,
      timing: "linear",
      iteration: "3",
      direction: "alternate",
      fill: "forwards",
      reducedMotion: false,
    });
    expect(out).toContain("animation: pulse 2500ms linear 100ms 3 alternate forwards;");
    expect(out).not.toContain("prefers-reduced-motion");
  });

  it("rejects a reserved animation name", () => {
    try {
      run("none", {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("reserved-name");
    }
  });

  it("rejects bad options", () => {
    expect(() => run("", { duration: 0 })).toThrowError(ToolError);
    expect(() => run("", { direction: "sideways" })).toThrowError(ToolError);
    expect(() => run("", { fill: "maybe" })).toThrowError(ToolError);
    expect(() => run("", { preset: "nope" })).toThrowError(ToolError);
  });

  it("keeps trimNumber tidy", () => {
    expect(trimNumber(1.05, 4)).toBe("1.05");
    expect(trimNumber(360, 3)).toBe("360");
  });
});
