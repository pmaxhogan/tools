import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  run,
  shadowRatio,
  solarPosition,
  sunTimes,
  julianCentury,
  julianDay,
  sunDeclination,
  equationOfTime,
} from "./index";
import { allPlaces, lookupPlace, PLACE_COUNT } from "./places";

/** A Date at 00:00 UTC on a calendar date. */
const utcDay = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

/** HH:MM of an instant in a zone, rounded to the nearest minute like the tool. */
const hhmm = (date: Date, zone: string): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(Math.round(date.getTime() / 60_000) * 60_000));

/** Minutes between two instants, for tolerance assertions. */
const minutesApart = (a: Date, b: Date): number => Math.abs(a.getTime() - b.getTime()) / 60_000;

const NY = { lat: 40.7128, lon: -74.006, zone: "America/New_York" };
/** 2026-06-21T12:00 in New York, used as a deterministic "now". */
const NOON_NY = Date.UTC(2026, 5, 21, 16, 0);

describe("sunrise-sunset-calculator: NOAA equations", () => {
  it("puts solar noon at Greenwich on the June 2026 solstice at 12:02 UTC", () => {
    const times = sunTimes(utcDay(2026, 6, 21), 51.4779, 0);
    expect(hhmm(times.solarNoon, "UTC")).toBe("12:02");
    // The equation of time is about -1.8 minutes on that date, so the real
    // sun crosses the meridian just under two minutes after 12:00.
    expect(times.equationOfTime).toBeCloseTo(-1.8, 0);
    expect(times.equationOfTime).toBeLessThan(0);
  });

  it("puts the solar declination at the June solstice near +23.44 degrees", () => {
    const t = julianCentury(julianDay(Date.UTC(2026, 5, 21, 12)));
    expect(sunDeclination(t)).toBeCloseTo(23.44, 1);
    // And near zero at the March equinox.
    const equinox = julianCentury(julianDay(Date.UTC(2026, 2, 20, 14, 46)));
    expect(Math.abs(sunDeclination(equinox))).toBeLessThan(0.05);
  });

  it("matches the NOAA sunrise and sunset for New York on 2026-06-21", () => {
    const times = sunTimes(utcDay(2026, 6, 21), NY.lat, NY.lon);
    expect(times.sunrise).not.toBeNull();
    expect(times.sunset).not.toBeNull();
    // NOAA reference: 05:25 and 20:31 local (EDT), allow two minutes.
    expect(
      minutesApart(times.sunrise as Date, new Date(Date.UTC(2026, 5, 21, 9, 25))),
    ).toBeLessThan(2);
    expect(minutesApart(times.sunset as Date, new Date(Date.UTC(2026, 5, 22, 0, 31)))).toBeLessThan(
      2,
    );
    expect(hhmm(times.sunrise as Date, NY.zone)).toBe("05:25");
    expect(hhmm(times.sunset as Date, NY.zone)).toBe("20:31");
  });

  it("gives an equinox day just over twelve hours long", () => {
    // Refraction and the sun's own width push the equinox past 12h: the
    // 90.833 degree zenith means the disc is already visible before the
    // geometric centre reaches the horizon.
    const newYork = sunTimes(utcDay(2026, 3, 20), NY.lat, NY.lon);
    expect(newYork.dayLengthMinutes).toBeGreaterThan(720);
    expect(newYork.dayLengthMinutes).toBeLessThan(735);

    const equator = sunTimes(utcDay(2026, 3, 20), 0, 0);
    expect(equator.dayLengthMinutes).toBeGreaterThan(720);
    expect(equator.dayLengthMinutes).toBeLessThan(730);
  });

  it("reads the same whatever time of day the anchor Date carries", () => {
    const midnight = sunTimes(utcDay(2026, 6, 21), NY.lat, NY.lon);
    const teatime = sunTimes(new Date(Date.UTC(2026, 5, 21, 16, 42, 7)), NY.lat, NY.lon);
    expect(teatime.sunrise?.getTime()).toBe(midnight.sunrise?.getTime());
    expect(teatime.solarNoon.getTime()).toBe(midnight.solarNoon.getTime());
  });

  it("puts the sun due south at its highest at solar noon in New York", () => {
    const times = sunTimes(utcDay(2026, 6, 21), NY.lat, NY.lon);
    const position = solarPosition(times.solarNoon, NY.lat, NY.lon);
    expect(position.azimuth).toBeCloseTo(180, 1);
    // Highest possible altitude is 90 minus the distance from latitude to
    // declination, before the small refraction correction.
    expect(position.geometricAltitude).toBeCloseTo(90 - (NY.lat - position.declination), 2);
    expect(position.altitude).toBeGreaterThan(position.geometricAltitude);
    expect(position.equationOfTime).toBeCloseTo(
      equationOfTime(julianCentury(julianDay(times.solarNoon.getTime()))),
      6,
    );
  });

  it("puts the sun due north at solar noon in the southern hemisphere", () => {
    const times = sunTimes(utcDay(2026, 12, 21), -33.8688, 151.2093);
    const position = solarPosition(times.solarNoon, -33.8688, 151.2093);
    expect(Math.min(position.azimuth, 360 - position.azimuth)).toBeLessThan(0.5);
  });

  it("turns altitude into a shadow ratio", () => {
    expect(shadowRatio(45) as number).toBeCloseTo(1, 10);
    expect(shadowRatio(60) as number).toBeCloseTo(0.5773502692, 8);
    expect(shadowRatio(30) as number).toBeCloseTo(1.7320508076, 8);
    expect(shadowRatio(0)).toBeNull();
    expect(shadowRatio(-4.2)).toBeNull();
  });
});

