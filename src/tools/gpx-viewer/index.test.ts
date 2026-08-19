import { describe, expect, it } from "vitest";
import {
  cumulativeDistances,
  detectFormat,
  downsample,
  elevationProfile,
  parseTrack,
  renderElevationSvg,
  renderTrackSvg,
  run,
  toCsv,
  toGeoJson,
  toGpx,
  trackStats,
  trimByTime,
  trimTrack,
  type Track,
} from "./index";
import { ToolError } from "../types";

/**
 * Five points 0.001 degrees of latitude apart, so every leg is the same length
 * and the pinned totals are easy to reason about by hand.
 */
const GPX_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="fixture" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Morning Loop</name></metadata>
  <wpt lat="47.6205" lon="-122.3493">
    <ele>50</ele>
    <name>Space Needle</name>
  </wpt>
  <trk>
    <name>Morning Loop</name>
    <trkseg>
      <trkpt lat="47.6062" lon="-122.3321"><ele>10</ele><time>2026-03-01T08:00:00Z</time></trkpt>
      <trkpt lat="47.6072" lon="-122.3321"><ele>12</ele><time>2026-03-01T08:01:00Z</time></trkpt>
      <trkpt lat="47.6082" lon="-122.3321"><ele>11</ele><time>2026-03-01T08:02:00Z</time></trkpt>
      <trkpt lat="47.6092" lon="-122.3321"><ele>25</ele><time>2026-03-01T08:03:00Z</time></trkpt>
      <trkpt lat="47.6102" lon="-122.3321"><ele>18</ele><time>2026-03-01T08:04:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>
`;

const KML_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Waterfront Walk</name>
    <Placemark>
      <name>Ferry Terminal</name>
      <Point><coordinates>-122.3400,47.6020,5</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Route</name>
      <LineString>
        <coordinates>
          -122.3321,47.6062,10
          -122.3321,47.6072,12
          -122.3321,47.6082,11
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`;

const KML_GX_TRACK = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <Placemark>
      <name>Flight</name>
      <gx:Track>
        <when>2026-03-01T08:00:00Z</when>
        <when>2026-03-01T08:01:00Z</when>
        <gx:coord>-122.3321 47.6062 10</gx:coord>
        <gx:coord>-122.3321 47.6072 40</gx:coord>
      </gx:Track>
    </Placemark>
  </Document>
