import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  apparentSiderealTime,
  deltaTSeconds,
  horizontalFrom,
  illumination,
  julianDay,
  moonEvents,
  moonPosition,
  moonSnapshot,
  msFromJulianDay,
  nextPhase,
  phaseJde,
  phaseName,
  previousPhase,
  run,
  sunState,
  terminatorPath,
  topocentricMoon,
} from "./index";

/**
 * Ground truth comes from two independent places, on purpose.
 *
 * The chapter 47 and chapter 49 anchors are Meeus's own worked examples, which
 * check the transcription of the series tables digit for digit.
 *
 * Everything else is JPL Horizons, queried at
 * https://ssd.jpl.nasa.gov/api/horizons.api with CENTER='500@399' for the
 * geocentric rows and SITE_COORD='-90.1994,38.627,0.15' with
 * CENTER='coord@399' for the St Louis rows. Horizons is a full numerical
 * ephemeris, so agreement there is a real check on the whole chain rather than
 * a check that two transcriptions of the same book agree with each other.
 */

const AU_KM = 149_597_870.7;

/** Right ascension in hours, minutes and seconds, as degrees. */
function hms(h: number, m: number, s: number): number {
  return (h + m / 60 + s / 3600) * 15;
}

/** Declination in degrees, arcminutes and arcseconds, as degrees. */
function dms(sign: number, d: number, m: number, s: number): number {
  return sign * (d + m / 60 + s / 3600);
}

describe("moonPosition (Meeus chapter 47)", () => {
  it("reproduces Meeus example 47.a for 1992 April 12.0 TD", () => {
    // JDE 2448724.5. Meeus prints apparent longitude 133.167265 degrees,
    // latitude -3.229126, distance 368409.7 km, apparent right ascension
    // 134.688470 and declination +13.768368.
    const moon = moonPosition(2448724.5);
    expect(moon.longitude).toBeCloseTo(133.167265, 3);
    expect(moon.latitude).toBeCloseTo(-3.229126, 4);
    expect(moon.distanceKm).toBeCloseTo(368409.7, 0);
    expect(moon.ra).toBeCloseTo(134.68847, 2);
    expect(moon.dec).toBeCloseTo(13.768368, 2);
  });

  it("reports the equatorial horizontal parallax Meeus gives, 0.991990 degrees", () => {
    expect(moonPosition(2448724.5).parallax).toBeCloseTo(0.99199, 4);
  });

  it("matches JPL Horizons on 2024-01-25 00:00 UT", () => {
    const ms = Date.UTC(2024, 0, 25);
    const jde = julianDay(ms) + deltaTSeconds(julianDay(ms)) / 86400;
    const moon = moonPosition(jde);
    // Horizons ObsEcLon/ObsEcLat 116.1019012 / +4.9673423, delta 0.00266806097357 au,
    // apparent RA/Dec 07 56 32.32 / +25 48 15.6.
    expect(moon.longitude).toBeCloseTo(116.1019012, 2);
    expect(moon.latitude).toBeCloseTo(4.9673423, 2);
    expect(Math.abs(moon.distanceKm - 0.00266806097357 * AU_KM)).toBeLessThan(30);
    expect(Math.abs(moon.ra - hms(7, 56, 32.32))).toBeLessThan(0.01);
    expect(Math.abs(moon.dec - dms(1, 25, 48, 15.6))).toBeLessThan(0.01);
  });

  it("matches JPL Horizons on 2026-08-30 00:00 UT, across the zero of longitude", () => {
    const ms = Date.UTC(2026, 7, 30);
    const jde = julianDay(ms) + deltaTSeconds(julianDay(ms)) / 86400;
    const moon = moonPosition(jde);
    // Horizons 358.5512942 / +2.5404011, delta 0.00256651630652 au,
    // apparent RA/Dec 23 50 38.49 / +01 45 16.9.
    expect(moon.longitude).toBeCloseTo(358.5512942, 2);
    expect(moon.latitude).toBeCloseTo(2.5404011, 2);
    expect(Math.abs(moon.distanceKm - 0.00256651630652 * AU_KM)).toBeLessThan(30);
    expect(Math.abs(moon.ra - hms(23, 50, 38.49))).toBeLessThan(0.01);
    expect(Math.abs(moon.dec - dms(1, 1, 45, 16.9))).toBeLessThan(0.01);
  });
});

