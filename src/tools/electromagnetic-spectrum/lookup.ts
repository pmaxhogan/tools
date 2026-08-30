/**
 * The unified search brain for the spectrum tool: the original physics and
 * band interpretations (interpretQuery), plus allocation rows and the numbered
 * channels of the fixed channel plans (Zigbee, LoRa, Bluetooth, DECT, FRS and
 * GMRS, MURS, WiGig). Pure: the panel calls unifiedSearch on every keystroke.
 */

import {
  CHANNEL_TABLES,
  searchAllocations,
  type Allocation,
  type AllocationRegion,
  type Channel,
  type ChannelTable,
} from "./allocations";
import {
  SERVICE_ICONS,
  STATUS_LABELS,
  formatRange,
  regionIncludes,
  serviceLabel,
} from "./allocation-view";
import { formatFrequency, interpretQuery, type Interpretation } from "./index";

/** How many candidates the unified dropdown holds. */
export const MAX_UNIFIED_RESULTS = 12;

/** How many allocation rows a text query contributes before the band matches. */
export const MAX_ALLOCATION_HITS = 6;

/* ------------------------------------------------------------------ */
/* Channel plan queries                                                */
/* ------------------------------------------------------------------ */

/**
 * Alias words that name a channel plan, mapped to its table id. Longer aliases
 * are matched first so "lora downlink" beats "lora".
 */
const PLAN_ALIASES: { alias: string; tableId: string }[] = [
  { alias: "lora downlink", tableId: "lora-us915-downlink" },
  { alias: "lorawan downlink", tableId: "lora-us915-downlink" },
  { alias: "lora dl", tableId: "lora-us915-downlink" },
  { alias: "lora 500", tableId: "lora-us915-uplink-500k" },
  { alias: "lora wide", tableId: "lora-us915-uplink-500k" },
  { alias: "lorawan", tableId: "lora-us915-uplink-125k" },
  { alias: "lora", tableId: "lora-us915-uplink-125k" },
  { alias: "zigbee", tableId: "zigbee-802154" },
  { alias: "802.15.4", tableId: "zigbee-802154" },
  { alias: "thread", tableId: "thread-802154" },
  { alias: "matter", tableId: "thread-802154" },
  { alias: "bluetooth le", tableId: "bluetooth-le" },
  { alias: "bluetooth low energy", tableId: "bluetooth-le" },
  { alias: "ble", tableId: "bluetooth-le" },
  { alias: "bluetooth", tableId: "bluetooth-classic" },
  { alias: "bt", tableId: "bluetooth-classic" },
  { alias: "dect", tableId: "dect-6" },
  { alias: "gmrs repeater", tableId: "gmrs-repeater-inputs" },
  { alias: "gmrs input", tableId: "gmrs-repeater-inputs" },
  { alias: "gmrs", tableId: "frs-gmrs" },
  { alias: "frs", tableId: "frs-gmrs" },
  { alias: "murs", tableId: "murs" },
  { alias: "wigig", tableId: "wigig-60ghz" },
  { alias: "60 ghz", tableId: "wigig-60ghz" },
  { alias: "60ghz", tableId: "wigig-60ghz" },
  { alias: "802.11ad", tableId: "wigig-60ghz" },
].sort((a, b) => b.alias.length - a.alias.length);

export interface PlanQuery {
  tableId: string;
  /** The channel id as typed, or undefined for "list the whole plan". */
  channelId?: string;
}

/**
 * Recognize "zigbee 15", "lora channel 8", "ble 37", "gmrs 19", "murs 3",
 * "wigig 2" and the bare plan name. Returns null when no plan alias appears.
 */
export function parsePlanQuery(input: string): PlanQuery | null {
  const text = String(input ?? "")
    .toLowerCase()
    .replace(/[\s_/,]+/g, " ")
    .trim();
  if (!text) return null;
  for (const { alias, tableId } of PLAN_ALIASES) {
    const at = text.indexOf(alias);
    if (at === -1) continue;
    // Word boundary on both sides so "bt" does not fire inside "obtain".
    const before = at === 0 ? " " : text[at - 1]!;
    const afterIdx = at + alias.length;
    const after = afterIdx >= text.length ? " " : text[afterIdx]!;
    if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
    const rest = (text.slice(0, at) + " " + text.slice(afterIdx)).replace(
      /\b(channel|ch|chan)\b/g,
      " ",
    );
    const m = /\b(\d{1,3}[a-z]?)\b/.exec(rest);
    return { tableId, channelId: m ? m[1] : undefined };
  }
  return null;
}