</kml>
`;

const GEOJSON_FIXTURE = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        name: "Waterfront Walk",
        coordTimes: ["2026-03-01T08:00:00Z", "2026-03-01T08:01:00Z", "2026-03-01T08:02:00Z"],
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [-122.3321, 47.6062, 10],
          [-122.3321, 47.6072, 12],
          [-122.3321, 47.6082, 11],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "Ferry Terminal" },
      geometry: { type: "Point", coordinates: [-122.34, 47.602, 5] },
    },
  ],
});

/** One leg of the fixture: 0.001 degrees of latitude on the IUGG mean sphere. */
const LEG_METERS = 111.19508;

describe("gpx-viewer parsing", () => {
  it("detects each supported format", () => {
    expect(detectFormat(GPX_FIXTURE)).toBe("gpx");
    expect(detectFormat(KML_FIXTURE)).toBe("kml");
    expect(detectFormat(GEOJSON_FIXTURE)).toBe("geojson");
    expect(detectFormat("just some words")).toBe(null);
  });

  it("parses a GPX track with waypoints, elevation and timestamps", () => {
    const track = parseTrack(GPX_FIXTURE);
    expect(track.source).toBe("gpx");
    expect(track.name).toBe("Morning Loop");
    expect(track.points).toHaveLength(5);
    expect(track.points.every((p) => p.seg === 0)).toBe(true);
    expect(track.points[0]).toEqual({
      lat: 47.6062,
      lon: -122.3321,
      ele: 10,
      time: Date.parse("2026-03-01T08:00:00Z"),
      seg: 0,
    });
    expect(track.waypoints).toEqual([
      { lat: 47.6205, lon: -122.3493, name: "Space Needle", ele: 50 },
    ]);
  });

  it("parses GPX routes and multiple segments with separate segment indexes", () => {
    const src = `<gpx version="1.1">
      <trk><trkseg>
        <trkpt lat="1" lon="1"/><trkpt lat="1.001" lon="1"/>
      </trkseg><trkseg>
        <trkpt lat="2" lon="2"/><trkpt lat="2.001" lon="2"/>
      </trkseg></trk>
      <rte><rtept lat="3" lon="3"/><rtept lat="3.001" lon="3"/></rte>
    </gpx>`;
    const track = parseTrack(src);
    expect(track.points.map((p) => p.seg)).toEqual([0, 0, 1, 1, 2, 2]);
    // The jump between segments must not be billed as distance.
    expect(trackStats(track).distanceMeters).toBeCloseTo(3 * LEG_METERS, 2);
    expect(trackStats(track).segmentCount).toBe(3);
  });

  it("parses a KML LineString and its Point placemarks", () => {
    const track = parseTrack(KML_FIXTURE);
    expect(track.source).toBe("kml");
    expect(track.name).toBe("Waterfront Walk");
    expect(track.points).toHaveLength(3);
    expect(track.points[1]).toEqual({ lat: 47.6072, lon: -122.3321, ele: 12, seg: 0 });
    expect(track.waypoints).toEqual([
      { lat: 47.602, lon: -122.34, name: "Ferry Terminal", ele: 5 },
    ]);
  });

  it("parses a KML gx:Track by pairing when with coord", () => {
    const track = parseTrack(KML_GX_TRACK);
    expect(track.name).toBe("Flight");
    expect(track.points).toEqual([
      { lat: 47.6062, lon: -122.3321, ele: 10, time: Date.parse("2026-03-01T08:00:00Z"), seg: 0 },
      { lat: 47.6072, lon: -122.3321, ele: 40, time: Date.parse("2026-03-01T08:01:00Z"), seg: 0 },
    ]);
  });

  it("parses a GeoJSON FeatureCollection with coordTimes and a Point feature", () => {
    const track = parseTrack(GEOJSON_FIXTURE);
    expect(track.source).toBe("geojson");
    expect(track.name).toBe("Waterfront Walk");
    expect(track.points).toHaveLength(3);
    expect(track.points[0].time).toBe(Date.parse("2026-03-01T08:00:00Z"));
    expect(track.waypoints).toEqual([
      { lat: 47.602, lon: -122.34, name: "Ferry Terminal", ele: 5 },
    ]);
  });

  it("splits a GeoJSON MultiLineString into one segment per line", () => {
    const src = JSON.stringify({
      type: "MultiLineString",
      coordinates: [
        [
          [1, 1],
          [1, 1.001],
        ],
        [
          [2, 2],
          [2, 2.001],
        ],
      ],
    });
    expect(parseTrack(src).points.map((p) => p.seg)).toEqual([0, 0, 1, 1]);
  });

  it("reads the same three points from GPX, KML and GeoJSON with identical distance", () => {
    const gpx = `<gpx version="1.1"><trk><trkseg>
      <trkpt lat="47.6062" lon="-122.3321"/>
      <trkpt lat="47.6072" lon="-122.3321"/>
      <trkpt lat="47.6082" lon="-122.3321"/>
    </trkseg></trk></gpx>`;
    const kml = `<kml><Document><Placemark><LineString><coordinates>
      -122.3321,47.6062 -122.3321,47.6072 -122.3321,47.6082
    </coordinates></LineString></Placemark></Document></kml>`;
    const geojson = JSON.stringify({
      type: "LineString",
      coordinates: [
        [-122.3321, 47.6062],
        [-122.3321, 47.6072],
        [-122.3321, 47.6082],
      ],
    });

    const distances = [gpx, kml, geojson].map(
      (text) => trackStats(parseTrack(text)).distanceMeters,
    );
    expect(distances[0]).toBeCloseTo(2 * LEG_METERS, 4);
    expect(distances[1]).toBeCloseTo(distances[0], 9);
    expect(distances[2]).toBeCloseTo(distances[0], 9);
  });

  it("decodes character entities and CDATA in names", () => {
    const src = `<gpx version="1.1"><metadata><name>Ben &amp; Jerry&apos;s</name></metadata>
      <wpt lat="1" lon="1"><name><![CDATA[Caf<e>]]></name></wpt></gpx>`;
    const track = parseTrack(src);
    expect(track.name).toBe("Ben & Jerry's");
    expect(track.waypoints[0].name).toBe("Caf<e>");
  });
});

describe("gpx-viewer stats", () => {
  it("pins distance, elevation, duration and speed for the GPX fixture", () => {
    const stats = trackStats(parseTrack(GPX_FIXTURE));
    expect(stats.pointCount).toBe(5);
    expect(stats.segmentCount).toBe(1);
    expect(stats.waypointCount).toBe(1);

    expect(stats.distanceMeters).toBeCloseTo(444.78032, 4);
    expect(stats.distanceKm).toBeCloseTo(0.44478, 5);
    expect(stats.distanceMiles).toBeCloseTo(0.276374, 5);

    // 10 -> 12 -> 11 are all inside the 3 m threshold, so only 11 -> 25 -> 18 count.
    expect(stats.gainMeters).toBe(15);
    expect(stats.lossMeters).toBe(7);
    expect(stats.minEle).toBe(10);
    expect(stats.maxEle).toBe(25);
    expect(stats.avgEle).toBeCloseTo(15.2, 10);
    expect(stats.maxGradePercent).toBeCloseTo(12.59046, 4);

    expect(stats.startTime).toBe(Date.parse("2026-03-01T08:00:00Z"));
    expect(stats.endTime).toBe(Date.parse("2026-03-01T08:04:00Z"));
    expect(stats.durationSeconds).toBe(240);
    expect(stats.movingSeconds).toBe(240);
    expect(stats.avgSpeedMps).toBeCloseTo(1.853251, 5);
    expect(stats.maxSpeedMps).toBeCloseTo(1.853251, 5);
    expect(stats.bounds).toEqual({
      minLat: 47.6062,
      maxLat: 47.6205,
      minLon: -122.3493,
      maxLon: -122.3321,
    });
  });

  it("counts every wobble when smoothing is turned off", () => {
    const track = parseTrack(GPX_FIXTURE);
    const raw = trackStats(track, { smoothing: 0 });
    expect(raw.gainMeters).toBe(16);
    expect(raw.lossMeters).toBe(8);
  });

  it("leaves slow legs out of moving time", () => {
    const src = `<gpx version="1.1"><trk><trkseg>
      <trkpt lat="47.6062" lon="-122.3321"><time>2026-03-01T08:00:00Z</time></trkpt>
      <trkpt lat="47.6072" lon="-122.3321"><time>2026-03-01T08:01:00Z</time></trkpt>
      <trkpt lat="47.60720001" lon="-122.3321"><time>2026-03-01T08:11:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const stats = trackStats(parseTrack(src));
    expect(stats.durationSeconds).toBe(660);
    expect(stats.movingSeconds).toBe(60);
  });

  it("keeps a metre of jitter from reporting a cliff", () => {
    const src = `<gpx version="1.1"><trk><trkseg>
      <trkpt lat="47.60620" lon="-122.3321"><ele>10</ele></trkpt>
      <trkpt lat="47.60620500" lon="-122.3321"><ele>14</ele></trkpt>
    </trkseg></trk></gpx>`;
    // The pair is about 0.6 m apart, under the 10 m minimum run, so no sample is taken.
    expect(trackStats(parseTrack(src)).maxGradePercent).toBeUndefined();
  });

  it("reports cumulative distance per point", () => {
    const distances = cumulativeDistances(parseTrack(GPX_FIXTURE).points);
    expect(distances).toHaveLength(5);
    expect(distances[0]).toBe(0);
    expect(distances[4]).toBeCloseTo(444.78032, 4);
  });
});

