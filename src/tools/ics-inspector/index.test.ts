import { describe, expect, it } from "vitest";
import { run, googleCalendarUrl, outlookUrl, effectiveEnd, type ParsedEvent } from "./index";
import { ToolError } from "../types";

const CRLF = "\r\n";

function ics(lines: string[]): string {
  return lines.join(CRLF);
}

describe("ics-inspector", () => {
  it("parses a minimal single-event calendar and builds a Google Calendar link", () => {
    const src = ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:1@test",
      "DTSTART:20250806T230000Z",
      "DTEND:20250806T233000Z",
      "SUMMARY:Team Sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);

    const out = run(src, {});
    expect(out["Events"]).toBe("1");
    expect(out["Title"]).toBe("Team Sync");
    expect(out["Starts"]).toBe("2025-08-06 23:00 UTC");
    expect(out["Ends"]).toBe("2025-08-06 23:30 UTC");

    const link = out["Google Calendar link"];
    expect(link).toContain("Team+Sync");
    expect(link).toMatch(/dates=20250806T230000Z%2F20250806T233000Z/);
  });

  it("unfolds a folded DESCRIPTION line", () => {
    const src = ics([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:2@test",
      "DTSTART:20250101T120000Z",
      "SUMMARY:Folded",
      "DESCRIPTION:This is a long descrip",
      " tion that was folded across",
      "\ttwo continuation lines.",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);

    const out = run(src, {});
    expect(out["Description"]).toBe(
      "This is a long description that was folded acrosstwo continuation lines.",
    );
  });

  it("treats an all-day VALUE=DATE event as date-only in the calendar links", () => {
    const src = ics([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:3@test",
      "DTSTART;VALUE=DATE:20260308",
      "DTEND;VALUE=DATE:20260309",
      "SUMMARY:All day thing",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);

    const out = run(src, {});
    expect(out["Starts"]).toBe("2026-03-08");
    expect(out["Time zone"]).toBe("All day");
    expect(out["Google Calendar link"]).toMatch(/dates=20260308%2F20260309/);
    expect(out["Outlook link"]).toMatch(/startdt=2026-03-08&enddt=2026-03-09/);
  });

  it("parses the TZID param on a zoned DTSTART", () => {
    const src = ics([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:4@test",
      "DTSTART;TZID=America/New_York:20260308T013000",
      "DTEND;TZID=America/New_York:20260308T023000",
      "SUMMARY:Zoned event",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);

    const out = run(src, {});
    expect(out["Time zone"]).toBe("America/New_York");
    expect(out["Starts"]).toBe("2026-03-08 01:30 America/New_York");
  });

  it("counts multiple events and builds links for the requested one", () => {
    const src = ics([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:5@test",
      "DTSTART:20250101T090000Z",
      "SUMMARY:First",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:6@test",
      "DTSTART:20250102T090000Z",
      "SUMMARY:Second",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);

    const out = run(src, {});
    expect(out["Events"]).toBe("2");
    expect(out["Event 1"]).toContain("First");
    expect(out["Event 2"]).toContain("Second");
    expect(out["Google Calendar link (event 1)"]).toContain("First");

    const outSecond = run(src, { eventIndex: 1 });
    expect(outSecond["Google Calendar link (event 2)"]).toContain("Second");
  });

  it("throws no-events when the calendar has no VEVENT block", () => {
    const src = ics(["BEGIN:VCALENDAR", "VERSION:2.0", "END:VCALENDAR"]);
    expect(() => run(src, {})).toThrowError(ToolError);
    try {
      run(src, {});
    } catch (e) {
      expect((e as ToolError).code).toBe("no-events");
    }
  });

  it("throws empty-input on blank input", () => {
    expect(() => run("", {})).toThrowError(ToolError);
    try {
      run("", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("unescapes TEXT values (\\n becomes a newline)", () => {
    const src = ics([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:7@test",
      "DTSTART:20250101T090000Z",
      "SUMMARY:Escaped",
      "DESCRIPTION:Line one\\nLine two\\, with a comma",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);

    const out = run(src, {});
    expect(out["Description"]).toBe("Line one\nLine two, with a comma");
  });

  it("accepts a Uint8Array (UTF-8 bytes) as input", () => {
    const src = ics([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:8@test",
      "DTSTART:20250101T090000Z",
      "SUMMARY:Bytes",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    const bytes = new TextEncoder().encode(src);
    const out = run(bytes, {});
    expect(out["Title"]).toBe("Bytes");
  });

  it("defaults DTEND to start+1h when neither DTEND nor DURATION is present", () => {
    const event: ParsedEvent = {
      summary: "No end",
      start: {
        year: 2026,
        month: 1,
        day: 1,
        hour: 10,
        minute: 0,
        second: 0,
        allDay: false,
        utc: true,
      },
    };
    const end = effectiveEnd(event);
    expect(end.hour).toBe(11);
  });

  it("computes an end from DTSTART+DURATION when DTEND is missing", () => {
    const src = ics([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:9@test",
      "DTSTART:20250101T090000Z",
      "DURATION:PT1H30M",
      "SUMMARY:Duration based",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    const out = run(src, {});
    expect(out["Ends"]).toBe("2025-01-01 10:30 UTC");
  });

  it("exports pure link builders directly", () => {
    const event: ParsedEvent = {
      summary: "Direct",
      location: "HQ",
      start: {
        year: 2026,
        month: 5,
        day: 1,
        hour: 9,
        minute: 0,
        second: 0,
        allDay: false,
        utc: true,
      },
      end: {
        year: 2026,
        month: 5,
        day: 1,
        hour: 10,
        minute: 0,
        second: 0,
        allDay: false,
        utc: true,
      },
    };
    expect(googleCalendarUrl(event)).toContain("calendar.google.com");
    expect(outlookUrl(event)).toContain("outlook.live.com");
    expect(outlookUrl(event)).toContain("HQ");
  });
});