/** The plan table for an id, if it exists. */
export function channelTableById(id: string): ChannelTable | undefined {
  return CHANNEL_TABLES.find((t) => t.id === id);
}

/** Matching channels for a plan query: one exact id hit, or the whole plan. */
export function findPlanChannels(
  query: PlanQuery,
): { table: ChannelTable; channels: Channel[] } | null {
  const table = channelTableById(query.tableId);
  if (!table) return null;
  if (query.channelId === undefined) return { table, channels: table.channels };
  const wanted = query.channelId.toLowerCase();
  const channels = table.channels.filter((c) => c.id.toLowerCase() === wanted);
  return { table, channels };
}

/** Present one plan channel as a jump candidate. */
export function planChannelInterpretation(table: ChannelTable, ch: Channel): Interpretation {
  const width = ch.widthHz ? `, ${formatFrequency(ch.widthHz)} wide` : "";
  const half = (ch.widthHz ?? 0) / 2;
  return {
    id: `plan-${table.id}-${ch.id}`,
    kind: "plan",
    label: `${planShortName(table)} channel ${ch.id}${ch.label ? ` (${ch.label})` : ""}`,
    detail: `${formatFrequency(ch.centerHz)}${width}${ch.note ? `. ${ch.note}` : ""}`,
    frequencyHz: ch.centerHz,
    rangeHz: half > 0 ? [ch.centerHz - half, ch.centerHz + half] : undefined,
    icon: SERVICE_ICONS[table.service] ?? "RadioTower",
    tableId: table.id,
  };
}

/** The part of a plan name before the first comma: "Zigbee and 802.15.4". */
export function planShortName(table: ChannelTable): string {
  return table.name.split(",")[0]!.trim();
}

/* ------------------------------------------------------------------ */
/* Allocation candidates                                               */
/* ------------------------------------------------------------------ */

/** Present one allocation row as a jump candidate, centered on its geometric mean. */
export function allocationInterpretation(a: Allocation): Interpretation {
  return {
    id: `alloc-${a.id}`,
    kind: "allocation",
    label: a.label,
    detail: `${formatRange(a.lowHz, a.highHz)}. ${serviceLabel(a.service)}, ${STATUS_LABELS[a.status].toLowerCase()}`,
    frequencyHz: Math.sqrt(a.lowHz * a.highHz),
    rangeHz: [a.lowHz, a.highHz],
    icon: SERVICE_ICONS[a.service] ?? "RadioTower",
    allocationId: a.id,
  };
}

/* ------------------------------------------------------------------ */
/* Unified search                                                      */
/* ------------------------------------------------------------------ */

const PHYSICS_KINDS = new Set<Interpretation["kind"]>(["frequency", "wavelength", "energy"]);
const CHANNEL_KINDS = new Set<Interpretation["kind"]>(["wifi", "channel"]);

/**
 * Rank, best first: the literal numeric reading, then the numbered channels
 * (Wi-Fi, marine, CB, NOAA, FM, TV, and the fixed plans), then allocation rows
 * that match the text, then the physical band matches. Deduplicated by id and
 * capped at MAX_UNIFIED_RESULTS.
 */
export function unifiedSearch(input: string, region: AllocationRegion = "US"): Interpretation[] {
  const text = String(input ?? "").trim();
  if (!text) return [];

  const base = interpretQuery(text);
  const physics = base.filter((it) => PHYSICS_KINDS.has(it.kind));
  const channels = base.filter((it) => CHANNEL_KINDS.has(it.kind));
  const bands = base.filter((it) => !PHYSICS_KINDS.has(it.kind) && !CHANNEL_KINDS.has(it.kind));

  const plan: Interpretation[] = [];
  const planQuery = parsePlanQuery(text);
  if (planQuery) {
    const hit = findPlanChannels(planQuery);
    if (hit) {
      const list = planQuery.channelId === undefined ? hit.channels.slice(0, 4) : hit.channels;
      for (const ch of list) plan.push(planChannelInterpretation(hit.table, ch));
    }
  }

  const allocations = searchAllocations(text)
    .filter((a) => regionIncludes(a.region, region))
    .slice(0, MAX_ALLOCATION_HITS)
    .map(allocationInterpretation);

  const seen = new Set<string>();
  const out: Interpretation[] = [];
  for (const it of [...physics, ...channels, ...plan, ...allocations, ...bands]) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
    if (out.length >= MAX_UNIFIED_RESULTS) break;
  }
  return out;
}