describe("gpx-viewer trimming", () => {
  it("trims by index, inclusive at both ends, and clamps out of range values", () => {
    const track = parseTrack(GPX_FIXTURE);
    const trimmed = trimTrack(track, 1, 3);
    expect(trimmed.points).toHaveLength(3);
    expect(trimmed.points[0].ele).toBe(12);
    expect(trimmed.points[2].ele).toBe(25);
    expect(trimTrack(track, -5, 999).points).toHaveLength(5);
  });

  it("trims by timestamp and drops points with no time", () => {
    const track = parseTrack(GPX_FIXTURE);
    const trimmed = trimByTime(
      track,
      Date.parse("2026-03-01T08:01:00Z"),
      Date.parse("2026-03-01T08:03:00Z"),
    );
    expect(trimmed.points.map((p) => p.ele)).toEqual([12, 11, 25]);
    expect(trimByTime(parseTrack(KML_FIXTURE), 0, 1e15).points).toHaveLength(0);
  });

  it("downsamples while always keeping the first and last point", () => {
    const track = parseTrack(GPX_FIXTURE);
    const reduced = downsample(track, 3);
    expect(reduced.points).toHaveLength(3);
    expect(reduced.points[0]).toEqual(track.points[0]);
    expect(reduced.points[2]).toEqual(track.points[4]);
    expect(downsample(track, 50).points).toHaveLength(5);
  });
});