describe("sunrise-sunset-calculator: polar cases", () => {
  it("reports midnight sun at Tromso on the June solstice", () => {
    const times = sunTimes(utcDay(2026, 6, 21), 69.6492, 18.9553);
    expect(times.states.day).toBe("up-all-day");
    expect(times.sunrise).toBeNull();
    expect(times.sunset).toBeNull();
    expect(times.dayLengthMinutes).toBe(1440);

    const out = run("Tromso\non 2026-06-21", { now: Date.UTC(2026, 5, 21, 10) });
    expect(out.Sunrise).toMatch(/midnight sun/);
    expect(out.Sunset).toMatch(/midnight sun/);
    expect(out["Day length"]).toMatch(/never sets/);
    expect(out["Civil twilight"]).toMatch(/^None:/);
    // The sun still dips below 6 degrees around local midnight, so there is
    // a golden hour even though there is no sunrise.
    expect(out["Golden hour (morning)"]).toMatch(/^Until \d\d:\d\d/);
    expect(out["Golden hour (evening)"]).toMatch(/^From \d\d:\d\d/);
    expect(JSON.stringify(out)).not.toMatch(/NaN|Invalid/);
  });

  it("reports polar night at McMurdo on the June solstice", () => {
    const times = sunTimes(utcDay(2026, 6, 21), -77.8419, 166.6863);
    expect(times.states.day).toBe("down-all-day");
    expect(times.dayLengthMinutes).toBe(0);
    // The thresholds stay independent: the sun peaks near -11.3 degrees, so
    // there is no civil twilight but there is a real nautical one.
    expect(times.states.civil).toBe("down-all-day");
    expect(times.states.nautical).toBe("normal");
    expect(times.states.astronomical).toBe("normal");

    const out = run("McMurdo\non 2026-06-21", { now: Date.UTC(2026, 5, 21, 0) });
    expect(out.Sunrise).toMatch(/polar night/);
    expect(out["Day length"]).toMatch(/never rises/);
    expect(out["Civil twilight"]).toBe(
      "None: the sun stays lower than 6 degrees below the horizon all day.",
    );
    expect(out["Nautical twilight"]).toMatch(/^11:33 to 14:17, one unbroken stretch/);
    expect(out["Astronomical twilight"]).toBe("Morning 08:33 to 11:33, evening 14:17 to 17:17");
    expect(out["Shadow length"]).toBe("No shadow: sun below horizon");
    expect(out["Shadow direction"]).toBe("No shadow: sun below horizon");
    expect(JSON.stringify(out)).not.toMatch(/NaN|Invalid/);
  });

  it("drops astronomical twilight from a London midsummer night", () => {
    const out = run("London\non 2026-06-21", { now: Date.UTC(2026, 5, 21, 11) });
    expect(out.Sunrise).toBe("04:43");
    expect(out.Sunset).toBe("21:22");
    expect(out["Nautical twilight"]).toMatch(/^Morning /);
    expect(out["Astronomical twilight"]).toBe(
      "None: the sun stays higher than 18 degrees below the horizon all day.",
    );
  });
});

