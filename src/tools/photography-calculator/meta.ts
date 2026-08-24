import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "photography-calculator",
  matrixSlug: "photo-calc",
  icon: "Aperture",
  name: "Photography Calculators",
  description:
    "Depth of field, hyperfocal distance, exposure value, ND filter times, and field of view in one text box.",
  category: "Geo",
  keywords: [
    "depth of field calculator",
    "hyperfocal distance calculator",
    "exposure calculator",
    "nd filter calculator",
    "field of view calculator",
    "crop factor",
  ],
  searchTerms: [
    "dof calculator",
    "circle of confusion",
    "ev calculator",
    "sunny 16 rule",
    "long exposure calculator",
    "angle of view calculator",
    "35mm equivalent focal length",
    "equivalent exposure",
    "aps-c crop factor",
    "bulb mode exposure time",
    "portrait lens depth of field",
    "camera settings calculator",
    "focal length calculator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Calculation",
      default: "dof",
      options: [
        {
          value: "dof",
          label: "Depth of field",
          synonyms: ["dof", "focus range", "near and far limit", "sharpness", "bokeh"],
        },
        {
          value: "hyperfocal",
          label: "Hyperfocal distance",
          synonyms: ["hyperfocal", "landscape focus", "focus to infinity", "zone focus"],
        },
        {
          value: "exposure",
          label: "Exposure value and equivalents",
          synonyms: ["ev", "exposure value", "sunny 16", "reciprocity", "equivalent exposure"],
        },
        {
          value: "nd",
          label: "ND filter exposure time",
          synonyms: [
            "nd",
            "neutral density",
            "long exposure",
            "big stopper",
            "filter factor",
            "10 stop",
          ],
        },
        {
          value: "fov",
          label: "Field of view and crop factor",
          synonyms: [
            "fov",
            "angle of view",
            "aov",
            "crop factor",
            "35mm equivalent",
            "focal length multiplier",
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "sensor",
      label: "Sensor format",
      default: "full-frame",
      options: [
        {
          value: "full-frame",
          label: "Full frame 35mm (36 x 24 mm)",
          synonyms: ["full frame", "ff", "35mm", "135", "fx", "24x36"],
        },
        {
          value: "aps-c",
          label: "APS-C (23.6 x 15.6 mm)",
          synonyms: ["apsc", "crop sensor", "dx", "sony", "nikon", "fuji", "1.5x"],
        },
        {
          value: "aps-c-canon",
          label: "Canon APS-C (22.3 x 14.9 mm)",
          synonyms: ["canon crop", "apsc canon", "1.6x", "efs"],
        },
        {
          value: "micro-four-thirds",
          label: "Micro Four Thirds (17.3 x 13 mm)",
          synonyms: ["mft", "m43", "four thirds", "olympus", "om system", "panasonic", "lumix"],
        },
        {
          value: "1-inch",
          label: "1 inch type (13.2 x 8.8 mm)",
          synonyms: ["1 inch", "one inch", "cx", "rx100", "compact", "drone sensor"],
        },
        {
          value: "medium-format-44x33",
          label: "Medium format (44 x 33 mm)",
          synonyms: ["medium format", "gfx", "44x33", "645", "hasselblad", "fujifilm gfx"],
        },
        {
          value: "custom",
          label: "Custom (set sensorWidth, sensorHeight, coc)",
          synonyms: ["custom", "other", "manual", "own sensor", "cinema", "super 35"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "Portrait depth of field",
      input: "85mm f/1.4 4m",
      opts: { mode: "dof", sensor: "full-frame" },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Five photography calculators behind one text box: depth of field with near and far limits, hyperfocal distance with a table across the common apertures, exposure value with a set of equivalent aperture and shutter pairs, ND filter exposure times with a table of the usual filters, and field of view with crop factor and 35mm equivalent focal length. Every calculation uses the real sensor dimensions and circle of confusion for the format you pick, from 1 inch compacts up to 44 by 33 mm medium format, or a custom sensor you define yourself. Distances come back in whichever unit system you typed, and depth of field past the hyperfocal distance is reported honestly as infinity.",
    how: 'Choose a calculation and a sensor, then type the numbers the way you would say them out loud: "50mm f/2.8 3m" for depth of field, "f/16 1/125 ISO100" for exposure, "1/125 ND1000" for a long exposure, or "24mm" for field of view. Key=value tokens work too when you want to be explicit, such as focal=85 aperture=1.4 distance=2.5m, and you can override the circle of confusion with coc=0.015 or describe an unusual sensor with sensorWidth, sensorHeight, and coc. Feet and inches are recognized, so "50mm f/2.8 10ft" answers in feet. In exposure mode you can supply ev= and leave out the aperture, shutter, or ISO, and the missing one is solved for you.',
    why: "The popular depth of field sites wrap three or four numbers in banner ads, cookie walls, and a newsletter modal, and most of them only do one calculation, so planning a shot means opening four tabs. This does all five, accepts the shorthand you already use instead of six dropdowns, shows the formula it applied so you can check the work, and runs entirely in the page: your files and inputs never leave your device. There is no sign in, no request limit, and the same URL works as a JSON endpoint when you want to script it.",
    faq: [
      {
        q: "What circle of confusion does the depth of field math use?",
        a: "The traditional value for the format, which is roughly the sensor diagonal divided by 1440: 0.030 mm on full frame, 0.020 mm on APS-C, 0.019 mm on Canon APS-C, 0.015 mm on Micro Four Thirds, 0.011 mm on 1 inch, and 0.037 mm on 44 by 33 medium format. That standard assumes an 8 by 10 inch print viewed from about 25 cm. Judging sharpness at 100% on a high resolution screen is much stricter, so add coc=0.015 or coc=0.010 to your input for a conservative answer.",
      },
      {
        q: "Why does my ND1000 give 8 seconds here when a 10 stop filter should give 8.2?",
        a: "ND1000 is marketed as a round number but a true 10 stop filter blocks a factor of 1024, so the two answers differ by about 3%. This calculator uses the factor printed on the filter, which is what the label promises. Real filters also drift by a third of a stop or more and dense filters shift color, so treat any long exposure as a starting point and bracket around it.",
      },
      {
        q: "How is the 35mm equivalent focal length calculated?",
        a: "By diagonal crop factor: the full frame diagonal of 43.27 mm divided by the diagonal of the selected sensor, multiplied by the real focal length. That gives 1.53x for 23.6 by 15.6 mm APS-C, 1.61x for Canon APS-C, 2.00x for Micro Four Thirds, and 0.79x for 44 by 33 medium format. Equivalence applies to framing only; the physical focal length and aperture still set the depth of field, which is why the depth of field mode asks for the actual focal length rather than the equivalent one.",
      },
    ],
  },
};
