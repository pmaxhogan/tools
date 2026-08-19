import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  decodeTimerState,
  encodeTimerState,
  formatRemaining,
  formatStopwatch,
  lapStats,
  parseDuration,
  parseTarget,
  renderChimeSamples,
  run,
  timerProgress,
} from "./index";

describe("parseDuration", () => {
  it('parses "5m" as 300 seconds', () => {
    expect(parseDuration("5m")).toBe(300);
  });

  it('parses "1h 30m" as 5400 seconds', () => {
    expect(parseDuration("1h 30m")).toBe(5400);
  });

  it('parses "90s" as 90 seconds', () => {
    expect(parseDuration("90s")).toBe(90);
  });

  it('parses "00:05:00" (hh:mm:ss) as 300 seconds', () => {
    expect(parseDuration("00:05:00")).toBe(300);
  });

  it('parses "2:30" (mm:ss) as 150 seconds', () => {
    expect(parseDuration("2:30")).toBe(150);
  });

  it("parses a bare number as seconds", () => {
    expect(parseDuration("45")).toBe(45);
  });

  it("throws bad-duration for empty input", () => {
    expect(() => parseDuration("")).toThrow(ToolError);
    try {
      parseDuration("  ");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-duration");
    }
  });

  it("throws bad-duration for unparsable text", () => {
    expect(() => parseDuration("banana")).toThrow(ToolError);
    try {
      parseDuration("banana");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-duration");
      expect((e as ToolError).fix).toBeTruthy();
    }
  });
});

describe("parseTarget", () => {
  it("parses a plain ISO date/time as UTC", () => {
    expect(parseTarget("2026-12-31T23:59")).toBe(Date.UTC(2026, 11, 31, 23, 59, 0));
  });

  it("parses a date/time with an explicit Z as an instant", () => {
    expect(parseTarget("2026-12-31T23:59:00Z")).toBe(Date.UTC(2026, 11, 31, 23, 59, 0));
  });

  it("parses a date/time with a numeric offset as an instant", () => {
    expect(parseTarget("2026-12-31T23:59:00-05:00")).toBe(Date.UTC(2027, 0, 1, 4, 59, 0));
  });

  it("parses a date/time with an embedded IANA zone", () => {
    // 2026-12-31 15:00 America/Chicago is CST (UTC-6): 21:00 UTC.
    const ms = parseTarget("2026-12-31 15:00 America/Chicago");
    expect(ms).toBe(Date.UTC(2026, 11, 31, 21, 0, 0));
  });

  it("accepts a zone via the tz argument instead of embedded text", () => {
    const embedded = parseTarget("2026-12-31 15:00 America/Chicago");
    const viaArg = parseTarget("2026-12-31 15:00", "America/Chicago");
    expect(viaArg).toBe(embedded);
  });

  it("throws bad-target for empty input", () => {
    expect(() => parseTarget("")).toThrow(ToolError);
    try {
      parseTarget("");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-target");
    }
  });

  it("throws bad-target for unparsable text", () => {
    expect(() => parseTarget("not a date")).toThrow(ToolError);
    try {
      parseTarget("2026-99-99T99:99");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-target");
    }
  });

  it("throws bad-target for an unknown embedded zone", () => {
    expect(() => parseTarget("2026-12-31 15:00 Mars/Olympus")).toThrow(ToolError);
  });
});

describe("formatRemaining", () => {
  const ms = ((1 * 60 + 2) * 60 + 3) * 1000; // 1h 2m 3s

  it("formats the clock style", () => {
    expect(formatRemaining(ms, { style: "clock" })).toBe("01:02:03");
  });

  it("formats the words style", () => {
    expect(formatRemaining(ms, { style: "words" })).toBe("1 hour 2 minutes 3 seconds");
  });

  it("formats the compact style", () => {
    expect(formatRemaining(ms, { style: "compact" })).toBe("1h 2m 3s");
  });

  it("defaults to the clock style", () => {
    expect(formatRemaining(ms, {})).toBe("01:02:03");
  });

  it("resolves style synonyms", () => {
    expect(formatRemaining(ms, { style: "verbose" })).toBe("1 hour 2 minutes 3 seconds");
    expect(formatRemaining(ms, { style: "short" })).toBe("1h 2m 3s");
  });

  it("includes days when present", () => {
    const twoDays = ms + 2 * 86400 * 1000;
    expect(formatRemaining(twoDays, { style: "clock" })).toBe("2d 01:02:03");
    expect(formatRemaining(twoDays, { style: "words" })).toBe("2 days 1 hour 2 minutes 3 seconds");
    expect(formatRemaining(twoDays, { style: "compact" })).toBe("2d 1h 2m 3s");
  });

  it("formats negative durations as overdue", () => {
    expect(formatRemaining(-ms, { style: "clock" })).toBe("overdue by 01:02:03");
    expect(formatRemaining(-5000, { style: "compact" })).toBe("overdue by 5s");
  });

  it("formats a zero duration as all-zero, not blank", () => {
    expect(formatRemaining(0, { style: "clock" })).toBe("00:00:00");
    expect(formatRemaining(0, { style: "words" })).toBe("0 seconds");
    expect(formatRemaining(0, { style: "compact" })).toBe("0s");
  });
});

describe("formatStopwatch", () => {
  it('formats 1 minute 23.45 seconds as "00:01:23.45"', () => {
    expect(formatStopwatch(83450)).toBe("00:01:23.45");
  });

  it("formats zero", () => {
    expect(formatStopwatch(0)).toBe("00:00:00.00");
  });

  it("formats over an hour", () => {
    expect(formatStopwatch(3661000)).toBe("01:01:01.00");
  });
});

