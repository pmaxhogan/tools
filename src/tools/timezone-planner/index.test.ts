import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";
import { allPlaces, lookupPlace, normalizePlace, PLACE_COUNT } from "./cities";

/** Northern winter, so nothing in Europe or North America is on summer time. */
const WINTER_NOON = Date.UTC(2026, 0, 15, 12, 0, 0);

describe("timezone-planner", () => {
  it("finds the overlap between Berlin and St Louis in winter", () => {
    const out = run("Europe/Berlin, st louis", { now: WINTER_NOON });
    expect(out["Planning date"]).toBe("2026-01-15 (Thu), the current date in Europe/Berlin");
    expect(out["Working hours"]).toBe("09:00 to 17:00 local time in every place");
    expect(out["Europe/Berlin"]).toBe(
      "Now 13:00 Thu. UTC+01:00 on 2026-01-15. Working 08:00 to 16:00 UTC on 2026-01-15.",
    );
    expect(out["St Louis"]).toBe(
      "Now 06:00 Thu. UTC-06:00 on 2026-01-15. Working 15:00 to 23:00 UTC on 2026-01-15.",
    );
    expect(out.Overlap).toBe(
      "1h together: 15:00 to 16:00 UTC on 2026-01-15. Local clocks: 16:00-17:00 Europe/Berlin, 09:00-10:00 St Louis.",
    );
  });

  it("recomputes offsets for the planned date, not for today", () => {
    // London keeps summer time in July, Delhi never moves. Same pair, same
    // working hours, a different answer because the offsets are date specific.
    const winter = run("on 2026-01-15\nlondon\ndelhi", { now: WINTER_NOON });
    expect(winter.London).toContain("UTC+00:00 on 2026-01-15");
    expect(winter.Overlap).toBe(
      "2h 30m together: 09:00 to 11:30 UTC on 2026-01-15. Local clocks: 09:00-11:30 London, 14:30-17:00 Delhi.",
    );

    const summer = run("on 2026-07-15\nlondon\ndelhi", { now: WINTER_NOON });
    expect(summer["Planning date"]).toBe(
      "2026-07-15 (Wed), taken from the first line of the input",
    );
    expect(summer.London).toContain("UTC+01:00 on 2026-07-15");
    expect(summer.Overlap).toBe(
      "3h 30m together: 08:00 to 11:30 UTC on 2026-07-15. Local clocks: 09:00-12:30 London, 13:30-17:00 Delhi.",
    );
  });

  it("handles the half hour offset of Asia/Kolkata", () => {
    const out = run("Asia/Kolkata, Europe/London", { now: WINTER_NOON });
    expect(out["Asia/Kolkata"]).toContain("UTC+05:30 on 2026-01-15");
    expect(out["Asia/Kolkata"]).toContain("Working 03:30 to 11:30 UTC on 2026-01-15");
  });

  it("gets a daylight saving transition day right", () => {
    // Chicago springs forward at 02:00 on 2026-03-08, so a 09:00 start that day
    // is already on CDT (UTC-5) while London is still on GMT.
    const out = run("on 2026-03-08\nAmerica/Chicago, Europe/London", { now: WINTER_NOON });
    expect(out["America/Chicago"]).toContain("UTC-05:00 on 2026-03-08");
    expect(out.Overlap).toBe(
      "3h together: 14:00 to 17:00 UTC on 2026-03-08. Local clocks: 09:00-12:00 America/Chicago, 14:00-17:00 Europe/London.",
    );
  });

  it("explains the near miss when nothing overlaps", () => {
    const out = run("sydney\nlondon", { now: WINTER_NOON });
    // Sydney's working day lands on the previous UTC date.
    expect(out.Sydney).toBe(
      "Now 23:00 Thu. UTC+11:00 on 2026-01-15. Working 2026-01-14 22:00 to 2026-01-15 06:00 UTC.",
    );
    expect(out.Overlap).toBe(
      "No overlap. The closest windows miss by 3h. Start the day in London 4h earlier, or finish the day in Sydney 4h later, to share a full hour.",
    );
  });

  it("reports windows that touch without sharing a minute", () => {
    const out = run("utc, UTC-08:00", { now: WINTER_NOON });
    expect(out["UTC-08:00"]).toContain("Working 2026-01-15 17:00 to 2026-01-16 01:00 UTC");
    expect(out.Overlap).toContain("The two closest windows touch without sharing a single minute");
  });

  it("accepts raw UTC offsets as a place", () => {
    const out = run("UTC+5:30, nyc", { now: WINTER_NOON });
    expect(out["UTC+05:30"]).toContain("Working 03:30 to 11:30 UTC on 2026-01-15");
    expect(out["New York"]).toContain("UTC-05:00 on 2026-01-15");
  });

  it("tags overlap clocks that fall on another calendar day", () => {
    const out = run("honolulu, tokyo", { now: WINTER_NOON, dayStart: 0, dayEnd: 24 });
    expect(out["Working hours"]).toBe("00:00 to 24:00 local time in every place");
    expect(out.Overlap).toBe(
      "5h together: 10:00 to 15:00 UTC on 2026-01-15. Local clocks: 00:00-05:00 Honolulu, 19:00-00:00 +1d Tokyo.",
    );
  });

  it("takes the default planning date from the first listed place", () => {
    // 02:00 UTC on the 16th is still the 15th in San Francisco.
    const out = run("sf\nberlin", { now: Date.UTC(2026, 0, 16, 2, 0, 0) });
    expect(out["Planning date"]).toBe("2026-01-15 (Thu), the current date in San Francisco");
    expect(out["San Francisco"]).toContain("Now 18:00 Thu.");
    expect(out.Berlin).toContain("Now 03:00 Fri.");
  });

  it("matches city names past case, punctuation, and accents", () => {
    const out = run("ST. LOUIS, são paulo, zürich", { now: WINTER_NOON });
    expect(Object.keys(out)).toEqual([
      "Planning date",
      "Working hours",
      "St Louis",
      "Sao Paulo",
      "Zurich",
      "Overlap",
    ]);
    expect(normalizePlace("  St. Louis ")).toBe(normalizePlace("st louis"));
    expect(lookupPlace("saint louis")?.name).toBe("St Louis");
    expect(lookupPlace("NYC")?.zone).toBe("America/New_York");
    expect(lookupPlace("atlantis")).toBeUndefined();
  });

  it("collapses places that share a time zone into one row", () => {
    const out = run("nyc, new york city, ST. LOUIS, berlin", { now: WINTER_NOON });
    expect(Object.keys(out).filter((k) => k === "New York")).toHaveLength(1);
    expect(out.Overlap).toContain("Local clocks: 10:00-11:00 New York");
  });

  it("ships a city table whose every zone is a real IANA zone", () => {
    expect(PLACE_COUNT).toBeGreaterThan(200);
    const broken = allPlaces().filter((place) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: place.zone });
        return false;
      } catch {
        return true;
      }
    });
    expect(broken).toEqual([]);
  });

  it("rejects empty input", () => {
    expect(() => run("   \n\n", { now: WINTER_NOON })).toThrowError(ToolError);
    try {
      run("", { now: WINTER_NOON });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("rejects a single place", () => {
    try {
      run("berlin", { now: WINTER_NOON });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("need-two");
      expect((e as ToolError).message).toContain("nothing to overlap with");
    }
  });

  it("rejects a list that is all one time zone", () => {
    try {
      run("nyc, boston, philly", { now: WINTER_NOON });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("need-two");
      expect((e as ToolError).message).toContain("same time zone");
    }
  });

  it("rejects more than eight places", () => {
    const many = "berlin, london, paris, tokyo, sydney, nyc, chicago, denver, lima";
    try {
      run(many, { now: WINTER_NOON });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("too-many");
      expect((e as ToolError).message).toContain("9 places");
    }
  });

  it("rejects an unknown place and names the token", () => {
    try {
      run("berlin, gotham city", { now: WINTER_NOON });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-place");
      expect((e as ToolError).message).toContain("gotham city");
      expect((e as ToolError).fix).toContain("Europe/Berlin");
    }
  });

  it("rejects an unknown IANA zone", () => {
    try {
      run("Mars/Olympus, berlin", { now: WINTER_NOON });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-place");
      expect((e as ToolError).message).toContain("Mars/Olympus");
    }
  });

  it("rejects working hours that do not make a day", () => {
    try {
      run("berlin, nyc", { now: WINTER_NOON, dayStart: 17, dayEnd: 9 });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-hours");
      expect((e as ToolError).fix).toContain("start hour below the end hour");
    }
    expect(() => run("berlin, nyc", { now: WINTER_NOON, dayStart: 9, dayEnd: 9 })).toThrowError(
      ToolError,
    );
  });

  it("rejects working hours outside the clock", () => {
    try {
      run("berlin, nyc", { now: WINTER_NOON, dayStart: -1, dayEnd: 30 });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-hours");
    }
    expect(() => run("berlin, nyc", { now: WINTER_NOON, dayEnd: 8.5 })).toThrowError(ToolError);
  });

  it("rejects a first line that looks like a date but is not one", () => {
    try {
      run("on monday\nberlin, nyc", { now: WINTER_NOON });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-date");
      expect((e as ToolError).fix).toContain("2026-08-18");
    }
    try {
      run("on 2026-02-30\nberlin, nyc", { now: WINTER_NOON });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-date");
      expect((e as ToolError).message).toContain("no such date");
    }
  });
});
