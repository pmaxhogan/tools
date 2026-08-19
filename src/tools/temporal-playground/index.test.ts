import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

const NY = { timeZone: "America/New_York" };

describe("temporal-playground", () => {
  it("interprets a wall-clock time before the 2026 spring forward as EST", () => {
    const out = run("2026-03-08T01:30", NY);
    expect(out["Input parsed as"]).toContain("Temporal.PlainDateTime");
    expect(out["Offset"]).toContain("-05:00");
    expect(out["DST"]).toContain("standard time");
    expect(out["Instant (UTC)"]).toBe("2026-03-08T06:30:00Z");
  });

  it("interprets a wall-clock time after the 2026 spring forward as EDT", () => {
    const out = run("2026-03-08T03:30", NY);
    expect(out["Offset"]).toContain("-04:00");
    expect(out["DST"]).toContain("daylight saving time");
  });

  it("reports the spring-forward gap instead of crashing", () => {
    const out = run("2026-03-08T02:30", NY);
    expect(out["DST"]).toContain("does not exist due to spring-forward");
    // Resolved forward by the gap length, per the compatible disambiguation.
    expect(out["DST"]).toContain("2026-03-08T03:30:00");
    expect(out["Offset"]).toContain("-04:00");
    expect(out["Instant (UTC)"]).toBe("2026-03-08T07:30:00Z");
  });

  it("reports the fall-back overlap", () => {
    const out = run("2026-11-01T01:30", NY);
    expect(out["DST"]).toContain("happens twice");
    expect(out["Offset"]).toContain("-04:00");
  });

  it("describes a bracketed input in its own zone, not the selected one", () => {
    const out = run("2026-03-07T12:00[America/New_York]", { timeZone: "UTC" });
    expect(out["Offset"]).toBe("-05:00 (America/New_York)");
    expect(out["DST"]).toContain("standard time");
    expect(out["DST"]).not.toContain("does not observe");
  });

  it("flags an exact instant that lands inside the fall-back overlap", () => {
    const earlier = run("2026-11-01T01:30-04:00", NY);
    expect(earlier["DST"]).toContain("happens twice");
    expect(earlier["DST"]).toContain("the earlier of the two instants");
    const later = run("2026-11-01T01:30-05:00", NY);
    expect(later["DST"]).toContain("the later of the two instants");
  });

  it("adds P1D across the spring forward and shows the changed offset", () => {
    const out = run("2026-03-07T12:00[America/New_York]", { ...NY, add: "P1D" });
    expect(out["Input parsed as"]).toContain("Temporal.ZonedDateTime");
    expect(out["Offset"]).toContain("-05:00");
    expect(out["After adding"]).toContain("2026-03-08T12:00");
    expect(out["After adding"]).toContain("-04:00");
    expect(out["After adding"]).toContain("changed from -05:00");
  });

  it("keeps the offset when adding does not cross a transition", () => {
    const out = run("2026-03-01T12:00[America/New_York]", { ...NY, add: "P1D" });
    expect(out["After adding"]).toContain("unchanged");
  });

  it("adds a mixed duration to a zoned date-time", () => {
    const out = run("2026-01-31T09:00[Europe/Paris]", {
      timeZone: "Europe/Paris",
      add: "P1M2DT3H",
    });
    expect(out["After adding"]).toContain("2026-03-02T12:00");
  });

  it("handles a date-only input by anchoring to start of day", () => {
    const out = run("2026-12-31", NY);
    expect(out["Input parsed as"]).toContain("Temporal.PlainDate");
    expect(out["Anchored to"]).toContain("Start of day in America/New_York");
    expect(out["Day of year"]).toBe("365 of 365");
    expect(out["ISO week"]).toBe("2026-W53");
    expect(out["Day of week"]).toContain("Thursday");
  });

  it("reports a leap day and its calendar facts", () => {
    const out = run("2024-02-29", { timeZone: "UTC" });
    expect(out["Leap year"]).toContain("Yes");
    expect(out["Days in month"]).toBe("29 (February 2024)");
    expect(out["Day of year"]).toBe("60 of 366");
    expect(out["ISO week"]).toBe("2024-W09");
  });

  it("reports a zone without DST as such", () => {
    const out = run("2026-06-15T12:00", { timeZone: "Asia/Kolkata" });
    expect(out["Offset"]).toContain("+05:30");
    expect(out["DST"]).toContain("does not observe daylight saving time");
    expect(out["Next DST change"]).toContain("No further offset change");
  });

  it("parses an instant with a UTC designator and shows it in the chosen zone", () => {
    const out = run("2026-03-08T12:00:00Z", NY);
    expect(out["Input parsed as"]).toContain("Temporal.Instant");
    expect(out["Epoch ms"]).toBe(String(Date.UTC(2026, 2, 8, 12, 0, 0)));
    expect(out["Epoch seconds"]).toBe(String(Date.UTC(2026, 2, 8, 12, 0, 0) / 1000));
    expect(out["Offset"]).toContain("-04:00");
  });

  it("parses an instant given with a numeric offset", () => {
    const out = run("2026-03-08T01:30-05:00", NY);
    expect(out["Instant (UTC)"]).toBe("2026-03-08T06:30:00Z");
  });

  it("names the next DST transition", () => {
    const out = run("2026-03-01T12:00", NY);
    expect(out["Next DST change"]).toContain("2026-03-08T03:00:00");
    expect(out["Next DST change"]).toContain("-05:00 becomes -04:00");
  });

  it("throws a ToolError on empty input", () => {
    expect(() => run("", { timeZone: "UTC" })).toThrowError(ToolError);
    try {
      run("   ", { timeZone: "UTC" });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toContain("2026-03-08T01:30");
    }
  });

  it("throws a ToolError on an unparseable date", () => {
    expect(() => run("not-a-date", { timeZone: "UTC" })).toThrowError(ToolError);
    try {
      run("not-a-date", { timeZone: "UTC" });
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-date");
      expect((e as ToolError).fix).toContain("ISO 8601");
    }
  });

  it("throws a ToolError on an unparseable duration", () => {
    try {
      run("2026-03-08", { timeZone: "UTC", add: "one day" });
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-duration");
      expect((e as ToolError).fix).toContain("P1M2DT3H");
    }
  });

  it("throws a ToolError on an unknown time zone", () => {
    try {
      run("2026-03-08", { timeZone: "Mars/Olympus" });
      throw new Error("expected a ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("bad-timezone");
    }
  });

  it("is deterministic for the same input", () => {
    expect(run("2026-03-08T01:30", NY)).toEqual(run("2026-03-08T01:30", NY));
  });
});
