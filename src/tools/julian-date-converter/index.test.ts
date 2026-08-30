import { describe, expect, it } from "vitest";
import {
  calendarToJd,
  degreesToHms,
  deltaTSeconds,
  greenwichMeanSiderealDegrees,
  isoWeekDate,
  jdToCalendar,
  parseLongitude,
  run,
  weekdayOf,
  JD_J2000,
  JD_UNIX_EPOCH,
  MJD_OFFSET,
} from "./index";
import { ToolError } from "../types";

/**
 * Reference values and where they come from:
 *
 * - JD 2451545.0 = 2000-01-01T12:00 and JD 2440587.5 = the Unix epoch:
 *   IAU standard epoch J2000.0, and the definition of Unix time. Both are
 *   fixed by definition rather than measured.
 * - MJD 0 = 1858-11-17T00:00: the definition of Modified Julian Date,
 *   MJD = JD - 2400000.5.
 * - 1957 October 4.81 UT = JD 2436116.31: Jean Meeus, "Astronomical
 *   Algorithms" 2nd edition, example 7.a (the launch of Sputnik 1).
 * - 333 January 27 at 12h in the Julian calendar = JD 1842713.0: Meeus,
 *   example 7.b.
 * - GMST on 1987 April 10 at 0h UT = 13h 10m 46.3668s: Meeus example 12.a.
 * - GMST on 1987 April 10 at 19h 21m 00s UT = 8h 34m 57.0896s: Meeus
 *   example 12.b.
 * - Delta T anchor values: the Espenak and Meeus polynomial expressions
 *   published with the NASA Five Millennium Canon of Solar Eclipses. The
 *   1900, 1950 and 2000 constants are the leading terms of their own
 *   pieces, so they are the fitted values at those epochs.
 * - 1234567890 Unix = 2009-02-13T23:31:30Z: the definition of Unix time.
 */

const M = { year: 2000, month: 1, day: 1.5 };

describe("calendarToJd", () => {
  it("puts the standard epoch J2000.0 at JD 2451545.0", () => {
    expect(calendarToJd(M, "gregorian")).toBe(JD_J2000);
  });

  it("puts the Unix epoch at JD 2440587.5", () => {
    expect(calendarToJd({ year: 1970, month: 1, day: 1 }, "gregorian")).toBe(JD_UNIX_EPOCH);
  });

  it("puts MJD zero on 1858 November 17", () => {
    expect(calendarToJd({ year: 1858, month: 11, day: 17 }, "gregorian")).toBe(MJD_OFFSET);
  });

  it("matches Meeus example 7.a, Sputnik on 1957 October 4.81", () => {
    expect(calendarToJd({ year: 1957, month: 10, day: 4.81 }, "gregorian")).toBeCloseTo(
      2436116.31,
      6,
    );
  });

  it("matches Meeus example 7.b, 333 January 27.5 in the Julian calendar", () => {
    expect(calendarToJd({ year: 333, month: 1, day: 27.5 }, "julian")).toBe(1842713);
  });

  it("joins the two calendars across the 1582 reform", () => {
    // 1582 October 4 Julian was followed directly by October 15 Gregorian.
    expect(calendarToJd({ year: 1582, month: 10, day: 4 }, "julian")).toBe(
      calendarToJd({ year: 1582, month: 10, day: 14 }, "gregorian"),
    );
  });
});

describe("jdToCalendar", () => {
  it("inverts calendarToJd on a spread of dates", () => {
    const cases = [
      { year: 2026, month: 8, day: 30.25 },
      { year: 1900, month: 2, day: 28 },
      { year: 1600, month: 12, day: 31.75 },
      { year: -1000, month: 6, day: 15.5 },
    ];
    for (const c of cases) {
      const back = jdToCalendar(calendarToJd(c, "gregorian"), "gregorian");
      expect(back.year).toBe(c.year);
      expect(back.month).toBe(c.month);
      expect(back.day).toBeCloseTo(c.day, 6);
    }
  });

  it("reads J2000.0 back as 2000 January 1.5", () => {
    const back = jdToCalendar(JD_J2000, "gregorian");
    expect(back).toEqual({ year: 2000, month: 1, day: 1.5 });
  });
});