describe("gpx-viewer exporters", () => {
  it("round trips through toGpx", () => {
    const track = parseTrack(GPX_FIXTURE);
    const reparsed = parseTrack(toGpx(track));
    expect(reparsed.source).toBe("gpx");
    expect(reparsed.name).toBe(track.name);
    expect(reparsed.points).toEqual(track.points);
    expect(reparsed.waypoints).toEqual(track.waypoints);
  });

  it("keeps segment breaks through toGpx", () => {
    const track = parseTrack(
      `<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="1"/></trkseg>` +
        `<trkseg><trkpt lat="2" lon="2"/></trkseg></trk></gpx>`,
    );
    expect(parseTrack(toGpx(track)).points.map((p) => p.seg)).toEqual([0, 1]);
  });

  it("round trips through toGeoJson", () => {
    const track = parseTrack(GPX_FIXTURE);
    const json = toGeoJson(track);
    expect(JSON.parse(json).type).toBe("FeatureCollection");
    const reparsed = parseTrack(json);
    expect(reparsed.points).toEqual(track.points);
    expect(reparsed.waypoints).toEqual(track.waypoints);
  });

  it("writes one CSV row per point with the running distance", () => {
    const csv = toCsv(parseTrack(GPX_FIXTURE));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("segment,index,latitude,longitude,elevation_m,time,distance_m");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe("0,0,47.6062,-122.3321,10,2026-03-01T08:00:00.000Z,0.00");
    expect(lines[5].endsWith(",444.78")).toBe(true);
  });
});

