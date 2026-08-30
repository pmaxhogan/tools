/**
 * Pure view helpers for the spectrum allocation viewer: lane packing, culling,
 * display vocabulary for services and statuses, and the CSV / JSON exports.
 *
 * Nothing here touches the DOM. The panel projects the packed lanes onto
 * pixels with the same AxisView transforms the main spectrum map uses, so the
 * two stay in lockstep as the visitor pans and zooms.
 */

import {
  ALLOCATIONS,
  ALLOCATION_META,
  type Allocation,
  type AllocationRegion,
  type AllocationService,
  type AllocationStatus,
} from "./allocations";
import { formatFrequency, frequencyToPosition } from "./index";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** Display order for statuses, most relevant first. */
export const STATUS_ORDER: readonly AllocationStatus[] = [
  "primary",
  "secondary",
  "unlicensed",
  "restricted",
];

export const STATUS_LABELS: Record<AllocationStatus, string> = {
  primary: "Primary",
  secondary: "Secondary",
  unlicensed: "Unlicensed",
  restricted: "Restricted",
};

/** One line per status explaining what the word means on a chart. */
export const STATUS_HELP: Record<AllocationStatus, string> = {
  primary: "Protected from interference and may not be interfered with by lower ranked users.",
  secondary: "Allowed, but must accept interference from and never interfere with primary users.",
  unlicensed:
    "Anyone may transmit with certified equipment under a power limit, no license needed.",
  restricted: "Transmitting is prohibited or tightly limited, usually to protect passive users.",
};

export const REGION_LABELS: Record<AllocationRegion, string> = {
  US: "United States",
  ITU1: "ITU Region 1",
  ITU2: "ITU Region 2",
  ITU3: "ITU Region 3",
  global: "Worldwide",
};

export const REGION_HELP: Record<AllocationRegion, string> = {
  US: "The FCC and NTIA tables, which sit inside ITU Region 2. Shows US, Region 2 and worldwide rows.",
  ITU1: "Europe, Africa, the Middle East and northern Asia. Shows Region 1 and worldwide rows.",
  ITU2: "The Americas and Greenland. Shows Region 2 and worldwide rows without US specific detail.",
  ITU3: "The rest of Asia and Oceania. Shows Region 3 and worldwide rows.",
  global: "Only rows that apply everywhere under the ITU Radio Regulations.",
};

/** Human names for the service vocabulary. */
export const SERVICE_LABELS: Record<AllocationService, string> = {
  amateur: "Amateur radio",
  "amateur-satellite": "Amateur satellite",
  aeronautical: "Aeronautical",
  "broadcast-am": "AM broadcast",
  "broadcast-fm": "FM broadcast",
  "broadcast-sw": "Shortwave broadcast",
  "broadcast-tv": "TV broadcast",
  cellular: "Cellular",
  "citizens-band": "Citizens Band",
  fixed: "Fixed links",
  "frs-gmrs": "FRS and GMRS",
  "gps-gnss": "GPS and GNSS",
  ism: "ISM",
  "land-mobile": "Land mobile",
  maritime: "Maritime",
  meteorological: "Weather",
  military: "Military and federal",
  paging: "Paging",
  "public-safety": "Public safety",
  radar: "Radar",
  "radio-astronomy": "Radio astronomy",
  radiolocation: "Radiolocation",
  radionavigation: "Radionavigation",
  "rfid-nfc": "RFID and NFC",
  satellite: "Satellite",
  sdars: "Satellite radio",
  "space-research": "Space research",
  "standard-time": "Time and frequency",
  telemetry: "Telemetry",
  "unlicensed-part15": "Unlicensed devices",
  "wifi-unlicensed": "Wi-Fi",
  "wireless-microphones": "Wireless microphones",
  "wireless-power": "Wireless power",
};

