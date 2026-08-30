import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "fresnel-zone",
  icon: "Crosshair",
  name: "Fresnel Zone Calculator",
  description:
    "First Fresnel zone radius, 60 percent clearance requirement, and earth bulge for a wireless link, with an optional obstacle clearance check.",
  category: "RF",
  keywords: [
    "fresnel zone calculator",
    "fresnel zone clearance",
    "line of sight calculator",
    "earth bulge calculator",
    "wireless link clearance",
    "microwave link fresnel zone",
    "antenna height calculator",
  ],
  searchTerms: [
    "first fresnel zone radius",
    "60 percent clearance rule",
    "k factor 4/3",
    "effective earth radius",
    "point to point wifi clearance",
    "obstruction clearance calculator",
    "tower height for line of sight",
    "radio line of sight calculator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "kFactor",
      label: "Earth bulge k factor",
      default: "4/3",
      options: [
        {
          value: "4/3",
          label: "4/3 (standard atmospheric refraction)",
          synonyms: ["standard", "4/3 earth", "effective earth radius", "normal refraction"],
        },
        {
          value: "1",
          label: "1 (true earth curvature, no refraction)",
          synonyms: ["true earth", "no refraction correction", "worst case"],
        },
      ],
    },
  ],
  examples: [
    { label: "10 km link at 5.8 GHz", input: "5.8GHz 10km" },
    {
      label: "Obstacle off center",
      input: "freq=915MHz distance=20km obstacle=8km obstacleheight=12m",
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Calculates the first Fresnel zone radius at the midpoint of a wireless link (and at a specific obstacle point when given), the 60 percent clearance most link planners target, and the earth bulge that eats into that clearance over distance. Given an obstacle height, it also suggests the antenna height needed for a clear line drawn through that point. Input is plain text like "5.8GHz 10km" or key=value tokens like "freq=915MHz distance=20km obstacle=8km obstacleheight=12m".',
    how: 'Type a frequency and total link distance, either as bare tokens ("2.4GHz 5km") or as freq= and distance= keys. Add obstacle= for the distance from the near end to an obstruction, and obstacleheight= for its height, to get a clearance check and a recommended antenna height at that point. Pick a k factor of 4/3 for typical atmospheric refraction or 1 for true earth curvature with no correction.',
    why: "Most Fresnel zone calculators only handle the midpoint and skip earth bulge entirely, which matters on longer links where the curvature of the earth itself blocks part of the zone. This one covers the midpoint, an arbitrary obstacle point, and the combined 60 percent clearance plus earth bulge requirement in one pass, with your inputs never leaving your device.",
    faq: [
      {
        q: "Why 60 percent clearance instead of the full Fresnel zone?",
        a: "Keeping the first Fresnel zone at least 60 percent unobstructed keeps diffraction loss from an edge obstruction below about 0.5 dB, which is the widely used rule of thumb for point to point microwave and Wi-Fi links. Full 100 percent clearance is ideal but often impractical on long runs with terrain in the way.",
      },
      {
        q: "What does the k factor actually change?",
        a: "Radio waves bend slightly toward the earth as they pass through the atmosphere, which effectively makes the earth appear less curved than it really is. The standard 4/3 earth model accounts for typical refraction and is the default most link budget tools and the FCC use. Setting k to 1 removes that correction and shows the worst case true geometric curvature, useful for checking margin under abnormal atmospheric conditions.",
      },
      {
        q: "How does this relate to the free space path loss and link budget?",
        a: "Fresnel zone clearance and free space path loss are separate checks on the same link: clearance tells you whether the signal path is physically obstructed, while path loss tells you how much the signal weakens over distance assuming it is not. Run both together for a complete picture, using the Path Loss and Link Budget tool for the power side of the link.",
      },
    ],
  },
};
