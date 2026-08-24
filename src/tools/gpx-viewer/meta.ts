import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "gpx-viewer",
  matrixSlug: "tracks",
  icon: "Route",
  name: "GPX Track Viewer",
  description:
    "View GPX, KML and GeoJSON tracks with distance, elevation profile, speed stats and trimming, all in your browser.",
  category: "Geo",
  keywords: [
    "gpx viewer",
    "view gpx file online",
    "gpx elevation profile",
    "kml viewer",
    "geojson viewer",
    "gpx to geojson",
    "trim gpx track",
  ],
  searchTerms: [
    "open gpx file",
    "gps track viewer",
    "strava export viewer",
    "garmin gpx reader",
    "kml to gpx",
    "gpx statistics",
    "route distance calculator",
    "elevation gain calculator",
    "map route viewer",
    "hiking track viewer",
    "running route viewer",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "units",
      label: "Units",
      default: "metric",
      options: [
        {
          value: "metric",
          label: "Metric (km, m)",
          synonyms: ["metric", "kilometers", "kilometres", "km", "meters", "metres", "si"],
        },
        {
          value: "imperial",
          label: "Imperial (miles, feet)",
          synonyms: ["imperial", "miles", "mi", "feet", "ft", "us", "statute", "mph"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "svg",
      label: "Include the map and elevation SVG",
      default: false,
    },
    {
      kind: "number",
      id: "smoothing",
      label: "Elevation smoothing (m)",
      default: 3,
      min: 0,
      max: 20,
      step: 1,
    },
  ],
  copy: {
    what: "Reads a GPX, KML or GeoJSON track and reports everything worth knowing about it: total distance, elevation gain and loss, minimum, maximum and average elevation, steepest grade, duration, moving time, average and maximum speed, pace, bounding box and point count. Waypoints, routes and multi segment recordings are all understood, including Google Earth gx:Track blocks with per point timestamps. It draws the track on a clean canvas without a map background by default, so nothing is fetched, alongside a distance versus elevation profile. An optional OpenStreetMap background loads only if you click for it. You can also trim a track to a range of points or times, thin a dense recording down, and export the result as GPX, GeoJSON or CSV.",
    how: 'Drop a .gpx, .kml or .geojson file onto the page, or paste its text. The format is detected from the file itself, so a Strava export, a Garmin ride and a Google Earth path all work without picking anything. Switch between metric and imperial units, raise the smoothing value if a noisy barometer is inflating the elevation gain, then use the trim controls to cut a warm up or a wrong turn off the ends before exporting. Click "Load map tiles" under the track drawing if you want an OpenStreetMap background behind it, and "Hide map" to go back to the plain canvas.',
    why: "Most GPX viewers upload your file to a server and paint it over commercial map tiles, which means your route history, your home address and the times you were there all land in someone else's logs. This one parses and draws everything locally: your files and inputs never leave your device. The map background is opt-in too: nothing is fetched until you click to load OpenStreetMap tiles, and that click, which only sends your track's rough bounding box, is the only thing on this page that talks to another server. There is no sign in, no track size limit beyond 50 MB, and no upsell to a paid plan to see your own elevation profile.",
    faq: [
      {
        q: "Why is there no map background behind my track by default?",
        a: 'Map tiles come from a third party server, and requesting them would tell that server your track\'s rough area. So the track draws on a plain canvas with a scale bar and a north arrow, and nothing is fetched until you ask for it. Click "Load map tiles" under the track if you want an OpenStreetMap background; that click is the only thing on this page that leaves your device, and "Hide map" reverts to the plain canvas with no reload needed. Your files and inputs never leave your device either way.',
      },
      {
        q: "What does loading the map tiles actually send to OpenStreetMap?",
        a: "Only the rough bounding box of the track currently shown, the same numbers already printed in the bounding box statistic, requested as a handful of standard PNG tile images from openstreetmap.org with no extra headers attached. Your file itself, its name, and every point and timestamp in it stay on your device. The request is capped at 30 tiles per click and only fires when you click the button, never on load and never remembered between visits.",
      },
      {
        q: "How is elevation gain calculated?",
        a: "Gain and loss use a hysteresis filter rather than adding up every reading. A climb or descent only counts once the elevation differs from the last accepted reading by the smoothing threshold, 3 meters by default, and then the whole difference is booked. That keeps barometric and GPS noise from turning a flat ride into hundreds of meters of fake climbing. Set the smoothing option to 0 to see the raw sum, or raise it for a very noisy recording.",
      },
      {
        q: "Can it convert GPX to GeoJSON?",
        a: "Yes. Every supported format parses into the same track model, so you can load a GPX file and export GeoJSON, load a KML file and export GPX, or export a CSV of every point with its running distance. Timestamps survive the trip as GeoJSON coordTimes, and multi segment tracks keep their segment breaks.",
      },
    ],
  },
};
