import { describe, expect, it } from "vitest";
import {
  KEY_LAYOUT,
  GHOSTING_GUIDANCE,
  classifyRollover,
  initialState,
  maxRollover,
  recordEvent,
  run,
  summarize,
  type RolloverEvent,
} from "./index";
import { ToolError } from "../types";

function ev(type: "keydown" | "keyup", code: string, key: string, timestamp: number): RolloverEvent {
  return { type, code, key, timestamp };
}

describe("KEY_LAYOUT", () => {
  it("has no duplicate codes", () => {
    const codes = KEY_LAYOUT.flat()
      .map((k) => k.code)
      .filter((code): code is string => code !== null);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has exactly 104 real keys (ANSI 104 layout)", () => {
    const codes = KEY_LAYOUT.flat()
      .map((k) => k.code)
      .filter((code): code is string => code !== null);
    expect(codes.length).toBe(104);
  });

  it("every real key has a positive width and a label", () => {
    for (const row of KEY_LAYOUT) {
      for (const k of row) {
        expect(k.width).toBeGreaterThan(0);
        if (k.code !== null) expect(k.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("recordEvent", () => {
  it("tracks a growing chord and its press order", () => {
    let state = initialState;
    state = recordEvent(state, ev("keydown", "KeyA", "a", 0));
    state = recordEvent(state, ev("keydown", "KeyS", "s", 1));
    state = recordEvent(state, ev("keydown", "KeyD", "d", 2));

    expect(state.heldOrder).toEqual(["KeyA", "KeyS", "KeyD"]);
    expect(maxRollover(state)).toBe(3);
    expect(state.maxChordKeys).toEqual(["a", "s", "d"]);
    expect(state.totalPresses).toBe(3);
  });

  it("keeps the max chord after keys release, but updates held now", () => {
    let state = initialState;
    state = recordEvent(state, ev("keydown", "KeyA", "a", 0));
    state = recordEvent(state, ev("keydown", "KeyS", "s", 1));
    state = recordEvent(state, ev("keyup", "KeyA", "a", 2));

    expect(state.heldOrder).toEqual(["KeyS"]);
    expect(maxRollover(state)).toBe(2);
    expect(state.maxChordKeys).toEqual(["a", "s"]);
  });

  it("tolerates a keyup with no matching keydown", () => {
    const state = recordEvent(initialState, ev("keyup", "KeyQ", "q", 0));
    expect(state).toEqual(initialState);
  });

  it("does not double-count auto-repeat keydowns for an already-held key", () => {
    let state = initialState;
    state = recordEvent(state, ev("keydown", "KeyA", "a", 0));
    state = recordEvent(state, ev("keydown", "KeyA", "a", 1));

    expect(state.totalPresses).toBe(1);
    expect(maxRollover(state)).toBe(1);
    expect(state.pressCounts["KeyA"]).toBe(1);
  });

  it("does not mutate the input state", () => {
    const before = initialState;
    recordEvent(before, ev("keydown", "KeyA", "a", 0));
    expect(before).toEqual(initialState);
    expect(before.heldOrder.length).toBe(0);
  });

  it("counts repeated press/release cycles of the same key in pressCounts", () => {
    let state = initialState;
    state = recordEvent(state, ev("keydown", "KeyA", "a", 0));
    state = recordEvent(state, ev("keyup", "KeyA", "a", 1));
    state = recordEvent(state, ev("keydown", "KeyA", "a", 2));

    expect(state.pressCounts["KeyA"]).toBe(2);
    expect(state.totalPresses).toBe(2);
    expect(state.heldOrder).toEqual(["KeyA"]);
  });
});

describe("classifyRollover", () => {
  it("classifies every threshold", () => {
    expect(classifyRollover(0)).toBe("No keys pressed yet");
    expect(classifyRollover(1)).toBe("2KRO or blocked");
    expect(classifyRollover(2)).toBe("2KRO or blocked");
    expect(classifyRollover(3)).toBe("limited");
    expect(classifyRollover(5)).toBe("limited");
    expect(classifyRollover(6)).toBe("6KRO (USB boot protocol)");
    expect(classifyRollover(7)).toBe("NKRO");
    expect(classifyRollover(20)).toBe("NKRO");
  });
});

describe("summarize", () => {
  it("reports max, held, totals, distinct keys, verdict, and chord order", () => {
    let state = initialState;
    state = recordEvent(state, ev("keydown", "KeyA", "a", 0));
    state = recordEvent(state, ev("keydown", "KeyS", "s", 1));
    state = recordEvent(state, ev("keyup", "KeyA", "a", 2));

    const rows = summarize(state);
    expect(rows["Max simultaneous"]).toBe("2");
    expect(rows["Held now"]).toBe("s");
    expect(rows["Total presses"]).toBe("2");
    expect(rows["Distinct keys pressed"]).toBe("2");
    expect(rows["Verdict"]).toBe("2KRO or blocked");
    expect(rows["Largest chord press order"]).toBe("a then s");
  });

  it("reports the empty-session defaults", () => {
    const rows = summarize(initialState);
    expect(rows["Max simultaneous"]).toBe("0");
    expect(rows["Held now"]).toBe("none");
    expect(rows["Total presses"]).toBe("0");
    expect(rows["Distinct keys pressed"]).toBe("0");
    expect(rows["Verdict"]).toBe("No keys pressed yet");
    expect(rows["Largest chord press order"]).toBe("none");
  });
});

describe("GHOSTING_GUIDANCE", () => {
  it("explains ghosting versus blocking without claiming to detect it", () => {
    expect(GHOSTING_GUIDANCE).toMatch(/ghost/i);
    expect(GHOSTING_GUIDANCE).toMatch(/block/i);
  });
});

describe("run", () => {
  it("returns instructions for empty input", () => {
    const out = run("", {});
    expect(out["Instructions"]).toMatch(/press/i);
    expect(out["Note"]).toMatch(/Win\+L|Alt\+Tab/);
  });

  it("returns instructions for whitespace-only input", () => {
    const out = run("   ", {});
    expect(out["Instructions"]).toBeDefined();
  });

  it("builds a report from a JSON events payload", () => {
    const payload = JSON.stringify({
      events: [
        { type: "keydown", code: "KeyA", key: "a", timestamp: 0 },
        { type: "keydown", code: "KeyS", key: "s", timestamp: 1 },
        { type: "keydown", code: "KeyD", key: "d", timestamp: 2 },
        { type: "keyup", code: "KeyA", key: "a", timestamp: 3 },
      ],
    });
    const out = run(payload, {});
    expect(out["Max simultaneous"]).toBe("3");
    expect(out["Verdict"]).toBe("limited");
    expect(out["Held now"]).toBe("s + d");
  });

  it("throws bad-json for malformed JSON", () => {
    expect(() => run("{not valid json", {})).toThrowError(ToolError);
    try {
      run("{not valid json", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-json");
      expect((e as ToolError).fix).toMatch(/events/);
    }
  });

  it("throws bad-json for valid JSON missing an events key", () => {
    try {
      run(JSON.stringify({ foo: "bar" }), {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-json");
    }
  });

  it("throws bad-json for a JSON array instead of an object", () => {
    try {
      run(JSON.stringify([1, 2, 3]), {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-json");
    }
  });

  it("throws not-a-report when events is an empty array", () => {
    try {
      run(JSON.stringify({ events: [] }), {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("not-a-report");
    }
  });

  it("skips malformed individual events rather than throwing", () => {
    const payload = JSON.stringify({
      events: [
        { type: "keydown", code: "KeyA", key: "a", timestamp: 0 },
        { type: "keydown" }, // missing code, dropped
        null, // dropped
        { type: "keydown", code: "KeyB", key: "b", timestamp: 1 },
      ],
    });
    const out = run(payload, {});
    expect(out["Max simultaneous"]).toBe("2");
    expect(out["Distinct keys pressed"]).toBe("2");
  });
});