describe("weekdayOf", () => {
  it("knows 2000 January 1 was a Saturday", () => {
    expect(weekdayOf(2451544.5)).toBe("Saturday");
    expect(weekdayOf(JD_J2000)).toBe("Saturday");
  });

  it("advances one weekday per day", () => {
    expect(weekdayOf(2451545.5)).toBe("Sunday");
    expect(weekdayOf(2451546.5)).toBe("Monday");
  });
});

describe("isoWeekDate", () => {
  it("puts 2026 January 1, a Thursday, in 2026-W01", () => {
    expect(isoWeekDate(2026, 1, 1)).toEqual({ year: 2026, week: 1, weekday: 4 });
  });

  it("puts 2027 January 1, a Friday, in the last week of 2026", () => {
    expect(isoWeekDate(2027, 1, 1)).toEqual({ year: 2026, week: 53, weekday: 5 });
  });

  it("puts 2000 January 1, a Saturday, in the last week of 1999", () => {
    expect(isoWeekDate(2000, 1, 1)).toEqual({ year: 1999, week: 52, weekday: 6 });
  });
});

describe("greenwichMeanSiderealDegrees", () => {
  it("matches Meeus example 12.a at 0h UT on 1987 April 10", () => {
    const gmst = greenwichMeanSiderealDegrees(2446895.5);
    expect(degreesToHms(gmst)).toBe("13h 10m 46.3668s");
  });

  it("matches Meeus example 12.b at 19:21:00 UT on 1987 April 10", () => {
    const gmst = greenwichMeanSiderealDegrees(2446895.5 + 19.35 / 24);
    expect(degreesToHms(gmst)).toBe("08h 34m 57.0896s");
  });
});

describe("deltaTSeconds", () => {
  it("matches the Espenak and Meeus anchors", () => {
    expect(deltaTSeconds(1900)).toBeCloseTo(-2.79, 2);
    expect(deltaTSeconds(1950)).toBeCloseTo(29.07, 2);
    expect(deltaTSeconds(2000)).toBeCloseTo(63.86, 2);
  });

  it("stays continuous where two polynomial pieces meet", () => {
    expect(deltaTSeconds(2004.999)).toBeCloseTo(deltaTSeconds(2005.001), 0);
    expect(deltaTSeconds(1985.999)).toBeCloseTo(deltaTSeconds(1986.001), 0);
  });

  it("grows quadratically in the deep past", () => {
    // The parabola -20 + 32u^2 with u in centuries from 1820.
    expect(deltaTSeconds(-1000)).toBeCloseTo(25400, -2);
  });
});

describe("parseLongitude", () => {
  it("reads decimal degrees and hemisphere letters the same way", () => {
    expect(parseLongitude("-90.1994")).toBeCloseTo(-90.1994, 6);
    expect(parseLongitude("90.1994 W")).toBeCloseTo(-90.1994, 6);
    expect(parseLongitude("13.405 E")).toBeCloseTo(13.405, 6);
  });

  it("returns null when nothing was given", () => {
    expect(parseLongitude("")).toBeNull();
    expect(parseLongitude(undefined)).toBeNull();
  });

  it("rejects a longitude off the planet", () => {
    expect(() => parseLongitude("400")).toThrow(ToolError);
  });

  it("rejects text that is not a longitude", () => {
    expect(() => parseLongitude("somewhere")).toThrow(/longitude/i);
  });
});

