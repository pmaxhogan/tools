import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import { apparentSiderealTime, horizontalFrom, julianDay } from "../moon-phase-calculator/index";
import { solarPosition } from "../sunrise-sunset-calculator/index";
import {
  BODY_IDS,
  bodyState,
  constellationAt,
  heliocentric,
  precessFromJ2000,
  run,
  skyEvents,
  visibilityNote,
  type BodyId,
} from "./index";

/**
 * The reference values are JPL Horizons, queried at
 * https://ssd.jpl.nasa.gov/api/horizons.api. The geocentric rows use
 * CENTER='500@399' with QUANTITIES='2,9,19,20,23,24', which is apparent right
 * ascension and declination of date, apparent magnitude, the distances from
 * the Sun and from Earth, the elongation and the phase angle. The St Louis
 * rows use SITE_COORD='-90.1994,38.627,0.15' with CENTER='coord@399' and
 * APPARENT='AIRLESS', so the elevations are geometric, matching what this tool
 * reports.
 *
 * Horizons is a full numerical ephemeris, so these are genuinely independent
 * of the approximate Keplerian elements the tool runs on. The tolerance below,
 * 0.1 degrees, is the honest accuracy claim for those elements; every body
 * currently lands well inside it.
 */

const ARCMIN = 1 / 60;

/** Angular separation between two equatorial positions, degrees. */
function separation(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r = Math.PI / 180;
  const cos =
    Math.sin(dec1 * r) * Math.sin(dec2 * r) +
    Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.cos((ra1 - ra2) * r);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / r;
}

function hms(h: number, m: number, s: number): number {
  return (h + m / 60 + s / 3600) * 15;
}

function dms(sign: number, d: number, m: number, s: number): number {
  return sign * (d + m / 60 + s / 3600);
}

interface Reference {
  ra: number;
  dec: number;
  magnitude: number;
  sunDistance: number;
  distance: number;
  elongation: number;
  phaseAngle: number;
}

const HORIZONS_2024: Partial<Record<BodyId, Reference>> = {
  sun: {
    ra: hms(18, 43, 41.03),
    dec: dms(-1, 23, 3, 30.5),
    magnitude: -26.779,
    sunDistance: 0,
    distance: 0.98331828203968,
    elongation: 0,
    phaseAngle: 0,
  },
  moon: {
    ra: hms(10, 36, 28.42),
    dec: dms(1, 12, 37, 39),
    magnitude: -11.15,
    sunDistance: 0.98483259649,
    distance: 0.00270481348636,
    elongation: 123.9718,
    phaseAngle: 55.8978,
  },
  mercury: {
    ra: hms(17, 27, 8.82),
    dec: dms(-1, 20, 9, 13.1),
    magnitude: 0.508,
    sunDistance: 0.342463082893,
    distance: 0.77754542055822,
    elongation: 18.0114,
    phaseAngle: 117.4013,
  },
  venus: {
    ra: hms(16, 3, 48.13),
    dec: dms(-1, 18, 46, 9.4),
    magnitude: -4.039,
    sunDistance: 0.720452810377,
    distance: 1.18190732715254,
    elongation: 37.47,
    phaseAngle: 56.1348,
  },
  mars: {
    ra: hms(17, 48, 13.06),
    dec: dms(-1, 23, 57, 41),
    magnitude: 1.418,
    sunDistance: 1.480677649313,
    distance: 2.4238067535467,
    elongation: 12.7423,
    phaseAngle: 8.4221,
  },
  jupiter: {
    ra: hms(2, 14, 44.52),
    dec: dms(1, 12, 15, 50.3),
    magnitude: -2.589,
    sunDistance: 4.984892933682,
    distance: 4.48150367162417,
    elongation: 115.5375,
    phaseAngle: 10.2482,
  },
  saturn: {
    ra: hms(22, 23, 6.79),
    dec: dms(-1, 11, 50, 20.7),
    magnitude: 0.955,
    sunDistance: 9.737841934008,
    distance: 10.2947006895469,
    elongation: 53.222,
    phaseAngle: 4.6407,
  },
  uranus: {
    ra: hms(3, 8, 4.73),
    dec: dms(1, 17, 16, 45.7),
    magnitude: 5.691,
    sunDistance: 19.61344308842,
    distance: 18.9754148355181,
    elongation: 129.3443,
    phaseAngle: 2.2174,
  },
  neptune: {
    ra: hms(23, 43, 53.27),
    dec: dms(-1, 3, 5, 32),
    magnitude: 7.775,
    sunDistance: 29.90376049873,
    distance: 30.1425626828419,
    elongation: 75.0407,
    phaseAngle: 1.8209,
  },
};