describe("sunState (Meeus chapter 25)", () => {
  it("matches JPL Horizons for the Sun on 2024-01-01 00:00 UT", () => {
    const ms = Date.UTC(2024, 0, 1);
    const jde = julianDay(ms) + deltaTSeconds(julianDay(ms)) / 86400;
    const sun = sunState(jde);
    // Horizons apparent RA/Dec 18 43 41.03 / -23 03 30.5, delta 0.98331828203968 au.
    expect(Math.abs(sun.ra - hms(18, 43, 41.03))).toBeLessThan(0.01);
    expect(Math.abs(sun.dec - dms(-1, 23, 3, 30.5))).toBeLessThan(0.01);
    // The chapter 25 series is the low accuracy one, good to about 1e-5 au.
    expect(Math.abs(sun.distanceAu - 0.98331828203968)).toBeLessThan(3e-5);
  });
});

describe("illumination (Meeus chapter 48)", () => {
  it("matches the Horizons illuminated fraction on 2024-01-25", () => {
    const ms = Date.UTC(2024, 0, 25);
    const snapshot = moonSnapshot(ms);
    // Horizons Illu% 99.28285 at the geocenter.
    expect(snapshot.light.fraction * 100).toBeCloseTo(99.28285, 1);
    expect(snapshot.light.waxing).toBe(true);
  });

  it("matches the Horizons illuminated fraction on 2026-08-30", () => {
    const snapshot = moonSnapshot(Date.UTC(2026, 7, 30));
    // Horizons Illu% 96.36850.
    expect(snapshot.light.fraction * 100).toBeCloseTo(96.3685, 1);
    expect(snapshot.light.waxing).toBe(false);
  });

  it("puts the phase angle near 180 degrees at new moon and near 0 at full", () => {
    const newMoon = nextPhase("new", Date.UTC(2024, 3, 1));
    const full = nextPhase("full", Date.UTC(2024, 0, 20));
    expect(moonSnapshot(newMoon.ms).light.phaseAngle).toBeGreaterThan(174);
    // A full moon is a conjunction in longitude, not an eclipse, so what is
    // left of the phase angle is the Moon's own ecliptic latitude.
    const atFull = moonSnapshot(full.ms);
    expect(atFull.light.phaseAngle).toBeLessThan(6);
    expect(atFull.light.phaseAngle).toBeCloseTo(Math.abs(atFull.position.latitude), 1);
  });

  it("uses the tool's own illumination helper on a position and a sun", () => {
    const jde = 2448724.5;
    const light = illumination(moonPosition(jde), sunState(jde));
    expect(light.fraction).toBeGreaterThan(0);
    expect(light.fraction).toBeLessThan(1);
    expect(light.phaseLongitude).toBeCloseTo(
      (moonPosition(jde).longitude - sunState(jde).longitude + 360) % 360,
      6,
    );
  });
});

