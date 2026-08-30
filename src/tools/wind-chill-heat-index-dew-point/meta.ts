import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "wind-chill-heat-index-dew-point",
  matrixSlug: "wind-chill-heat-index-calculator",
  icon: "Snowflake",
  name: "Wind Chill, Heat Index and Dew Point Calculator",
  description:
    "NWS wind chill and heat index, dew point, wet bulb temperature, humidex and apparent temperature from air temperature, humidity and wind speed.",
  category: "Weather & Earth",
  keywords: [
    "wind chill calculator",
    "heat index calculator",
    "dew point calculator",
    "feels like temperature",
    "wet bulb temperature calculator",
    "humidex calculator",
  ],
  searchTerms: [
    "nws wind chill formula",
    "rothfusz regression",
    "magnus formula dew point",
    "stull wet bulb approximation",
    "apparent temperature",
    "real feel temperature",
    "frostbite risk chart",
  ],
  input: "none",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "temperature",
      label: "Air temperature",
      default: 90,
      min: -150,
      max: 150,
      step: 0.1,
    },
    {
      kind: "select",
      id: "temperatureUnit",
      label: "Temperature unit",
      default: "F",
      ui: "segmented",
      options: [
        { value: "F", label: "Fahrenheit", synonyms: ["f", "deg f"] },
        { value: "C", label: "Celsius", synonyms: ["c", "deg c", "centigrade"] },
      ],
    },
    {
      kind: "number",
      id: "humidity",
      label: "Relative humidity (%)",
      default: 70,
      min: 1,
      max: 100,
      step: 1,
    },
    {
      kind: "number",
      id: "windSpeed",
      label: "Wind speed",
      default: 10,
      min: 0,
      max: 200,
      step: 0.1,
    },
    {
      kind: "select",
      id: "windUnit",
      label: "Wind speed unit",
      default: "mph",
      ui: "segmented",
      options: [
        { value: "mph", label: "mph", synonyms: ["miles per hour"] },
        { value: "kmh", label: "km/h", synonyms: ["kilometers per hour", "kph"] },
        { value: "ms", label: "m/s", synonyms: ["meters per second"] },
        { value: "kt", label: "knots", synonyms: ["kt", "nautical miles per hour"] },
      ],
    },
    {
      kind: "select",
      id: "dewPointMethod",
      label: "Dew point formula",
      default: "magnus",
      options: [
        {
          value: "magnus",
          label: "Magnus (Alduchov and Eskridge, NWS)",
          synonyms: ["magnus tetens", "nws"],
        },
        { value: "buck", label: "Arden Buck (1981)", synonyms: ["buck equation"] },
      ],
    },
  ],
  examples: [
    {
      label: "Dangerous wind chill",
      opts: {
        temperature: "-20",
        temperatureUnit: "F",
        humidity: "40",
        windSpeed: "15",
        windUnit: "mph",
        dewPointMethod: "magnus",
      },
    },
    {
      label: "Hot and humid heat index",
      opts: {
        temperature: "90",
        temperatureUnit: "F",
        humidity: "70",
        windSpeed: "5",
        windUnit: "mph",
        dewPointMethod: "magnus",
      },
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Computes how the air actually feels from temperature, relative humidity and wind speed: the National Weather Service wind chill formula for cold, windy conditions, the NWS Rothfusz heat index regression for hot, humid conditions, dew point by the Magnus or Arden Buck formula, plus wet bulb temperature, the Environment Canada humidex and the Australian Bureau of Meteorology apparent temperature for a fuller picture. Each figure is only shown when its formula's documented valid range covers the input, and marked as an extrapolation outside it rather than silently guessed.",
    how: "Enter the air temperature, relative humidity and wind speed, in whichever units you have them, and every figure updates at once. Wind chill only applies at or below 50 F with wind at or above 3 mph, and heat index only applies at or above 80 F, both per NWS convention, so outside those ranges the calculator says so instead of printing a number the formula was never validated for.",
    why: "Most feels-like calculators online only compute one number and hide which formula they used. This one names its sources for every figure, from the exact NWS wind chill and Rothfusz regressions to Stull's 2011 wet bulb approximation, and is explicit about each formula's validated range rather than quietly extrapolating past it. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "Why does wind chill say Not applicable for a mild day?",
        a: "The NWS wind chill formula is only meant to be read at or below 50 F with wind at or above 3 mph; calm air or warm temperatures do not chill exposed skin the formula was built around, so the calculator shows Not applicable instead of a misleading number.",
      },
      {
        q: "Why do the Magnus and Arden Buck dew points differ slightly?",
        a: "Both are approximations to the same underlying physics with different fitted constants; Magnus with the Alduchov and Eskridge (1996) constants is what the NWS uses, and Arden Buck (1981) is a common alternative. They typically agree within a few tenths of a degree.",
      },
      {
        q: "What is the difference between heat index and humidex?",
        a: "Heat index (Rothfusz) is the NWS's Fahrenheit-scaled measure of how hot humid air feels, built from a lookup table regression, while humidex is Environment Canada's own Celsius-scaled measure built from the actual dew point. They measure a similar effect but are not directly interchangeable numbers.",
      },
    ],
  },
};