const HORIZONS_2026: Partial<Record<BodyId, Reference>> = {
  sun: {
    ra: hms(10, 33, 36.43),
    dec: dms(1, 9, 4, 1),
    magnitude: -26.721,
    sunDistance: 0,
    distance: 1.00975314138852,
    elongation: 0,
    phaseAngle: 0,
  },
  mercury: {
    ra: hms(10, 44, 33.05),
    dec: dms(1, 9, 47, 13.5),
    magnitude: -1.699,
    sunDistance: 0.366854820722,
    distance: 1.37209272883883,
    elongation: 2.7934,
    phaseAngle: 7.706,
  },
  venus: {
    ra: hms(13, 14, 53.45),
    dec: dms(-1, 11, 18, 27.7),
    magnitude: -4.597,
    sunDistance: 0.728175505016,
    distance: 0.56982332039799,
    elongation: 44.977,
    phaseAngle: 101.4421,
  },
  mars: {
    ra: hms(6, 52, 54.15),
    dec: dms(1, 23, 23, 15.7),
    magnitude: 1.261,
    sunDistance: 1.5173297069,
    distance: 1.86083898296465,
    elongation: 54.5394,
    phaseAngle: 32.8254,
  },
  jupiter: {
    ra: hms(9, 3, 36.21),
    dec: dms(1, 17, 20, 10.7),
    magnitude: -1.8,
    sunDistance: 5.296434572649,
    distance: 6.20803709473294,
    elongation: 23.3873,
    phaseAngle: 4.3375,
  },
  saturn: {
    ra: hms(0, 54, 52.47),
    dec: dms(1, 3, 0, 8.9),
    magnitude: 0.487,
    sunDistance: 9.444426220836,
    distance: 8.62038523771433,
    elongation: 142.7888,
    phaseAngle: 3.7127,
  },
  uranus: {
    ra: hms(4, 15, 2.46),
    dec: dms(1, 21, 5, 31.7),
    magnitude: 5.711,
    sunDistance: 19.44707823461,
    distance: 19.4027315156716,
    elongation: 91.0225,
    phaseAngle: 2.9773,
  },
  neptune: {
    ra: hms(0, 15, 52.58),
    dec: dms(1, 0, 10, 51.7),
    magnitude: 7.687,
    sunDistance: 29.87882700694,
    distance: 28.9762154944434,
    elongation: 152.9116,
    phaseAngle: 0.8875,
  },
};