describe("phaseJde (Meeus chapter 49)", () => {
  it("reproduces example 49.a, the new moon of 1977 February", () => {
    // Meeus prints the mean phase as JDE 2443192.94102 and the corrected
    // answer as 1977 February 18.15118 TD, which is JDE 2443192.65118. That
    // instant is 1977-02-18 03:37 UT once Delta T is taken off, which is the
    // new moon the almanacs of the day printed.
    expect(phaseJde(-283)).toBeCloseTo(2443192.65118, 4);
  });

  it("reproduces example 49.b, the last quarter of 2044 January", () => {
    expect(phaseJde(544.75)).toBeCloseTo(2467636.49186, 4);
  });

  it("is within two minutes of the published full moon of 2024-01-25 17:54 UT", () => {
    const event = nextPhase("full", Date.UTC(2024, 0, 20));
    const published = Date.UTC(2024, 0, 25, 17, 54);
    expect(Math.abs(event.ms - published)).toBeLessThan(2 * 60_000);
  });

  it("is within two minutes of the published new moon of 2024-04-08 18:21 UT", () => {
    const event = nextPhase("new", Date.UTC(2024, 3, 5));
    const published = Date.UTC(2024, 3, 8, 18, 21);
    expect(Math.abs(event.ms - published)).toBeLessThan(2 * 60_000);
  });

  it("ties chapter 49 to chapter 47: the disc is fully lit at the computed full moon", () => {
    const full = nextPhase("full", Date.UTC(2024, 0, 20));
    expect(moonSnapshot(full.ms).light.fraction).toBeGreaterThan(0.998);
  });

  it("ties chapter 49 to chapter 47: the disc is dark at the computed new moon", () => {
    const dark = nextPhase("new", Date.UTC(2024, 3, 5));
    expect(moonSnapshot(dark.ms).light.fraction).toBeLessThan(0.005);
  });

  it("steps the four phases in order inside one lunation", () => {
    const from = Date.UTC(2026, 0, 1);
    const times = (["new", "first-quarter", "full", "last-quarter"] as const).map(
      (kind) => nextPhase(kind, from).ms,
    );
    for (const ms of times) expect(ms).toBeGreaterThanOrEqual(from);
    // Every one lands inside the next synodic month.
    for (const ms of times) expect(ms - from).toBeLessThan(30 * 86_400_000);
  });

  it("finds a previous phase strictly at or before the instant asked about", () => {
    const now = Date.UTC(2026, 5, 15);
    const last = previousPhase("new", now);
    expect(last.ms).toBeLessThanOrEqual(now);
    expect(now - last.ms).toBeLessThan(30 * 86_400_000);
  });

  it("numbers lunations the way almanacs do", () => {
    // Meeus k = 0 is the new moon of 2000 January 6, Brown lunation 953.
    expect(previousPhase("new", msFromJulianDay(phaseJde(0) + 1)).lunation).toBe(953);
  });
});

describe("topocentric position and the events of a day", () => {
  const LAT = 38.627;
  const LON = -90.1994;

  it("matches Horizons for the Moon over St Louis at 2024-01-01 00:00 UT", () => {
    const ms = Date.UTC(2024, 0, 1);
    const jd = julianDay(ms);
    const moon = moonPosition(jd + deltaTSeconds(jd) / 86400);
    const sidereal = apparentSiderealTime(jd);
    const topo = topocentricMoon(moon, sidereal, LAT, LON);
    const horizontal = horizontalFrom(topo.ra, topo.dec, sidereal, LAT, LON);
    // Horizons topocentric RA/Dec 10 37 56.50 / +11 57 11.0, azimuth 35.783664,
    // airless elevation -31.969758.
    expect(Math.abs(topo.ra - hms(10, 37, 56.5))).toBeLessThan(0.02);
    expect(Math.abs(topo.dec - dms(1, 11, 57, 11))).toBeLessThan(0.02);
    expect(horizontal.azimuth).toBeCloseTo(35.783664, 1);
    expect(horizontal.altitude).toBeCloseTo(-31.969758, 1);
  });

  it("matches Horizons for the Moon over St Louis at 2024-01-01 06:00 UT", () => {
    const ms = Date.UTC(2024, 0, 1, 6);
    const jd = julianDay(ms);
    const moon = moonPosition(jd + deltaTSeconds(jd) / 86400);
    const sidereal = apparentSiderealTime(jd);
    const topo = topocentricMoon(moon, sidereal, LAT, LON);
    const horizontal = horizontalFrom(topo.ra, topo.dec, sidereal, LAT, LON);
    // Horizons azimuth 99.018751, airless elevation 28.320276.
    expect(horizontal.azimuth).toBeCloseTo(99.018751, 1);
    expect(horizontal.altitude).toBeCloseTo(28.320276, 1);
  });

  it("puts moonrise over St Louis on 2024-01-01 within two minutes of 03:24 UT", () => {
    // From the Horizons elevation table at one minute steps: the Moon's center
    // reaches the sea level rise altitude (refraction plus its own semidiameter)
    // between 03:23 and 03:24 UT. Horizons' own r marker sits at 03:22 because
    // it also subtracts the dip of the horizon for the 150 m site elevation.
    const events = moonEvents(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2), LAT, LON);
    expect(events.rise).not.toBeNull();
    expect(Math.abs((events.rise as number) - Date.UTC(2024, 0, 1, 3, 24))).toBeLessThan(
      2 * 60_000,
    );
  });

  it("reports a polar day where the moon never sets", () => {
    // Longyearbyen, 78.22 N, on a day the Moon rides high in declination.
    const events = moonEvents(Date.UTC(2024, 0, 21), Date.UTC(2024, 0, 22), 78.22, 15.65);
    expect(
      events.alwaysUp || events.alwaysDown || events.rise !== null || events.set !== null,
    ).toBe(true);
    if (events.alwaysUp) {
      expect(events.rise).toBeNull();
      expect(events.set).toBeNull();
    }
  });

  it("finds the highest point above the horizon on a normal day", () => {
    const events = moonEvents(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2), LAT, LON);
    expect(events.peakAltitude).toBeGreaterThan(0);
    expect(events.transit).toBeGreaterThan(Date.UTC(2024, 0, 1));
    expect(events.transit).toBeLessThan(Date.UTC(2024, 0, 2));
  });
});

