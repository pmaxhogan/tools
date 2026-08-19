import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "ics-inspector",
  matrixSlug: "ics",
  icon: "CalendarDays",
  name: "ICS Inspector",
  description:
    "Inspect a calendar (.ics) file and turn its events into Google Calendar and Outlook add links.",
  category: "Time",
  keywords: [
    "ics viewer",
    "ics inspector",
    "add to calendar link",
    "ical parser",
    "google calendar link generator",
    "open ics file",
  ],
  searchTerms: [
    "ics file reader",
    "vevent parser",
    "calendar invite viewer",
    "ical to google calendar",
    "outlook add event link",
    "read ics attachment",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "eventIndex",
      label: "Event to build links for",
      default: 0,
      min: 0,
    },
  ],
  copy: {
    what: "Reads any .ics calendar file, from a meeting invite to a multi-event export, and shows every field of its events: title, start and end time, location, description, organizer, status, and recurrence rule. For the event you pick, it also builds ready-to-click Google Calendar and Outlook add links, all without uploading the file anywhere.",
    how: "Drop an .ics file onto the page or paste its raw text. If the file has more than one event, each one is summarized on its own row and you can set the event number option to choose which event the add-to-calendar links are built for. Copy any field or link with its copy button.",
    why: "Calendar invites often carry names, locations, and dial-in details you would rather not hand to a random web form. This tool parses the file entirely in your browser, so nothing about your meeting ever reaches a server, and there is no file-size limit or ad-supported upload wall to fight through.",
    faq: [
      {
        q: "Is my calendar file uploaded anywhere?",
        a: "No. Parsing happens locally in your browser and the file never leaves your device.",
      },
      {
        q: "Does it handle recurring events?",
        a: "It reads and displays the RRULE so you can see the recurrence pattern, but the Google Calendar and Outlook links are built from the first instance's start and end time only.",
      },
      {
        q: "What about all-day events?",
        a: "All-day events (DTSTART with VALUE=DATE) are detected automatically and the add-to-calendar links use a date-only range instead of a timestamp.",
      },
    ],
  },
};