describe("lapStats", () => {
  it("computes fastest, slowest, average, and total", () => {
    const stats = lapStats([1000, 3000, 2000]);
    expect(stats.fastest).toBe(1000);
    expect(stats.slowest).toBe(3000);
    expect(stats.average).toBe(2000);
    expect(stats.total).toBe(6000);
  });

  it("handles a single lap", () => {
    const stats = lapStats([500]);
    expect(stats).toEqual({ fastest: 500, slowest: 500, average: 500, total: 500 });
  });

  it("returns all zeros for an empty array", () => {
    expect(lapStats([])).toEqual({ fastest: 0, slowest: 0, average: 0, total: 0 });
  });
});

describe("encodeTimerState / decodeTimerState", () => {
  it("round trips a countdown state", () => {
    const state = { kind: "countdown" as const, seconds: 300, startedAtMs: 1_700_000_000_000 };
    const decoded = decodeTimerState(encodeTimerState(state));
    expect(decoded).toEqual(state);
  });

  it("round trips an until state with a label", () => {
    const state = {
      kind: "until" as const,
      targetMs: 1_800_000_000_000,
      label: "Launch: T-minus zero",
    };
    const decoded = decodeTimerState(encodeTimerState(state));
    expect(decoded).toEqual(state);
  });

  it("round trips a stopwatch state", () => {
    const state = { kind: "stopwatch" as const, startedAtMs: 1_650_000_000_000 };
    const decoded = decodeTimerState(encodeTimerState(state));
    expect(decoded).toEqual(state);
  });

  it("is tolerant of an empty string", () => {
    expect(decodeTimerState("")).toEqual({ kind: "countdown" });
  });

  it("is tolerant of garbage input", () => {
    const decoded = decodeTimerState("not-a-real-state:::");
    expect(decoded.kind).toBe("countdown");
  });

  it("produces a compact, fragment-safe string (no raw spaces)", () => {
    const encoded = encodeTimerState({ kind: "until", targetMs: 1_800_000_000_000, label: "Tea time" });
    expect(encoded).not.toMatch(/\s/);
  });
});

describe("timerProgress", () => {
  it("is 0 right at the start", () => {
    expect(timerProgress(1000, 60, 1000)).toBe(0);
  });

  it("is 0.5 halfway through", () => {
    expect(timerProgress(0, 60, 30_000)).toBe(0.5);
  });

  it("clamps to 1 after the end", () => {
    expect(timerProgress(0, 60, 120_000)).toBe(1);
  });

  it("clamps to 0 before the start", () => {
    expect(timerProgress(10_000, 60, 0)).toBe(0);
  });

  it("treats a non-positive duration as already complete", () => {
    expect(timerProgress(0, 0, 0)).toBe(1);
  });
});

describe("renderChimeSamples", () => {
  it("renders a non-empty buffer with samples in range", () => {
    const samples = renderChimeSamples(44100);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples).toBeInstanceOf(Float32Array);
    let peak = 0;
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
      peak = Math.max(peak, Math.abs(s));
    }
    expect(peak).toBeGreaterThan(0.1);
  });

  it("scales length with sample rate", () => {
    const at44100 = renderChimeSamples(44100);
    const at48000 = renderChimeSamples(48000);
    expect(at48000.length).toBeGreaterThan(at44100.length);
  });

  it("throws bad-option for a non-positive sample rate", () => {
    expect(() => renderChimeSamples(0)).toThrow(ToolError);
    try {
      renderChimeSamples(-1);
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-option");
    }
  });
});

describe("run", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);

  it("explains the panel for empty input", () => {
    const out = run("", { style: "clock" });
    expect(out["Countdown timer"]).toBeTruthy();
    expect(out.Stopwatch).toBeTruthy();
    expect(out.Alarm).toBeTruthy();
  });

  it("treats a duration as a countdown from now", () => {
    const out = run("5m", { style: "clock", now });
    expect(out.Kind).toMatch(/Countdown/);
    expect(out["Duration/Target"]).toBe("5m");
    expect(out["Remaining now"]).toBe("00:05:00");
    expect(out["Ends at"]).toContain(new Date(now + 300_000).toISOString());
    expect(out["Share link fragment"]).toBeTruthy();

    const decoded = decodeTimerState(out["Share link fragment"]!);
    expect(decoded.kind).toBe("countdown");
    expect(decoded.seconds).toBe(300);
    expect(decoded.startedAtMs).toBe(now);
  });

  it("treats an ISO date/time as an until target", () => {
    const out = run("2026-06-01T12:00", { style: "clock", now });
    expect(out.Kind).toMatch(/Until/);
    const targetMs = Date.UTC(2026, 5, 1, 12, 0, 0);
    expect(out["Ends at"]).toContain(new Date(targetMs).toISOString());

    const decoded = decodeTimerState(out["Share link fragment"]!);
    expect(decoded.kind).toBe("until");
    expect(decoded.targetMs).toBe(targetMs);
  });

  it("reports overdue remaining time for a past target", () => {
    const past = Date.UTC(2025, 0, 1, 0, 0, 0);
    const out = run("2025-01-01T00:00", { style: "clock", now: past + 5000 });
    expect(out["Remaining now"]).toMatch(/^overdue by/);
  });

  it("respects the style option", () => {
    const out = run("90s", { style: "words", now });
    expect(out["Remaining now"]).toBe("1 minute 30 seconds");
  });

  it("propagates bad-duration for unparsable non-date input", () => {
    expect(() => run("not a duration", { style: "clock", now })).toThrow(ToolError);
  });

  it("propagates bad-target for a date-shaped but invalid input", () => {
    expect(() => run("2026-99-99T99:99", { style: "clock", now })).toThrow(ToolError);
  });
});