describe("sunrise-sunset-calculator: run output", () => {
  it("reports every row for a named city", () => {
    const out = run("New York\non 2026-06-21", { now: NOON_NY });
    expect(out.Location).toBe("New York (40.7128 N, 74.0060 W)");
    expect(out.Date).toBe("2026-06-21, Sunday, taken from the input");
    expect(out["Time zone"]).toBe(
      "America/New_York, UTC-04:00 on this date, the home zone of New York",
    );
    expect(out.Sunrise).toBe("05:25");
    expect(out.Sunset).toBe("20:31");
    expect(out["Solar noon"]).toBe("12:58, the sun at its highest");
    expect(out["Day length"]).toBe("15h 06m");
    expect(out["Civil twilight"]).toBe("Morning 04:52 to 05:25, evening 20:31 to 21:04");
    expect(out["Nautical twilight"]).toBe("Morning 04:09 to 04:52, evening 21:04 to 21:47");
    expect(out["Astronomical twilight"]).toBe("Morning 03:19 to 04:09, evening 21:47 to 22:37");
    expect(out["Golden hour (morning)"]).toBe("05:25 to 06:06");
    expect(out["Golden hour (evening)"]).toBe("19:49 to 20:31");
    expect(out["Blue hour (morning)"]).toBe("04:52 to 05:05");
    expect(out["Blue hour (evening)"]).toBe("20:51 to 21:04");
    expect(out["Sun right now"]).toBe(
      "Altitude 68.9 degrees, azimuth 140.5 degrees (SE), at 2026-06-21 12:00",
    );
    expect(out["Shadow length"]).toBe("0.39 times the height of the object");
    expect(out["Shadow direction"]).toBe("320.5 degrees (NW), straight away from the sun");
    expect(out["Solar declination"]).toBeUndefined();
  });

  it("reads hemisphere letters the same as signed decimals", () => {
    const signed = run("40.7128, -74.0060\non 2026-06-21\ntz America/New_York", { now: NOON_NY });
    const lettered = run("40.7128 N, 74.0060 W\non 2026-06-21\ntz America/New_York", {
      now: NOON_NY,
    });
    const reversed = run("74.0060 W, 40.7128 N\non 2026-06-21\ntz America/New_York", {
      now: NOON_NY,
    });
    expect(lettered).toEqual(signed);
    expect(reversed).toEqual(signed);
    expect(signed.Location).toBe("40.7128 N, 74.0060 W");
    expect(signed["Time zone"]).toMatch(/set on its own line of the input$/);
  });

  it("falls back to UTC and tags events that land on the next day", () => {
    const out = run("40.7128, -74.0060\non 2026-06-21", { now: NOON_NY });
    expect(out["Time zone"]).toBe("UTC, no zone was given, so times are UTC");
    expect(out.Sunrise).toBe("09:25");
    expect(out.Sunset).toBe("00:31 (+1 day)");
    expect(out["Golden hour (evening)"]).toBe("23:49 to 00:31 (+1 day)");
  });

  it("defaults the date to today where the place is", () => {
    // 2026-06-20T20:00Z is already 2026-06-21 in Tokyo but still the 20th in UTC.
    const city = run("Tokyo", { now: Date.UTC(2026, 5, 20, 20) });
    expect(city.Date).toBe("2026-06-21, Sunday, today in Asia/Tokyo");
    const coords = run("35.6762, 139.6503", { now: Date.UTC(2026, 5, 20, 20) });
    expect(coords.Date).toBe("2026-06-20, Saturday, today in UTC");
  });

  it("keeps the date honest where the zone offset fights the longitude", () => {
    // Apia sits west of the date line but keeps a UTC+13 clock, so the naive
    // UTC day would put solar noon on the wrong local date.
    const out = run("-13.8333, -171.7667\non 2026-06-21\ntz Pacific/Apia", {
      now: Date.UTC(2026, 5, 21, 0),
    });
    expect(out["Solar noon"]).toBe("12:29, the sun at its highest");
    expect(out.Sunrise).toBe("06:49");
    expect(out.Sunset).toBe("18:08");
  });

  it("adds the raw numbers in full detail, including synonyms for the option", () => {
    for (const detail of ["full", "everything", "detailed"]) {
      const out = run("New York\non 2026-06-21", { detail, now: NOON_NY });
      expect(out["Solar declination"]).toBe("+23.44 degrees at solar noon");
      expect(out["Equation of time"]).toMatch(/^-1\.8\d minutes at solar noon/);
      expect(out["Sunrise (UTC)"]).toBe("2026-06-21 09:25 UTC");
      expect(out["Solar noon (UTC)"]).toBe("2026-06-21 16:58 UTC");
      expect(out["Sunset (UTC)"]).toBe("2026-06-22 00:31 UTC");
      expect(out["Sun altitude now, before refraction"]).toMatch(/geometric$/);
    }
    const summary = run("New York\non 2026-06-21", { detail: "summary", now: NOON_NY });
    expect(summary["Sunrise (UTC)"]).toBeUndefined();
  });

  it("reports no shadow when the sun is down", () => {
    const out = run("New York\non 2026-06-21", { now: Date.UTC(2026, 5, 21, 6) });
    expect(out["Shadow length"]).toBe("No shadow: sun below horizon");
    expect(out["Sun right now"]).toMatch(/^Altitude -/);
  });

  it("only ever returns strings", () => {
    const out = run("Sydney\non 2026-12-21", { detail: "full", now: Date.UTC(2026, 11, 21, 2) });
    for (const [key, value] of Object.entries(out)) {
      expect(typeof value, key).toBe("string");
      expect(value.length, key).toBeGreaterThan(0);
    }
  });
});