describe("run", () => {
  it("converts a calendar date to the Julian Date family", () => {
    const out = run("2000-01-01 12:00:00");
    expect(out["Julian Date (JD)"]).toBe("2451545.00000000");
    expect(out["Modified Julian Date (MJD)"]).toBe("51544.50000000");
    expect(out["Unix time (seconds)"]).toBe("946728000.000");
    expect(out["Date and time (UTC)"]).toContain("Saturday");
  });

  it("converts a Julian Date back to a calendar date", () => {
    const out = run("JD 2451545.0");
    expect(out["ISO 8601"]).toBe("2000-01-01T12:00:00Z");
    expect(out["Julian day number"]).toBe("2451545");
  });

  it("reads a Modified Julian Date", () => {
    const out = run("MJD 0");
    expect(out["ISO 8601"]).toBe("1858-11-17T00:00:00Z");
  });

  it("reads a Unix time", () => {
    const out = run("unix 1234567890");
    expect(out["ISO 8601"]).toBe("2009-02-13T23:31:30Z");
    expect(out["Input read as"]).toContain("Unix time");
  });

  it("reads @ prefixed Unix time the way date(1) does", () => {
    const out = run("@0");
    expect(out["Julian Date (JD)"]).toBe("2440587.50000000");
  });

  it("treats a bare number in Julian Date range as a Julian Date", () => {
    const out = run("2451545");
    expect(out["ISO 8601"]).toBe("2000-01-01T12:00:00Z");
    expect(out["Input read as"]).toContain("Julian Date");
  });

  it("treats a bare number too large for a Julian Date as Unix seconds", () => {
    const out = run("1234567890");
    expect(out["ISO 8601"]).toBe("2009-02-13T23:31:30Z");
  });

  it("applies a UTC offset carried by the input", () => {
    const withOffset = run("2000-01-01T13:00:00+01:00");
    expect(withOffset["Julian Date (JD)"]).toBe("2451545.00000000");
  });

  it("reports the ISO week date and the day of year", () => {
    const out = run("2026-01-01");
    expect(out["ISO week date"]).toBe("2026-W01-4 (Thursday)");
    expect(out["Day of year"]).toBe("1 of 365");
  });

  it("reports sidereal time, and local sidereal time when a longitude is set", () => {
    const bare = run("1987-04-10 00:00:00");
    expect(bare["Greenwich mean sidereal time"]).toContain("13h 10m 46.3668s");
    expect(bare["Local mean sidereal time"]).toBeUndefined();

    const local = run("1987-04-10 00:00:00", { longitude: "0" });
    expect(local["Local mean sidereal time"]).toContain("13h 10m 46.3668s");
  });

  it("switches calendar on the historical reform date by default", () => {
    const before = run("1582-10-04");
    expect(before["Date and time (UTC)"]).toContain("Julian calendar");
    const after = run("1582-10-15");
    expect(after["Date and time (UTC)"]).toContain("Gregorian calendar");
    // The two days are consecutive Julian Days despite the ten day jump.
    expect(Number(after["Julian Date (JD)"]) - Number(before["Julian Date (JD)"])).toBe(1);
  });

  it("forces one calendar throughout when asked", () => {
    const proleptic = run("1582-10-04", { calendar: "gregorian" });
    expect(proleptic["Date and time (UTC)"]).toContain("Gregorian calendar");
    expect(Number(proleptic["Julian Date (JD)"])).toBeCloseTo(2299149.5, 6);
  });

  it("adds the deep rows only in full detail", () => {
    const summary = run("2026-08-30");
    expect(summary["Julian epoch"]).toBeUndefined();
    const full = run("2026-08-30", { detail: "full" });
    expect(full["Julian epoch"]).toMatch(/^J2026\./);
    expect(full["Truncated Julian Date (TJD)"]).toBeDefined();
    expect(full["Rata Die"]).toBeDefined();
    expect(full["Calendar difference"]).toContain("13 days");
  });

  it("uses the injected now for an empty input", () => {
    const out = run("", { now: 946728000000 });
    expect(out["Julian Date (JD)"]).toBe("2451545.00000000");
    expect(out["Input read as"]).toContain("current moment");
  });

  it("ignores comment lines", () => {
    const out = run("# a note\n2000-01-01 12:00:00");
    expect(out["Julian Date (JD)"]).toBe("2451545.00000000");
  });

  it("round trips a date through JD and back", () => {
    const first = run("2026-08-30 18:45:30");
    const second = run(`JD ${first["Julian Date (JD)"]}`);
    expect(second["ISO 8601"]).toBe("2026-08-30T18:45:30Z");
  });

  it("names the ten days the Gregorian reform skipped", () => {
    expect(() => run("1582-10-10")).toThrow(ToolError);
    expect(() => run("1582-10-10")).toThrow(/never happened/i);
  });

  it("rejects an impossible month", () => {
    expect(() => run("2026-13-01")).toThrow(/no month 13/i);
  });

  it("rejects an impossible day", () => {
    expect(() => run("2026-01-45")).toThrow(/no day/i);
  });

  it("rejects text that is neither a date nor a day number", () => {
    expect(() => run("sometime next Tuesday")).toThrow(ToolError);
  });

  it("rejects a Julian Date far outside the covered range", () => {
    expect(() => run("JD 99999999")).toThrow(/outside the range/i);
  });

  it("rejects a longitude that is not a number", () => {
    expect(() => run("2026-08-30", { longitude: "east a bit" })).toThrow(ToolError);
  });
});