describe("bodyState against JPL Horizons", () => {
  const epochs: { label: string; ms: number; table: Partial<Record<BodyId, Reference>> }[] = [
    { label: "2024-01-01 00:00 UT", ms: Date.UTC(2024, 0, 1), table: HORIZONS_2024 },
    { label: "2026-08-30 00:00 UT", ms: Date.UTC(2026, 7, 30), table: HORIZONS_2026 },
  ];

  for (const epoch of epochs) {
    for (const id of BODY_IDS) {
      const reference = epoch.table[id];
      if (!reference) continue;

      it(`places ${id} within 0.1 degrees at ${epoch.label}`, () => {
        const state = bodyState(id, epoch.ms);
        expect(separation(state.ra, state.dec, reference.ra, reference.dec)).toBeLessThan(0.1);
      });

      it(`gets the distance and brightness of ${id} at ${epoch.label}`, () => {
        const state = bodyState(id, epoch.ms);
        expect(Math.abs(state.distanceAu - reference.distance)).toBeLessThan(
          0.002 * Math.max(1, reference.distance),
        );
        expect(Math.abs(state.magnitude - reference.magnitude)).toBeLessThan(0.25);
        if (id !== "sun") {
          expect(Math.abs(state.elongation - reference.elongation)).toBeLessThan(0.15);
          expect(Math.abs(state.phaseAngle - reference.phaseAngle)).toBeLessThan(0.15);
        }
      });
    }
  }

  it("puts Mars within 0.02 degrees, the case the accuracy claim is judged on", () => {
    // Mars is the body a reader is most likely to check against an almanac.
    const state = bodyState("mars", Date.UTC(2024, 0, 1));
    const reference = HORIZONS_2024.mars as Reference;
    expect(separation(state.ra, state.dec, reference.ra, reference.dec)).toBeLessThan(0.02);
  });

  it("says which side of the sun each body is on the way Horizons does", () => {
    const ms = Date.UTC(2024, 0, 1);
    // Horizons marks Mars and Mercury /L, leading, which is west of the sun,
    // and Jupiter and Saturn /T, trailing, which is east of it.
    expect(bodyState("mars", ms).elongationSide).toBe("west");
    expect(bodyState("mercury", ms).elongationSide).toBe("west");
    expect(bodyState("jupiter", ms).elongationSide).toBe("east");
    expect(bodyState("saturn", ms).elongationSide).toBe("east");
  });

  it("has Mars at opposition on the night of the 2022 December opposition", () => {
    // Opposition is a conjunction in longitude, not a straight line: Mars sat
    // 2.29 degrees north of the ecliptic that night, so the separation from the
    // Sun stops short of 180. Horizons gives 177.7050 for this instant.
    const state = bodyState("mars", Date.UTC(2022, 11, 8, 5, 42));
    expect(Math.abs(state.elongation - 177.705)).toBeLessThan(0.05);
    expect(state.eclipticLatitude).toBeCloseTo(2.2949, 1);
    expect(state.elongationSide).toBe("east");
  });
});

describe("cross-checks against the site's other solar implementation", () => {
  /**
   * The sun calculator runs the NOAA equations, which share no code and no
   * coefficient table with the Keplerian elements here. Agreement between them
   * exercises the Earth's own elements, the ecliptic to equatorial rotation,
   * precession and sidereal time all at once.
   */
  const places: [string, number, number][] = [
    ["St Louis", 38.627, -90.1994],
    ["Sydney", -33.8688, 151.2093],
    ["Reykjavik", 64.1466, -21.9426],
  ];
  const moments = [Date.UTC(2024, 0, 1, 18), Date.UTC(2026, 5, 21, 12), Date.UTC(2030, 8, 9, 3)];

  for (const [name, lat, lon] of places) {
    for (const ms of moments) {
      it(`agrees with the NOAA sun position at ${name} on ${new Date(ms).toISOString().slice(0, 10)}`, () => {
        const noaa = solarPosition(new Date(ms), lat, lon);
        const state = bodyState("sun", ms);
        const here = horizontalFrom(
          state.ra,
          state.dec,
          apparentSiderealTime(julianDay(ms)),
          lat,
          lon,
        );
        expect(Math.abs(here.altitude - noaa.geometricAltitude)).toBeLessThan(3 * ARCMIN);
        // Azimuth is meaningless within a few arcminutes of the zenith, and
        // never gets close at these three latitudes.
        const azimuthGap = Math.abs(((here.azimuth - noaa.azimuth + 540) % 360) - 180);
        expect(azimuthGap).toBeLessThan(12 * ARCMIN);
      });
    }
  }
});

describe("heliocentric and precession", () => {
  it("puts each planet at roughly its own semimajor axis from the sun", () => {
    const jde = 2451545;
    const expected: Record<string, number> = {
      mercury: 0.387,
      venus: 0.723,
      earth: 1,
      mars: 1.524,
      jupiter: 5.203,
      saturn: 9.537,
      uranus: 19.189,
      neptune: 30.07,
    };
    for (const [planet, a] of Object.entries(expected)) {
      const r = Math.hypot(...heliocentric(planet, jde));
      // Inside the eccentricity of the orbit, which is what a radius can vary by.
      expect(r).toBeGreaterThan(a * 0.78);
      expect(r).toBeLessThan(a * 1.22);
    }
  });

  it("leaves a position untouched at J2000 and moves it about 50 arcseconds a year", () => {
    const at2000 = precessFromJ2000(120, 20, 0);
    expect(at2000.ra).toBeCloseTo(120, 9);
    expect(at2000.dec).toBeCloseTo(20, 9);
    const at2100 = precessFromJ2000(120, 20, 1);
    expect(separation(120, 20, at2100.ra, at2100.dec)).toBeGreaterThan(1.2);
    expect(separation(120, 20, at2100.ra, at2100.dec)).toBeLessThan(1.5);
  });
});