describe("gpx-viewer renderers", () => {
  it("draws the track with start, end, waypoint, scale bar and north arrow", () => {
    const svg = renderTrackSvg(parseTrack(GPX_FIXTURE), { width: 400, height: 300 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="400"');
    expect(svg).toContain('class="track-line"');
    expect(svg).toContain('class="track-start"');
    expect(svg).toContain('class="track-end"');
    expect(svg).toContain('class="track-waypoint"');
    expect(svg).toContain('class="track-scale"');
    expect(svg).toContain('class="track-north"');
    expect(svg).toContain("Space Needle");
    expect(svg).not.toContain("NaN");
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("starts a new path command at every segment break", () => {
    const track = parseTrack(
      `<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1.01" lon="1"/></trkseg>` +
        `<trkseg><trkpt lat="2" lon="2"/><trkpt lat="2.01" lon="2"/></trkseg></trk></gpx>`,
    );
    const d = /class="track-line" d="([^"]+)"/.exec(renderTrackSvg(track));
    expect(d).not.toBeNull();
    expect((d?.[1].match(/M/g) ?? []).length).toBe(2);
  });

  it("is deterministic", () => {
    const track = parseTrack(GPX_FIXTURE);
    expect(renderTrackSvg(track)).toBe(renderTrackSvg(track));
    expect(renderElevationSvg(track)).toBe(renderElevationSvg(track));
  });

  it("survives a single point track without producing NaN", () => {
    const track = parseTrack(
      `<gpx version="1.1"><trk><trkseg><trkpt lat="10" lon="20"/></trkseg></trk></gpx>`,
    );
    const svg = renderTrackSvg(track);
    expect(svg).not.toContain("NaN");
    expect(svg).toContain('class="track-start"');
  });

  it("draws the elevation profile with min and max labels", () => {
    const svg = renderElevationSvg(parseTrack(GPX_FIXTURE), { width: 400, height: 160 });
    expect(svg).toContain('class="elevation-area"');
    expect(svg).toContain('class="elevation-line"');
    expect(svg).toContain(">25 m<");
    expect(svg).toContain(">10 m<");
    expect(svg).not.toContain("NaN");
  });

  it("says so plainly when a track carries no elevation", () => {
    const track = parseTrack(
      `<gpx version="1.1"><trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk></gpx>`,
    );
    expect(renderElevationSvg(track)).toContain("No elevation data in this track");
  });

  it("resamples the elevation profile to the requested number of points", () => {
    const profile = elevationProfile(parseTrack(GPX_FIXTURE), 3);
    expect(profile).toHaveLength(3);
    [10, 11, 18].forEach((expected, index) => {
      expect(profile[index].elevationMeters).toBeCloseTo(expected, 6);
    });
    expect(profile[2].distanceMeters).toBeCloseTo(444.78032, 4);
  });
});

describe("gpx-viewer run", () => {
  it("reports metric stats by default", () => {
    const out = run(GPX_FIXTURE, {});
    expect(out["Format"]).toBe("GPX");
    expect(out["Track name"]).toBe("Morning Loop");
    expect(out["Points"]).toBe("5");
    expect(out["Segments"]).toBe("1");
    expect(out["Waypoints"]).toBe("1");
    expect(out["Distance"]).toBe("445 m");
    expect(out["Elevation gain"]).toBe("15 m");
    expect(out["Elevation loss"]).toBe("7 m");
    expect(out["Min elevation"]).toBe("10 m");
    expect(out["Max elevation"]).toBe("25 m");
    expect(out["Average elevation"]).toBe("15.2 m");
    expect(out["Max grade"]).toBe("12.6%");
    expect(out["Start time"]).toBe("2026-03-01T08:00:00.000Z");
    expect(out["Duration"]).toBe("4m 00s");
    expect(out["Moving time"]).toBe("4m 00s");
    expect(out["Average speed"]).toBe("6.67 km/h");
    expect(out["Average pace"]).toBe("9:00 /km");
    expect(out["Max speed"]).toBe("6.67 km/h");
    expect(out["Bounding box"]).toBe("47.60620, -122.34930 to 47.62050, -122.33210");
    expect(out["Track SVG"]).toBeUndefined();
    expect(out["Elevation SVG"]).toBeUndefined();
  });

  it("switches to imperial units on request, including synonyms", () => {
    const out = run(GPX_FIXTURE, { units: "miles" });
    expect(out["Distance"]).toBe("0.28 mi");
    expect(out["Max elevation"]).toBe("82 ft");
    expect(out["Average speed"]).toBe("4.15 mph");
    expect(out["Average pace"]).toBe("14:28 /mi");
  });

  it("adds the two SVG rows only when the svg option is on", () => {
    const out = run(GPX_FIXTURE, { svg: true });
    expect(out["Track SVG"]).toContain('class="track-line"');
    expect(out["Elevation SVG"]).toContain('class="elevation-line"');
  });

  it("honours the smoothing option", () => {
    expect(run(GPX_FIXTURE, { smoothing: 0 })["Elevation gain"]).toBe("16 m");
    expect(run(GPX_FIXTURE, { smoothing: 3 })["Elevation gain"]).toBe("15 m");
  });

  it("accepts a Uint8Array of UTF-8 bytes", () => {
    const bytes = new TextEncoder().encode(GPX_FIXTURE);
    expect(run(bytes, {})["Points"]).toBe("5");
  });

  it("reports a waypoint only file instead of failing", () => {
    const out = run(
      `<gpx version="1.1"><wpt lat="1" lon="2"><name>Trailhead</name></wpt></gpx>`,
      {},
    );
    expect(out["Points"]).toBe("0");
    expect(out["Waypoints"]).toBe("1");
  });
});

describe("gpx-viewer errors", () => {
  function codeOf(fn: () => unknown): string {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      return (error as ToolError).code;
    }
    throw new Error("expected the call to throw");
  }

  it("throws empty-input for blank input", () => {
    expect(codeOf(() => run("   \n  ", {}))).toBe("empty-input");
  });

  it("throws unknown-format for text that is not a track file", () => {
    expect(codeOf(() => run("hello, this is not a track", {}))).toBe("unknown-format");
  });

  it("throws unknown-format for broken JSON", () => {
    expect(codeOf(() => run('{"type": "FeatureCollection", ', {}))).toBe("unknown-format");
  });

  it("throws no-points for a track file with no coordinates", () => {
    expect(codeOf(() => run(`<gpx version="1.1"><trk><name>Empty</name></trk></gpx>`, {}))).toBe(
      "no-points",
    );
  });

  it("throws bad-xml when a close tag does not match", () => {
    expect(codeOf(() => run(`<gpx version="1.1"><trk><trkseg></trk></gpx>`, {}))).toBe("bad-xml");
  });

  it("throws bad-xml when a tag is never closed", () => {
    expect(codeOf(() => run(`<gpx version="1.1"><trk><trkseg>`, {}))).toBe("bad-xml");
  });

  it("throws too-large past 50 MB", () => {
    expect(codeOf(() => run(new Uint8Array(50 * 1024 * 1024 + 1), {}))).toBe("too-large");
  });

  it("carries an actionable fix on every error", () => {
    try {
      run("hello, this is not a track", {});
    } catch (error) {
      expect((error as ToolError).fix).toContain(".gpx");
    }
  });
});

describe("gpx-viewer model", () => {
  it("accepts a hand built track in the exporters", () => {
    const track: Track = {
      name: "Hand built",
      source: "geojson",
      waypoints: [],
      points: [
        { lat: 1, lon: 2, seg: 0 },
        { lat: 1.001, lon: 2, seg: 0 },
      ],
    };
    expect(toGpx(track)).toContain('<trkpt lat="1" lon="2">');
    expect(toGeoJson(track)).toContain('"LineString"');
    expect(toCsv(track).split("\n")).toHaveLength(4);
  });
});