describe("sunrise-sunset-calculator: errors", () => {
  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      return (e as ToolError).code;
    }
    throw new Error("expected a ToolError");
  };

  it("asks for input when there is none", () => {
    expect(codeOf(() => run(""))).toBe("empty-input");
    expect(codeOf(() => run("   \n\n  # just a comment\n"))).toBe("empty-input");
  });

  it("rejects out of range coordinates and names the token", () => {
    expect(codeOf(() => run("91, 0"))).toBe("bad-coordinates");
    expect(codeOf(() => run("40.7128, -200"))).toBe("bad-coordinates");
    try {
      run("40.7128, -200");
    } catch (e) {
      expect((e as ToolError).message).toContain('"-200"');
      expect((e as ToolError).fix).toContain("-180");
    }
  });

  it("rejects coordinate lines it cannot read", () => {
    expect(codeOf(() => run("40.7128"))).toBe("bad-coordinates");
    expect(codeOf(() => run("1 2 3"))).toBe("bad-coordinates");
    expect(codeOf(() => run("40.7128 N N, 74 W"))).toBe("bad-coordinates");
    expect(codeOf(() => run("Atlantis 7"))).toBe("bad-coordinates");
  });

  it("rejects a place it does not know", () => {
    expect(codeOf(() => run("Atlantis"))).toBe("unknown-place");
    try {
      run("Atlantis");
    } catch (e) {
      expect((e as ToolError).fix).toContain("40.7128");
    }
  });

  it("rejects a date it cannot use", () => {
    expect(codeOf(() => run("Tokyo\non 2026-02-30"))).toBe("bad-date");
    expect(codeOf(() => run("Tokyo\non 21 June 2026"))).toBe("bad-date");
    expect(codeOf(() => run("Tokyo\nnext tuesday"))).toBe("bad-date");
  });

  it("rejects a time zone it does not know", () => {
    expect(codeOf(() => run("Tokyo\ntz Mars/Olympus"))).toBe("bad-timezone");
    expect(codeOf(() => run("Tokyo\nMars/Olympus"))).toBe("bad-timezone");
    try {
      run("Tokyo\ntz Mars/Olympus");
    } catch (e) {
      expect((e as ToolError).fix).toContain("Europe/Berlin");
    }
  });
});

describe("sunrise-sunset-calculator: place table", () => {
  it("holds around sixty cities, all with usable coordinates and zones", () => {
    const places = allPlaces();
    expect(PLACE_COUNT).toBeGreaterThanOrEqual(60);
    expect(places).toHaveLength(PLACE_COUNT);
    for (const place of places) {
      expect(Math.abs(place.lat), place.name).toBeLessThanOrEqual(90);
      expect(Math.abs(place.lon), place.name).toBeLessThanOrEqual(180);
      expect(() =>
        new Intl.DateTimeFormat("en-US", { timeZone: place.zone }).format(0),
      ).not.toThrow();
    }
  });

  it("folds punctuation, case, and accents in a lookup", () => {
    expect(lookupPlace("st. louis")?.zone).toBe("America/Chicago");
    expect(lookupPlace("SAINT-LOUIS")?.name).toBe("St Louis");
    expect(lookupPlace("NYC")?.name).toBe("New York");
    expect(lookupPlace("nowhere at all")).toBeUndefined();
  });
});
