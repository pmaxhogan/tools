import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { DURATIONS, cps, rank, run, summarize } from "./index";

describe("DURATIONS", () => {
  it("offers the five documented windows", () => {
    expect([...DURATIONS]).toEqual([5, 10, 30, 60, 100]);
  });
});

describe("cps", () => {
  it("divides clicks by seconds", () => {
    expect(cps(73, 10)).toBe(7.3);
  });

  it("rounds to two decimals", () => {
    expect(cps(10, 3)).toBe(3.33);
  });

  it("returns zero for a run with no clicks", () => {
    expect(cps(0, 5)).toBe(0);
  });

  it("rejects a negative click count", () => {
    expect(() => cps(-1, 10)).toThrowError(ToolError);
    try {
      cps(-1, 10);
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-number");
    }
  });

  it("rejects a zero length window", () => {
    try {
      cps(10, 0);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-duration");
    }
  });

  it("rejects a window longer than an hour", () => {
    try {
      cps(10, 3601);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-duration");
    }
  });
});

describe("rank", () => {
  it("names the bands at their boundaries", () => {
    expect(rank(0).label).toBe("Relaxed");
    expect(rank(3.99).label).toBe("Relaxed");
    expect(rank(4).label).toBe("Average");
    expect(rank(5.9).label).toBe("Average");
    expect(rank(6).label).toBe("Fast");
    expect(rank(8).label).toBe("Very fast");
    expect(rank(10).label).toBe("Jitter or butterfly range");
    expect(rank(18).label).toBe("Jitter or butterfly range");
  });

  it("describes the top band as a technique rather than a score", () => {
    expect(rank(12).description).toContain("butterfly clicking");
  });

  it("rejects a value that is not a number of zero or more", () => {
    try {
      rank(Number.NaN);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-number");
    }
    try {
      rank(-2);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-number");
    }
  });
});

describe("summarize", () => {
  it("buckets clicks into whole seconds and averages the rate", () => {
    const stamps = [0, 250, 500, 750, 1000, 1500, 2200, 2400, 2600, 2800];
    const s = summarize(stamps, 5);
    expect(s.clicks).toBe(10);
    expect(s.cps).toBe(2);
    expect(s.perSecond).toEqual([4, 2, 4, 0, 0]);
  });

  it("measures the peak as a sliding window, not a bucket", () => {
    // Five clicks straddling the boundary between second 0 and second 1.
    const s = summarize([800, 900, 1000, 1100, 1200], 5);
    expect(s.perSecond).toEqual([2, 3, 0, 0, 0]);
    expect(s.peakCps).toBe(5);
  });

  it("drops clicks recorded after the window closed", () => {
    const s = summarize([0, 500, 4999, 5000, 5001, 9000], 5);
    expect(s.clicks).toBe(4);
  });

  it("drops values that are not usable timestamps", () => {
    const s = summarize([0, Number.NaN, -5, Number.POSITIVE_INFINITY, 900], 5);
    expect(s.clicks).toBe(2);
  });

  it("sorts unordered timestamps before measuring", () => {
    const ordered = summarize([0, 100, 200, 300], 5);
    const jumbled = summarize([300, 0, 200, 100], 5);
    expect(jumbled).toEqual(ordered);
  });

  it("handles an empty run without dividing by nothing", () => {
    const s = summarize([], 10);
    expect(s.clicks).toBe(0);
    expect(s.cps).toBe(0);
    expect(s.peakCps).toBe(0);
    expect(s.perSecond).toHaveLength(10);
    expect(s.rank.label).toBe("Relaxed");
  });

  it("rejects a window that is not a positive length", () => {
    try {
      summarize([0, 100], -10);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-duration");
    }
  });
});

describe("run", () => {
  it("scores a plain click count against the chosen window", () => {
    const out = run("73", { duration: 10 });
    expect(out["Clicks per second"]).toBe("7.30");
    expect(out["Total clicks"]).toBe("73");
    expect(out["Test length"]).toBe("10 seconds");
    expect(out.Ranking).toBe("Fast");
  });

  it("defaults to the 10 second window", () => {
    expect(run("40", {})["Clicks per second"]).toBe("4.00");
  });

  it("accepts the duration as the string a URL fragment carries", () => {
    expect(run("40", { duration: "5" })["Clicks per second"]).toBe("8.00");
  });

  it("reports peak and per second rows when given timestamps", () => {
    const out = run("0, 100, 200, 1500, 1600, 4900", { duration: 5 });
    expect(out["Total clicks"]).toBe("6");
    expect(out["Peak in any one second"]).toBe("3");
    expect(out["Clicks by second"]).toBe("3, 2, 0, 0, 1");
  });

  it("accepts timestamps separated by spaces or newlines", () => {
    const out = run("0 100\n200;300", { duration: 5 });
    expect(out["Total clicks"]).toBe("4");
  });

  it("throws empty-input on a blank input", () => {
    try {
      run("   ", { duration: 10 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toBeTruthy();
    }
  });

  it("throws bad-number on a token that is not a timestamp", () => {
    try {
      run("0, 100, fast", { duration: 10 });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-number");
    }
  });

  it("throws bad-duration on a window that is not a positive number", () => {
    try {
      run("50", { duration: "soon" });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-duration");
    }
  });

  it("is deterministic for the same input and options", () => {
    const a = run("0, 250, 500, 750", { duration: 5 });
    const b = run("0, 250, 500, 750", { duration: 5 });
    expect(a).toEqual(b);
  });
});