describe("constellationAt", () => {
  it("names the band the ecliptic runs through", () => {
    expect(constellationAt(0)).toBe("Pisces");
    expect(constellationAt(40)).toBe("Aries");
    expect(constellationAt(100)).toBe("Gemini");
    expect(constellationAt(200)).toBe("Virgo");
    expect(constellationAt(245)).toBe("Scorpius");
    expect(constellationAt(255)).toBe("Ophiuchus");
    expect(constellationAt(355)).toBe("Pisces");
  });

  it("wraps rather than falling off either end", () => {
    expect(constellationAt(-5)).toBe("Pisces");
    expect(constellationAt(365)).toBe("Pisces");
    expect(constellationAt(395)).toBe("Aries");
  });

  it("gives Scorpius the short stretch the IAU boundaries actually leave it", () => {
    expect(constellationAt(242)).toBe("Scorpius");
    expect(constellationAt(248)).toBe("Ophiuchus");
  });
});

describe("altitude, azimuth and the events of a day", () => {
  const LAT = 38.627;
  const LON = -90.1994;

  it("matches Horizons for Mars over St Louis at 2024-01-01 12:00 UT", () => {
    const ms = Date.UTC(2024, 0, 1, 12);
    const state = bodyState("mars", ms);
    const here = horizontalFrom(state.ra, state.dec, apparentSiderealTime(julianDay(ms)), LAT, LON);
    // Horizons azimuth 116.585505, airless elevation -5.351465.
    expect(here.azimuth).toBeCloseTo(116.585505, 1);
    expect(here.altitude).toBeCloseTo(-5.351465, 1);
  });

  it("matches Horizons for Mars over St Louis at 2024-01-01 18:00 UT", () => {
    const ms = Date.UTC(2024, 0, 1, 18);
    const state = bodyState("mars", ms);
    const here = horizontalFrom(state.ra, state.dec, apparentSiderealTime(julianDay(ms)), LAT, LON);
    // Horizons azimuth 193.272756, airless elevation 26.213724.
    expect(here.azimuth).toBeCloseTo(193.272756, 1);
    expect(here.altitude).toBeCloseTo(26.213724, 1);
  });

  it("finds a sunrise that agrees with the site's own sun calculator", () => {
    const dayStart = Date.UTC(2024, 0, 1, 6);
    const events = skyEvents("sun", dayStart, dayStart + 86_400_000, LAT, LON);
    expect(events.rise).not.toBeNull();
    // The sun calculator's own zenith for sunrise is the same 0.8333 degrees,
    // so the two must land within a minute of each other.
    const at = solarPosition(new Date(events.rise as number), LAT, LON);
    expect(Math.abs(at.geometricAltitude + 0.8333)).toBeLessThan(0.05);
  });

  it("orders rise, transit and set through the day", () => {
    const dayStart = Date.UTC(2026, 7, 30, 5);
    const events = skyEvents("jupiter", dayStart, dayStart + 86_400_000, LAT, LON);
    expect(events.rise).not.toBeNull();
    expect(events.set).not.toBeNull();
    expect(events.peakAltitude).toBeGreaterThan(0);
    expect(events.transit).toBeGreaterThan(events.rise as number);
  });

  it("says a circumpolar body never sets", () => {
    // Well inside the Arctic circle in midsummer: the sun is up the whole day.
    const dayStart = Date.UTC(2026, 5, 21);
    const events = skyEvents("sun", dayStart, dayStart + 86_400_000, 78.22, 15.65);
    expect(events.alwaysUp).toBe(true);
    expect(events.rise).toBeNull();
    expect(events.set).toBeNull();
  });
});