/** Lucide icon names per service, drawn from the set the panel already imports. */
export const SERVICE_ICONS: Partial<Record<AllocationService, string>> = {
  amateur: "RadioTower",
  "amateur-satellite": "Satellite",
  aeronautical: "Plane",
  "broadcast-am": "RadioReceiver",
  "broadcast-fm": "RadioReceiver",
  "broadcast-sw": "RadioReceiver",
  "broadcast-tv": "Tv",
  cellular: "Smartphone",
  "citizens-band": "RadioTower",
  fixed: "Antenna",
  "frs-gmrs": "RadioTower",
  "gps-gnss": "Satellite",
  ism: "Microwave",
  "land-mobile": "RadioTower",
  maritime: "Ship",
  meteorological: "CloudRain",
  military: "Radar",
  paging: "SignalHigh",
  "public-safety": "RadioTower",
  radar: "Radar",
  "radio-astronomy": "SatelliteDish",
  radiolocation: "Radar",
  radionavigation: "Anchor",
  "rfid-nfc": "ScanLine",
  satellite: "Satellite",
  sdars: "Satellite",
  "space-research": "SatelliteDish",
  "standard-time": "Clock",
  telemetry: "SignalHigh",
  "unlicensed-part15": "Router",
  "wifi-unlicensed": "Wifi",
  "wireless-microphones": "SignalHigh",
  "wireless-power": "Microwave",
};

export function serviceLabel(service: AllocationService): string {
  return SERVICE_LABELS[service] ?? service;
}

/** "144 to 148 MHz" style range text, using the shared frequency formatter. */
export function formatRange(lowHz: number, highHz: number): string {
  return `${formatFrequency(lowHz)} to ${formatFrequency(highHz)}`;
}

/* ------------------------------------------------------------------ */
/* Region filter                                                       */
/* ------------------------------------------------------------------ */

/**
 * Does a row belong to a regional view? Mirrors the rule in allocations.ts:
 * the US view includes Region 2 and worldwide rows, a specific ITU region
 * includes worldwide rows, and "global" is worldwide rows only.
 */
export function regionIncludes(entry: AllocationRegion, view: AllocationRegion): boolean {
  if (entry === "global" || entry === view) return true;
  return view === "US" && entry === "ITU2";
}

/** Every allocation in a regional view, in frequency order. */
export function allocationsForRegion(
  region: AllocationRegion,
  source: readonly Allocation[] = ALLOCATIONS,
): Allocation[] {
  return source.filter((a) => regionIncludes(a.region, region));
}

/* ------------------------------------------------------------------ */
/* Lane packing                                                        */
/* ------------------------------------------------------------------ */

export interface PackedAllocation {
  allocation: Allocation;
  /** Zero based lane index, top lane first. */
  lane: number;
  /** Normalized axis positions of the edges (see frequencyToPosition). */
  posLow: number;
  posHigh: number;
}

export interface AllocationLanes {
  items: PackedAllocation[];
  laneCount: number;
  /** The status every lane holds, so the panel can paint lane groups. */
  laneStatus: AllocationStatus[];
}

/**
 * Pack allocations into horizontal lanes so no two rows in one lane overlap.
 * Lanes are grouped by status (all primary lanes first, then secondary, and so
 * on) because that is how a reader scans a chart: "what owns this, and who
 * else is allowed here". Within a group the packing is the classic greedy
 * interval scheduling by low edge, which is optimal for the lane count.
 *
 * Touching edges do not count as an overlap: 146 to 148 MHz may share a lane
 * with 148 to 150 MHz, since a shared boundary frequency is a real answer for
 * both rows.
 */