describe("terminatorPath", () => {
  it("draws nothing at new moon", () => {
    expect(terminatorPath(0, true)).toBe("");
  });

  it("collapses the terminator to a straight line at exactly half lit", () => {
    const path = terminatorPath(0.5, true, { cx: 50, cy: 50, r: 40 });
    expect(path).toBe("M50 10A40 40 0 0 1 50 90A0 40 0 0 0 50 10Z");
  });

  it("puts the light on the right while waxing and on the left while waning", () => {
    expect(terminatorPath(0.5, true, { r: 10 })).toContain("A10 10 0 0 1");
    expect(terminatorPath(0.5, false, { r: 10 })).toContain("A10 10 0 0 0");
  });

  it("bulges the terminator the other way once the moon is gibbous", () => {
    const crescent = terminatorPath(0.25, true, { cx: 0, cy: 0, r: 10 });
    const gibbous = terminatorPath(0.75, true, { cx: 0, cy: 0, r: 10 });
    // Same half ellipse either side of half lit, swept the opposite way.
    expect(crescent).toContain("A5 10 0 0 0");
    expect(gibbous).toContain("A5 10 0 0 1");
  });

  it("closes into the whole disc at full moon", () => {
    const path = terminatorPath(1, true, { cx: 0, cy: 0, r: 10 });
    expect(path).toBe("M0 -10A10 10 0 0 1 0 10A10 10 0 0 1 0 -10Z");
  });

  it("flips the orientation for the southern hemisphere", () => {
    const north = terminatorPath(0.3, true, { r: 10 });
    const south = terminatorPath(0.3, true, { r: 10, southern: true });
    expect(north).not.toBe(south);
    expect(south).toBe(terminatorPath(0.3, false, { r: 10 }));
  });
});

describe("phaseName", () => {
  it("names the four cardinal phases inside a narrow window", () => {
    expect(phaseName(0)).toBe("New moon");
    expect(phaseName(359)).toBe("New moon");
    expect(phaseName(90)).toBe("First quarter");
    expect(phaseName(180)).toBe("Full moon");
    expect(phaseName(270)).toBe("Last quarter");
  });

  it("names the four stretches between them", () => {
    expect(phaseName(45)).toBe("Waxing crescent");
    expect(phaseName(135)).toBe("Waxing gibbous");
    expect(phaseName(225)).toBe("Waning gibbous");
    expect(phaseName(315)).toBe("Waning crescent");
  });
});