describe("visibilityNote", () => {
  it("refuses anything below the horizon", () => {
    expect(visibilityNote("jupiter", -1, -2.5, -30)).toContain("below the horizon");
  });

  it("refuses anything fainter than the naked eye can reach", () => {
    expect(visibilityNote("neptune", 40, 7.8, -30)).toContain("too faint for the unaided eye");
  });

  it("lets Venus through a daylight sky but not Mars", () => {
    expect(visibilityNote("venus", 30, -4.4, 10)).toContain("daylight");
    expect(visibilityNote("mars", 30, 1.4, 10)).toContain("washes it out");
  });

  it("answers for the sun itself by whether it is up", () => {
    expect(visibilityNote("sun", 20, -26.7, 20)).toContain("the sun is up");
    expect(visibilityNote("sun", -20, -26.7, -20)).toContain("below the horizon");
  });

  it("holds a faint planet back until the twilight has gone", () => {
    expect(visibilityNote("saturn", 30, 0.9, -3)).toContain("Yes");
    expect(visibilityNote("uranus", 30, 5.7, -3)).toContain("Not yet");
  });
});

describe("run", () => {
  const NOW = Date.UTC(2026, 7, 30, 2, 0);

  it("answers for the current moment with no input at all", () => {
    const out = run("", { now: NOW });
    expect(out.Moment).toContain("right now");
    expect(out.Location).toContain("No place given");
    for (const id of BODY_IDS) {
      const name = id[0].toUpperCase() + id.slice(1);
      expect(out[name]).toMatch(/^Magnitude [+-]\d/);
    }
  });

  it("adds altitude, azimuth and rise times once a place is given", () => {
    const out = run("St Louis\n2026-08-30", { now: NOW });
    expect(out.Location).toContain("St Louis");
    expect(out.Mars).toContain("altitude");
    expect(out.Mars).toContain("azimuth");
    expect(out.Mars).toMatch(/rises \d\d:\d\d/);
    expect(out.Mars).toMatch(/sets \d\d:\d\d/);
    expect(out.Mars).toContain("visible now:");
  });

  it("names a constellation for every body", () => {
    const out = run("St Louis\n2026-08-30", { now: NOW });
    expect(out.Jupiter).toContain("in Cancer");
    expect(out.Saturn).toContain("in Pisces");
    expect(out.Sun).toContain("in Leo");
  });

  it("reads the time zone from the city and the date from the input", () => {
    const out = run("Tokyo\n2026-08-30 21:30", { now: NOW });
    expect(out.Moment).toContain("2026-08-30 21:30");
    expect(out.Moment).toContain("Asia/Tokyo");
  });

  it("reorders by brightness on request", () => {
    const keys = Object.keys(run("St Louis\n2026-08-30", { now: NOW, order: "brightest" }));
    expect(keys.indexOf("Sun")).toBeLessThan(keys.indexOf("Neptune"));
    expect(keys.indexOf("Venus")).toBeLessThan(keys.indexOf("Mars"));
  });

  it("adds a second row per body under Full detail", () => {
    const out = run("St Louis\n2026-08-30", { now: NOW, detail: "full" });
    expect(out["Mars in detail"]).toMatch(/RA \d\dh \d\dm/);
    expect(out["Mars in detail"]).toContain("au from Earth");
    expect(out["Mars in detail"]).toContain("light takes");
    expect(out["Sun in detail"]).not.toContain("au from the sun");
  });

  it("always says how the numbers were worked out", () => {
    expect(run("", { now: NOW }).Method).toContain("Standish");
    expect(run("", { now: NOW }).Method).toContain("band lookup along the ecliptic");
  });

  it("refuses a place it does not know", () => {
    try {
      run("Narnia", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("unknown-place");
    }
  });

  it("refuses coordinates outside the real ranges", () => {
    try {
      run("100, 20", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-coordinates");
    }
  });

  it("refuses a year the orbital elements are not fitted to", () => {
    try {
      run("2090-01-01", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("date-out-of-range");
    }
  });

  it("refuses a date that does not exist", () => {
    try {
      run("2026-04-31", { now: NOW });
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
      run("2026-08-30\nat 24:30", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-time");
    }
  });

  it("refuses a line it cannot place", () => {
    try {
      run("Paris\nsomething else entirely", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-line");
    }
  });
});
