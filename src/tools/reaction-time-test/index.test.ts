import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MIN_DELAY_MS,
  DELAY_CEILING_MS,
  DELAY_FLOOR_MS,
  ROUND_LIMITS,
  TYPICAL_RANGE_MS,
  classifyPress,
  delayForTrial,
  delaysForTest,
  ratingFor,
  report,
  run,
  summarize,
} from "./index";

describe("delaysForTest", () => {
  it("draws the requested number of waits inside the given range", () => {
    const waits = delaysForTest(5, { seed: 1 });
    expect(waits).toHaveLength(5);
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(DEFAULT_MIN_DELAY_MS);
      expect(w).toBeLessThanOrEqual(DEFAULT_MAX_DELAY_MS);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = delaysForTest(5, { seed: 42 });
    const b = delaysForTest(5, { seed: 42 });
    expect(a).toEqual(b);
  });

  it("produces a different sequence for a different seed", () => {
    const a = delaysForTest(5, { seed: 1 });
    const b = delaysForTest(5, { seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("honors a custom min and max delay", () => {
    const waits = delaysForTest(10, { seed: 7, minDelayMs: 600, maxDelayMs: 900 });
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(600);
      expect(w).toBeLessThanOrEqual(900);
    }
  });

  it("rejects a round count outside the allowed range", () => {
    try {
      delaysForTest(0, { seed: 1 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-rounds");
    }
    try {
      delaysForTest(ROUND_LIMITS.max + 1, { seed: 1 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-rounds");
    }
  });

  it("rejects a range below the floor or above the ceiling", () => {
    try {
      delaysForTest(3, { seed: 1, minDelayMs: DELAY_FLOOR_MS - 1, maxDelayMs: 1000 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-delay-range");
    }
    try {
      delaysForTest(3, { seed: 1, minDelayMs: 1000, maxDelayMs: DELAY_CEILING_MS + 1 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-delay-range");
    }
  });

  it("rejects a minimum greater than the maximum", () => {
    try {
      delaysForTest(3, { seed: 1, minDelayMs: 4000, maxDelayMs: 2000 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-delay-range");
    }
  });
});

describe("delayForTrial", () => {
  it("matches the value at the same index in delaysForTest", () => {
    const seq = delaysForTest(6, { seed: 9 });
    expect(delayForTrial(3, { seed: 9 })).toBe(seq[3]);
  });

  it("rejects a negative index", () => {
    try {
      delayForTrial(-1, { seed: 1 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-trial-index");
    }
  });
});

describe("ratingFor", () => {
  it("bands a reading at each documented boundary", () => {
    expect(ratingFor(100).id).toBe("anticipated");
    expect(ratingFor(180).id).toBe("very-fast");
    expect(ratingFor(220).id).toBe("typical");
    expect(ratingFor(280).id).toBe("average");
    expect(ratingFor(500).id).toBe("slow");
  });
});

describe("classifyPress", () => {
  it("starts a run from idle", () => {
    expect(classifyPress({ phase: "idle", pressedAtMs: 0, cueAtMs: null })).toEqual({
      kind: "start",
    });
  });

  it("flags a press before the cue as a false start", () => {
    const outcome = classifyPress({ phase: "waiting", pressedAtMs: 1000, cueAtMs: 1300 });
    expect(outcome).toEqual({ kind: "false-start", earlyByMs: 300 });
  });

  it("measures a reaction from the cue time", () => {
    const outcome = classifyPress({ phase: "cue", pressedAtMs: 1230, cueAtMs: 1000 });
    expect(outcome).toEqual({ kind: "reaction", timeMs: 230 });
  });

  it("ignores a press once the run is done", () => {
    expect(classifyPress({ phase: "done", pressedAtMs: 5000, cueAtMs: 4000 })).toEqual({
      kind: "ignored",
    });
  });

  it("ignores a press with no live trial in progress", () => {
    expect(classifyPress({ phase: "waiting", pressedAtMs: 10, cueAtMs: null })).toEqual({
      kind: "ignored",
    });
  });

  it("never reports a negative reaction time", () => {
    const outcome = classifyPress({ phase: "cue", pressedAtMs: 900, cueAtMs: 1000 });
    expect(outcome).toEqual({ kind: "reaction", timeMs: 0 });
  });
});

describe("summarize", () => {
  it("computes average, best, worst, median, and a rating", () => {
    const stats = summarize([200, 210, 220, 230, 240]);
    expect(stats.count).toBe(5);
    expect(stats.averageMs).toBe(220);
    expect(stats.bestMs).toBe(200);
    expect(stats.worstMs).toBe(240);
    expect(stats.medianMs).toBe(220);
    expect(stats.rating).toBe("Typical");
  });

  it("averages the two middle values for an even trial count", () => {
    const stats = summarize([200, 220, 240, 260]);
    expect(stats.medianMs).toBe(230);
  });

  it("rejects an empty set of trials", () => {
    try {
      summarize([]);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("no-trials");
    }
  });
});

describe("report", () => {
  it("includes false starts only when there were any", () => {
    const clean = report([210, 220, 230]);
    expect(clean["False starts"]).toBeUndefined();

    const withFalseStarts = report([210, 220, 230], 2);
    expect(withFalseStarts["False starts"]).toBe("2");
  });

  it("names the typical range in the rating row", () => {
    const rows = report([220]);
    expect(rows.Rating).toContain(`${TYPICAL_RANGE_MS.min} to ${TYPICAL_RANGE_MS.max} ms`);
  });
});

describe("run", () => {
  it("scores pasted reaction times separated by commas and newlines", () => {
    const out = run("210, 220\n230", {});
    expect(out.Trials).toBe("3");
    expect(out.Average).toBe("220 ms");
  });

  it("accepts a trailing ms unit on each value", () => {
    const out = run("200ms 210ms 220ms", {});
    expect(out.Trials).toBe("3");
  });

  it("throws empty-input on a blank input", () => {
    try {
      run("   ", {});
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toBeTruthy();
    }
  });

  it("throws bad-number on a token that is not a time", () => {
    try {
      run("210, fast, 230", {});
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-number");
    }
  });

  it("throws bad-number on a negative time", () => {
    try {
      run("-5", {});
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-number");
    }
  });

  it("is deterministic for the same input", () => {
    expect(run("210, 220, 230", {})).toEqual(run("210, 220, 230", {}));
  });
});
