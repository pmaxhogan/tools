import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "magnitude-calculator",
  icon: "Star",
  name: "Magnitude Calculator",
  description:
    "Convert between apparent and absolute magnitude using the distance modulus, and work out flux ratios, combined magnitudes and surface brightness.",
  category: "Astronomy",
  keywords: [
    "magnitude calculator",
    "apparent to absolute magnitude",
    "distance modulus calculator",
    "absolute magnitude formula",
    "flux ratio between magnitudes",
    "combined magnitude of two stars",
    "surface brightness calculator",
    "telescope limiting magnitude",
  ],
  searchTerms: [
    "m minus M",
    "pogson ratio",
    "brightness ratio magnitudes",
    "star distance from magnitude",
    "parallax to distance",
    "milliarcseconds to parsecs",
    "parsec to light year",
    "luminosity from absolute magnitude",
    "double star combined brightness",
    "mag per square arcsecond",
    "how faint can my telescope see",
    "light grasp aperture",
    "interstellar extinction magnitudes",
  ],
  input: "text/plain",
  output: "application/json",
  http: { method: "GET", contentType: "text/plain" },
  options: [
    {
      kind: "select",
      id: "distanceUnit",
      label: "Lead distance with",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Automatic",
          synonyms: ["best fit", "readable", "default", "whichever"],
        },
        { value: "pc", label: "Parsecs", synonyms: ["pc", "parsec"] },
        { value: "ly", label: "Light years", synonyms: ["ly", "lightyear", "light year"] },
        {
          value: "au",
          label: "Astronomical units",
          synonyms: ["au", "ua", "earth sun distance"],
        },
        { value: "km", label: "Kilometers", synonyms: ["km", "kilometres", "metric"] },
      ],
    },
    {
      kind: "number",
      id: "pupil",
      label: "Dark adapted pupil (mm)",
      default: 7,
      min: 2,
      max: 9,
      step: 0.5,
    },
  ],
  examples: [
    {
      label: "Sirius from its parallax",
      input: "apparent: -1.46\nparallax: 379.21 mas",
      opts: { distanceUnit: "auto", pupil: "7" },
    },
    {
      label: "An 8 inch telescope and a double star",
      input: "aperture: 8 in\ncombine: 2.0, 3.0\ncompare: -1.46, 0.03",
      opts: { distanceUnit: "auto", pupil: "7" },
    },
  ],
  copy: {
    what: "Works the distance modulus in whichever direction you have data for. Give any two of apparent magnitude, absolute magnitude and distance and it solves for the third, converts the distance into parsecs, light years, astronomical units and kilometers, and reports the parallax and the V band luminosity relative to the Sun. It also does the four jobs that usually sit on separate pages: the flux ratio between two magnitudes, the single magnitude of several sources seen together, the mean surface brightness of an extended object from its magnitude and angular size, and a rough limiting magnitude and light grasp for a telescope aperture. Interstellar extinction is subtracted from the modulus when you supply it.",
    how: 'Write one field per line as "name: value". Use "apparent" and "absolute", or the standard symbols with case mattering, so "m: -1.46" is apparent and "M: 1.43" is absolute. Distance takes a unit, so "distance: 2.64 pc", "distance: 25 kly" and "distance: 1 au" all work, and "parallax: 379.21 mas" is accepted instead. Add "extinction: 0.3" for dust, "combine: 2.0, 3.0, 4.0" to add sources together, "compare: -1.46, 0.03" for a flux ratio, "aperture: 8 in" for a telescope, and "size: 190x60 arcmin" for surface brightness.',
    why: "The astronomy calculators that rank for this are single formula boxes surrounded by ads, each doing one direction of one conversion, so a real question takes four tabs. This one takes the whole problem at once, states which quantity it solved for, and shows the distance in every unit you might need to quote it in. Your files and inputs never leave your device, and nothing is behind a signup. It is also honest about the limiting magnitude rule of thumb, which most pages present as a specification.",
    faq: [
      {
        q: "What exactly is absolute magnitude?",
        a: "Absolute magnitude is the apparent magnitude an object would have if it sat exactly 10 parsecs away, which is 32.6 light years. It strips distance out of brightness so two objects can be compared on the light they actually emit. The relation is the distance modulus, m minus M equals 5 log10(d in parsecs) minus 5, so an object at 10 parsecs has m equal to M and the modulus is zero. For solar system objects astronomers use a different absolute magnitude, defined at 1 AU from both Sun and observer, which this tool does not calculate.",
      },
      {
        q: "Why does adding a second equal star only gain 0.75 magnitudes?",
        a: "Magnitudes are logarithmic. Doubling the flux is a factor of 2, and 2.5 log10(2) is 0.7526, so two identical stars together are 0.75 magnitudes brighter than one alone rather than twice as bright in the number. The same logic runs the other way: 5 magnitudes is a factor of exactly 100 in flux, and 1 magnitude is a factor of about 2.512, the fifth root of 100.",
      },
      {
        q: "How much should I trust the limiting magnitude number?",
        a: "Treat it as a starting point, not an answer. The 2.7 plus 5 log10 of the aperture in millimeters rule assumes a dark sky, a well collimated telescope, a target high overhead and a practiced observer. Real limits move by two magnitudes or more: light pollution alone can cost three, and magnification, seeing, optical quality and how long you have been dark adapted all matter. The light grasp figure beside it is the honest part, since the collecting area really does scale with the square of the aperture.",
      },
      {
        q: "Which magnitude system are these numbers in?",
        a: "The tool is band agnostic: the distance modulus works in whatever photometric band your input magnitudes are in, as long as both are in the same one. The two places a band is assumed are the luminosity row, which uses the Sun's Johnson V absolute magnitude of 4.83, and the comparison against the Sun's apparent magnitude of -26.74. Mixing a V magnitude with a G or an R magnitude will give a wrong answer that looks perfectly reasonable, so keep them consistent.",
      },
    ],
  },
};