export function packAllocations(allocations: readonly Allocation[]): AllocationLanes {
  const items: PackedAllocation[] = [];
  const laneStatus: AllocationStatus[] = [];
  let laneOffset = 0;

  for (const status of STATUS_ORDER) {
    const group = allocations
      .filter((a) => a.status === status)
      .sort((a, b) => a.lowHz - b.lowHz || b.highHz - b.lowHz - (a.highHz - a.lowHz));
    if (group.length === 0) continue;

    const laneEnds: number[] = [];
    for (const a of group) {
      let lane = laneEnds.findIndex((end) => end <= a.lowHz);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(a.highHz);
      } else {
        laneEnds[lane] = a.highHz;
      }
      // The axis runs from gamma rays down to ELF, so position falls as
      // frequency rises: the high frequency edge is the smaller position.
      const pA = frequencyToPosition(a.lowHz);
      const pB = frequencyToPosition(a.highHz);
      items.push({
        allocation: a,
        lane: laneOffset + lane,
        posLow: Math.min(pA, pB),
        posHigh: Math.max(pA, pB),
      });
    }
    for (let i = 0; i < laneEnds.length; i++) laneStatus.push(status);
    laneOffset += laneEnds.length;
  }

  return { items, laneCount: laneOffset, laneStatus };
}

/**
 * The packed items that intersect a normalized position window. Culling keeps
 * the SVG small when the visitor is zoomed into a sliver of the axis.
 */
export function visibleAllocations(
  lanes: AllocationLanes,
  posLow: number,
  posHigh: number,
): PackedAllocation[] {
  const lo = Math.min(posLow, posHigh);
  const hi = Math.max(posLow, posHigh);
  return lanes.items.filter((p) => p.posHigh >= lo && p.posLow <= hi);
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const CSV_HEADER = [
  "id",
  "label",
  "service",
  "status",
  "region",
  "low_hz",
  "high_hz",
  "summary",
  "rules",
  "notes",
  "source",
];

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 style CSV with a header row and LF line endings. */
export function allocationsToCsv(allocations: readonly Allocation[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const a of allocations) {
    lines.push(
      [
        a.id,
        a.label,
        a.service,
        a.status,
        a.region,
        a.lowHz,
        a.highHz,
        a.summary,
        (a.rules ?? []).join(" | "),
        a.notes ?? "",
        a.source,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/** Pretty printed JSON of the rows as they are, plus the range in hertz. */
export function allocationsToJson(allocations: readonly Allocation[]): string {
  return JSON.stringify(allocations, null, 2) + "\n";
}

/** A one line, copyable description of one allocation. */
export function describeAllocation(a: Allocation): string {
  const parts = [
    `${a.label}: ${formatRange(a.lowHz, a.highHz)}`,
    `${serviceLabel(a.service)}, ${STATUS_LABELS[a.status].toLowerCase()}, ${REGION_LABELS[a.region]}`,
    a.summary,
  ];
  if (a.rules?.length) parts.push(...a.rules);
  if (a.notes) parts.push(a.notes);
  parts.push(`Source: ${a.source}`);
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

export interface SourceLink {
  title: string;
  url: string;
}

/**
 * The best matching entry of ALLOCATION_META.sources for a row's free text
 * `source`, so the panel can offer a real link beside the citation. Falls back
 * to the FCC table, which is the parent document for every domestic row.
 */
export function sourceLinkFor(source: string): SourceLink {
  const s = source.toLowerCase();
  const pick = (id: string): SourceLink => {
    const hit = ALLOCATION_META.sources.find((x) => x.id === id) ?? ALLOCATION_META.sources[0];
    return { title: hit.title, url: hit.url };
  };
  if (s.includes("1.1310") || s.includes("1.1307") || s.includes("exposure")) {
    return pick("rf-exposure");
  }
  if (s.includes("part 97") || /\b97\.\d/.test(s)) return pick("part97");
  if (s.includes("arrl")) return pick("arrl-bands");
  if (s.includes("part 15") || /\b15\.\d/.test(s)) return pick("part15");
  if (s.includes("part 95") || /\b95\.\d/.test(s)) return pick("part95");
  if (s.includes("3gpp") || s.includes("36.101") || s.includes("38.101")) return pick("3gpp");
  if (s.includes("lora")) return pick("lorawan");
  if (s.includes("nist") || s.includes("wwv")) return pick("nist-time");
  if (s.includes("itu")) return pick("itu-rr");
  if (s.includes("ntia")) return pick("ntia-manual");
  return pick("fcc-table");
}
