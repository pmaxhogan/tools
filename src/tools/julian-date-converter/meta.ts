import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "julian-date-converter",
  icon: "CalendarClock",
  name: "Julian Date Converter",
  description:
    "Convert between calendar dates, Julian Date, Modified Julian Date and Unix time, with sidereal time and Delta T.",
  category: "Astronomy",
  keywords: [
    "julian date converter",
    "modified julian date converter",
    "jd to calendar date",
    "mjd to date",
    "julian day number calculator",
    "sidereal time calculator",
    "delta t calculator",
    "unix time to julian date",
  ],
  searchTerms: [
    "jd",
    "mjd",
    "julian day",
    "astronomical date",
    "gmst",
    "lst",
    "local sidereal time",
    "greenwich mean sidereal time",
    "tt minus ut",
    "terrestrial time",
    "julian ephemeris day",
    "proleptic gregorian",
    "gregorian reform 1582",
    "rata die",
    "excel serial date",
    "iso week number",
    "day of year",
    "j2000 epoch",
  ],
  input: "text/plain",
  output: "application/json",
  http: { method: "GET", contentType: "text/plain" },
  options: [
    {
      kind: "select",
      id: "calendar",
      label: "Calendar",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Historical",
          synonyms: ["automatic", "mixed", "real", "julian before 1582", "default"],
        },
        {
          value: "gregorian",
          label: "Gregorian (proleptic)",
          synonyms: ["new style", "civil", "modern", "extended backwards"],
        },
        {
          value: "julian",
          label: "Julian (proleptic)",
          synonyms: ["old style", "roman", "caesar", "extended forwards"],
        },
      ],
    },
    {
      kind: "text",
      id: "longitude",
      label: "Longitude for local sidereal time",
      default: "",
      placeholder: "-90.1994 or 90.1994 W",
    },
    {
      kind: "select",
      id: "detail",
      label: "Detail",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary",
          synonyms: ["short", "basic", "simple", "just the conversions"],
        },
        {
          value: "full",
          label: "Full",
          synonyms: [
            "everything",
            "detailed",
            "advanced",
            "rata die",
            "excel serial",
            "julian epoch",
            "besselian epoch",
            "truncated julian date",
          ],
        },
      ],
    },
  ],
  examples: [
    {
      label: "The standard epoch J2000.0",
      input: "2000-01-01 12:00:00",
      opts: { calendar: "auto", detail: "full", longitude: "" },
    },
    {
      label: "A Modified Julian Date back to a date",
      input: "MJD 51544.5",
      opts: { calendar: "auto", detail: "summary", longitude: "" },
    },
  ],
  copy: {
    what: "Converts in either direction between a calendar date and the day numbering astronomers actually use: Julian Date, Modified Julian Date, Julian day number, Truncated JD, Rata Die, the Excel 1900 serial, and Unix time. It works out which direction you meant from what you typed, so a date goes one way and a number with a JD, MJD or unix prefix goes the other. Alongside the conversion it reports the ISO week date, the day of year, Greenwich mean sidereal time, local sidereal time for a longitude you supply, Delta T, and the Julian Ephemeris Day in Terrestrial Time. Dates before the 1582 reform are read in the Julian calendar by default, and the ten days the reform deleted are reported as the mistake they are rather than silently shifted.",
    how: 'Type a date like "2026-08-30 18:45" or a day number like "JD 2451545.0", "MJD 51544.5" or "unix 1234567890". A bare number in Julian Date range is read as a Julian Date and anything larger is read as Unix seconds, and the "Input read as" row always says which reading it used. Leave the box empty to convert the current moment. Set Calendar to force one calendar throughout, fill in a longitude to get local sidereal time, and switch Detail to Full for Rata Die, the Excel serial, the Julian epoch and the Besselian epoch.',
    why: "Most Julian date pages convert one number one way, in a box wrapped in ads, and quietly assume the Gregorian calendar back to the year 1. This one runs the Meeus chapter 7 algorithms in both directions, keeps the Julian and the Gregorian calendar dates side by side, refuses the ten day gap in October 1582 instead of guessing, and adds the sidereal time and Delta T you would otherwise open a second tab for. Your files and inputs never leave your device, and there is no limit on how many conversions you run.",
    faq: [
      {
        q: "What is the difference between JD, MJD and the Julian day number?",
        a: "Julian Date counts days and fractions of a day from noon Universal Time on 1 January 4713 BC in the Julian calendar, so JD 2451545.0 is noon on 2000 January 1. The half day offset is deliberate: it keeps a whole night of observing inside one Julian Date. Modified Julian Date is simply JD minus 2400000.5, which trims five digits and moves the day boundary to midnight, so MJD 0 is 1858 November 17 at 00:00. The Julian day number is the integer label of the day a given JD falls in, with no time of day attached.",
      },
      {
        q: "Why does a date before 1582 change depending on the Calendar setting?",
        a: "The Gregorian reform of October 1582 deleted ten days: Thursday 4 October was followed directly by Friday 15 October. Historical dates before that are written in the Julian calendar, so the Historical setting reads them that way and switches to Gregorian from 15 October 1582 on. The proleptic settings extend one calendar in both directions instead, which is what you want when you are matching another program's convention rather than a historical record. Under the Historical setting a date inside the deleted gap is refused, because no such day existed.",
      },
      {
        q: "How accurate is the Delta T value?",
        a: "Delta T is Terrestrial Time minus Universal Time, the accumulated difference between atomic time and the Earth's actual rotation. This tool uses the Espenak and Meeus polynomial expressions published with the NASA Five Millennium Canon of Solar Eclipses. Between about 1700 and 2015 they follow the measured record closely, within a second or two. Before 1700 they are fits to ancient eclipse records and carry uncertainties of minutes to hours. After about 2015 they are an extrapolation, and because the Earth's rotation sped up after the fit was made they run a few seconds high for the present decade. That is fine for planning an observation and not fine for reducing timing measurements.",
      },
      {
        q: "What is sidereal time for?",
        a: "Sidereal time is the hour angle of the March equinox, so local sidereal time tells you which right ascension is crossing your meridian right now. A star whose right ascension equals your local sidereal time is at its highest point in the sky. The value here is mean sidereal time from Meeus formula 12.4, which leaves out nutation and so differs from apparent sidereal time by up to about a second of time.",
      },
    ],
  },
};
