import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "sunrise-sunset-calculator",
  matrixSlug: "sun",
  icon: "Sunrise",
  name: "Sun & Golden Hour Calculator",
  description: "Sunrise, sunset, twilight, golden hour and shadow angles for any spot on any date.",
  category: "Geo",
  keywords: [
    "sunrise sunset calculator",
    "golden hour calculator",
    "blue hour times",
    "civil nautical astronomical twilight",
    "solar noon calculator",
    "day length calculator",
    "sun angle and shadow length",
  ],
  searchTerms: [
    "what time is sunset",
    "when is golden hour today",
    "magic hour photography times",
    "sun position calculator",
    "solar elevation azimuth",
    "shadow length from sun angle",
    "midnight sun polar night dates",
    "noaa solar calculator",
    "sun path for latitude longitude",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "detail",
      label: "Detail",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary",
          synonyms: ["short", "brief", "basic", "simple", "just the times"],
        },
        {
          value: "full",
          label: "Full",
          synonyms: [
            "everything",
            "detailed",
            "advanced",
            "verbose",
            "declination",
            "equation of time",
            "raw utc times",
          ],
        },
      ],
    },
  ],
  copy: {
    what: "Works out the sun for any place and date: sunrise, sunset, solar noon, day length, the civil, nautical and astronomical twilights, the golden hour at both ends of the day, and the blue hour in between. It also reports where the sun is right now as an altitude and a compass bearing, then turns that into the length and direction of the shadow a one metre pole would cast. The maths is the published NOAA solar calculator: Julian century, the equation of centre, apparent longitude, obliquity, declination, the equation of time, and the hour angle for each zenith.",
    how: 'Type a city like "Tokyo" or a coordinate pair like "40.7128, -74.0060" on the first line. Hemisphere letters work too, so "40.7128 N, 74.0060 W" is the same place. Add "on 2026-06-21" on a second line for another date, and "tz Europe/Berlin" on a third to read the results in a different time zone. Switch Detail to Full to also see the solar declination, the equation of time, and the raw UTC times.',
    why: "The big sunrise sites wrap three numbers in ads, a cookie wall, and a newsletter box, and several of them geolocate you before they will answer. This one runs the NOAA equations in your browser, so your files and inputs never leave your device, there is no location prompt, and there are no daily lookup limits. It also answers honestly above the Arctic Circle instead of printing a blank cell or a NaN.",
    faq: [
      {
        q: "How accurate are these times?",
        a: "Sunrise and sunset land within about a minute of the NOAA reference values for most of the planet. The calculation assumes a standard atmosphere for refraction and a flat horizon at sea level, so real conditions shift things: unusual temperature or pressure moves sunrise by a minute or so, and a mountain or a tall building on your horizon can move it by a great deal more. Accuracy falls off inside the polar circles, where the sun crosses the horizon at a very shallow angle and a small refraction error becomes a large time error.",
      },
      {
        q: "What exactly counts as golden hour here?",
        a: "Golden hour is the stretch when the centre of the sun sits between the horizon and 6 degrees above it, so the morning one runs from sunrise up to 6 degrees and the evening one from 6 degrees back down to sunset. Blue hour is the darker stretch on the other side of the horizon, from 6 degrees below up to 4 degrees below. Neither is an hour long except by coincidence: near the equator both last about 25 minutes, and in northern Scotland in June golden hour runs well over an hour.",
      },
      {
        q: "What happens above the Arctic Circle or in Antarctica?",
        a: "You get a sentence instead of a broken time. When the sun never sets the tool says so and reports a 24 hour day, and when it never rises it says polar night and reports a zero length day. Each twilight is judged on its own, so a polar night day at McMurdo can still report a real nautical twilight around noon while civil twilight is correctly listed as none. Golden hour is handled the same way: under the midnight sun it wraps around local midnight rather than around dawn.",
      },
    ],
  },
};