describe("run", () => {
  const NOW = Date.UTC(2026, 7, 30, 18, 45);

  it("answers for the current moment when the input is empty", () => {
    const out = run("", { now: NOW });
    expect(out.Moment).toContain("right now");
    expect(out.Phase.length).toBeGreaterThan(0);
    expect(out.Illumination).toMatch(/% of the disc is lit/);
    expect(out.Age).toMatch(/days/);
    expect(out.Distance).toMatch(/km from the center of the Earth/);
  });

  it("reads a date on its own and reports local noon", () => {
    const out = run("2024-01-25", { now: NOW });
    expect(out.Moment).toContain("2024-01-25 12:00 UTC");
    expect(out.Moment).toContain("local noon");
    expect(out.Phase).toBe("Full moon");
  });

  it("reads a date and a time together", () => {
    const out = run("2024-01-25 17:54", { now: NOW });
    expect(out.Moment).toContain("2024-01-25 17:54 UTC");
    // The moment of full moon itself: all but a rounding of the disc is lit.
    expect(Number.parseFloat(out.Illumination)).toBeGreaterThan(99.5);
  });

  it("adds rise, set and sky position once a place is given", () => {
    const out = run("St Louis\n2024-01-01", { now: NOW });
    expect(out.Location).toContain("St Louis");
    expect(out.Moonrise).toMatch(/^\d\d:\d\d/);
    expect(out.Moonset).toBeDefined();
    expect(out["Altitude now"]).toMatch(/degrees/);
    expect(out["Azimuth now"]).toMatch(/degrees, [NSEW]/);
  });

  it("reads coordinates with hemisphere letters and its own time zone", () => {
    const out = run("33.8688 S, 151.2093 E\n2026-03-01\ntz Australia/Sydney", { now: NOW });
    expect(out.Location).toBe("33.8688 S, 151.2093 E");
    expect(out.Moment).toContain("Australia/Sydney");
  });

  it("lists the next four phases with a countdown", () => {
    const out = run("2026-08-30", { now: NOW });
    for (const key of [
      "Next new moon",
      "Next first quarter",
      "Next full moon",
      "Next last quarter",
    ]) {
      expect(out[key]).toMatch(/in \d+\.\d days$/);
    }
  });

  it("says which way up the disc is drawn", () => {
    expect(run("2026-08-30", { now: NOW })["Disc drawn for"]).toContain("northern hemisphere");
    expect(run("2026-08-30", { now: NOW, hemisphere: "south" })["Disc drawn for"]).toContain(
      "southern hemisphere",
    );
  });

  it("adds the raw numbers under Full detail", () => {
    const out = run("2026-08-30", { now: NOW, detail: "full" });
    expect(out["Ecliptic longitude"]).toMatch(/degrees$/);
    expect(out["Right ascension"]).toMatch(/^\d\dh \d\dm/);
    expect(out["Terminator path"]).toMatch(/^M/);
    expect(out.Lunation).toContain("Brown lunation number");
  });

  it("refuses a place it does not know", () => {
    expect(() => run("Narnia", { now: NOW })).toThrow(ToolError);
    try {
      run("Narnia", { now: NOW });
    } catch (err) {
      expect((err as ToolError).code).toBe("unknown-place");
    }
  });

  it("refuses coordinates outside the real ranges", () => {
    try {
      run("120, 30", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-coordinates");
    }
  });

  it("refuses a year outside the range the series covers", () => {
    try {
      run("1620-04-01", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("date-out-of-range");
    }
  });

  it("refuses a date that does not exist", () => {
    try {
      run("2026-02-30", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-date");
    }
  });

  it("refuses a time zone it cannot resolve", () => {
    try {
      run("2026-08-30\ntz Middle/Earth", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-timezone");
    }
  });

  it("refuses a time that is not on the clock", () => {
    try {
      run("2026-08-30\nat 25:00", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-time");
    }
  });

  it("refuses a second unreadable line rather than guessing", () => {
    try {
      run("London\nsomething else entirely", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-line");
    }
  });
});
