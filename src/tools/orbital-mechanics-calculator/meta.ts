import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "orbital-mechanics-calculator",
  icon: "Orbit",
  name: "Orbital Mechanics Calculator",
  description:
    "Circular and elliptical orbit speeds, period, escape velocity, and a Hohmann transfer delta-v between two orbits, for the Sun, every planet, the Moon, Ceres and Pluto.",
  category: "Astronomy",
  keywords: [
    "hohmann transfer calculator",
    "orbital velocity calculator",
    "escape velocity calculator",
    "orbital period calculator",
    "delta-v calculator",
    "geostationary orbit altitude",
  ],
  searchTerms: [
    "vis viva equation",
    "kepler's third law calculator",
    "leo to geo transfer",
    "circular orbit speed",
    "transfer orbit delta v",
    "plane change delta v",
    "semi major axis calculator",
    "phase angle for transfer",
  ],
  input: "text/plain",
  output: "application/json",
  inputOptional: {
    label: "Quick entry",
    hint: 'Type "planet: value" lines such as "body: Earth", "altitude: 400 km" and "to: 35786 km", or a bare body name.',
  },
  options: [
    {
      kind: "select",
      id: "speedUnit",
      label: "Speed unit",
      default: "km/s",
      options: [
        { value: "km/s", label: "km/s", synonyms: ["kilometers per second", "kps"] },
        { value: "m/s", label: "m/s", synonyms: ["meters per second", "mps"] },
        { value: "mi/h", label: "mi/h", synonyms: ["miles per hour", "mph"] },
      ],
    },
    {
      kind: "select",
      id: "detail",
      label: "Detail",
      default: "summary",
      options: [
        { value: "summary", label: "Summary", synonyms: ["basic", "short", "key numbers"] },
        {
          value: "full",
          label: "Full (energy, momentum, mean motion)",
          synonyms: ["advanced", "specific energy", "angular momentum", "mean motion"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "ISS-altitude circular orbit around Earth",
      input: "body: Earth\naltitude: 400 km",
    },
    {
      label: "Hohmann transfer from a 300 km parking orbit to geostationary",
      input: "body: Earth\naltitude: 300 km\nto: 35786 km",
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Runs two body Keplerian orbital mechanics: circular and elliptical orbit speed from the vis-viva equation, orbital period from Kepler's third law, escape velocity, the geostationary or synchronous orbit altitude, and the two burn Hohmann transfer delta-v and transfer time between a starting and a destination orbit. Presets carry the gravitational parameter, radius and rotation period for the Sun, every planet, the Moon, Ceres and Pluto, or you can supply a custom GM and radius.",
    how: 'Write one field per line, such as "body: Earth", "altitude: 400 km" and "to: 35786 km" for a transfer, or just type a body name on its own to see its escape velocity and geostationary orbit. Lengths, speeds, times and angles all accept a unit after the number (km, AU, mi, m/s, mph, hours, days, degrees), and a bare number is read in the field\'s natural unit.',
    why: "Most orbital mechanics calculators online handle one equation at a time and make you look up GM yourself. This one carries the constants for every body in the solar system, chains vis-viva, Kepler's third law and the Hohmann transfer into one readable report, and is upfront that it is idealized two body, impulsive burn mechanics with no drag, oblateness or launch cost, rather than pretending to be a mission planner. It runs entirely in your browser, so your inputs never leave your device.",
    faq: [
      {
        q: "How much delta-v does a transfer from low Earth orbit to geostationary really take?",
        a: "About 3.9 km/s total for the two Hohmann burns, from a 300 km parking orbit: roughly 2.43 km/s to leave the circular orbit onto the transfer ellipse, and 1.47 km/s to circularize at geostationary altitude. That excludes the delta-v to reach the parking orbit from the ground and any plane change.",
      },
      {
        q: "Why is the geostationary altitude 35,786 km and not the orbit radius?",
        a: "35,786 km is the altitude above Earth's equatorial surface; the orbit radius, which is what the vis-viva and Kepler equations actually use, is about 42,164 km, measured from Earth's center. The calculator reports both so neither number gets mixed up with the other.",
      },
      {
        q: "Does this account for atmospheric drag or launch losses?",
        a: "No. Every result is two body, point mass, impulsive burn mechanics: no drag, no oblateness, no third body pull, no finite burn or gravity losses, and no cost to reach the starting orbit from the ground. Real mission delta-v budgets run higher than these numbers, which is stated on every result.",
      },
    ],
  },
};
