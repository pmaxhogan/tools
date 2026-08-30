/**
 * A curated United States radio spectrum allocation reference, 9 kHz to 275 GHz.
 *
 * This module is pure data plus pure helpers: no imports from the framework, no
 * DOM, no network. Everything was hand built from the FCC Table of Frequency
 * Allocations (47 CFR 2.106), the NTIA federal manual, the FCC service part
 * rules, the ITU Radio Regulations, and the standards bodies that define the
 * channel plans. Every section carries a source line and every entry carries a
 * `source` string.
 *
 * It is deliberately a *summary*. The real Table of Frequency Allocations is
 * hundreds of pages of footnotes, and a single row here can stand in for a
 * dozen co-primary services. Where a simplification was made it is stated in
 * `notes`. See `ALLOCATION_META.disclaimer`.
 *
 * Companion modules:
 *   ./data     hierarchical band tree, Wi-Fi channels, marine / CB / NOAA /
 *              FM / TV channel tables. Not duplicated here.
 *   ./rules    FCC RF exposure limits and evaluation exemptions, re-exported
 *              from the bottom of this file.
 */

import { NAMED_CHANNELS, WIFI_CHANNELS } from "./data";

export { exemptionThresholdAt, isExemptFromEvaluation, mpeAt, RF_EXPOSURE } from "./rules";
export type {
  ExemptionResult,
  ExemptionThresholdSegment,
  MpeEnvironment,
  MpeResult,
  MpeSegment,
} from "./rules";

/* ================================================================== */
/* Types                                                              */
/* ================================================================== */

/**
 * The service taxonomy. This is a display and filtering vocabulary, not the
 * ITU's formal list of radio services: it merges some ITU services (fixed and
 * fixed satellite both land under `fixed` or `satellite` depending on which
 * reads more usefully) and splits others that matter to a curious reader
 * (Wi-Fi out of the general unlicensed pool, GNSS out of radionavigation).
 *
 * Exported as a runtime array so validation can iterate it.
 */
export const ALLOCATION_SERVICES = [
  "amateur",
  "amateur-satellite",
  "aeronautical",
  "broadcast-am",
  "broadcast-fm",
  "broadcast-sw",
  "broadcast-tv",
  "cellular",
  "citizens-band",
  "fixed",
  "frs-gmrs",
  "gps-gnss",
  "ism",
  "land-mobile",
  "maritime",
  "meteorological",
  "military",
  "paging",
  "public-safety",
  "radar",
  "radio-astronomy",
  "radiolocation",
  "radionavigation",
  "rfid-nfc",
  "satellite",
  "sdars",
  "space-research",
  "standard-time",
  "telemetry",
  "unlicensed-part15",
  "wifi-unlicensed",
  "wireless-microphones",
  "wireless-power",
] as const;

/** One of the service categories in {@link ALLOCATION_SERVICES}. */
export type AllocationService = (typeof ALLOCATION_SERVICES)[number];

/**
 * How the service holds the spectrum.
 *
 *   primary      protected against interference from secondary users
 *   secondary    must not cause interference to, and cannot claim protection
 *                from, primary users
 *   unlicensed   Part 15 or Part 18 devices, no individual license, no
 *                interference protection at all
 *   restricted   transmission is forbidden or sharply constrained here, for
 *                example the radio astronomy and passive sensing bands
 */
export type AllocationStatus = "primary" | "secondary" | "unlicensed" | "restricted";

/**
 * Which regulatory map the row belongs to. `US` rows are the domestic FCC and
 * NTIA picture; `ITU1` / `ITU2` / `ITU3` rows exist to show where the United
 * States differs from the rest of the world; `global` rows are the same
 * everywhere.
 *
 * The United States sits in ITU Region 2, so a query for `US` also matches
 * `ITU2` and `global` rows. See {@link allocationsAt}.
 */
export type AllocationRegion = "US" | "ITU1" | "ITU2" | "ITU3" | "global";

/** Who is allowed to hold the license: federal agencies, everybody else, or both. */
export type AllocationUser = "federal" | "non-federal";

/** One curated allocation row. */
export interface Allocation {
  /** Stable, unique, kebab case id. */
  id: string;
  /** Lower frequency edge in hertz (inclusive). */
  lowHz: number;
  /** Upper frequency edge in hertz (inclusive). */
  highHz: number;
  /** The service category this row represents. */
  service: AllocationService;
  /** How the service holds the spectrum here. */
  status: AllocationStatus;
  /** Which regulatory map the row belongs to. */
  region: AllocationRegion;
  /** Federal, non federal, or both. Omitted where the split is not meaningful. */
  users?: AllocationUser[];
  /** Short display name, for example "2 m amateur band". */
  label: string;
  /** One sentence saying what actually happens on these frequencies. */
  summary: string;
  /** Plain English rules: who may transmit, license class, power, bandwidth. */
  rules?: string[];
  /** Caveats, simplifications, history, and things that are about to change. */
  notes?: string;
  /** Where the numbers came from. */
  source: string;
}

/* ================================================================== */
/* Authoring helpers                                                  */
/* ================================================================== */

/*
 * Every edge below is written in its natural unit and scaled to hertz exactly
 * once, then rounded, so the stored values are exact integers. Writing
 * 462.5625 * 1e6 directly would be fine here, but rounding removes any doubt
 * and makes the tests able to compare against integer literals.
 */
const kHz = (v: number): number => Math.round(v * 1e3);
const MHz = (v: number): number => Math.round(v * 1e6);
const GHz = (v: number): number => Math.round(v * 1e9);

/* ================================================================== */
/* Sources                                                            */
/* ================================================================== */

const SRC_FCC_TABLE = "FCC Table of Frequency Allocations, 47 CFR 2.106 (retrieved 2026-08-30)";
const SRC_NTIA =
  "NTIA Manual of Regulations and Procedures for Federal Radio Frequency Management, chapter 4 (retrieved 2026-08-30)";
const SRC_ITU = "ITU Radio Regulations, Article 5 Table of Frequency Allocations";
const SRC_PART15 = "47 CFR Part 15 (retrieved 2026-08-30)";
const SRC_PART18 = "47 CFR Part 18, industrial, scientific and medical equipment";
const SRC_PART73 = "47 CFR Part 73, radio broadcast services";
const SRC_PART74 = "47 CFR Part 74, experimental, auxiliary and special broadcast";
const SRC_PART80 = "47 CFR Part 80, stations in the maritime services";
const SRC_PART87 = "47 CFR Part 87, aviation services";
const SRC_PART90 = "47 CFR Part 90, private land mobile radio services";
const SRC_PART95 = "47 CFR Part 95, personal radio services";
const SRC_PART97 =
  "47 CFR Part 97 sections 97.301, 97.303 and 97.305 (retrieved 2026-08-30 via law.cornell.edu)";
const SRC_ARRL = "ARRL US Amateur Radio Bands chart and ARRL band news (retrieved 2026-08-30)";
const SRC_3GPP =
  "3GPP TS 36.101 and TS 38.101 operating band tables, cross checked against the FCC service rules";
const SRC_GNSS =
  "GPS interface specifications IS-GPS-200/705/800 and the published GLONASS, Galileo and BeiDou signal plans";
const SRC_ICAO = "ICAO Annex 10 and 47 CFR Part 87";

/* ================================================================== */
/* The allocation table                                               */
/* ================================================================== */

const ALLOCATION_ROWS: Allocation[] = [
  /* ---------------------------------------------------------------- */
  /* VLF and LF, 9 kHz to 300 kHz                                      */
  /* Source: FCC Table of Frequency Allocations, NTIA manual, Part 15  */
  /* ---------------------------------------------------------------- */
  {
    id: "vlf-radionavigation-9-14k",
    lowHz: kHz(9),
    highHz: kHz(14),
    service: "radionavigation",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "9 kHz to 14 kHz radionavigation",
    summary:
      "The very bottom of the allocated spectrum, historically hyperbolic navigation systems such as Omega.",
    notes:
      "Omega shut down in 1997. The allocation survives, and the band is now mostly used for natural radio research and a handful of experimental transmissions.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "vlf-fixed-maritime-14-19k",
    lowHz: kHz(14),
    highHz: kHz(19.95),
    service: "maritime",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "14 kHz to 19.95 kHz fixed and maritime mobile",
    summary:
      "Very low frequency shore to ship transmitters, in practice navy stations that reach submerged submarines.",
    rules: [
      "Federal government stations only in the United States. Transmitters are megawatt class and antennas are miles of wire.",
    ],
    notes:
      "Well known occupants include NAA Cutler at 24 kHz and NML LaMoure at 25.2 kHz, both just above this row.",
    source: SRC_NTIA,
  },
  {
    id: "vlf-standard-time-20k",
    lowHz: kHz(19.95),
    highHz: kHz(20.05),
    service: "standard-time",
    status: "primary",
    region: "global",
    label: "20 kHz standard frequency and time signal",
    summary:
      "A 100 Hz wide slot reserved worldwide for standard frequency and time transmissions at 20 kHz.",
    source: SRC_ITU,
  },
  {
    id: "vlf-fixed-20-70k",
    lowHz: kHz(20.05),
    highHz: kHz(70),
    service: "fixed",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "20 kHz to 70 kHz fixed and maritime mobile",
    summary:
      "Federal fixed and maritime very low frequency links, including the US Navy submarine broadcast stations.",
    notes:
      "This row also carries the 60 kHz WWVB time signal, which is listed separately because most people are looking for it by name.",
    source: SRC_NTIA,
  },
  {
    id: "wwvb-60k",
    lowHz: kHz(59.9),
    highHz: kHz(60.1),
    service: "standard-time",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "WWVB 60 kHz time code",
    summary:
      "NIST station WWVB near Fort Collins, Colorado, the transmitter that sets every radio controlled clock in North America.",
    rules: [
      "NIST operates the station. Listening needs no license; nothing else may transmit here.",
      "70 kW of radiated power, amplitude modulated with a 1 bit per second time code, plus a phase modulated code for higher precision receivers.",
    ],
    source: "NIST WWVB service description, 47 CFR 2.106 federal allocation",
  },
  {
    id: "lf-wireless-power-87-205k",
    lowHz: kHz(87),
    highHz: kHz(205),
    service: "wireless-power",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "Qi inductive wireless charging",
    summary:
      "The operating range of Qi phone chargers and most inductive charging pads, an unintentional radiator rather than a radio service.",
    rules: [
      "No license. Devices are regulated as wireless power transfer equipment under Part 18 or as unintentional radiators under Part 15, with strict radiated emission limits.",
      "Qi baseline power profile sweeps roughly 110 kHz to 205 kHz; the extended profile reaches down near 87 kHz.",
    ],
    notes:
      "Power is coupled magnetically over a few millimeters, so almost nothing is meant to radiate. The frequency is a circuit design choice, not an allocation.",
    source: SRC_PART18,
  },
  {
    id: "lf-loran-90-110k",
    lowHz: kHz(90),
    highHz: kHz(110),
    service: "radionavigation",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "Loran C and eLoran, 100 kHz",
    summary:
      "The long range hyperbolic navigation band centered on 100 kHz, kept as a terrestrial backup to satellite navigation.",
    notes:
      "The US Coast Guard shut down Loran C in 2010. Interest in eLoran as a GPS backup has kept the allocation and several test transmissions alive.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "lf-rfid-125-134k",
    lowHz: kHz(119),
    highHz: kHz(135),
    service: "rfid-nfc",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "Low frequency RFID, 125 kHz and 134.2 kHz",
    summary:
      "Proximity cards, pet microchips, car immobilizers and livestock tags, all working by magnetic coupling at a few centimeters.",
    rules: [
      "No license. Part 15.209 general radiated emission limits apply, which is why the read range is so short.",
      "125 kHz is the common access control carrier; 134.2 kHz is the ISO 11784/11785 animal identification carrier.",
    ],
    source: SRC_PART15,
  },
  {
    id: "lf-maritime-130-190k",
    lowHz: kHz(130),
    highHz: kHz(190),
    service: "maritime",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "130 kHz to 190 kHz fixed and maritime mobile",
    summary: "Low frequency maritime and fixed links, thinly used in North America.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "amateur-2200m",
    lowHz: kHz(135.7),
    highHz: kHz(137.8),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "2200 m amateur band",
    summary:
      "A 2.1 kHz sliver of low frequency spectrum where amateurs run very slow digital modes over intercontinental distances.",
    rules: [
      "General, Advanced and Amateur Extra class licensees.",
      "Maximum 1 W effective isotropic radiated power. A practical antenna here is so inefficient that a kilowatt transmitter can be needed to reach 1 W EIRP.",
      "You must notify the Utilities Technology Council and wait 30 days before your first transmission, because power line carrier systems share the band.",
    ],
    notes:
      "Shared with unlicensed power line carrier systems on electricity distribution networks, which is the reason for the notification rule.",
    source: SRC_PART97,
  },
  {
    id: "lf-ndb-190-435k",
    lowHz: kHz(190),
    highHz: kHz(435),
    service: "aeronautical",
    status: "primary",
    region: "US",
    users: ["federal", "non-federal"],
    label: "Aeronautical non directional beacons",
    summary:
      "NDBs: simple low frequency beacons that send a Morse identifier for aircraft automatic direction finders to home on.",
    rules: [
      "Licensed aeronautical ground stations. The FAA has been decommissioning NDBs steadily as GPS approaches replace them.",
    ],
    notes:
      "Amateur radio hobbyists chase these as beacon DXing. The 630 m amateur band sits inside this range and is listed separately.",
    source: SRC_PART87,
  },
  {
    id: "amateur-630m",
    lowHz: kHz(472),
    highHz: kHz(479),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "630 m amateur band",
    summary:
      "A 7 kHz medium frequency band for weak signal digital work, opened to US amateurs in 2017.",
    rules: [
      "General, Advanced and Amateur Extra class licensees.",
      "Maximum 5 W effective isotropic radiated power, reduced to 1 W EIRP in parts of Alaska within 800 km of the Russian border.",
      "Notify the Utilities Technology Council and wait 30 days before the first transmission.",
    ],
    notes: "WSPR and FT8 dominate. Ground wave coverage is a few hundred miles by day.",
    source: SRC_PART97,
  },
  {
    id: "mf-maritime-415-495k",
    lowHz: kHz(415),
    highHz: kHz(495),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "415 kHz to 495 kHz maritime mobile",
    summary:
      "The old maritime radiotelegraph band, now mostly quiet apart from NAVTEX and a few coastal stations.",
    source: SRC_PART80,
  },
  {
    id: "navtex-518k",
    lowHz: kHz(517.5),
    highHz: kHz(518.5),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "NAVTEX 518 kHz",
    summary:
      "The international NAVTEX channel, which broadcasts navigational warnings and weather to ships as narrow band direct printing text.",
    rules: [
      "Coast stations only. Receivers are mandatory equipment on many vessels under the GMDSS rules.",
    ],
    notes: "490 kHz carries national language NAVTEX and 4209.5 kHz carries the HF version.",
    source: SRC_PART80,
  },
  {
    id: "mf-distress-500k",
    lowHz: kHz(495),
    highHz: kHz(505),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "500 kHz maritime distress, historic",
    summary:
      "The original international radiotelegraph distress frequency, silent since GMDSS replaced Morse watchkeeping in 1999.",
    notes:
      "Guard periods used to be observed twice an hour. The band is now allocated to maritime mobile but carries almost no traffic.",
    source: SRC_PART80,
  },

  /* ---------------------------------------------------------------- */
  /* MF, 535 kHz to 3 MHz                                              */
  /* Source: 47 CFR Part 73 subpart B, Part 80, FCC table              */
  /* ---------------------------------------------------------------- */
  {
    id: "broadcast-am-535-1705k",
    lowHz: kHz(535),
    highHz: kHz(1705),
    service: "broadcast-am",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "AM broadcast band, 540 kHz to 1700 kHz",
    summary:
      "The medium wave AM band. Carriers sit on 10 kHz spacing from 540 kHz to 1700 kHz, each station occupying about 20 kHz.",
    rules: [
      "Licensed under Part 73 subpart B. Daytime powers run from 250 W to 50 kW; most stations must reduce power, switch to a directional pattern, or go off the air at night.",
      "Class A clear channel stations run 50 kW around the clock and can be heard hundreds of miles away after dark.",
    ],
    notes:
      "Region 1 uses 9 kHz channel spacing from 526.5 kHz to 1606.5 kHz, so European and US dial positions do not line up.",
    source: SRC_PART73,
  },
  {
    id: "broadcast-am-expanded-1605-1705k",
    lowHz: kHz(1605),
    highHz: kHz(1705),
    service: "broadcast-am",
    status: "primary",
    region: "ITU2",
    users: ["non-federal"],
    label: "Expanded AM band, 1610 kHz to 1700 kHz",
    summary:
      "Ten extra AM channels added in the 1990s in Region 2 to relieve congestion lower in the band.",
    rules: ["10 kW day and 1 kW night, non directional, with reduced interference protection."],
    source: SRC_PART73,
  },
  {
    id: "mf-tis-1610k",
    lowHz: kHz(1609.5),
    highHz: kHz(1610.5),
    service: "land-mobile",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "Travelers information stations, 1610 kHz",
    summary:
      "Low power highway advisory radio run by state agencies, parks and airports, the stations behind the roadside signs.",
    rules: [
      "Licensed to government entities under Part 90 subpart P. 10 W transmitter output into a short antenna.",
    ],
    source: SRC_PART90,
  },
  {
    id: "amateur-160m",
    lowHz: kHz(1800),
    highHz: kHz(2000),
    service: "amateur",
    status: "primary",
    region: "ITU2",
    users: ["non-federal"],
    label: "160 m amateur band, the top band",
    summary:
      "The lowest classic amateur band, a night time and winter band where a full size antenna is the size of a football field.",
    rules: [
      "All license classes from Technician up have the entire 1800 kHz to 2000 kHz band, all modes.",
      "1500 W PEP output, the general amateur limit.",
      "Region 1 amateurs only get 1810 kHz to 1850 kHz, so intercontinental contacts here need cross band planning.",
    ],
    source: SRC_PART97,
  },
  {
    id: "mf-maritime-2000-2065k",
    lowHz: kHz(2000),
    highHz: kHz(2065),
    service: "maritime",
    status: "primary",
    region: "US",
    label: "2 MHz maritime mobile",
    summary: "Medium frequency ship to shore radiotelephone working channels.",
    source: SRC_PART80,
  },
  {
    id: "mf-distress-2182k",
    lowHz: kHz(2173.5),
    highHz: kHz(2190.5),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "2182 kHz maritime distress and calling",
    summary:
      "The international medium frequency distress, urgency and safety voice frequency, with 2187.5 kHz alongside it for digital selective calling.",
    rules: [
      "All ships and coast stations. Silence periods are observed for three minutes at the top and half of each hour.",
    ],
    source: SRC_PART80,
  },
  {
    id: "mf-standard-time-2500k",
    lowHz: kHz(2495),
    highHz: kHz(2505),
    service: "standard-time",
    status: "primary",
    region: "global",
    label: "WWV and WWVH 2.5 MHz",
    summary:
      "The lowest of the NIST shortwave time and frequency broadcasts, best after dark over short paths.",
    rules: ["WWV in Colorado runs 2.5 kW here; WWVH in Hawaii runs 5 kW."],
    source: "NIST WWV and WWVH service description",
  },
  {
    id: "mf-aeronautical-2850-3155k",
    lowHz: kHz(2850),
    highHz: kHz(3155),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "Aeronautical mobile route service, 3 MHz",
    summary:
      "The lowest HF band used for long haul air traffic control on oceanic and remote routes.",
    source: SRC_PART87,
  },

  /* ---------------------------------------------------------------- */
  /* HF, 3 MHz to 30 MHz                                               */
  /* Source: ITU Radio Regulations Article 5, 47 CFR Part 97, Part 95  */
  /* subpart D, Part 18, NIST service descriptions                     */
  /* ---------------------------------------------------------------- */
  {
    id: "sw-120m",
    lowHz: kHz(2300),
    highHz: kHz(2495),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "120 m tropical broadcast band",
    summary:
      "One of the tropical bands, allocated for domestic broadcasting inside the tropics where medium wave suffers from static.",
    notes: "Very few stations remain. Region 2 use is limited to the tropical zone.",
    source: SRC_ITU,
  },
  {
    id: "sw-90m",
    lowHz: kHz(3200),
    highHz: kHz(3400),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "90 m tropical broadcast band",
    summary: "The second tropical broadcast band, shared with fixed and mobile services.",
    source: SRC_ITU,
  },
  {
    id: "amateur-80m",
    lowHz: kHz(3500),
    highHz: kHz(4000),
    service: "amateur",
    status: "primary",
    region: "ITU2",
    users: ["non-federal"],
    label: "80 m and 75 m amateur band",
    summary:
      "The workhorse regional night time band. 80 m by convention means the CW and digital half, 75 m the voice half.",
    rules: [
      "Amateur Extra: 3.500 to 4.000 MHz, the whole band.",
      "Advanced: 3.525 to 3.600 MHz and 3.700 to 4.000 MHz.",
      "General: 3.525 to 3.600 MHz and 3.800 to 4.000 MHz.",
      "Technician and Novice: 3.525 to 3.600 MHz, CW only.",
      "Phone and image are allowed from 3.600 to 4.000 MHz; below that it is CW, RTTY and data.",
      "1500 W PEP output.",
    ],
    notes:
      "Region 1 only has 3.500 to 3.800 MHz, and 3.900 to 4.000 MHz is a broadcast band there, so the top of the US band is not usable worldwide.",
    source: SRC_PART97,
  },
  {
    id: "sw-75m-region1",
    lowHz: kHz(3900),
    highHz: kHz(4000),
    service: "broadcast-sw",
    status: "primary",
    region: "ITU1",
    label: "75 m broadcast band, Regions 1 and 3",
    summary:
      "Broadcasting occupies 3.9 to 4.0 MHz outside the Americas, directly on top of the US 75 m amateur phone band.",
    notes:
      "This is one of the clearest examples of a regional difference. A US station calling CQ on 3.950 MHz is inside a foreign broadcast channel.",
    source: SRC_ITU,
  },
  {
    id: "hf-maritime-4000-4438k",
    lowHz: kHz(4000),
    highHz: kHz(4438),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "4 MHz maritime mobile",
    summary:
      "The first of the HF marine bands, with 4125 kHz as the distress and calling voice frequency and 4207.5 kHz for digital selective calling.",
    source: SRC_PART80,
  },
  {
    id: "hf-aeronautical-4650-4750k",
    lowHz: kHz(4650),
    highHz: kHz(4750),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "4.7 MHz aeronautical mobile route",
    summary: "Long haul air traffic control voice on oceanic and polar routes.",
    source: SRC_PART87,
  },
  {
    id: "sw-60m",
    lowHz: kHz(4750),
    highHz: kHz(4995),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "60 m tropical broadcast band",
    summary:
      "The busiest of the tropical bands, still carrying domestic services in Africa and Asia.",
    source: SRC_ITU,
  },
  {
    id: "hf-standard-time-5000k",
    lowHz: kHz(4995),
    highHz: kHz(5005),
    service: "standard-time",
    status: "primary",
    region: "global",
    label: "WWV, WWVH and CHU neighbors at 5 MHz",
    summary:
      "The 5 MHz standard frequency and time band, carrying WWV from Colorado and WWVH from Hawaii at 10 kW each.",
    rules: ["Reserved worldwide for standard frequency and time signal stations."],
    source: "NIST WWV and WWVH service description, ITU Radio Regulations Article 5",
  },
  {
    id: "amateur-60m-channels",
    lowHz: kHz(5330.5),
    highHz: kHz(5405),
    service: "amateur",
    status: "secondary",
    region: "US",
    users: ["non-federal"],
    label: "60 m amateur channels",
    summary:
      "Four fixed channels shared with federal users, the only channelised amateur allocation in the United States.",
    rules: [
      "General class and higher. Channel centers are 5332, 5348, 5373 and 5405 kHz.",
      "Maximum 100 W PEP effective radiated power relative to a half wave dipole, and 2.8 kHz maximum bandwidth.",
      "Upper sideband only for voice. Amateurs are secondary to federal users and must not cause interference.",
    ],
    notes:
      "The former fifth channel at 5358.5 kHz was folded into the new 5351.5 to 5366.5 kHz sub band on 13 February 2026 and now carries that sub band's much lower power limit.",
    source: SRC_ARRL,
  },
  {
    id: "amateur-60m-band",
    lowHz: kHz(5351.5),
    highHz: kHz(5366.5),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "60 m amateur band, worldwide allocation",
    summary:
      "The 15 kHz worldwide secondary amateur allocation agreed at WRC-15, available to US amateurs since 13 February 2026.",
    rules: [
      "General class and higher, secondary to federal and fixed service users.",
      "Maximum 9.15 W effective radiated power, and 2.8 kHz maximum bandwidth.",
    ],
    notes:
      "The power limit here is far lower than on the four legacy US channels, which is the trade for a real band instead of fixed channels.",
    source: SRC_ARRL,
  },
  {
    id: "sw-60m-extension",
    lowHz: kHz(5005),
    highHz: kHz(5060),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "5005 kHz to 5060 kHz broadcasting",
    summary: "A small extension of the tropical broadcast allocation above the 5 MHz time band.",
    source: SRC_ITU,
  },
  {
    id: "hf-aeronautical-5450-5730k",
    lowHz: kHz(5450),
    highHz: kHz(5730),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "5.5 MHz aeronautical mobile",
    summary:
      "Air traffic control and military air to ground HF, including part of the US High Frequency Global Communications System.",
    source: SRC_PART87,
  },
  {
    id: "sw-49m",
    lowHz: kHz(5900),
    highHz: kHz(6200),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "49 m international broadcast band",
    summary:
      "The classic night time shortwave broadcast band, the first place a beginner finds international stations after dark.",
    source: SRC_ITU,
  },
  {
    id: "hf-maritime-6200-6525k",
    lowHz: kHz(6200),
    highHz: kHz(6525),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "6 MHz maritime mobile",
    summary:
      "HF marine band with 6215 kHz as the distress and calling voice frequency and 6312 kHz for digital selective calling.",
    source: SRC_PART80,
  },
  {
    id: "hf-aeronautical-6525-6765k",
    lowHz: kHz(6525),
    highHz: kHz(6765),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "6.6 MHz aeronautical mobile route",
    summary: "Oceanic air traffic control voice, heavily used on North Atlantic tracks at night.",
    source: SRC_PART87,
  },
  {
    id: "ism-6780k",
    lowHz: kHz(6765),
    highHz: kHz(6795),
    service: "ism",
    status: "unlicensed",
    region: "global",
    label: "6.78 MHz ISM band",
    summary:
      "An industrial, scientific and medical band centered on 6.78 MHz, used by resonant wireless power systems and some industrial heaters.",
    rules: [
      "Part 18 equipment operates here with no communication license. Radiated emission limits still apply and users get no protection from interference.",
    ],
    source: SRC_PART18,
  },
  {
    id: "amateur-40m",
    lowHz: kHz(7000),
    highHz: kHz(7300),
    service: "amateur",
    status: "primary",
    region: "ITU2",
    users: ["non-federal"],
    label: "40 m amateur band",
    summary:
      "The most reliable all round HF band: regional by day, continental to intercontinental at night, and open through most of the solar cycle.",
    rules: [
      "Amateur Extra: 7.000 to 7.300 MHz, the whole band.",
      "Advanced: 7.025 to 7.300 MHz.",
      "General: 7.025 to 7.125 MHz and 7.175 to 7.300 MHz.",
      "Technician and Novice: 7.025 to 7.125 MHz, CW only.",
      "Phone and image are allowed 7.125 to 7.300 MHz, plus 7.075 to 7.100 MHz for stations in specified Pacific and Caribbean areas.",
      "1500 W PEP output.",
    ],
    notes:
      "Regions 1 and 3 only have 7.000 to 7.200 MHz for amateurs, and broadcasting starts at 7.200 MHz there. US phone activity above 7.200 MHz can therefore land on top of foreign broadcasters.",
    source: SRC_PART97,
  },
  {
    id: "sw-41m",
    lowHz: kHz(7200),
    highHz: kHz(7450),
    service: "broadcast-sw",
    status: "primary",
    region: "ITU1",
    label: "41 m broadcast band, Regions 1 and 3",
    summary:
      "International broadcasting from 7.2 MHz upward outside the Americas, overlapping the top 100 kHz of the US 40 m amateur band.",
    notes:
      "7.300 to 7.450 MHz is broadcasting everywhere; 7.200 to 7.300 MHz is broadcasting in Regions 1 and 3 and amateur in Region 2. This is the single most quoted example of an ITU regional clash.",
    source: SRC_ITU,
  },
  {
    id: "hf-standard-time-chu",
    lowHz: kHz(7849),
    highHz: kHz(7851),
    service: "standard-time",
    status: "primary",
    region: "US",
    label: "CHU Canada 7850 kHz",
    summary:
      "The National Research Council of Canada time signal station, also on 3330 kHz and 14670 kHz, with a bilingual voice announcement and an FSK time code.",
    source: "National Research Council of Canada CHU service description",
  },
  {
    id: "hf-maritime-8100-8815k",
    lowHz: kHz(8100),
    highHz: kHz(8815),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "8 MHz maritime mobile",
    summary:
      "The busiest HF marine band, with 8291 kHz for distress voice and 8414.5 kHz for digital selective calling.",
    source: SRC_PART80,
  },
  {
    id: "hf-aeronautical-8815-9040k",
    lowHz: kHz(8815),
    highHz: kHz(9040),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "8.9 MHz aeronautical mobile route",
    summary:
      "Daytime oceanic air traffic control. 8992 kHz is a US Air Force High Frequency Global Communications System frequency.",
    source: SRC_PART87,
  },
  {
    id: "sw-31m",
    lowHz: kHz(9400),
    highHz: kHz(9900),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "31 m international broadcast band",
    summary:
      "The most crowded shortwave broadcast band, usable day and night across a wide range of path lengths.",
    source: SRC_ITU,
  },
  {
    id: "hf-standard-time-10000k",
    lowHz: kHz(9995),
    highHz: kHz(10005),
    service: "standard-time",
    status: "primary",
    region: "global",
    label: "WWV and WWVH 10 MHz",
    summary:
      "The 10 MHz standard frequency and time band, the most consistently usable NIST time broadcast across the continental United States.",
    source: "NIST WWV and WWVH service description",
  },
  {
    id: "hf-aeronautical-10005-10100k",
    lowHz: kHz(10005),
    highHz: kHz(10100),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "10 MHz aeronautical mobile route",
    summary: "A narrow air traffic control allocation directly below the 30 m amateur band.",
    source: SRC_PART87,
  },
  {
    id: "amateur-30m",
    lowHz: kHz(10100),
    highHz: kHz(10150),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "30 m amateur band",
    summary:
      "A quiet 50 kHz WARC band for CW and digital modes only, with no contests by long standing gentlemen's agreement.",
    rules: [
      "General class and higher.",
      "CW, RTTY and data only. No phone and no image, anywhere in the band.",
      "200 W PEP output maximum, and amateurs are secondary to the fixed service.",
    ],
    notes:
      "One of the three WARC bands added in 1979, along with 17 m and 12 m. Contest operation is excluded by convention, not by rule.",
    source: SRC_PART97,
  },
  {
    id: "hf-aeronautical-11175-11400k",
    lowHz: kHz(11175),
    highHz: kHz(11400),
    service: "aeronautical",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "11.2 MHz aeronautical mobile off route",
    summary:
      "Military air to ground HF. 11175 kHz is the primary US Air Force High Frequency Global Communications System calling frequency.",
    source: SRC_PART87,
  },
  {
    id: "sw-25m",
    lowHz: kHz(11600),
    highHz: kHz(12100),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "25 m international broadcast band",
    summary:
      "A daytime and evening broadcast band that follows the 31 m band as the ionosphere lifts.",
    source: SRC_ITU,
  },
  {
    id: "hf-maritime-12230-13200k",
    lowHz: kHz(12230),
    highHz: kHz(13200),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "12 MHz maritime mobile",
    summary:
      "A long haul HF marine band, with 12290 kHz for distress voice and 12577 kHz for digital selective calling.",
    source: SRC_PART80,
  },
  {
    id: "ism-13560k",
    lowHz: kHz(13553),
    highHz: kHz(13567),
    service: "rfid-nfc",
    status: "unlicensed",
    region: "global",
    label: "13.56 MHz ISM band, NFC and HF RFID",
    summary:
      "The carrier behind contactless payment, transit cards, NFC tags, passports, library tags and inductive industrial heaters.",
    rules: [
      "No license. Near field devices are governed by Part 15.225, which allows a much higher field strength inside the innermost 13.553 to 13.567 MHz slice than the general Part 15 limits.",
      "The standards that live here are ISO 14443, ISO 15693, ISO 18092 (NFC) and FeliCa.",
    ],
    notes:
      "Also a Part 18 ISM band, so RF welders and plasma equipment share it. Coupling is magnetic, so the working range is a few centimeters.",
    source: SRC_PART15,
  },
  {
    id: "sw-22m",
    lowHz: kHz(13570),
    highHz: kHz(13870),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "22 m international broadcast band",
    summary: "A daytime broadcast band that only opens well near solar maximum.",
    source: SRC_ITU,
  },
  {
    id: "amateur-20m",
    lowHz: kHz(14000),
    highHz: kHz(14350),
    service: "amateur",
    status: "primary",
    region: "global",
    users: ["non-federal"],
    label: "20 m amateur band",
    summary:
      "The classic worldwide DX band, open somewhere on the planet almost every day of the solar cycle.",
    rules: [
      "Amateur Extra: 14.000 to 14.350 MHz, the whole band.",
      "Advanced: 14.025 to 14.150 MHz and 14.175 to 14.350 MHz.",
      "General: 14.025 to 14.150 MHz and 14.225 to 14.350 MHz.",
      "Technician and Novice: no privileges on 20 m.",
      "Phone and image are allowed from 14.150 to 14.350 MHz.",
      "1500 W PEP output.",
    ],
    notes:
      "14.100 MHz carries the international beacon project, a chain of stations that transmit in a timed sequence so you can gauge propagation.",
    source: SRC_PART97,
  },
  {
    id: "hf-standard-time-15000k",
    lowHz: kHz(14990),
    highHz: kHz(15010),
    service: "standard-time",
    status: "primary",
    region: "global",
    label: "WWV and WWVH 15 MHz",
    summary: "The 15 MHz standard frequency and time band, a daytime path across the continent.",
    source: "NIST WWV and WWVH service description",
  },
  {
    id: "sw-19m",
    lowHz: kHz(15100),
    highHz: kHz(15800),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "19 m international broadcast band",
    summary: "A wide daytime broadcast band, still one of the better populated ones.",
    source: SRC_ITU,
  },
  {
    id: "hf-maritime-16360-17410k",
    lowHz: kHz(16360),
    highHz: kHz(17410),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "16 MHz maritime mobile",
    summary:
      "The long haul HF marine band, with 16420 kHz for distress voice and 16804.5 kHz for digital selective calling.",
    source: SRC_PART80,
  },
  {
    id: "sw-16m",
    lowHz: kHz(17480),
    highHz: kHz(17900),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "16 m international broadcast band",
    summary: "A daytime broadcast band for long paths when the ionosphere is well ionised.",
    source: SRC_ITU,
  },
  {
    id: "hf-aeronautical-17900-17970k",
    lowHz: kHz(17900),
    highHz: kHz(17970),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "17.9 MHz aeronautical mobile route",
    summary: "Daytime long haul air traffic control on oceanic routes.",
    source: SRC_PART87,
  },
  {
    id: "amateur-17m",
    lowHz: kHz(18068),
    highHz: kHz(18168),
    service: "amateur",
    status: "primary",
    region: "global",
    users: ["non-federal"],
    label: "17 m amateur band",
    summary:
      "A 100 kHz WARC band with a DX flavor similar to 20 m but with less contest activity to fight through.",
    rules: [
      "General class and higher. There is no sub band split by class.",
      "Phone and image are allowed from 18.110 to 18.168 MHz; below that is CW, RTTY and data.",
      "1500 W PEP output.",
    ],
    source: SRC_PART97,
  },
  {
    id: "sw-15m",
    lowHz: kHz(18900),
    highHz: kHz(19020),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "15 m international broadcast band",
    summary: "A little used broadcast allocation that never attracted many stations.",
    source: SRC_ITU,
  },
  {
    id: "hf-standard-time-20000k",
    lowHz: kHz(19990),
    highHz: kHz(20010),
    service: "standard-time",
    status: "primary",
    region: "global",
    label: "WWV 20 MHz",
    summary: "The 20 MHz NIST time broadcast, a daytime signal that fades out after dark.",
    source: "NIST WWV service description",
  },
  {
    id: "amateur-15m",
    lowHz: kHz(21000),
    highHz: kHz(21450),
    service: "amateur",
    status: "primary",
    region: "global",
    users: ["non-federal"],
    label: "15 m amateur band",
    summary:
      "A daytime DX band that comes alive near solar maximum and can carry worldwide contacts on modest power.",
    rules: [
      "Amateur Extra: 21.000 to 21.450 MHz, the whole band.",
      "Advanced: 21.025 to 21.200 MHz and 21.225 to 21.450 MHz.",
      "General: 21.025 to 21.200 MHz and 21.275 to 21.450 MHz.",
      "Technician and Novice: 21.025 to 21.200 MHz, CW only.",
      "Phone and image are allowed from 21.200 to 21.450 MHz.",
      "1500 W PEP output.",
    ],
    source: SRC_PART97,
  },
  {
    id: "sw-13m",
    lowHz: kHz(21450),
    highHz: kHz(21850),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "13 m international broadcast band",
    summary: "A solar maximum daytime band sitting immediately above the 15 m amateur band.",
    source: SRC_ITU,
  },
  {
    id: "hf-maritime-22000-22855k",
    lowHz: kHz(22000),
    highHz: kHz(22855),
    service: "maritime",
    status: "primary",
    region: "global",
    label: "22 MHz maritime mobile",
    summary: "The highest of the main HF marine bands, usable only on good daytime paths.",
    source: SRC_PART80,
  },
  {
    id: "amateur-12m",
    lowHz: kHz(24890),
    highHz: kHz(24990),
    service: "amateur",
    status: "primary",
    region: "global",
    users: ["non-federal"],
    label: "12 m amateur band",
    summary:
      "The third WARC band, a quiet 100 kHz slot that behaves like a calmer version of 10 m.",
    rules: [
      "General class and higher. No sub band split by class.",
      "Phone and image are allowed from 24.930 to 24.990 MHz.",
      "1500 W PEP output.",
    ],
    source: SRC_PART97,
  },
  {
    id: "hf-standard-time-25000k",
    lowHz: kHz(24990),
    highHz: kHz(25010),
    service: "standard-time",
    status: "primary",
    region: "global",
    label: "WWV 25 MHz",
    summary:
      "The highest NIST time broadcast, restored as an experimental transmission and useful as a quick propagation check.",
    source: "NIST WWV service description",
  },
  {
    id: "sw-11m",
    lowHz: kHz(25670),
    highHz: kHz(26100),
    service: "broadcast-sw",
    status: "primary",
    region: "global",
    label: "11 m international broadcast band",
    summary:
      "The highest shortwave broadcast band, essentially only usable at solar maximum and now nearly empty.",
    source: SRC_ITU,
  },
  {
    id: "citizens-band-27mhz",
    lowHz: kHz(26965),
    highHz: kHz(27405),
    service: "citizens-band",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "Citizens Band, 40 channels",
    summary:
      "The 40 channel CB service, license free since 1983, still used by truckers, off roaders and farms.",
    rules: [
      "No license needed. Anyone may operate a certified CB radio, including children.",
      "4 W carrier output on AM, 12 W PEP on single sideband. External amplifiers are prohibited.",
      "Channel 9 is reserved for emergencies; channel 19 is the informal highway channel.",
      "Antenna height is limited to 20 feet above a natural formation or existing structure.",
    ],
    notes:
      "Individual channel frequencies live in NAMED_CHANNELS in ./data and are not duplicated here.",
    source: SRC_PART95,
  },
  {
    id: "ism-27120k",
    lowHz: kHz(26957),
    highHz: kHz(27283),
    service: "ism",
    status: "unlicensed",
    region: "global",
    label: "27.12 MHz ISM band",
    summary:
      "The ISM band that overlaps CB, home to short wave diathermy, plastic welders, and older radio controlled models.",
    rules: [
      "Part 18 equipment needs no communication license. Part 15 remote control devices also operate here under 15.235.",
    ],
    notes:
      "The overlap with CB is why cheap toy transmitters sometimes appear on a CB radio. 27.145 MHz is a common toy remote channel.",
    source: SRC_PART18,
  },
  {
    id: "amateur-10m",
    lowHz: MHz(28),
    highHz: MHz(29.7),
    service: "amateur",
    status: "primary",
    region: "global",
    users: ["non-federal"],
    label: "10 m amateur band",
    summary:
      "A 1.7 MHz wide band that is dead at solar minimum and worldwide on a few watts at solar maximum, and the only HF band Technicians can use for voice.",
    rules: [
      "Amateur Extra, Advanced and General: 28.000 to 29.700 MHz, all modes.",
      "Technician and Novice: 28.000 to 28.500 MHz, with CW, RTTY and data from 28.000 to 28.300 MHz and single sideband phone from 28.300 to 28.500 MHz.",
      "Technician and Novice power is limited to 200 W PEP; other classes may run 1500 W PEP.",
      "FM repeaters and simplex operate between 29.500 and 29.700 MHz.",
    ],
    notes:
      "28.200 to 28.300 MHz holds the beacon sub band, which is the fastest way to tell whether the band is open.",
    source: SRC_PART97,
  },

  /* ---------------------------------------------------------------- */
  /* VHF, 30 MHz to 300 MHz                                            */
  /* Source: FCC table, Part 73, Part 74, Part 80, Part 87, Part 90,   */
  /* Part 95 subpart J, Part 97, NTIA manual                           */
  /* ---------------------------------------------------------------- */
  {
    id: "vhf-lowband-landmobile-30-50",
    lowHz: MHz(29.7),
    highHz: MHz(50),
    service: "land-mobile",
    status: "primary",
    region: "US",
    users: ["federal", "non-federal"],
    label: "VHF low band land mobile, 30 MHz to 50 MHz",
    summary:
      "Legacy low band dispatch: state highway patrols, forestry, utilities, school buses and federal agencies, on 20 kHz channels.",
    rules: [
      "Licensed under Part 90 for non federal users and coordinated by NTIA for federal agencies. Frequencies are assigned per licensee, not shared casually.",
    ],
    notes:
      "Low band travels a long way over terrain but suffers badly from ignition noise and from summer sporadic E skip that drops distant users on top of each other.",
    source: SRC_PART90,
  },
  {
    id: "ra-38mhz",
    lowHz: MHz(37.5),
    highHz: MHz(38.25),
    service: "radio-astronomy",
    status: "secondary",
    region: "US",
    label: "37.5 MHz to 38.25 MHz radio astronomy",
    summary:
      "A low frequency radio astronomy allocation used for solar and Jupiter observations and for low frequency arrays.",
    notes:
      "Secondary in the United States and protected mainly by coordination near observatories.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ism-40680k",
    lowHz: MHz(40.66),
    highHz: MHz(40.7),
    service: "ism",
    status: "unlicensed",
    region: "global",
    label: "40.68 MHz ISM band",
    summary:
      "A narrow ISM band used by industrial heating equipment, some medical telemetry, and older radio control gear.",
    rules: ["Part 18 equipment, plus Part 15 devices operating under 15.229 and 15.231."],
    source: SRC_PART18,
  },
  {
    id: "part15-49mhz",
    lowHz: MHz(49.82),
    highHz: MHz(49.9),
    service: "unlicensed-part15",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "49 MHz low power devices",
    summary:
      "The band behind 1980s and 1990s cordless phones, baby monitors, walkie talkie toys and wireless intercoms.",
    rules: [
      "No license. Part 15.235 allows operation with a field strength limit rather than a power limit, which works out to a few tens of milliwatts.",
    ],
    notes: "Almost entirely displaced by 2.4 GHz and DECT, but cheap toys still ship on it.",
    source: SRC_PART15,
  },
  {
    id: "amateur-6m",
    lowHz: MHz(50),
    highHz: MHz(54),
    service: "amateur",
    status: "primary",
    region: "ITU2",
    users: ["non-federal"],
    label: "6 m amateur band, the magic band",
    summary:
      "A 4 MHz VHF band that is normally line of sight but opens to continental and intercontinental distances on sporadic E and F2 propagation.",
    rules: [
      "All license classes from Technician up have the entire band, all modes.",
      "50.0 to 50.1 MHz is CW only. Phone, image, RTTY and data are allowed from 50.1 to 54.0 MHz.",
      "1500 W PEP output.",
      "50.125 MHz is the national SSB calling frequency; 50.313 MHz is the FT8 watering hole.",
    ],
    notes:
      "Region 1 amateurs have only 50 to 52 MHz and in some countries less than that, which shapes where transatlantic openings get worked.",
    source: SRC_PART97,
  },
  {
    id: "tv-vhf-low-54-72",
    lowHz: MHz(54),
    highHz: MHz(72),
    service: "broadcast-tv",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "TV channels 2 to 4",
    summary:
      "The bottom of the VHF television band, three 6 MHz channels that survived the digital transition and the 600 MHz repack.",
    rules: ["Licensed under Part 73 subpart E. ATSC 1.0 and, in some markets, ATSC 3.0."],
    notes:
      "Very few full power stations still use channels 2 to 6: digital television is far more vulnerable to impulse noise at these frequencies than analogue was.",
    source: SRC_PART73,
  },
  {
    id: "rc-aircraft-72mhz",
    lowHz: MHz(72),
    highHz: MHz(73),
    service: "unlicensed-part15",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "72 MHz radio control, model aircraft",
    summary:
      "The traditional 50 channel band for radio controlled model aircraft, spaced 20 kHz apart.",
    rules: [
      "No license. Part 15.235 governs the transmitters, and by rule this band is for aircraft models only. Surface models use 75 MHz.",
    ],
    notes: "Largely replaced by 2.4 GHz spread spectrum systems that need no frequency pin.",
    source: SRC_PART15,
  },
  {
    id: "ra-73mhz",
    lowHz: MHz(73),
    highHz: MHz(74.6),
    service: "radio-astronomy",
    status: "restricted",
    region: "US",
    label: "73 MHz to 74.6 MHz radio astronomy, exclusive",
    summary:
      "A protected passive band with no transmitters allowed at all, used by low frequency arrays such as the VLA low band system.",
    rules: [
      "No transmission is permitted. This is one of the few bands allocated exclusively to radio astronomy in the United States.",
    ],
    source: SRC_FCC_TABLE,
  },
  {
    id: "marker-beacon-75mhz",
    lowHz: MHz(74.8),
    highHz: MHz(75.2),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "75 MHz instrument landing marker beacons",
    summary:
      "The outer, middle and inner marker beacons of an instrument landing system, all transmitting straight up on 75.000 MHz.",
    rules: [
      "Airport ground stations only. The beacon radiates a narrow vertical fan so an aircraft hears it only when directly overhead.",
    ],
    notes:
      "Marker beacons are being decommissioned as DME and GPS provide the same distance information.",
    source: SRC_ICAO,
  },
  {
    id: "rc-surface-75mhz",
    lowHz: MHz(75.41),
    highHz: MHz(76),
    service: "unlicensed-part15",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "75 MHz radio control, surface models",
    summary: "The companion band to 72 MHz, reserved for radio controlled cars and boats.",
    rules: ["No license, Part 15.235. Surface models only; aircraft models must use 72 MHz."],
    source: SRC_PART15,
  },
  {
    id: "tv-vhf-low-76-88",
    lowHz: MHz(76),
    highHz: MHz(88),
    service: "broadcast-tv",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "TV channels 5 and 6",
    summary: "Two more 6 MHz VHF television channels immediately below the FM broadcast band.",
    notes:
      "The audio subcarrier of an analogue channel 6 used to appear at 87.75 MHz, just below the FM dial, which is how a few stations ran as radio outlets.",
    source: SRC_PART73,
  },
  {
    id: "broadcast-fm-88-108",
    lowHz: MHz(88),
    highHz: MHz(108),
    service: "broadcast-fm",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "FM broadcast band, 88.1 MHz to 107.9 MHz",
    summary:
      "One hundred 200 kHz channels, numbered 201 to 300, with 88.1 to 91.9 MHz reserved for non commercial educational stations.",
    rules: [
      "Licensed under Part 73 subpart B. Full power class C stations reach 100 kW effective radiated power; low power FM stations under Part 73 subpart G are limited to 100 W.",
      "Unlicensed FM transmitters are legal only under Part 15.239, which limits field strength to 250 microvolts per meter at 3 meters, roughly a 200 foot range.",
    ],
    notes:
      "Channel center frequencies are in NAMED_CHANNELS in ./data. Japan uses 76 to 95 MHz and the former OIRT band was 65.8 to 74 MHz.",
    source: SRC_PART73,
  },
  {
    id: "vor-ils-108-118",
    lowHz: MHz(108),
    highHz: MHz(117.975),
    service: "radionavigation",
    status: "primary",
    region: "global",
    label: "VOR and ILS localizer",
    summary:
      "The aeronautical radionavigation band: instrument landing system localizers on the odd tenths from 108.10 to 111.95 MHz, VOR beacons on everything else up to 117.95 MHz.",
    rules: [
      "Ground stations are licensed to airports and the FAA. Aircraft only receive here.",
      "Channels are 50 kHz apart. A localizer identifies with a Morse code beginning with the letter I.",
    ],
    notes:
      "The ILS glide slope for a given localizer is paired automatically and lives at 328.6 to 335.4 MHz.",
    source: SRC_ICAO,
  },
  {
    id: "airband-118-137",
    lowHz: MHz(117.975),
    highHz: MHz(137),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "VHF airband voice, 118 MHz to 137 MHz",
    summary:
      "Air traffic control, tower, ground, approach, ATIS and air to air, all in amplitude modulation so that overlapping transmissions heterodyne instead of capturing.",
    rules: [
      "Aircraft and ground stations are licensed under Part 87. Listening is legal; transmitting needs a station license and, for ground stations, an operator permit.",
      "Channels are 25 kHz apart in the United States and 8.33 kHz apart in much of Europe.",
      "Amplitude modulation is used deliberately so that two simultaneous transmissions produce an audible squeal rather than one signal silently blocking the other.",
    ],
    notes:
      "121.500 MHz is the international emergency frequency. 136.975 MHz is the top usable channel; ACARS data sits at 131.550 MHz in North America.",
    source: SRC_PART87,
  },
  {
    id: "emergency-1215",
    lowHz: MHz(121.4),
    highHz: MHz(121.6),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "121.5 MHz aeronautical emergency",
    summary:
      "The international air distress frequency, monitored by air traffic control and by every airliner in cruise.",
    rules: [
      "Emergency use only. Emergency locator transmitters still sweep here for local homing even though satellite alerting moved to 406 MHz.",
    ],
    source: SRC_PART87,
  },
  {
    id: "metsat-137-138",
    lowHz: MHz(137),
    highHz: MHz(138),
    service: "meteorological",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Weather satellite downlinks, 137 MHz",
    summary:
      "Polar orbiting weather satellite downlinks, including the NOAA automatic picture transmission signals that hobbyists receive with a simple antenna.",
    rules: [
      "Downlink only. Receiving is unrestricted; nothing civil may transmit here.",
      "NOAA-15 transmits APT on 137.6200 MHz, NOAA-18 on 137.9125 MHz and NOAA-19 on 137.1000 MHz. Meteor M2 series satellites use LRPT near 137.1 and 137.9 MHz.",
    ],
    notes:
      "The band is shared with low earth orbit satellite downlinks such as Orbcomm, whose uplinks sit at 148 to 150.05 MHz.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "federal-138-144",
    lowHz: MHz(138),
    highHz: MHz(144),
    service: "military",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "138 MHz to 144 MHz federal land mobile",
    summary:
      "A federal exclusive VHF block used by the military and other agencies for tactical land mobile and air to ground.",
    rules: [
      "Federal government only, coordinated through NTIA. Not available to Part 90 or amateur users.",
    ],
    source: SRC_NTIA,
  },
  {
    id: "amateur-2m",
    lowHz: MHz(144),
    highHz: MHz(148),
    service: "amateur",
    status: "primary",
    region: "ITU2",
    users: ["non-federal"],
    label: "2 m amateur band",
    summary:
      "The busiest amateur band in the United States: FM repeaters, packet, weak signal SSB and CW, satellites and emergency communications.",
    rules: [
      "All license classes from Technician up have the entire band, all modes.",
      "144.0 to 144.1 MHz is CW only. Everything else allows phone, image, RTTY and data.",
      "1500 W PEP output, though almost nobody runs more than 50 W on FM.",
      "146.520 MHz is the national FM simplex calling frequency; 144.200 MHz is the SSB calling frequency.",
    ],
    notes:
      "Region 1 amateurs only have 144 to 146 MHz, so repeater outputs above 146 MHz are a North American feature.",
    source: SRC_PART97,
  },
  {
    id: "amateur-satellite-2m",
    lowHz: MHz(145.8),
    highHz: MHz(146),
    service: "amateur-satellite",
    status: "primary",
    region: "global",
    users: ["non-federal"],
    label: "2 m amateur satellite sub band",
    summary:
      "The satellite only slice of the 2 m band, carrying linear transponder downlinks, cubesat beacons and the ISS packet digipeater.",
    rules: [
      "Terrestrial amateur operation is discouraged here by band plan so that satellite links stay clear.",
      "The ISS packet digipeater operates on 145.825 MHz and the crew voice repeater downlink on 145.800 MHz.",
    ],
    source: SRC_PART97,
  },
  {
    id: "satellite-uplink-148-150",
    lowHz: MHz(148),
    highHz: MHz(150.05),
    service: "satellite",
    status: "primary",
    region: "US",
    label: "148 MHz to 150.05 MHz little LEO uplinks",
    summary:
      "Uplinks for low earth orbit data satellites such as Orbcomm, shared with federal land mobile.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "landmobile-vhf-150-156",
    lowHz: MHz(150.05),
    highHz: MHz(156),
    service: "land-mobile",
    status: "primary",
    region: "US",
    users: ["federal", "non-federal"],
    label: "VHF high band land mobile, 150 MHz to 156 MHz",
    summary:
      "Business, public safety, taxi, tow, utility and railroad dispatch on narrowband 12.5 kHz channels, plus the MURS channels.",
    rules: [
      "Licensed under Part 90 with frequency coordination. Since 2013 most channels must use 12.5 kHz or narrower equipment.",
      "155.160 to 155.400 MHz carries a lot of search and rescue and inter agency public safety traffic.",
    ],
    source: SRC_PART90,
  },
  {
    id: "murs-151-154",
    lowHz: MHz(151.82),
    highHz: MHz(154.6),
    service: "frs-gmrs",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "MURS, Multi Use Radio Service",
    summary:
      "Five license free VHF channels for business and personal use, the only unlicensed service where you may use an external gain antenna.",
    rules: [
      "No license. Anyone may operate certified MURS equipment.",
      "2 W transmitter output maximum. Channels 1 to 3 (151.820, 151.880, 151.940 MHz) are limited to 11.25 kHz bandwidth; channels 4 and 5 (154.570, 154.600 MHz) allow 20 kHz.",
      "External and elevated antennas are allowed, up to 60 feet above ground or 20 feet above the structure they are mounted on.",
      "Repeaters, duplex operation and store and forward packet are prohibited.",
    ],
    notes:
      "154.570 and 154.600 MHz are the old business band color dot channels, which is why so much older gear covers them.",
    source: SRC_PART95,
  },
  {
    id: "marine-vhf-156-162",
    lowHz: MHz(156),
    highHz: MHz(162.025),
    service: "maritime",
    status: "primary",
    region: "US",
    users: ["federal", "non-federal"],
    label: "Marine VHF, channels 1 to 88",
    summary:
      "The international VHF maritime mobile band: bridge to bridge, port operations, ship to shore and the Coast Guard.",
    rules: [
      "Recreational vessels in US waters do not need a station license; commercial vessels and any vessel traveling internationally do.",
      "25 W maximum, reduced to 1 W on some channels. Channel 16 (156.800 MHz) is the distress, safety and calling channel and must be monitored.",
      "Channel 70 (156.525 MHz) is digital selective calling only, never voice.",
      "Automatic identification system data is on 161.975 MHz (AIS 1) and 162.025 MHz (AIS 2).",
    ],
    notes:
      "The full channel plan, including the duplex ship and coast frequencies, is in NAMED_CHANNELS in ./data.",
    source: SRC_PART80,
  },
  {
    id: "noaa-weather-radio",
    lowHz: MHz(162.4),
    highHz: MHz(162.55),
    service: "meteorological",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "NOAA Weather Radio, seven channels",
    summary:
      "The National Weather Service broadcast network, seven channels 25 kHz apart carrying continuous forecasts and the Specific Area Message Encoding alert tones.",
    rules: [
      "NOAA transmits; everyone else listens. Receivers decode SAME headers to alert only for their own county.",
      "Channels are 162.400, 162.425, 162.450, 162.475, 162.500, 162.525 and 162.550 MHz.",
    ],
    notes: "The same channels are in NAMED_CHANNELS in ./data as the WX1 to WX7 identifiers.",
    source: "NOAA National Weather Service NWR service description",
  },
  {
    id: "federal-162-174",
    lowHz: MHz(162.0125),
    highHz: MHz(174),
    service: "military",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "162 MHz to 174 MHz federal land mobile",
    summary:
      "A federal exclusive VHF block: park service, forest service, border patrol, federal law enforcement and the weather radio network.",
    rules: ["Federal agencies only, assigned through NTIA."],
    source: SRC_NTIA,
  },
  {
    id: "wireless-mic-169-172",
    lowHz: MHz(169),
    highHz: MHz(172),
    service: "wireless-microphones",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "169 MHz to 172 MHz traveling wireless microphones",
    summary:
      "A set of narrow channels reserved for wireless microphones that need to work anywhere in the country without local coordination.",
    rules: [
      "Part 74 subpart H eligibility for licensed users, plus low power unlicensed operation on specified channels.",
      "Power is limited to 50 mW, which is enough for a stage but not a stadium.",
    ],
    source: SRC_PART74,
  },
  {
    id: "tv-vhf-high-174-216",
    lowHz: MHz(174),
    highHz: MHz(216),
    service: "broadcast-tv",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "TV channels 7 to 13",
    summary:
      "The VHF high television band, seven 6 MHz channels that carry a substantial share of US digital television.",
    notes:
      "Unused channels in this band are also where licensed and unlicensed wireless microphones operate.",
    source: SRC_PART73,
  },
  {
    id: "amts-216-220",
    lowHz: MHz(216),
    highHz: MHz(220),
    service: "maritime",
    status: "primary",
    region: "US",
    label: "216 MHz to 220 MHz automated maritime telecommunications and telemetry",
    summary:
      "Automated maritime telecommunications system channels, wildlife tracking telemetry and low power auditory assistance devices.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "amateur-1p25m-219",
    lowHz: MHz(219),
    highHz: MHz(220),
    service: "amateur",
    status: "secondary",
    region: "US",
    users: ["non-federal"],
    label: "219 MHz to 220 MHz amateur, data only",
    summary:
      "A one megahertz secondary amateur segment restricted to point to point digital message forwarding.",
    rules: [
      "Fixed digital message forwarding systems only. No voice, no beacons, no repeaters in the ordinary sense.",
      "50 W PEP maximum, and the station must be notified to the ARRL and kept away from maritime AMTS stations.",
    ],
    source: SRC_PART97,
  },
  {
    id: "landmobile-220-222",
    lowHz: MHz(220),
    highHz: MHz(222),
    service: "land-mobile",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "220 MHz to 222 MHz narrowband land mobile",
    summary:
      "A 5 kHz channel narrowband land mobile band the FCC carved out of the old amateur 220 MHz allocation in 1988.",
    rules: [
      "Part 90 licensed, 5 kHz channel spacing, used for telemetry and specialised dispatch.",
    ],
    notes:
      "Losing 220 to 222 MHz is why the US amateur 1.25 m band starts at 222 MHz today. Most of the world never had an amateur allocation here at all.",
    source: SRC_PART90,
  },
  {
    id: "amateur-1p25m",
    lowHz: MHz(222),
    highHz: MHz(225),
    service: "amateur",
    status: "primary",
    region: "ITU2",
    users: ["non-federal"],
    label: "1.25 m amateur band, 222 MHz",
    summary:
      "A Region 2 only VHF band with a small but loyal repeater community and excellent weak signal performance.",
    rules: [
      "All license classes from Technician up, all modes across 222 to 225 MHz.",
      "1500 W PEP output. 223.500 MHz is the national FM simplex calling frequency.",
    ],
    notes:
      "This band exists only in ITU Region 2. Radios for it are scarce, which keeps it quiet and useful.",
    source: SRC_PART97,
  },
  {
    id: "military-uhf-225-400",
    lowHz: MHz(225),
    highHz: MHz(400),
    service: "military",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "225 MHz to 400 MHz military UHF air band",
    summary:
      "The military aeronautical band: air to air, air to ground, tanker rendezvous, satellite communications and the SINCGARS and Have Quick waveforms.",
    rules: [
      "Federal government only. 25 kHz amplitude modulated voice channels are the norm, with narrowband satellite channels near 240 to 270 MHz and 290 to 320 MHz.",
      "243.0 MHz is the military guard frequency, the UHF counterpart of 121.5 MHz.",
    ],
    notes:
      "The ILS glide slope band at 328.6 to 335.4 MHz sits inside this range and is listed separately.",
    source: SRC_NTIA,
  },
  {
    id: "ra-322mhz",
    lowHz: MHz(322),
    highHz: MHz(328.6),
    service: "radio-astronomy",
    status: "primary",
    region: "global",
    label: "322 MHz to 328.6 MHz radio astronomy",
    summary:
      "A protected passive band used for deuterium line observations and low frequency continuum astronomy.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ils-glideslope-329",
    lowHz: MHz(328.6),
    highHz: MHz(335.4),
    service: "radionavigation",
    status: "primary",
    region: "global",
    label: "ILS glide slope, 329 MHz to 335 MHz",
    summary:
      "The vertical guidance half of an instrument landing system, paired automatically with a localizer frequency in the 108 to 112 MHz band.",
    rules: ["Airport ground stations. Aircraft receive only; the pairing is fixed by ICAO."],
    source: SRC_ICAO,
  },

  /* ---------------------------------------------------------------- */
  /* UHF, 300 MHz to 1 GHz                                             */
  /* Source: FCC table, Part 15, Part 22, Part 27, Part 73, Part 74,   */
  /* Part 90, Part 95, Part 97, 3GPP band tables                       */
  /* ---------------------------------------------------------------- */
  {
    id: "part15-315mhz",
    lowHz: MHz(314.9),
    highHz: MHz(315.1),
    service: "unlicensed-part15",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "315 MHz keyfobs and sensors",
    summary:
      "The North American short range device frequency: car remote keyless entry, tire pressure sensors, garage doors and home alarm sensors.",
    rules: [
      "No license. Part 15.231 allows periodic control transmissions only, with a duty cycle limit, not continuous data.",
    ],
    notes:
      "The rest of the world uses 433.92 MHz for the same job, which is why an imported remote often will not work here.",
    source: SRC_PART15,
  },
  {
    id: "radiosonde-400-406",
    lowHz: MHz(400.15),
    highHz: MHz(406),
    service: "meteorological",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Meteorological aids, 403 MHz radiosondes",
    summary:
      "Weather balloon radiosondes, dropsondes and the meteorological satellite data collection uplinks that go with them.",
    rules: [
      "Operated by weather services and licensed researchers. US National Weather Service radiosondes transmit near 403 MHz twice a day from about 90 sites.",
    ],
    notes:
      "401 to 403 MHz also carries earth to space data collection platform uplinks for GOES and Argos.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "sarsat-406",
    lowHz: MHz(406),
    highHz: MHz(406.1),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "406 MHz COSPAS-SARSAT distress beacons",
    summary:
      "The worldwide satellite distress alerting band: emergency locator transmitters in aircraft, EPIRBs on vessels and personal locator beacons.",
    rules: [
      "Beacons only. Every beacon carries a coded identity registered to an owner, and transmits a 5 W burst every 50 seconds.",
      "Nothing else may transmit in this 100 kHz. Even test transmissions must be done into a shielded enclosure.",
    ],
    notes:
      "Alerts are relayed by low earth orbit, geostationary and, since 2020, GPS and Galileo satellites carrying MEOSAR repeaters.",
    source: "COSPAS-SARSAT system documentation and 47 CFR 2.106",
  },
  {
    id: "ra-406mhz",
    lowHz: MHz(406.1),
    highHz: MHz(410),
    service: "radio-astronomy",
    status: "primary",
    region: "global",
    label: "406.1 MHz to 410 MHz radio astronomy",
    summary: "A protected continuum radio astronomy band directly above the distress beacon slot.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "federal-410-420",
    lowHz: MHz(410),
    highHz: MHz(420),
    service: "military",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "410 MHz to 420 MHz federal land mobile",
    summary: "Federal exclusive UHF land mobile, including military base and range communications.",
    source: SRC_NTIA,
  },
  {
    id: "amateur-70cm",
    lowHz: MHz(420),
    highHz: MHz(450),
    service: "amateur",
    status: "secondary",
    region: "ITU2",
    users: ["non-federal"],
    label: "70 cm amateur band",
    summary:
      "A 30 MHz wide UHF band carrying repeaters, digital voice, amateur television, satellites and microwave beacon links.",
    rules: [
      "All license classes from Technician up, all modes across 420 to 450 MHz.",
      "Amateurs are secondary to the federal radiolocation service. Power and location limits apply near certain military radars, and stations north of Line A near the Canadian border may not use 420 to 430 MHz at all.",
      "1500 W PEP output where permitted.",
      "446.000 MHz is the national FM simplex calling frequency.",
    ],
    notes:
      "Regions 1 and 3 amateurs only have 430 to 440 MHz, so 420 to 430 and 440 to 450 MHz are North American extras.",
    source: SRC_PART97,
  },
  {
    id: "ism-433-region1",
    lowHz: MHz(433.05),
    highHz: MHz(434.79),
    service: "ism",
    status: "unlicensed",
    region: "ITU1",
    label: "433 MHz ISM band, Region 1",
    summary:
      "The European short range device band: key fobs, weather station sensors, garage doors, LPWAN nodes and cheap radio modules.",
    rules: [
      "In Region 1 this is an ISM band with short range device rules. In the United States it is inside the amateur 70 cm band and federal radiolocation spectrum, so unlicensed use is not permitted the same way.",
    ],
    notes:
      "This is the classic import trap: a 433 MHz sensor sold in Europe is not legal to operate unlicensed in the United States.",
    source: SRC_ITU,
  },
  {
    id: "amateur-satellite-70cm",
    lowHz: MHz(435),
    highHz: MHz(438),
    service: "amateur-satellite",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "70 cm amateur satellite sub band",
    summary:
      "The satellite portion of 70 cm: linear transponder uplinks and downlinks, cubesat telemetry and the FM satellites.",
    source: SRC_PART97,
  },
  {
    id: "landmobile-uhf-450-470",
    lowHz: MHz(450),
    highHz: MHz(470),
    service: "land-mobile",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "UHF land mobile, 450 MHz to 470 MHz",
    summary:
      "The main non federal UHF business and public safety band: hospitals, schools, retail, construction, taxi and municipal fleets.",
    rules: [
      "Part 90 licensed with frequency coordination, on 12.5 kHz narrowband channels since the 2013 deadline.",
      "Repeater pairs use a 5 MHz split, with mobiles transmitting 5 MHz above the repeater output.",
    ],
    notes: "The GMRS and FRS channels sit inside this band and are listed separately.",
    source: SRC_PART90,
  },
  {
    id: "frs-gmrs-462-467",
    lowHz: MHz(462.5375),
    highHz: MHz(467.7375),
    service: "frs-gmrs",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "FRS and GMRS, channels 1 to 22",
    summary:
      "The 22 channel bubble pack walkie talkie band, shared between the license free Family Radio Service and the licensed General Mobile Radio Service.",
    rules: [
      "FRS needs no license. Power is 2 W on channels 1 to 7 and 15 to 22, and 0.5 W on channels 8 to 14. The antenna must be permanently attached.",
      "GMRS needs a license that costs 35 dollars, lasts 10 years, needs no exam and covers the licensee's whole immediate family.",
      "GMRS may run 50 W on channels 15 to 22 and 5 W on channels 1 to 7, may use detachable and external antennas, and may use repeaters with inputs 5 MHz up at 467.550 to 467.725 MHz.",
      "Channels 8 to 14, the 467 MHz interstitial channels, are 0.5 W handheld only for both services and may not be used with repeaters.",
    ],
    notes:
      "A radio sold as FRS and a radio sold as GMRS can talk to each other; the difference is power, antenna and license, not frequency.",
    source: SRC_PART95,
  },
  {
    id: "tv-uhf-470-608",
    lowHz: MHz(470),
    highHz: MHz(608),
    service: "broadcast-tv",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "UHF TV channels 14 to 36",
    summary:
      "The UHF television band after the 2017 to 2020 incentive auction repack, which is where most US digital television now lives.",
    rules: [
      "Part 73 licensed full power and low power stations, on 6 MHz channels.",
      "Vacant channels here are the white space band, usable by unlicensed white space devices and by wireless microphones through the FCC databases.",
    ],
    notes:
      "Before the repack UHF television ran to channel 51 at 698 MHz. Channels 38 to 51 were auctioned and became the 600 MHz mobile band.",
    source: SRC_PART73,
  },
  {
    id: "ra-608-614",
    lowHz: MHz(608),
    highHz: MHz(614),
    service: "radio-astronomy",
    status: "restricted",
    region: "US",
    label: "Channel 37, radio astronomy and medical telemetry",
    summary:
      "Television channel 37 was never assigned to broadcasters: it is reserved for radio astronomy and for wireless medical telemetry in hospitals.",
    rules: [
      "No broadcasting. Radio astronomy is primary; the Wireless Medical Telemetry Service shares the band under Part 95 subpart H with registration through a coordinator.",
    ],
    source: SRC_FCC_TABLE,
  },
  {
    id: "cellular-600-n71",
    lowHz: MHz(617),
    highHz: MHz(698),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "600 MHz band, LTE band 71 and 5G n71",
    summary:
      "The band cleared from television channels 38 to 51 in the incentive auction, mostly held by T-Mobile and prized for building penetration and rural reach.",
    rules: [
      "Part 27 licensed. Downlink 617 to 652 MHz, uplink 663 to 698 MHz, frequency division duplex.",
      "653 to 663 MHz is the duplex gap, part of which is reserved for wireless microphones.",
    ],
    notes:
      "The low frequency is the point: a single 600 MHz site covers several times the area of a mid band site.",
    source: SRC_3GPP,
  },
  {
    id: "wireless-mic-653-663",
    lowHz: MHz(653),
    highHz: MHz(663),
    service: "wireless-microphones",
    status: "secondary",
    region: "US",
    users: ["non-federal"],
    label: "600 MHz duplex gap wireless microphones",
    summary:
      "Part of the 600 MHz duplex gap kept available for licensed and unlicensed wireless microphones after they were evicted from 600 MHz television channels.",
    rules: [
      "Licensed Part 74 users may operate in 653 to 657 MHz; unlicensed microphones are confined to 657 to 663 MHz.",
    ],
    source: SRC_PART74,
  },
  {
    id: "cellular-700-lower",
    lowHz: MHz(698),
    highHz: MHz(758),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "Lower 700 MHz band, LTE bands 12, 17, 29 and 85",
    summary:
      "The lower half of the old television channels 52 to 59, the spectrum that carried the first wide LTE deployments in the United States.",
    rules: [
      "Part 27 licensed. Band 12 uses 699 to 716 MHz uplink and 729 to 746 MHz downlink; band 17 is the AT and T subset at 704 to 716 and 734 to 746 MHz.",
      "Band 29 at 717 to 728 MHz is a supplemental downlink with no uplink at all.",
    ],
    source: SRC_3GPP,
  },
  {
    id: "publicsafety-700-narrowband",
    lowHz: MHz(769),
    highHz: MHz(775),
    service: "public-safety",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "700 MHz public safety narrowband",
    summary:
      "Narrowband voice and data channels for police, fire and emergency medical services, paired with 799 to 805 MHz.",
    rules: ["Part 90 subpart R, 12.5 kHz channels, coordinated by regional planning committees."],
    source: SRC_PART90,
  },
  {
    id: "firstnet-band14",
    lowHz: MHz(758),
    highHz: MHz(798),
    service: "public-safety",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "FirstNet, LTE band 14",
    summary:
      "The nationwide public safety broadband network: 20 MHz of dedicated 700 MHz spectrum operated under a license held by the FirstNet Authority.",
    rules: [
      "Uplink 788 to 798 MHz, downlink 758 to 768 MHz. Priority and pre emption are granted to verified first responders.",
    ],
    notes:
      "Commercial traffic may use the band but is pre empted the moment public safety users need capacity.",
    source: SRC_3GPP,
  },
  {
    id: "smr-800",
    lowHz: MHz(806),
    highHz: MHz(824),
    service: "public-safety",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "800 MHz SMR and public safety, mobile transmit",
    summary:
      "The 800 MHz trunked land mobile band: municipal public safety systems, utilities and the old Nextel iDEN spectrum, paired with 851 to 869 MHz.",
    rules: [
      "Part 90 licensed. The upper 806 to 809 and 851 to 854 MHz portion is the NPSPAC block reserved for public safety mutual aid.",
    ],
    notes:
      "The 2004 rebanding order moved public safety and commercial users apart to stop Nextel interfering with police radios.",
    source: SRC_PART90,
  },
  {
    id: "cellular-850-band5",
    lowHz: MHz(824),
    highHz: MHz(894),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "Cellular 850 MHz, LTE band 5 and 5G n5",
    summary:
      "The original 1983 cellular band, still the coverage layer for AT and T and Verizon in rural areas.",
    rules: [
      "Uplink 824 to 849 MHz, downlink 869 to 894 MHz, frequency division duplex. Band 26 extends the uplink down to 814 MHz.",
      "Licensed under Part 22 subpart H by cellular geographic service area.",
    ],
    notes:
      "The 869 to 894 MHz downlink is why an old analogue scanner with an 800 MHz gap has that gap: eavesdropping on cellular calls was banned in 1993.",
    source: SRC_3GPP,
  },
  {
    id: "smr-900",
    lowHz: MHz(896),
    highHz: MHz(901),
    service: "land-mobile",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "900 MHz business and SMR, mobile transmit",
    summary:
      "The 900 MHz land mobile band, paired with 935 to 940 MHz, partially realigned in 2020 to create a 3 by 3 MHz broadband block.",
    source: SRC_PART90,
  },
  {
    id: "ism-915",
    lowHz: MHz(902),
    highHz: MHz(928),
    service: "ism",
    status: "unlicensed",
    region: "ITU2",
    users: ["non-federal"],
    label: "915 MHz ISM band",
    summary:
      "The Region 2 workhorse unlicensed band: LoRa and LoRaWAN, Z-Wave, smart meters, cordless phones, RFID readers, garage doors and telemetry.",
    rules: [
      "No license under Part 15.247 and 15.249. Frequency hopping or digitally modulated systems may run up to 1 W transmitter output, and up to 4 W effective isotropic radiated power with a directional antenna in fixed point to point links.",
      "Devices must accept interference from ISM equipment and from licensed users, and must not cause interference to them.",
      "Z-Wave uses 908.42 MHz in North America; LoRaWAN US915 uses 902 to 928 MHz split into 72 uplink and 8 downlink channels.",
    ],
    notes:
      "This band does not exist in Region 1, where the equivalent devices use 868 MHz. A 915 MHz LoRa node is not legal in Europe and an 868 MHz node is not legal here.",
    source: SRC_PART15,
  },
  {
    id: "amateur-33cm",
    lowHz: MHz(902),
    highHz: MHz(928),
    service: "amateur",
    status: "secondary",
    region: "ITU2",
    users: ["non-federal"],
    label: "33 cm amateur band",
    summary:
      "A Region 2 only amateur band that shares its whole width with unlicensed Part 15 devices and federal radiolocation.",
    rules: [
      "All license classes from Technician up. Amateurs are secondary and share with an enormous population of unlicensed devices.",
      "Not available in the state of Texas within 100 miles of the Mexican border, and subject to radar coordination elsewhere.",
    ],
    notes:
      "Because Part 15 devices need not protect amateurs and amateurs need not protect Part 15 devices, this band is a genuinely shared free for all.",
    source: SRC_PART97,
  },
  {
    id: "rfid-uhf-902-928",
    lowHz: MHz(902),
    highHz: MHz(928),
    service: "rfid-nfc",
    status: "unlicensed",
    region: "ITU2",
    users: ["non-federal"],
    label: "UHF RFID, EPC Gen2",
    summary:
      "The North American passive UHF RFID band: retail inventory tags, toll transponders, warehouse portals and race timing.",
    rules: [
      "No license. Readers hop across 50 channels of 500 kHz under Part 15.247 and can run 1 W with a 6 dBi antenna, giving read ranges of several meters.",
    ],
    notes: "Europe uses 865 to 868 MHz for the same standard at lower power.",
    source: SRC_PART15,
  },
  {
    id: "paging-929-932",
    lowHz: MHz(929),
    highHz: MHz(932),
    service: "paging",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "929 MHz to 932 MHz paging",
    summary:
      "The narrowband paging band, still carrying hospital and emergency services pagers because simulcast paging penetrates buildings better than cellular.",
    rules: [
      "Part 22 subpart E and Part 90. Transmitters run kilowatts of effective radiated power in synchronised simulcast networks.",
    ],
    source: "47 CFR Part 22 subpart E, paging and radiotelephone service",
  },
  {
    id: "wireless-mic-941-960",
    lowHz: MHz(941.5),
    highHz: MHz(960),
    service: "wireless-microphones",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "900 MHz broadcast auxiliary and wireless microphones",
    summary:
      "Studio to transmitter links, remote pickup units and licensed wireless microphones in the band above the ISM allocation.",
    rules: [
      "Part 74 licensed. 944 to 952 MHz is the aural studio to transmitter link band; 941.5 to 944 MHz and 952 to 960 MHz carry fixed point to point links.",
    ],
    source: SRC_PART74,
  },

  /* ---------------------------------------------------------------- */
  /* 960 MHz to 2 GHz                                                  */
  /* Source: FCC table, Part 87, ICAO Annex 10, GNSS interface specs,  */
  /* 3GPP band tables, NTIA manual                                     */
  /* ---------------------------------------------------------------- */
  {
    id: "dme-tacan-960-1164",
    lowHz: MHz(960),
    highHz: MHz(1164),
    service: "aeronautical",
    status: "primary",
    region: "global",
    users: ["federal", "non-federal"],
    label: "DME, TACAN and aeronautical radionavigation",
    summary:
      "Distance measuring equipment and its military TACAN cousin, plus the secondary surveillance radar and ADS-B channels, on 1 MHz spacing.",
    rules: [
      "Aircraft interrogate on 1025 to 1150 MHz and ground beacons reply on 962 to 1213 MHz, offset by 63 MHz. The aircraft times the round trip to get slant range.",
    ],
    notes:
      "This band is protected fiercely because everything in it is safety of life. The three specific channels below sit inside it.",
    source: SRC_ICAO,
  },
  {
    id: "uat-978",
    lowHz: MHz(977.5),
    highHz: MHz(978.5),
    service: "aeronautical",
    status: "primary",
    region: "US",
    label: "978 MHz UAT, ADS-B for general aviation",
    summary:
      "Universal Access Transceiver: the United States only ADS-B link for aircraft below 18,000 feet, which also carries free weather and traffic uplinks.",
    rules: [
      "Aircraft operating below 18,000 feet may use UAT instead of 1090 MHz extended squitter. Ground stations uplink FIS-B weather and TIS-B traffic on the same channel.",
    ],
    notes:
      "UAT exists only in the United States. Everywhere else ADS-B means 1090 MHz extended squitter.",
    source: SRC_PART87,
  },
  {
    id: "ssr-1030",
    lowHz: MHz(1029),
    highHz: MHz(1031),
    service: "radar",
    status: "primary",
    region: "global",
    label: "1030 MHz secondary radar interrogation",
    summary:
      "The uplink of the air traffic control transponder system: ground radars and airborne collision avoidance systems interrogate aircraft here.",
    source: SRC_ICAO,
  },
  {
    id: "ssr-1090",
    lowHz: MHz(1089),
    highHz: MHz(1091),
    service: "radar",
    status: "primary",
    region: "global",
    label: "1090 MHz transponder reply and ADS-B",
    summary:
      "The channel every aircraft transponder answers on, and the worldwide ADS-B link that flight tracking websites decode.",
    rules: [
      "Aircraft transponders reply to interrogations and, with Mode S extended squitter, broadcast position, altitude, velocity and identity about twice a second.",
      "Receiving is unrestricted, which is why a 20 dollar dongle can plot every airliner overhead.",
    ],
    source: SRC_ICAO,
  },
  {
    id: "gnss-1164-1215",
    lowHz: MHz(1164),
    highHz: MHz(1215),
    service: "gps-gnss",
    status: "primary",
    region: "global",
    label: "GNSS lower L band, L5 and E5",
    summary:
      "The aeronautical radionavigation satellite band carrying GPS L5, Galileo E5a and E5b, and BeiDou B2, the safety of life signals.",
    rules: [
      "Receive only for users. GPS L5 is centered on 1176.45 MHz with a 24 MHz wide signal, Galileo E5a shares that center and E5b sits at 1207.14 MHz.",
    ],
    notes:
      "L5 sits inside a protected aeronautical band, which is exactly why it was chosen for aviation grade positioning.",
    source: SRC_GNSS,
  },
  {
    id: "gps-l5",
    lowHz: MHz(1164.45),
    highHz: MHz(1188.45),
    service: "gps-gnss",
    status: "primary",
    region: "global",
    label: "GPS L5, 1176.45 MHz",
    summary:
      "The third civil GPS signal, higher power and wider than L1, designed for aviation and for dual frequency ionospheric correction.",
    source: SRC_GNSS,
  },
  {
    id: "radiolocation-1215-1300",
    lowHz: MHz(1215),
    highHz: MHz(1300),
    service: "radiolocation",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "1215 MHz to 1300 MHz radiolocation",
    summary:
      "Long range air surveillance and space surveillance radars, including the ARSR-4 joint use radars and the PAVE PAWS early warning system.",
    rules: [
      "Federal radiolocation is primary. Amateur and GNSS users share the band on other terms.",
    ],
    source: SRC_NTIA,
  },
  {
    id: "gps-l2",
    lowHz: MHz(1215.6),
    highHz: MHz(1239.6),
    service: "gps-gnss",
    status: "primary",
    region: "global",
    label: "GPS L2, 1227.60 MHz",
    summary:
      "The second GPS frequency, carrying the encrypted P(Y) code and the civil L2C signal used for dual frequency correction in surveying.",
    notes: "GLONASS L2 sits nearby at 1242 to 1249 MHz and BeiDou B3I at 1268.52 MHz.",
    source: SRC_GNSS,
  },
  {
    id: "amateur-23cm",
    lowHz: MHz(1240),
    highHz: MHz(1300),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "23 cm amateur band",
    summary:
      "A 60 MHz wide microwave band used for repeaters, amateur television, satellite work and earth moon earth contacts.",
    rules: [
      "All license classes from Technician up. Novice licensees are limited to 1270 to 1295 MHz at 5 W.",
      "Secondary to federal radiolocation, and subject to coordination near radars.",
      "1270 to 1276 MHz carries satellite uplinks; 1260 to 1270 MHz is the amateur satellite sub band.",
    ],
    notes:
      "Interference into Galileo E6 receivers has put this band under study internationally, so its long term shape is not settled.",
    source: SRC_PART97,
  },
  {
    id: "asr-1300-1350",
    lowHz: MHz(1300),
    highHz: MHz(1350),
    service: "radar",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "1300 MHz to 1350 MHz aeronautical radionavigation radar",
    summary: "Long range air route surveillance radars operated by the FAA and the military.",
    source: SRC_NTIA,
  },
  {
    id: "federal-1350-1390",
    lowHz: MHz(1350),
    highHz: MHz(1390),
    service: "military",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "1350 MHz to 1390 MHz federal radiolocation and fixed",
    summary: "Military radiolocation, test range telemetry and fixed links.",
    source: SRC_NTIA,
  },
  {
    id: "ra-1400-1427",
    lowHz: MHz(1400),
    highHz: MHz(1427),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "1400 MHz to 1427 MHz, the hydrogen line, passive only",
    summary:
      "The most protected band in radio astronomy: the 21 cm neutral hydrogen line at 1420.405751 MHz, plus passive microwave soil moisture sensing.",
    rules: [
      "All emissions are prohibited. No transmitter of any kind may operate here, and out of band emissions from neighboring services are tightly capped.",
      "Radio astronomy and the earth exploration satellite service share the band, both passive.",
    ],
    notes:
      "The hydrogen line is how galaxies are weighed and how the Milky Way was first mapped, and it is the frequency the Pioneer plaque and the Arecibo message were built around.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "wmts-1427-1432",
    lowHz: MHz(1427),
    highHz: MHz(1432),
    service: "telemetry",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "Wireless medical telemetry, 1427 MHz",
    summary:
      "Hospital patient monitoring telemetry, one of three bands set aside so that heart monitors do not have to share with Wi-Fi.",
    rules: [
      "Part 95 subpart H. Health care facilities register their systems with a frequency coordinator; devices may not be used outside a hospital.",
    ],
    source: SRC_PART95,
  },
  {
    id: "aeronautical-telemetry-1435-1525",
    lowHz: MHz(1435),
    highHz: MHz(1525),
    service: "telemetry",
    status: "primary",
    region: "US",
    users: ["federal", "non-federal"],
    label: "Aeronautical mobile telemetry, 1435 MHz to 1525 MHz",
    summary:
      "Flight test telemetry from aircraft and missiles at test ranges, shared with licensed wireless microphones under coordination.",
    rules: [
      "Primary use is flight testing. Part 74 wireless microphone users may operate on a secondary basis with coordination, which is common at large events.",
    ],
    source: SRC_FCC_TABLE,
  },
  {
    id: "mss-downlink-1525-1559",
    lowHz: MHz(1525),
    highHz: MHz(1559),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "L band mobile satellite downlink",
    summary:
      "Inmarsat, Ligado and other geostationary mobile satellite downlinks, plus the satellite based augmentation signals for aviation.",
    notes:
      "WAAS augmentation for GPS is broadcast from geostationary satellites at the GPS L1 and L5 frequencies rather than in this block.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "gnss-1559-1610",
    lowHz: MHz(1559),
    highHz: MHz(1610),
    service: "gps-gnss",
    status: "primary",
    region: "global",
    label: "GNSS upper L band, L1 and E1",
    summary:
      "The band every consumer satellite navigation receiver listens to: GPS L1, Galileo E1, BeiDou B1 and the GLONASS L1 frequency division channels.",
    rules: [
      "Receive only. GPS L1 C/A is centered on 1575.42 MHz, Galileo E1 shares that center, BeiDou B1I sits at 1561.098 MHz and GLONASS L1OF occupies 1598.0625 to 1605.375 MHz on 562.5 kHz channel steps.",
      "Received power at the ground is around 130 dBm, below the thermal noise floor, which is why nearby transmitters cause so much trouble.",
    ],
    source: SRC_GNSS,
  },
  {
    id: "gps-l1",
    lowHz: MHz(1563.42),
    highHz: MHz(1587.42),
    service: "gps-gnss",
    status: "primary",
    region: "global",
    label: "GPS L1, 1575.42 MHz",
    summary:
      "The original civil GPS signal, and the one in every phone, car and watch. Galileo E1 and BeiDou B1C share the same center frequency.",
    notes:
      "1575.42 MHz is 154 times the 10.23 MHz GPS master clock, and L2 at 1227.60 MHz is 120 times the same clock.",
    source: SRC_GNSS,
  },
  {
    id: "mss-uplink-1610-1626",
    lowHz: MHz(1610),
    highHz: MHz(1626.5),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "Big LEO mobile satellite uplink, Iridium and Globalstar",
    summary:
      "Handset to satellite uplinks for the low earth orbit voice constellations, with Iridium using 1616 to 1626.5 MHz in time division duplex.",
    notes:
      "Iridium is the reason satellite messengers work at the poles, and the reason the 1610.6 to 1613.8 MHz radio astronomy band needs a coordination agreement.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ra-1610-oh",
    lowHz: MHz(1610.6),
    highHz: MHz(1613.8),
    service: "radio-astronomy",
    status: "primary",
    region: "global",
    label: "1612 MHz hydroxyl line radio astronomy",
    summary:
      "A protected band for the 1612 MHz OH maser line, which traces the envelopes of evolved stars.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "mss-uplink-1626-1660",
    lowHz: MHz(1626.5),
    highHz: MHz(1660.5),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "L band mobile satellite uplink, Inmarsat",
    summary:
      "The uplink half of the geostationary L band mobile satellite service: ship earth stations, aviation safety services and satellite phones.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ra-1660-1670",
    lowHz: MHz(1660),
    highHz: MHz(1670),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "1665 MHz hydroxyl line radio astronomy",
    summary:
      "A passive band protecting the main OH lines at 1665 and 1667 MHz, with 1660.5 to 1668.4 MHz closed to all emissions.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "metsat-1670-1710",
    lowHz: MHz(1670),
    highHz: MHz(1710),
    service: "meteorological",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "Meteorological satellite downlinks, 1.7 GHz",
    summary:
      "Weather satellite data downlinks: GOES HRIT and GRB, polar orbiter HRPT, and the ground receiving stations that feed forecast models.",
    rules: [
      "GOES HRIT is at 1694.1 MHz and GOES Rebroadcast at 1686.6 MHz. NOAA and Metop HRPT downlinks occupy 1698 to 1710 MHz.",
    ],
    notes:
      "1695 to 1710 MHz was reallocated for AWS-3 uplinks with coordination zones around federal earth stations, which is why the two entries overlap.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "cellular-aws3-uplink-1695",
    lowHz: MHz(1695),
    highHz: MHz(1710),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "AWS-3 uplink, LTE band 70",
    summary:
      "Fifteen megahertz of uplink only spectrum auctioned in 2015, paired with downlink at 1995 to 2020 MHz.",
    rules: [
      "Part 27 licensed, shared with federal meteorological earth stations under coordination zones.",
    ],
    source: SRC_3GPP,
  },
  {
    id: "cellular-aws-uplink-1710-1780",
    lowHz: MHz(1710),
    highHz: MHz(1780),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "AWS-1 and AWS-3 uplink, LTE bands 4 and 66",
    summary:
      "The Advanced Wireless Services uplink block, paired with downlink at 2110 to 2200 MHz, and the main mid band LTE carrier in most US cities.",
    rules: [
      "Band 4 uses 1710 to 1755 MHz uplink and 2110 to 2155 MHz downlink. Band 66 extends that to 1710 to 1780 MHz and 2110 to 2200 MHz.",
      "1755 to 1780 MHz was shared with federal systems and cleared for commercial use through the AWS-3 auction.",
    ],
    notes:
      "Region 1 uses 1710 to 1785 MHz paired with 1805 to 1880 MHz for GSM 1800 and LTE band 3, so the uplinks nearly line up but the downlinks do not.",
    source: SRC_3GPP,
  },
  {
    id: "cellular-band3-region1",
    lowHz: MHz(1710),
    highHz: MHz(1880),
    service: "cellular",
    status: "primary",
    region: "ITU1",
    label: "GSM 1800 and LTE band 3, Regions 1 and 3",
    summary:
      "The dominant mid band cellular pairing outside the Americas: 1710 to 1785 MHz uplink and 1805 to 1880 MHz downlink.",
    notes:
      "The United States put the equivalent capacity at 1900 MHz PCS instead, which is why a European phone without band 2 or 25 gets poor US coverage and vice versa.",
    source: SRC_3GPP,
  },
  {
    id: "federal-1780-1850",
    lowHz: MHz(1780),
    highHz: MHz(1850),
    service: "military",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "1780 MHz to 1850 MHz federal fixed and mobile",
    summary:
      "Federal fixed microwave, tactical radio relay and space operations telemetry, a long standing candidate for future sharing studies.",
    source: SRC_NTIA,
  },
  {
    id: "cellular-pcs-1900",
    lowHz: MHz(1850),
    highHz: MHz(1995),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "PCS 1900 MHz, LTE bands 2 and 25",
    summary:
      "The Personal Communications Service band auctioned in 1995, still the capacity backbone of every US carrier.",
    rules: [
      "Band 2 uses 1850 to 1910 MHz uplink and 1930 to 1990 MHz downlink. Band 25 adds the G block to give 1850 to 1915 MHz and 1930 to 1995 MHz.",
      "1915 to 1920 MHz paired with 1995 to 2000 MHz is the H block, auctioned separately in 2014.",
    ],
    notes:
      "1900 MHz PCS is a North American arrangement. Most of the world uses 1710 to 1880 MHz for the same role, which is the classic international roaming mismatch.",
    source: SRC_3GPP,
  },
  {
    id: "upcs-dect-1920-1930",
    lowHz: MHz(1920),
    highHz: MHz(1930),
    service: "unlicensed-part15",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "UPCS band, DECT 6.0 cordless phones",
    summary:
      "The unlicensed personal communications band that DECT 6.0 cordless phones use, sitting in the PCS duplex gap.",
    rules: [
      "No license, Part 15 subpart D. Devices must listen before transmitting and register their channel use.",
      "Five carriers on 1.728 MHz spacing, average power 4 mW and peak 100 mW.",
    ],
    notes:
      "European DECT uses 1880 to 1900 MHz with ten carriers and higher power, so the hardware is not interchangeable. The name DECT 6.0 is marketing; there is no DECT version 6.",
    source: SRC_PART15,
  },

  /* ---------------------------------------------------------------- */
  /* 2 GHz to 4 GHz                                                    */
  /* Source: FCC table, Part 15, Part 27, Part 74, Part 96, Part 97,   */
  /* 3GPP band tables, NTIA manual                                     */
  /* ---------------------------------------------------------------- */
  {
    id: "cellular-aws4-1995-2020",
    lowHz: MHz(1995),
    highHz: MHz(2020),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "AWS-4 and AWS-3 downlink, LTE band 70",
    summary:
      "The downlink half of the supplementary AWS blocks, licensed largely to Dish and used in its 5G build.",
    source: SRC_3GPP,
  },
  {
    id: "bas-2025-2110",
    lowHz: MHz(2025),
    highHz: MHz(2110),
    service: "wireless-microphones",
    status: "primary",
    region: "US",
    users: ["federal", "non-federal"],
    label: "2 GHz broadcast auxiliary and space operations",
    summary:
      "Electronic news gathering trucks, wireless camera links and federal space operations telemetry, tracking and command.",
    rules: [
      "Part 74 broadcast auxiliary licensees coordinate channels locally. NASA and other agencies use the same range for near earth spacecraft command.",
    ],
    source: SRC_PART74,
  },
  {
    id: "cellular-aws-downlink-2110-2200",
    lowHz: MHz(2110),
    highHz: MHz(2200),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "AWS downlink, LTE bands 4 and 66",
    summary:
      "The downlink block paired with 1710 to 1780 MHz, carrying the bulk of mid band LTE capacity in US cities.",
    source: SRC_3GPP,
  },
  {
    id: "dsn-uplink-2110",
    lowHz: MHz(2110),
    highHz: MHz(2120),
    service: "space-research",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Deep space network S band uplink",
    summary:
      "The earth to space half of NASA deep space communications, transmitted from Goldstone, Madrid and Canberra.",
    source: SRC_NTIA,
  },
  {
    id: "space-research-2200-2290",
    lowHz: MHz(2200),
    highHz: MHz(2290),
    service: "space-research",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "S band space research and space operations downlink",
    summary:
      "Telemetry downlinks from satellites, launch vehicles and the International Space Station, plus test range telemetry.",
    source: SRC_NTIA,
  },
  {
    id: "dsn-downlink-2290",
    lowHz: MHz(2290),
    highHz: MHz(2300),
    service: "space-research",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Deep space network S band downlink",
    summary:
      "The space to earth half of deep space communications, the band that carried Voyager telemetry for decades.",
    source: SRC_NTIA,
  },
  {
    id: "amateur-13cm-2300",
    lowHz: MHz(2300),
    highHz: MHz(2310),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "13 cm amateur band, lower segment",
    summary:
      "A 10 MHz secondary amateur segment used for weak signal microwave work and earth moon earth contacts.",
    rules: ["All license classes from Technician up, secondary to federal and satellite services."],
    source: SRC_PART97,
  },
  {
    id: "wcs-2305-2320",
    lowHz: MHz(2305),
    highHz: MHz(2320),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "Wireless Communications Service, LTE band 30",
    summary:
      "A 2.3 GHz block auctioned in 1997, held largely by AT and T and constrained by out of band limits that protect satellite radio.",
    rules: ["Uplink 2305 to 2315 MHz, downlink 2350 to 2360 MHz."],
    source: SRC_3GPP,
  },
  {
    id: "sdars-2320-2345",
    lowHz: MHz(2320),
    highHz: MHz(2345),
    service: "sdars",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "Satellite digital audio radio, SiriusXM",
    summary:
      "The satellite radio band: geostationary and highly elliptical satellites plus a network of terrestrial repeaters that fill in urban canyons.",
    rules: [
      "Licensed to SiriusXM. The terrestrial repeaters are what let the service work under bridges and in tunnels.",
    ],
    source: SRC_FCC_TABLE,
  },
  {
    id: "amateur-13cm-2390",
    lowHz: MHz(2390),
    highHz: MHz(2450),
    service: "amateur",
    status: "secondary",
    region: "ITU2",
    users: ["non-federal"],
    label: "13 cm amateur band, upper segment",
    summary:
      "The part of 13 cm that overlaps the 2.4 GHz ISM band, used for amateur television, high speed mesh networking and satellite uplinks.",
    rules: [
      "All license classes from Technician up. 2390 to 2450 MHz in Region 2, secondary throughout.",
      "Amateur high speed mesh networks run modified Wi-Fi hardware here at amateur power levels on channels that overlap Wi-Fi channel 1 and below.",
    ],
    notes:
      "Sharing this band with every microwave oven and Wi-Fi router in the country makes it noisy but legal.",
    source: SRC_PART97,
  },
  {
    id: "ism-2450",
    lowHz: MHz(2400),
    highHz: MHz(2500),
    service: "ism",
    status: "unlicensed",
    region: "global",
    label: "2.45 GHz ISM band",
    summary:
      "The most crowded piece of spectrum on earth: microwave ovens, Wi-Fi, Bluetooth, Zigbee, Thread, cordless phones and industrial heaters.",
    rules: [
      "Part 18 covers the ovens and heaters, which may leak far more energy than any communication device is allowed to radiate.",
      "The designated ISM center is 2450 MHz with a tolerance of 50 MHz, which is where a domestic microwave oven magnetron sits.",
    ],
    notes:
      "Communication devices here are guests. The band was chosen for unlicensed radio precisely because it was already polluted.",
    source: SRC_PART18,
  },
  {
    id: "wifi-24ghz",
    lowHz: MHz(2400),
    highHz: MHz(2483.5),
    service: "wifi-unlicensed",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "2.4 GHz Wi-Fi, channels 1 to 11",
    summary:
      "The original Wi-Fi band: eleven overlapping 20 MHz channels in the United States, of which only 1, 6 and 11 do not overlap.",
    rules: [
      "No license, Part 15.247. Up to 1 W transmitter output and 4 W effective isotropic radiated power for point to multipoint systems.",
      "The United States allows channels 1 to 11. Most of the world allows 1 to 13 and Japan adds channel 14 for one legacy mode.",
    ],
    notes:
      "The exact channel center frequencies and edges are in WIFI_CHANNELS in ./data and are not duplicated here.",
    source: SRC_PART15,
  },
  {
    id: "bluetooth-24ghz",
    lowHz: MHz(2400),
    highHz: MHz(2483.5),
    service: "unlicensed-part15",
    status: "unlicensed",
    region: "global",
    users: ["non-federal"],
    label: "Bluetooth and Bluetooth Low Energy",
    summary:
      "Frequency hopping short range links: 79 one megahertz channels for classic Bluetooth and 40 two megahertz channels for Bluetooth Low Energy.",
    rules: [
      "No license, Part 15.247 frequency hopping rules. Class 2 devices radiate 2.5 mW and class 1 devices up to 100 mW.",
      "Adaptive frequency hopping lets Bluetooth avoid the channels a nearby Wi-Fi network is using.",
    ],
    notes:
      "Channel numbering differs between classic Bluetooth and Bluetooth Low Energy. See CHANNEL_TABLES for both grids.",
    source: SRC_PART15,
  },
  {
    id: "zigbee-24ghz",
    lowHz: MHz(2400),
    highHz: MHz(2483.5),
    service: "unlicensed-part15",
    status: "unlicensed",
    region: "global",
    users: ["non-federal"],
    label: "Zigbee, Thread and 802.15.4",
    summary:
      "Low rate mesh networking for smart home devices: sixteen 5 MHz spaced channels numbered 11 to 26.",
    rules: [
      "No license, Part 15.247. Typical output is 1 to 10 mW, with mesh routing rather than power used to cover a house.",
      "Zigbee, Thread and Matter over Thread all run on the same IEEE 802.15.4 radio and the same channel grid.",
    ],
    notes:
      "Channels 15, 20, 25 and 26 fall between the busiest Wi-Fi channels, which is why installers favour them.",
    source: SRC_PART15,
  },
  {
    id: "mss-2483-2500",
    lowHz: MHz(2483.5),
    highHz: MHz(2500),
    service: "satellite",
    status: "primary",
    region: "US",
    label: "2483.5 MHz to 2500 MHz mobile satellite downlink",
    summary:
      "The Globalstar downlink band, also usable for a terrestrial low power service, and shared with Part 15 devices.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "cellular-brs-2500-2690",
    lowHz: MHz(2496),
    highHz: MHz(2690),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "BRS and EBS 2.5 GHz, LTE band 41 and 5G n41",
    summary:
      "A 194 MHz wide time division duplex block, originally instructional television, now T-Mobile's main mid band 5G layer.",
    rules: [
      "Part 27 licensed, time division duplex so uplink and downlink share the same frequencies in alternating slots.",
      "Educational Broadband Service licenses carry legacy educational use obligations that were relaxed in 2019.",
    ],
    notes:
      "This band is the reason T-Mobile's mid band 5G reached national coverage first: it was already licensed nationwide through the Sprint merger.",
    source: SRC_3GPP,
  },
  {
    id: "ra-2690-2700",
    lowHz: MHz(2690),
    highHz: MHz(2700),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "2690 MHz to 2700 MHz radio astronomy, passive",
    summary:
      "A passive band closed to all emissions, used for continuum radio astronomy and passive microwave sensing.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "nexrad-2700-3000",
    lowHz: MHz(2700),
    highHz: MHz(3000),
    service: "radar",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "S band weather and airport surveillance radar",
    summary:
      "The NEXRAD WSR-88D national weather radar network and the FAA airport surveillance radars, both S band.",
    rules: [
      "Federal radiolocation and aeronautical radionavigation. NEXRAD sites transmit around 2.7 to 3.0 GHz at roughly 750 kW peak.",
      "S band is chosen for weather radar because rain attenuates it far less than the C and X bands.",
    ],
    source: SRC_NTIA,
  },
  {
    id: "marine-radar-2900-3100",
    lowHz: MHz(2900),
    highHz: MHz(3100),
    service: "radar",
    status: "primary",
    region: "global",
    label: "S band maritime navigation radar",
    summary:
      "Shipborne S band navigation radar, the long range set that keeps working in heavy rain when the X band set is blinded.",
    rules: [
      "Licensed as part of a ship station. Large vessels carry both an S band and an X band radar.",
    ],
    source: SRC_PART80,
  },
  {
    id: "radiolocation-3100-3450",
    lowHz: MHz(3100),
    highHz: MHz(3450),
    service: "radiolocation",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "3.1 GHz to 3.45 GHz federal radiolocation",
    summary:
      "High power military and civil radars, including shipborne air defense radars, and the subject of ongoing spectrum sharing studies.",
    source: SRC_NTIA,
  },
  {
    id: "amateur-9cm",
    lowHz: MHz(3300),
    highHz: MHz(3450),
    service: "amateur",
    status: "secondary",
    region: "ITU2",
    users: ["non-federal"],
    label: "9 cm amateur band, what is left of it",
    summary:
      "The surviving lower half of the old 3.3 to 3.5 GHz amateur allocation, kept on a secondary basis with no fixed end date.",
    rules: [
      "All license classes from Technician up, secondary to federal radiolocation.",
      "Amateur access to 3.45 to 3.50 GHz ended on 14 April 2022 after that spectrum was auctioned for 5G.",
    ],
    notes:
      "The FCC ordered the whole band to sunset in 2020 and then agreed that 3.3 to 3.45 GHz could continue pending a later proceeding. Treat the long term status as unsettled.",
    source: SRC_ARRL,
  },
  {
    id: "cellular-3450-3550",
    lowHz: MHz(3450),
    highHz: MHz(3550),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "3.45 GHz service",
    summary:
      "One hundred megahertz auctioned in 2022, shared with federal radar operations through coordination zones and a dynamic protection framework.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "cbrs-3550-3700",
    lowHz: MHz(3550),
    highHz: MHz(3700),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["federal", "non-federal"],
    label: "CBRS, LTE band 48 and 5G n48",
    summary:
      "The Citizens Broadband Radio Service: a three tier shared band where a database grants access around incumbent naval radars.",
    rules: [
      "Tier one is incumbent federal radar and fixed satellite. Tier two is Priority Access Licenses bought at auction. Tier three is General Authorized Access, which anyone may use for free.",
      "A Spectrum Access System assigns channels dynamically and evicts lower tiers when a navy radar is detected offshore.",
      "General Authorized Access needs no auction and no individual license, which has made CBRS popular for private campus 5G networks.",
    ],
    notes:
      "This is the FCC's flagship dynamic sharing experiment and the model being proposed for other federal bands.",
    source: "47 CFR Part 96, Citizens Broadband Radio Service",
  },
  {
    id: "cellular-cband-3700-3980",
    lowHz: MHz(3700),
    highHz: MHz(3980),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "C band 5G, part of 5G n77",
    summary:
      "The 280 MHz cleared from satellite downlinks in the 2021 auction, the mid band spectrum that Verizon and AT and T built their 5G on.",
    rules: [
      "Time division duplex under 5G band n77, which the standard defines as 3300 to 4200 MHz.",
      "3980 to 4000 MHz is a guard band, and a further 20 MHz separates the band from the radar altimeters above 4200 MHz.",
    ],
    notes:
      "The 2021 and 2022 dispute over radar altimeter interference near airports came from this band, and led to power limits around runways.",
    source: SRC_3GPP,
  },
  {
    id: "fss-cband-downlink",
    lowHz: MHz(3700),
    highHz: MHz(4200),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "C band fixed satellite downlink",
    summary:
      "The traditional satellite television and data downlink band, paired with 5925 to 6425 MHz uplinks and the reason for backyard dishes.",
    notes:
      "In the United States the lower 300 MHz of this band was auctioned for 5G, so domestic satellite operation is now squeezed into 4.0 to 4.2 GHz.",
    source: SRC_FCC_TABLE,
  },

  /* ---------------------------------------------------------------- */
  /* 4 GHz to 8 GHz                                                    */
  /* Source: FCC table, Part 15 subpart E, Part 90, Part 97, NTIA      */
  /* ---------------------------------------------------------------- */
  {
    id: "radar-altimeter-4200-4400",
    lowHz: MHz(4200),
    highHz: MHz(4400),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "Radar altimeters, 4.2 GHz to 4.4 GHz",
    summary:
      "The downward looking radar that tells an aircraft its height above the ground, used on every airliner for autoland and terrain warning.",
    rules: [
      "Aeronautical radionavigation only, worldwide, with no other primary service in the band.",
      "The band is protected because a radar altimeter is a safety of life system with no backup during a low visibility approach.",
    ],
    notes:
      "The 2021 C band 5G dispute was about out of band energy from 3.7 to 3.98 GHz transmitters reaching altimeter receivers here.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "federal-4400-4940",
    lowHz: MHz(4400),
    highHz: MHz(4940),
    service: "military",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "4.4 GHz to 4.94 GHz federal fixed and mobile",
    summary:
      "Military tactical radio relay, unmanned aircraft control links and test range telemetry, a federal exclusive block.",
    source: SRC_NTIA,
  },
  {
    id: "publicsafety-4940-4990",
    lowHz: MHz(4940),
    highHz: MHz(4990),
    service: "public-safety",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "4.9 GHz public safety broadband",
    summary:
      "Fifty megahertz reserved for police, fire and emergency services broadband: incident scene video, robot control and hot spots.",
    rules: ["Part 90 subpart Y licensed to public safety entities, coordinated regionally."],
    source: SRC_PART90,
  },
  {
    id: "ra-4990-5000",
    lowHz: MHz(4990),
    highHz: MHz(5000),
    service: "radio-astronomy",
    status: "primary",
    region: "global",
    label: "4990 MHz to 5000 MHz radio astronomy",
    summary: "A protected continuum radio astronomy band just below the aeronautical allocations.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "mls-5030-5091",
    lowHz: MHz(5030),
    highHz: MHz(5091),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "Microwave landing system and AeroMACS",
    summary:
      "The microwave landing system band, now largely repurposed for AeroMACS airport surface data links and unmanned aircraft control.",
    source: SRC_PART87,
  },
  {
    id: "wifi-unii1-5150-5250",
    lowHz: MHz(5150),
    highHz: MHz(5250),
    service: "wifi-unlicensed",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "U-NII-1, Wi-Fi channels 36 to 48",
    summary:
      "The lowest 5 GHz Wi-Fi block, no radar detection required, and the default choice for most access points.",
    rules: [
      "No license, Part 15 subpart E. Up to 1 W transmitter output and 4 W effective isotropic radiated power for access points, with outdoor operation permitted since 2014.",
      "Client devices are limited to 250 mW effective isotropic radiated power.",
    ],
    source: SRC_PART15,
  },
  {
    id: "wifi-unii2a-5250-5350",
    lowHz: MHz(5250),
    highHz: MHz(5350),
    service: "wifi-unlicensed",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "U-NII-2A, Wi-Fi channels 52 to 64",
    summary:
      "The first dynamic frequency selection block: Wi-Fi may use it only while listening for and vacating on weather and military radar.",
    rules: [
      "Dynamic frequency selection and transmit power control are mandatory. A device that detects a radar must leave the channel within 10 seconds and stay off it for 30 minutes.",
      "This is why some access points take a minute of silent listening before they will bring a DFS channel up.",
    ],
    source: SRC_PART15,
  },
  {
    id: "radiolocation-5350-5470",
    lowHz: MHz(5350),
    highHz: MHz(5470),
    service: "radiolocation",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "5.35 GHz to 5.47 GHz radiolocation and earth exploration",
    summary:
      "Airborne and spaceborne radar, including synthetic aperture radar satellites. Not available to Wi-Fi, which is why the 5 GHz band has a gap here.",
    source: SRC_NTIA,
  },
  {
    id: "wifi-unii2c-5470-5725",
    lowHz: MHz(5470),
    highHz: MHz(5725),
    service: "wifi-unlicensed",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "U-NII-2C, Wi-Fi channels 100 to 144",
    summary:
      "The widest 5 GHz Wi-Fi block, 255 MHz of dynamic frequency selection spectrum shared with terminal doppler weather radar.",
    rules: [
      "Dynamic frequency selection and transmit power control are mandatory throughout.",
      "Channels 120, 124 and 128 sit in the terminal doppler weather radar range and are avoided by many vendors near airports.",
    ],
    source: SRC_PART15,
  },
  {
    id: "tdwr-5600-5650",
    lowHz: MHz(5600),
    highHz: MHz(5650),
    service: "radar",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "Terminal doppler weather radar",
    summary:
      "The C band radars at 45 major US airports that watch for microbursts and wind shear on approach and departure paths.",
    rules: [
      "Federal radiolocation. Unlicensed 5 GHz devices must detect and avoid these radars, and interference cases have led to enforcement action against outdoor Wi-Fi installers.",
    ],
    source: SRC_NTIA,
  },
  {
    id: "amateur-5cm",
    lowHz: MHz(5650),
    highHz: MHz(5925),
    service: "amateur",
    status: "secondary",
    region: "ITU2",
    users: ["non-federal"],
    label: "5 cm amateur band",
    summary:
      "A 275 MHz secondary amateur band overlapping the 5 GHz unlicensed spectrum, used for microwave contesting and satellite work.",
    rules: [
      "All license classes from Technician up, secondary throughout.",
      "5650 to 5670 MHz is an amateur satellite uplink segment and 5830 to 5850 MHz a satellite downlink segment.",
    ],
    source: SRC_PART97,
  },
  {
    id: "wifi-unii3-5725-5850",
    lowHz: MHz(5725),
    highHz: MHz(5850),
    service: "wifi-unlicensed",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "U-NII-3, Wi-Fi channels 149 to 165",
    summary:
      "The top classic 5 GHz block, no radar detection needed and the highest allowed power, which makes it the choice for long outdoor links.",
    rules: [
      "No license. Up to 1 W transmitter output, 4 W effective isotropic radiated power for point to multipoint, and unlimited antenna gain for fixed point to point links.",
      "Also an ISM band under Part 18, centered on 5800 MHz.",
    ],
    source: SRC_PART15,
  },
  {
    id: "unii4-5850-5925",
    lowHz: MHz(5850),
    highHz: MHz(5925),
    service: "wifi-unlicensed",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "U-NII-4 and vehicle to everything, 5.9 GHz",
    summary:
      "Spectrum reassigned in 2020: the lower 45 MHz went to unlicensed Wi-Fi and the upper 30 MHz to cellular vehicle to everything safety messaging.",
    rules: [
      "5850 to 5895 MHz is unlicensed Wi-Fi under Part 15, contiguous with U-NII-3 so a 160 MHz channel can fit.",
      "5895 to 5925 MHz is reserved for C-V2X intelligent transportation safety communications.",
    ],
    notes:
      "The whole 75 MHz used to be dedicated to the DSRC standard, which was never widely deployed in twenty years.",
    source: SRC_PART15,
  },
  {
    id: "fss-cband-uplink-5925-6425",
    lowHz: MHz(5925),
    highHz: MHz(6425),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "C band fixed satellite uplink",
    summary:
      "The earth to space half of the C band satellite service, and historically the main fixed terrestrial microwave relay band.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "wifi-6ghz-5925-7125",
    lowHz: MHz(5925),
    highHz: MHz(7125),
    service: "wifi-unlicensed",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "6 GHz Wi-Fi, U-NII-5 through U-NII-8",
    summary:
      "The 1200 MHz opened for unlicensed use in 2020, the spectrum behind Wi-Fi 6E and Wi-Fi 7, with room for seven non overlapping 160 MHz channels.",
    rules: [
      "No license. Low power indoor devices may run without coordination at 5 dBm per megahertz; standard power outdoor devices must consult an Automated Frequency Coordination database to protect incumbent fixed links.",
      "U-NII-5 is 5925 to 6425 MHz, U-NII-6 is 6425 to 6525 MHz, U-NII-7 is 6525 to 6875 MHz and U-NII-8 is 6875 to 7125 MHz.",
      "Very low power portable devices are allowed across the band at much lower power for wearables and short range links.",
    ],
    notes:
      "The incumbents are thousands of licensed fixed microwave links and broadcast auxiliary relays, which is what the coordination database exists to protect. Channel centers are in WIFI_CHANNELS in ./data.",
    source: SRC_PART15,
  },
  {
    id: "fixed-microwave-6425-7125",
    lowHz: MHz(6425),
    highHz: MHz(7125),
    service: "fixed",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "6 GHz licensed fixed microwave and broadcast auxiliary",
    summary:
      "Licensed point to point microwave links carrying utility control, cellular backhaul, public safety traffic and television studio links.",
    rules: [
      "Part 101 fixed microwave and Part 74 broadcast auxiliary. These are the incumbents that 6 GHz Wi-Fi has to coordinate around.",
    ],
    source: SRC_FCC_TABLE,
  },
  {
    id: "milsatcom-7250-7750",
    lowHz: MHz(7250),
    highHz: MHz(7750),
    service: "military",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "X band military satellite downlink",
    summary:
      "The downlink half of military X band satellite communications, including the Wideband Global SATCOM constellation.",
    source: SRC_NTIA,
  },
  {
    id: "eess-8025-8400",
    lowHz: MHz(8025),
    highHz: MHz(8400),
    service: "satellite",
    status: "primary",
    region: "global",
    users: ["federal", "non-federal"],
    label: "Earth exploration satellite downlink, 8 GHz",
    summary:
      "The X band downlink that most imaging satellites use to dump data to ground stations as they pass overhead.",
    source: SRC_FCC_TABLE,
  },

  /* ---------------------------------------------------------------- */
  /* 8 GHz to 18 GHz                                                   */
  /* Source: FCC table, ITU Radio Regulations, NTIA, Part 97, Part 101 */
  /* ---------------------------------------------------------------- */
  {
    id: "milsatcom-7900-8400",
    lowHz: MHz(7900),
    highHz: MHz(8400),
    service: "military",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "X band military satellite uplink",
    summary: "The earth to space half of military X band satellite communications.",
    source: SRC_NTIA,
  },
  {
    id: "dsn-x-downlink-8400",
    lowHz: MHz(8400),
    highHz: MHz(8450),
    service: "space-research",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Deep space network X band downlink",
    summary:
      "The main downlink for interplanetary missions, from Mars rovers to the Voyager probes in interstellar space.",
    source: SRC_NTIA,
  },
  {
    id: "radiolocation-8500-9000",
    lowHz: MHz(8500),
    highHz: MHz(9000),
    service: "radiolocation",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "8.5 GHz to 9 GHz radiolocation",
    summary: "Military fire control, tracking and airborne intercept radars.",
    source: SRC_NTIA,
  },
  {
    id: "marine-radar-9300-9500",
    lowHz: MHz(9300),
    highHz: MHz(9500),
    service: "radar",
    status: "primary",
    region: "global",
    label: "X band marine and airborne weather radar",
    summary:
      "Shipborne navigation radar, airborne weather radar, and the search and rescue transponders that answer them.",
    rules: [
      "Part of a ship or aircraft station license. Marine X band radar gives sharp bearing resolution on a small antenna, at the cost of heavy rain attenuation.",
      "Search and rescue radar transponders reply here with a line of blips that shows up on any nearby ship's radar screen.",
    ],
    source: SRC_PART80,
  },
  {
    id: "amateur-3cm",
    lowHz: GHz(10),
    highHz: GHz(10.5),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "3 cm amateur band, 10 GHz",
    summary:
      "The most popular amateur microwave band, used for rainscatter, tropospheric ducting and record breaking line of sight contacts.",
    rules: [
      "All license classes from Technician up, secondary to radiolocation.",
      "10.368 GHz is the narrowband calling frequency. 10.45 to 10.50 GHz is the amateur satellite segment.",
    ],
    source: SRC_PART97,
  },
  {
    id: "police-radar-10525",
    lowHz: GHz(10.5),
    highHz: GHz(10.55),
    service: "radiolocation",
    status: "primary",
    region: "US",
    label: "X band doppler radar, 10.525 GHz",
    summary:
      "Police speed radar, automatic door openers and motion sensors, the X band every radar detector was originally built for.",
    rules: [
      "Part 15.245 allows field disturbance sensors here without a license. Police radar is licensed under Part 90.",
    ],
    source: SRC_PART15,
  },
  {
    id: "ra-10680",
    lowHz: GHz(10.68),
    highHz: GHz(10.7),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "10.68 GHz to 10.7 GHz radio astronomy, passive",
    summary:
      "A passive band closed to all emissions, used for continuum astronomy and passive microwave sensing of sea surface conditions.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "fss-ku-downlink-10700-11700",
    lowHz: GHz(10.7),
    highHz: GHz(11.7),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "Ku band satellite downlink, lower",
    summary:
      "Fixed satellite downlinks shared with terrestrial fixed microwave, and the band most non geostationary broadband constellations use for user downlink.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "fss-ku-downlink-11700-12200",
    lowHz: GHz(11.7),
    highHz: GHz(12.2),
    service: "satellite",
    status: "primary",
    region: "ITU2",
    label: "Ku band satellite downlink, upper",
    summary:
      "The Region 2 fixed satellite downlink block, used for video distribution, VSAT networks and satellite broadband.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "dbs-12200-12700",
    lowHz: GHz(12.2),
    highHz: GHz(12.7),
    service: "satellite",
    status: "primary",
    region: "ITU2",
    users: ["non-federal"],
    label: "Direct broadcast satellite, 12.2 GHz to 12.7 GHz",
    summary:
      "The DirecTV and Dish Network downlink band, the one every 18 inch pizza dish on a roof is pointed at.",
    rules: [
      "Licensed geostationary broadcasting satellite service. The uplinks are at 17.3 to 17.8 GHz.",
    ],
    source: SRC_FCC_TABLE,
  },
  {
    id: "cars-12700-13250",
    lowHz: GHz(12.7),
    highHz: GHz(13.25),
    service: "wireless-microphones",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "Cable relay and broadcast auxiliary, 13 GHz",
    summary:
      "Cable television relay service and television pickup links, the microwave hops that bring live shots back to the studio.",
    source: SRC_PART74,
  },
  {
    id: "doppler-nav-13250-13400",
    lowHz: GHz(13.25),
    highHz: GHz(13.4),
    service: "aeronautical",
    status: "primary",
    region: "global",
    label: "13.25 GHz to 13.4 GHz airborne doppler navigation",
    summary: "Airborne doppler navigation radar and spaceborne precipitation radar.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "fss-ku-uplink-14000-14500",
    lowHz: GHz(14),
    highHz: GHz(14.5),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "Ku band satellite uplink",
    summary:
      "The uplink half of the Ku band: VSAT terminals, satellite news gathering trucks, maritime and aviation broadband, and consumer broadband user terminals.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ra-15350",
    lowHz: GHz(15.35),
    highHz: GHz(15.4),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "15.35 GHz to 15.4 GHz radio astronomy, passive",
    summary: "A passive band closed to all emissions for continuum radio astronomy.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "asde-15400-15700",
    lowHz: GHz(15.4),
    highHz: GHz(15.7),
    service: "radar",
    status: "primary",
    region: "global",
    label: "Airport surface detection radar, 15.7 GHz",
    summary:
      "The radar that tracks aircraft and vehicles on runways and taxiways in low visibility.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "radiolocation-15700-17700",
    lowHz: GHz(15.7),
    highHz: GHz(17.7),
    service: "radiolocation",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "15.7 GHz to 17.7 GHz radiolocation",
    summary: "Military tracking radar, airborne mapping radar and radionavigation.",
    source: SRC_NTIA,
  },

  /* ---------------------------------------------------------------- */
  /* 18 GHz to 40 GHz                                                  */
  /* Source: FCC table, ITU Radio Regulations, 3GPP FR2 bands, NTIA    */
  /* ---------------------------------------------------------------- */
  {
    id: "dbs-uplink-17300-17800",
    lowHz: GHz(17.3),
    highHz: GHz(17.8),
    service: "satellite",
    status: "primary",
    region: "ITU2",
    label: "Direct broadcast satellite uplink",
    summary:
      "The feeder uplinks that deliver programming to the 12.2 GHz direct broadcast satellites.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "fss-ka-downlink-17700-19700",
    lowHz: GHz(17.7),
    highHz: GHz(19.7),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "Ka band satellite downlink, lower",
    summary:
      "Fixed satellite downlinks shared with terrestrial fixed links, used for gateway feeder links by broadband constellations.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "eess-passive-18600",
    lowHz: GHz(18.6),
    highHz: GHz(18.8),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "18.6 GHz to 18.8 GHz passive sensing",
    summary:
      "A passive earth exploration band used to measure sea surface temperature, soil moisture and rainfall from orbit.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "fss-ka-downlink-19700-20200",
    lowHz: GHz(19.7),
    highHz: GHz(20.2),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "Ka band satellite downlink, user terminals",
    summary:
      "The consumer satellite broadband downlink: Starlink, Viasat and Hughes user terminals all receive here.",
    rules: ["Paired with 29.5 to 30.0 GHz for the user terminal uplink."],
    source: SRC_FCC_TABLE,
  },
  {
    id: "milsatcom-20200-21200",
    lowHz: GHz(20.2),
    highHz: GHz(21.2),
    service: "military",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Military Ka band satellite downlink",
    summary: "Protected government satellite downlinks, including the Advanced EHF system.",
    source: SRC_NTIA,
  },
  {
    id: "ra-22200-water",
    lowHz: GHz(22.21),
    highHz: GHz(22.5),
    service: "radio-astronomy",
    status: "primary",
    region: "global",
    label: "22.2 GHz water line radio astronomy",
    summary:
      "A protected band around the 22.235 GHz water vapour line, used to study star forming regions and to measure atmospheric water.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ra-23600-ammonia",
    lowHz: GHz(23.6),
    highHz: GHz(24),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "23.6 GHz to 24 GHz radio astronomy, passive",
    summary:
      "A passive band protecting the ammonia lines and the water vapour channel that weather satellites use to sound the atmosphere.",
    rules: [
      "All emissions prohibited. Adjacent 5G operation in the 24 GHz band was contentious for exactly this reason.",
    ],
    source: SRC_FCC_TABLE,
  },
  {
    id: "ism-24125",
    lowHz: GHz(24),
    highHz: GHz(24.25),
    service: "ism",
    status: "unlicensed",
    region: "global",
    label: "24.125 GHz ISM band",
    summary:
      "The K band ISM allocation: doppler motion sensors, industrial level gauges, short range automotive radar and drone detection.",
    rules: [
      "Part 15.245 field disturbance sensors and Part 18 equipment operate here with no license.",
    ],
    source: SRC_PART15,
  },
  {
    id: "amateur-1p2cm",
    lowHz: GHz(24),
    highHz: GHz(24.25),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "1.2 cm amateur band, 24 GHz",
    summary:
      "An amateur microwave band overlapping the 24 GHz ISM allocation, used for short range microwave contesting.",
    rules: [
      "All license classes from Technician up. 24.00 to 24.05 GHz is the amateur satellite segment.",
    ],
    source: SRC_PART97,
  },
  {
    id: "cellular-n258",
    lowHz: GHz(24.25),
    highHz: GHz(27.5),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "24 GHz millimeter wave, 5G n258",
    summary:
      "The lowest 5G millimeter wave band, auctioned in 2019, offering very high capacity over very short distances.",
    rules: [
      "Time division duplex. Usable range from a single site is a few hundred meters and drops sharply behind walls and foliage.",
    ],
    notes:
      "The proximity to the 23.6 to 24 GHz passive weather sensing band produced a public argument between the FCC and NOAA over out of band emission limits.",
    source: SRC_3GPP,
  },
  {
    id: "cellular-n261",
    lowHz: GHz(27.5),
    highHz: GHz(28.35),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "28 GHz millimeter wave, 5G n261",
    summary:
      "The 28 GHz band, the first millimeter wave spectrum deployed for 5G in the United States and the one behind stadium and downtown hot zones.",
    source: SRC_3GPP,
  },
  {
    id: "fss-ka-uplink-28350-30000",
    lowHz: GHz(28.35),
    highHz: GHz(30),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "Ka band satellite uplink",
    summary:
      "The uplink half of consumer satellite broadband, paired with the 19.7 to 20.2 GHz downlink.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "milsatcom-30000-31000",
    lowHz: GHz(30),
    highHz: GHz(31),
    service: "military",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Military Ka band satellite uplink",
    summary: "Protected government satellite uplinks paired with the 20.2 to 21.2 GHz downlinks.",
    source: SRC_NTIA,
  },
  {
    id: "ra-31300",
    lowHz: GHz(31.3),
    highHz: GHz(31.8),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "31.3 GHz to 31.8 GHz radio astronomy, passive",
    summary:
      "A passive band closed to all emissions, used for continuum astronomy and atmospheric sounding.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "dsn-ka-downlink-31800",
    lowHz: GHz(31.8),
    highHz: GHz(32.3),
    service: "space-research",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Deep space network Ka band downlink",
    summary:
      "The high rate deep space downlink band, which carries far more data per watt than the older X band link.",
    source: SRC_NTIA,
  },
  {
    id: "dsn-ka-uplink-34200",
    lowHz: GHz(34.2),
    highHz: GHz(34.7),
    service: "space-research",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "Deep space network Ka band uplink",
    summary: "The earth to space half of the high rate deep space link.",
    source: SRC_NTIA,
  },
  {
    id: "radiolocation-33400-36000",
    lowHz: GHz(33.4),
    highHz: GHz(36),
    service: "radiolocation",
    status: "primary",
    region: "US",
    users: ["federal"],
    label: "33.4 GHz to 36 GHz radiolocation",
    summary:
      "Millimeter wave tracking and imaging radar, including cloud profiling radar at 35 GHz.",
    source: SRC_NTIA,
  },
  {
    id: "eess-passive-36000",
    lowHz: GHz(36),
    highHz: GHz(37),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "36 GHz to 37 GHz passive sensing",
    summary:
      "A passive earth exploration and radio astronomy band used for precipitation and snow measurement.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "cellular-n260",
    lowHz: GHz(37),
    highHz: GHz(40),
    service: "cellular",
    status: "primary",
    region: "US",
    users: ["federal", "non-federal"],
    label: "39 GHz millimeter wave, 5G n260",
    summary:
      "The largest US millimeter wave block, auctioned in 2020, with 37 to 37.6 GHz shared with federal users under a coordination framework.",
    source: SRC_3GPP,
  },

  /* ---------------------------------------------------------------- */
  /* 40 GHz to 275 GHz                                                 */
  /* Source: FCC table, ITU Radio Regulations, Part 15 subpart C and   */
  /* subpart E, Part 97, NTIA                                          */
  /* ---------------------------------------------------------------- */
  {
    id: "fss-40500-42500",
    lowHz: GHz(40.5),
    highHz: GHz(42.5),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "40.5 GHz to 42.5 GHz satellite downlink",
    summary:
      "Broadcasting satellite and fixed satellite downlinks in the V band, a growth area for high throughput constellations.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ra-42500-43500",
    lowHz: GHz(42.5),
    highHz: GHz(43.5),
    service: "radio-astronomy",
    status: "primary",
    region: "global",
    label: "42.5 GHz to 43.5 GHz radio astronomy",
    summary:
      "A protected band covering the 43 GHz silicon monoxide maser lines, important for very long baseline interferometry.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "milsatcom-43500-45500",
    lowHz: GHz(43.5),
    highHz: GHz(45.5),
    service: "military",
    status: "primary",
    region: "global",
    users: ["federal"],
    label: "43.5 GHz to 45.5 GHz military satellite",
    summary:
      "Protected government satellite uplinks and crosslinks, including the Advanced EHF and Milstar systems.",
    source: SRC_NTIA,
  },
  {
    id: "amateur-6mm",
    lowHz: GHz(47),
    highHz: GHz(47.2),
    service: "amateur",
    status: "primary",
    region: "global",
    users: ["non-federal"],
    label: "6 mm amateur band, 47 GHz",
    summary:
      "A rare primary amateur allocation at millimeter wavelengths, shared with the amateur satellite service.",
    rules: ["All license classes from Technician up, primary in the whole 200 kHz wide band."],
    source: SRC_PART97,
  },
  {
    id: "fss-uplink-47200-50200",
    lowHz: GHz(47.2),
    highHz: GHz(50.2),
    service: "satellite",
    status: "primary",
    region: "global",
    label: "V band satellite uplink",
    summary:
      "The uplink half of the V band fixed satellite service, planned for the next generation of high throughput gateways.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "eess-passive-52600",
    lowHz: GHz(52.6),
    highHz: GHz(54.25),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "52.6 GHz to 54.25 GHz passive sensing",
    summary:
      "A passive band on the shoulder of the oxygen absorption complex, used by weather satellites to sound atmospheric temperature.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "unlicensed-60ghz",
    lowHz: GHz(57),
    highHz: GHz(71),
    service: "wifi-unlicensed",
    status: "unlicensed",
    region: "US",
    users: ["non-federal"],
    label: "60 GHz unlicensed, WiGig and 802.11ad or ay",
    summary:
      "Fourteen gigahertz of unlicensed spectrum where oxygen absorption limits range to a room, which is exactly what makes dense reuse possible.",
    rules: [
      "No license, Part 15.255. Up to 500 mW average transmitter output with high gain antennas allowed, and much higher effective isotropic radiated power for fixed outdoor links.",
      "Channels are 2.16 GHz wide. IEEE 802.11ad defines channels 1 to 6 at 58.32, 60.48, 62.64, 64.80, 66.96 and 69.12 GHz, and 802.11ay bonds them in pairs and quads.",
      "Also used for 60 GHz radar sensors such as gesture and presence detection.",
    ],
    notes:
      "Atmospheric oxygen absorbs about 15 dB per kilometer near 60 GHz, so the band is naturally self contained.",
    source: SRC_PART15,
  },
  {
    id: "eband-71000-76000",
    lowHz: GHz(71),
    highHz: GHz(76),
    service: "fixed",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "E band fixed links, 71 GHz to 76 GHz",
    summary:
      "Lightly licensed multi gigabit point to point links, paired with 81 to 86 GHz and used heavily for cellular backhaul.",
    rules: [
      "Part 101 light licensing: a link is registered in a database rather than individually auctioned, which makes deployment fast and cheap.",
    ],
    source: SRC_FCC_TABLE,
  },
  {
    id: "auto-radar-76000-81000",
    lowHz: GHz(76),
    highHz: GHz(81),
    service: "radar",
    status: "primary",
    region: "global",
    label: "Automotive radar, 76 GHz to 81 GHz",
    summary:
      "Adaptive cruise control, automatic emergency braking, blind spot monitoring and parking sensors on every modern car.",
    rules: [
      "76 to 77 GHz is the long range forward looking radar band; 77 to 81 GHz is the wideband short range imaging band.",
      "Part 95 subpart M in the United States, harmonised internationally so that a car works everywhere.",
    ],
    notes:
      "The amateur 4 mm band shares 76 to 81 GHz, which makes it a difficult place to operate as vehicle radar density grows.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "amateur-4mm",
    lowHz: GHz(76),
    highHz: GHz(81),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "4 mm amateur band, 78 GHz",
    summary:
      "A secondary amateur allocation now shared with automotive radar, used for very short range millimeter wave experiments.",
    source: SRC_PART97,
  },
  {
    id: "eband-81000-86000",
    lowHz: GHz(81),
    highHz: GHz(86),
    service: "fixed",
    status: "primary",
    region: "US",
    users: ["non-federal"],
    label: "E band fixed links, 81 GHz to 86 GHz",
    summary:
      "The upper half of the E band point to point pairing, carrying multi gigabit backhaul.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ra-86000-92000",
    lowHz: GHz(86),
    highHz: GHz(92),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "86 GHz to 92 GHz radio astronomy, passive",
    summary:
      "A passive band protecting millimeter wave astronomy, including the 86 GHz silicon monoxide maser and continuum work at ALMA.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "wband-92000-114250",
    lowHz: GHz(92),
    highHz: GHz(114.25),
    service: "fixed",
    status: "primary",
    region: "US",
    label: "W band fixed, satellite and radiolocation",
    summary:
      "The W band: experimental fixed links, millimeter wave imaging, cloud radar at 94 GHz and future satellite feeder links.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "eess-passive-114250",
    lowHz: GHz(114.25),
    highHz: GHz(122.25),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "114.25 GHz to 122.25 GHz passive sensing",
    summary:
      "A passive band around the 118 GHz oxygen line, used for atmospheric temperature sounding from orbit.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "ism-122ghz",
    lowHz: GHz(122),
    highHz: GHz(123),
    service: "ism",
    status: "unlicensed",
    region: "global",
    label: "122.5 GHz ISM band",
    summary:
      "One of the two highest ISM allocations, used for millimeter wave sensing and material measurement.",
    source: SRC_PART18,
  },
  {
    id: "amateur-2p5mm",
    lowHz: GHz(122.25),
    highHz: GHz(123),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "2.5 mm amateur band, 122 GHz",
    summary: "A secondary amateur allocation overlapping the 122 GHz ISM band.",
    source: SRC_PART97,
  },
  {
    id: "amateur-2mm",
    lowHz: GHz(134),
    highHz: GHz(141),
    service: "amateur",
    status: "primary",
    region: "global",
    users: ["non-federal"],
    label: "2 mm amateur band, 136 GHz",
    summary:
      "A seven gigahertz wide amateur allocation where the world distance records are measured in tens of kilometers.",
    rules: [
      "All license classes from Technician up. Amateur and amateur satellite share the band.",
    ],
    source: SRC_PART97,
  },
  {
    id: "eess-passive-164000",
    lowHz: GHz(164),
    highHz: GHz(167),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "164 GHz to 167 GHz passive sensing",
    summary: "A passive band used for atmospheric water vapour sounding and radio astronomy.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "eess-passive-200000",
    lowHz: GHz(200),
    highHz: GHz(209),
    service: "radio-astronomy",
    status: "restricted",
    region: "global",
    label: "200 GHz to 209 GHz passive sensing",
    summary:
      "A passive band covering ozone and nitric oxide lines, used for atmospheric chemistry from orbit.",
    source: SRC_FCC_TABLE,
  },
  {
    id: "amateur-1mm",
    lowHz: GHz(241),
    highHz: GHz(250),
    service: "amateur",
    status: "secondary",
    region: "global",
    users: ["non-federal"],
    label: "1 mm amateur band, 241 GHz",
    summary:
      "The highest amateur band with a specific allocation, where a contact of a few hundred meters is a genuine achievement.",
    rules: [
      "All license classes from Technician up. Above 275 GHz amateurs may operate without a specific allocation, subject to the general rules.",
    ],
    source: SRC_PART97,
  },
  {
    id: "ism-245ghz",
    lowHz: GHz(244),
    highHz: GHz(246),
    service: "ism",
    status: "unlicensed",
    region: "global",
    label: "245 GHz ISM band",
    summary:
      "The highest ISM allocation in the ITU table, used for laboratory and industrial sensing.",
    source: SRC_PART18,
  },
  {
    id: "top-of-table-275",
    lowHz: GHz(252),
    highHz: GHz(275),
    service: "fixed",
    status: "primary",
    region: "global",
    label: "252 GHz to 275 GHz, the top of the allocation table",
    summary:
      "The last allocated block before the ITU table stops. Above 275 GHz the regulations identify bands for passive science but make no formal service allocations.",
    notes:
      "WRC-19 identified 275 to 450 GHz for land mobile and fixed use, with protection conditions for passive science, but the classic table ends here.",
    source: SRC_ITU,
  },

  /* ---------------------------------------------------------------- */
  /* Notable ITU regional differences                                  */
  /* These rows exist to show where the United States is unusual.      */
  /* Source: ITU Radio Regulations Article 5, 3GPP band tables         */
  /* ---------------------------------------------------------------- */
  {
    id: "itu1-lw-broadcast",
    lowHz: kHz(148.5),
    highHz: kHz(283.5),
    service: "broadcast-am",
    status: "primary",
    region: "ITU1",
    label: "Long wave broadcasting, Region 1 only",
    summary:
      "Europe, Africa and northern Asia have an AM broadcast band below the medium wave band. Region 2 has none.",
    notes:
      "This is why a European radio has an LW position on the band switch and a US radio does not.",
    source: SRC_ITU,
  },
  {
    id: "itu1-mw-spacing",
    lowHz: kHz(526.5),
    highHz: kHz(1606.5),
    service: "broadcast-am",
    status: "primary",
    region: "ITU1",
    label: "Medium wave broadcasting, Region 1 and 3 plan",
    summary:
      "Outside the Americas the AM band runs 526.5 to 1606.5 kHz on 9 kHz channel spacing rather than 535 to 1705 kHz on 10 kHz spacing.",
    source: SRC_ITU,
  },
  {
    id: "itu3-fm-japan",
    lowHz: MHz(76),
    highHz: MHz(95),
    service: "broadcast-fm",
    status: "primary",
    region: "ITU3",
    label: "Japanese FM band, 76 MHz to 95 MHz",
    summary:
      "Japan places FM broadcasting below the international band, overlapping what is television channels 5 and 6 in the United States.",
    notes: "A US radio cannot tune the Japanese FM band, and the reverse is only partly true.",
    source: SRC_ITU,
  },
  {
    id: "itu1-gsm900",
    lowHz: MHz(880),
    highHz: MHz(960),
    service: "cellular",
    status: "primary",
    region: "ITU1",
    label: "GSM 900 and LTE band 8, Regions 1 and 3",
    summary:
      "The classic European cellular band, 880 to 915 MHz uplink and 925 to 960 MHz downlink, sitting exactly where the Americas put the 915 MHz ISM band.",
    notes:
      "This single difference explains why LoRa, Z-Wave and RFID all use different frequencies on the two sides of the Atlantic.",
    source: SRC_3GPP,
  },
  {
    id: "itu1-sr-devices-868",
    lowHz: MHz(863),
    highHz: MHz(870),
    service: "unlicensed-part15",
    status: "unlicensed",
    region: "ITU1",
    label: "868 MHz short range devices, Region 1",
    summary:
      "The European counterpart to the US 902 to 928 MHz band, used by LoRa, Z-Wave, meters and sensors at much lower duty cycles.",
    rules: [
      "Duty cycle limits, typically 0.1 to 1 percent, replace the frequency hopping requirements used in the United States.",
    ],
    source: SRC_ITU,
  },
  {
    id: "itu1-34ghz",
    lowHz: GHz(3.4),
    highHz: GHz(3.8),
    service: "cellular",
    status: "primary",
    region: "ITU1",
    label: "3.4 GHz to 3.8 GHz mobile, Region 1",
    summary:
      "Europe's main 5G mid band, 3GPP band n78, cleared and auctioned years before the United States opened its C band.",
    notes:
      "In the United States 3.4 to 3.55 GHz was federal radar spectrum and 3.55 to 3.7 GHz became the shared CBRS band instead, so the two markets ended up with different mid band 5G frequencies.",
    source: SRC_3GPP,
  },
  {
    id: "itu3-n79",
    lowHz: GHz(4.4),
    highHz: GHz(5),
    service: "cellular",
    status: "primary",
    region: "ITU3",
    label: "4.5 GHz to 4.9 GHz mobile, 5G n79",
    summary:
      "A mid band 5G allocation used in China and Japan that is federal military spectrum in the United States.",
    source: SRC_3GPP,
  },
];

/**
 * The allocation table, sorted by lower edge then upper edge so that a caller
 * can walk it in frequency order without sorting first. Overlaps are expected
 * and correct: the real table is full of co-primary services, and a single
 * frequency routinely belongs to several rows at once.
 */
export const ALLOCATIONS: Allocation[] = [...ALLOCATION_ROWS].sort(
  (a, b) => a.lowHz - b.lowHz || a.highHz - b.highHz || a.id.localeCompare(b.id),
);

/* ================================================================== */
/* Channel tables                                                     */
/* ================================================================== */

/** One numbered channel in a fixed channel plan. */
export interface Channel {
  /** Channel identifier as the standard writes it, for example "11" or "37". */
  id: string;
  /** Center frequency in hertz. */
  centerHz: number;
  /** Occupied bandwidth in hertz, where the standard defines one. */
  widthHz?: number;
  /** Optional display name. */
  label?: string;
  /** Optional short note about restrictions or special roles. */
  note?: string;
}

/** A named channel plan for one service. */
export interface ChannelTable {
  id: string;
  name: string;
  service: AllocationService;
  channels: Channel[];
  source: string;
}

/* ---- IEEE 802.15.4 at 2.4 GHz: Zigbee, Thread and Matter ---------- */
/* Source: IEEE 802.15.4 clause 10, channel page 0, channels 11 to 26  */

/**
 * 802.15.4 2.4 GHz channel k has a center of 2405 + 5 * (k - 11) MHz, for k
 * from 11 to 26. The occupied bandwidth is about 2 MHz inside a 5 MHz raster.
 */
function ieee802154Channels(): Channel[] {
  const out: Channel[] = [];
  for (let k = 11; k <= 26; k += 1) {
    const centerMHz = 2405 + 5 * (k - 11);
    let note: string | undefined;
    if (k === 15 || k === 20 || k === 25 || k === 26) {
      note = "Falls between the busiest Wi-Fi channels, so installers prefer it.";
    }
    out.push({
      id: String(k),
      centerHz: MHz(centerMHz),
      widthHz: MHz(2),
      label: `Channel ${k}`,
      note,
    });
  }
  return out;
}

/* ---- LoRaWAN US915 ------------------------------------------------ */
/* Source: LoRa Alliance LoRaWAN Regional Parameters, US902-928 plan    */

function loraUplink125(): Channel[] {
  const out: Channel[] = [];
  for (let k = 0; k <= 63; k += 1) {
    out.push({
      id: String(k),
      centerHz: Math.round(MHz(902.3) + k * kHz(200)),
      widthHz: kHz(125),
      label: `Uplink channel ${k}`,
    });
  }
  return out;
}

function loraUplink500(): Channel[] {
  const out: Channel[] = [];
  for (let k = 0; k <= 7; k += 1) {
    out.push({
      id: String(64 + k),
      centerHz: Math.round(MHz(903) + k * kHz(1600)),
      widthHz: kHz(500),
      label: `Uplink channel ${64 + k}`,
      note: "Wideband uplink channel, data rate 4.",
    });
  }
  return out;
}

function loraDownlink(): Channel[] {
  const out: Channel[] = [];
  for (let k = 0; k <= 7; k += 1) {
    out.push({
      id: `RX1-${k}`,
      centerHz: Math.round(MHz(923.3) + k * kHz(600)),
      widthHz: kHz(500),
      label: `Downlink channel ${k}`,
    });
  }
  return out;
}

/* ---- Bluetooth ---------------------------------------------------- */
/* Source: Bluetooth Core Specification, radio specification           */

function bluetoothClassicChannels(): Channel[] {
  const out: Channel[] = [];
  for (let k = 0; k <= 78; k += 1) {
    out.push({
      id: String(k),
      centerHz: MHz(2402 + k),
      widthHz: MHz(1),
      label: `RF channel ${k}`,
    });
  }
  return out;
}

/**
 * Bluetooth Low Energy uses its own numbering that does not line up with the
 * classic 0 to 78 grid: three advertising channels (37, 38 and 39) are placed
 * at the edges and in the middle of the band, with the 37 data channels
 * filling the gaps. Channel 37 is at 2402 MHz, the same frequency as classic
 * channel 0, but the two numbering schemes are unrelated.
 */
function bluetoothLeChannels(): Channel[] {
  const out: Channel[] = [];
  for (let k = 0; k <= 36; k += 1) {
    const centerMHz = k <= 10 ? 2404 + 2 * k : 2428 + 2 * (k - 11);
    out.push({
      id: String(k),
      centerHz: MHz(centerMHz),
      widthHz: MHz(2),
      label: `LE data channel ${k}`,
    });
  }
  const advertising: [string, number][] = [
    ["37", 2402],
    ["38", 2426],
    ["39", 2480],
  ];
  for (const [id, centerMHz] of advertising) {
    out.push({
      id,
      centerHz: MHz(centerMHz),
      widthHz: MHz(2),
      label: `LE advertising channel ${id}`,
      note: "Advertising, scanning and connection setup. Placed to dodge the three main Wi-Fi channels. This is BLE numbering, not the classic 0 to 78 grid.",
    });
  }
  return out.sort((a, b) => a.centerHz - b.centerHz);
}

/* ---- Everything else ---------------------------------------------- */

/**
 * FRS and GMRS channels 1 to 22. Channels 1 to 7 and 15 to 22 are the 462 MHz
 * main and interstitial channels; 8 to 14 are the 467 MHz low power
 * interstitials that both services limit to half a watt.
 */
const FRS_GMRS_MHZ: number[] = [
  462.5625, 462.5875, 462.6125, 462.6375, 462.6625, 462.6875, 462.7125, 467.5625, 467.5875,
  467.6125, 467.6375, 467.6625, 467.6875, 467.7125, 462.55, 462.575, 462.6, 462.625, 462.65,
  462.675, 462.7, 462.725,
];

function frsGmrsChannels(): Channel[] {
  return FRS_GMRS_MHZ.map((mhz, index) => {
    const n = index + 1;
    let note: string;
    if (n <= 7) {
      note =
        "FRS 2 W, GMRS 5 W. Repeater output for GMRS channels 15 to 22 uses the 462 MHz main channels instead.";
    } else if (n <= 14) {
      note = "0.5 W handheld only for both FRS and GMRS. No repeaters, no detachable antennas.";
    } else {
      note = "FRS 2 W, GMRS up to 50 W. These eight are the GMRS repeater output channels.";
    }
    return {
      id: String(n),
      centerHz: MHz(mhz),
      widthHz: n <= 7 || n >= 15 ? kHz(20) : kHz(12.5),
      label: `Channel ${n}`,
      note,
    };
  });
}

/** GMRS repeater inputs sit 5 MHz above the channel 15 to 22 outputs. */
function gmrsRepeaterInputs(): Channel[] {
  return [462.55, 462.575, 462.6, 462.625, 462.65, 462.675, 462.7, 462.725].map((mhz, index) => ({
    id: `RPT${15 + index}`,
    centerHz: MHz(mhz + 5),
    widthHz: kHz(20),
    label: `Repeater input for channel ${15 + index}`,
    note: "Mobile and handheld transmit frequency when working through a GMRS repeater.",
  }));
}

const MURS_CHANNELS: Channel[] = [
  {
    id: "1",
    centerHz: MHz(151.82),
    widthHz: kHz(11.25),
    label: "MURS 1",
    note: "Narrowband, 11.25 kHz maximum.",
  },
  {
    id: "2",
    centerHz: MHz(151.88),
    widthHz: kHz(11.25),
    label: "MURS 2",
    note: "Narrowband, 11.25 kHz maximum.",
  },
  {
    id: "3",
    centerHz: MHz(151.94),
    widthHz: kHz(11.25),
    label: "MURS 3",
    note: "Narrowband, 11.25 kHz maximum.",
  },
  {
    id: "4",
    centerHz: MHz(154.57),
    widthHz: kHz(20),
    label: "MURS 4, blue dot",
    note: "One of the old business band color dot channels, 20 kHz allowed.",
  },
  {
    id: "5",
    centerHz: MHz(154.6),
    widthHz: kHz(20),
    label: "MURS 5, green dot",
    note: "One of the old business band color dot channels, 20 kHz allowed.",
  },
];

const DECT6_CHANNELS: Channel[] = [0, 1, 2, 3, 4].map((k) => ({
  id: String(k),
  centerHz: Math.round(MHz(1921.536) + k * MHz(1.728)),
  widthHz: MHz(1.728),
  label: `DECT carrier ${k}`,
}));

const WIGIG_CHANNELS: Channel[] = [58.32, 60.48, 62.64, 64.8, 66.96, 69.12].map((ghz, index) => ({
  id: String(index + 1),
  centerHz: GHz(ghz),
  widthHz: Math.round(GHz(2.16)),
  label: `60 GHz channel ${index + 1}`,
  note:
    index >= 4
      ? "Only usable where the regulator allows operation above 66 GHz, which the United States does."
      : undefined,
}));

/**
 * The channel plans that this module owns. Wi-Fi, marine VHF, CB, NOAA weather
 * radio, FM and TV channel tables live in ./data and are referenced by
 * {@link REFERENCED_CHANNEL_TABLES} rather than duplicated here.
 */
export const CHANNEL_TABLES: ChannelTable[] = [
  {
    id: "zigbee-802154",
    name: "Zigbee and 802.15.4, 2.4 GHz",
    service: "unlicensed-part15",
    channels: ieee802154Channels(),
    source: "IEEE 802.15.4 clause 10, channel page 0",
  },
  {
    id: "thread-802154",
    name: "Thread and Matter over Thread, 2.4 GHz",
    service: "unlicensed-part15",
    channels: ieee802154Channels(),
    source:
      "Thread Group specification, which uses the IEEE 802.15.4 channel page 0 grid unchanged",
  },
  {
    id: "lora-us915-uplink-125k",
    name: "LoRaWAN US915 uplink, 125 kHz channels 0 to 63",
    service: "unlicensed-part15",
    channels: loraUplink125(),
    source: "LoRa Alliance LoRaWAN Regional Parameters, US902-928 channel plan",
  },
  {
    id: "lora-us915-uplink-500k",
    name: "LoRaWAN US915 uplink, 500 kHz channels 64 to 71",
    service: "unlicensed-part15",
    channels: loraUplink500(),
    source: "LoRa Alliance LoRaWAN Regional Parameters, US902-928 channel plan",
  },
  {
    id: "lora-us915-downlink",
    name: "LoRaWAN US915 downlink, 500 kHz channels 0 to 7",
    service: "unlicensed-part15",
    channels: loraDownlink(),
    source: "LoRa Alliance LoRaWAN Regional Parameters, US902-928 channel plan",
  },
  {
    id: "bluetooth-classic",
    name: "Bluetooth BR and EDR, RF channels 0 to 78",
    service: "unlicensed-part15",
    channels: bluetoothClassicChannels(),
    source: "Bluetooth Core Specification, radio specification",
  },
  {
    id: "bluetooth-le",
    name: "Bluetooth Low Energy, channels 0 to 39",
    service: "unlicensed-part15",
    channels: bluetoothLeChannels(),
    source: "Bluetooth Core Specification, low energy physical layer",
  },
  {
    id: "dect-6",
    name: "DECT 6.0 cordless phones, North America",
    service: "unlicensed-part15",
    channels: DECT6_CHANNELS,
    source: "ETSI EN 300 175 carrier plan as applied to the US UPCS band, 47 CFR Part 15 subpart D",
  },
  {
    id: "frs-gmrs",
    name: "FRS and GMRS channels 1 to 22",
    service: "frs-gmrs",
    channels: frsGmrsChannels(),
    source: SRC_PART95,
  },
  {
    id: "gmrs-repeater-inputs",
    name: "GMRS repeater input channels",
    service: "frs-gmrs",
    channels: gmrsRepeaterInputs(),
    source: SRC_PART95,
  },
  {
    id: "murs",
    name: "MURS channels 1 to 5",
    service: "frs-gmrs",
    channels: MURS_CHANNELS,
    source: SRC_PART95,
  },
  {
    id: "wigig-60ghz",
    name: "60 GHz WiGig channels, 802.11ad and ay",
    service: "wifi-unlicensed",
    channels: WIGIG_CHANNELS,
    source: "IEEE 802.11ad and 802.11ay channelization, 47 CFR 15.255",
  },
];

/**
 * Channel tables that already exist in ./data. Listed here so a panel can show
 * one combined index without this module duplicating the numbers.
 */
export const REFERENCED_CHANNEL_TABLES = [
  {
    id: "wifi",
    name: "Wi-Fi channels, 2.4, 5 and 6 GHz",
    service: "wifi-unlicensed" as AllocationService,
    exportName: "WIFI_CHANNELS",
    module: "./data",
    channelCount: WIFI_CHANNELS.length,
    source: SRC_PART15,
  },
  {
    id: "marine-vhf",
    name: "Marine VHF channels",
    service: "maritime" as AllocationService,
    exportName: "NAMED_CHANNELS",
    module: "./data",
    channelCount: NAMED_CHANNELS.filter((c) => c.service === "marine").length,
    source: SRC_PART80,
  },
  {
    id: "cb",
    name: "Citizens Band channels 1 to 40",
    service: "citizens-band" as AllocationService,
    exportName: "NAMED_CHANNELS",
    module: "./data",
    channelCount: NAMED_CHANNELS.filter((c) => c.service === "cb").length,
    source: SRC_PART95,
  },
  {
    id: "noaa",
    name: "NOAA Weather Radio channels",
    service: "meteorological" as AllocationService,
    exportName: "NAMED_CHANNELS",
    module: "./data",
    channelCount: NAMED_CHANNELS.filter((c) => c.service === "noaa").length,
    source: "NOAA National Weather Service NWR service description",
  },
  {
    id: "fm",
    name: "FM broadcast channels 201 to 300",
    service: "broadcast-fm" as AllocationService,
    exportName: "NAMED_CHANNELS",
    module: "./data",
    channelCount: NAMED_CHANNELS.filter((c) => c.service === "fm").length,
    source: SRC_PART73,
  },
  {
    id: "tv",
    name: "Television channels",
    service: "broadcast-tv" as AllocationService,
    exportName: "NAMED_CHANNELS",
    module: "./data",
    channelCount: NAMED_CHANNELS.filter((c) => c.service === "tv").length,
    source: SRC_PART73,
  },
];

/* ================================================================== */
/* Helpers                                                            */
/* ================================================================== */

/** Display order for statuses: what you are most likely to care about first. */
const STATUS_ORDER: Record<AllocationStatus, number> = {
  primary: 0,
  secondary: 1,
  unlicensed: 2,
  restricted: 3,
};

/**
 * Does an allocation row belong to the requested regional view?
 *
 * The United States is in ITU Region 2, so a `US` query also returns Region 2
 * rows and worldwide rows. A query for a specific ITU region returns only that
 * region plus worldwide rows, so `ITU1` never pulls in domestic FCC detail.
 */
function regionMatches(entry: AllocationRegion, query: AllocationRegion): boolean {
  if (entry === "global" || entry === query) return true;
  return query === "US" && entry === "ITU2";
}

/**
 * Every allocation that contains a frequency, sorted primary first, then by
 * how specific the row is (narrower ranges come first), then by id so the
 * order is stable.
 *
 * Edges are inclusive on both sides, because a band edge like 148 MHz is a
 * meaningful answer for both the band below and the band above it.
 */
export function allocationsAt(freqHz: number, region: AllocationRegion = "US"): Allocation[] {
  if (!Number.isFinite(freqHz)) return [];
  return ALLOCATIONS.filter(
    (a) => freqHz >= a.lowHz && freqHz <= a.highHz && regionMatches(a.region, region),
  ).sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.highHz - a.lowHz - (b.highHz - b.lowHz) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Every allocation that overlaps a frequency range at all, in frequency order.
 * The arguments are swapped if they arrive the wrong way round.
 */
export function allocationsInRange(lowHz: number, highHz: number): Allocation[] {
  if (!Number.isFinite(lowHz) || !Number.isFinite(highHz)) return [];
  const lo = Math.min(lowHz, highHz);
  const hi = Math.max(lowHz, highHz);
  return ALLOCATIONS.filter((a) => a.highHz >= lo && a.lowHz <= hi);
}

const FREQ_UNITS: Record<string, number> = {
  hz: 1,
  khz: 1e3,
  mhz: 1e6,
  ghz: 1e9,
  thz: 1e12,
};

/** Lowercase, collapse separators, and glue a number to a following unit word. */
function compactText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_/,]+/g, " ")
    .trim()
    .replace(/(\d)\s+(m|cm|mm|hz|khz|mhz|ghz|thz)\b/g, "$1$2");
}

/**
 * The searchable text for one allocation. Built once at module load, because
 * the table is static and the panel searches on every keystroke.
 */
const SEARCH_INDEX: { allocation: Allocation; haystack: string }[] = ALLOCATIONS.map((a) => ({
  allocation: a,
  haystack: compactText(
    [a.id, a.label, a.service, a.status, a.summary, a.notes ?? "", ...(a.rules ?? [])].join(" "),
  ),
}));

/** Parse a bare frequency query such as "915 MHz" or "2.4ghz". Returns null otherwise. */
function parseFrequencyQuery(compact: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(hz|khz|mhz|ghz|thz)$/.exec(compact);
  if (!m) return null;
  return Number(m[1]) * FREQ_UNITS[m[2]];
}

/**
 * Search the allocation table.
 *
 * Tolerant of the shorthand people actually type: band names by wavelength
 * ("2m", "70 cm"), 3GPP band numbers ("band 41", "n77"), service names
 * ("radio astronomy") and bare frequencies ("915 MHz", "6 GHz"). A bare
 * frequency also returns whatever is allocated at that frequency, listed
 * before the text matches.
 *
 * A single alphanumeric token is matched on word boundaries, so "2m" does not
 * match "2200m" or "12m". Anything with a space or punctuation in it is
 * matched as a plain substring.
 */
export function searchAllocations(query: string): Allocation[] {
  const compact = compactText(String(query ?? ""));
  if (!compact) return [];

  const seen = new Set<string>();
  const out: Allocation[] = [];
  const push = (a: Allocation): void => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push(a);
  };

  const freq = parseFrequencyQuery(compact);
  if (freq !== null) {
    for (const a of allocationsAt(freq)) push(a);
  }

  const isSingleToken = /^[a-z0-9.]+$/.test(compact);
  const escaped = compact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = isSingleToken ? new RegExp(`\\b${escaped}\\b`) : null;

  for (const entry of SEARCH_INDEX) {
    const hit = pattern ? pattern.test(entry.haystack) : entry.haystack.includes(compact);
    if (hit) push(entry.allocation);
  }
  return out;
}

/** What {@link licenseNeededAt} returns. */
export interface LicenseSummary {
  freqHz: number;
  /** True when at least one unlicensed allocation covers this frequency. */
  unlicensed: boolean;
  /** True when amateur radio has an allocation here. */
  amateur: boolean;
  /** True when every allocation here is federal government only. */
  federalOnly: boolean;
  /** True when a passive or otherwise transmission restricted band covers this frequency. */
  restricted: boolean;
  /** The services present, primary first. */
  services: AllocationService[];
  /** One or two sentences answering "may I transmit here". */
  summary: string;
  /** Every plain English rule from the matching allocations, deduplicated. */
  rules: string[];
}

/**
 * Summarize what it takes to transmit legally at one frequency in the
 * United States.
 *
 * This is a reading of the curated table, not legal advice. The FCC rules
 * govern, and many bands carry conditions that no summary can capture.
 */
export function licenseNeededAt(freqHz: number): LicenseSummary {
  const hits = allocationsAt(freqHz, "US");
  const services = [...new Set(hits.map((a) => a.service))];
  const rules = [...new Set(hits.flatMap((a) => a.rules ?? []))];
  const unlicensed = hits.some((a) => a.status === "unlicensed");
  const amateur = hits.some((a) => a.service === "amateur" || a.service === "amateur-satellite");
  const restricted = hits.some((a) => a.status === "restricted");
  const federalOnly =
    hits.length > 0 && hits.every((a) => a.users?.length === 1 && a.users[0] === "federal");

  const parts: string[] = [];
  if (hits.length === 0) {
    parts.push(
      "This module has no curated entry at that frequency. That does not mean the spectrum is free: check the FCC Table of Frequency Allocations.",
    );
  } else if (restricted) {
    parts.push(
      "A transmission restricted band covers this frequency. Passive science bands prohibit emissions outright, so assume you may not transmit here.",
    );
  } else if (unlicensed) {
    parts.push(
      "Unlicensed devices may transmit here, using certified equipment that meets the Part 15 or Part 18 limits. You get no protection from interference and must not cause any.",
    );
  } else if (amateur) {
    parts.push(
      "An amateur radio license covers transmission here. Check the sub band rules for your license class before you key up.",
    );
  } else if (federalOnly) {
    parts.push(
      "This is federal government spectrum, assigned through NTIA. There is no license a private individual or company can obtain for it.",
    );
  } else {
    parts.push(
      "Transmission here needs a license from the FCC under the relevant service rules, usually with frequency coordination.",
    );
  }
  if (amateur && !unlicensed && !restricted) {
    parts.push("Amateur privileges depend on license class; see the rules list.");
  }

  return {
    freqHz,
    unlicensed,
    amateur,
    federalOnly,
    restricted,
    services,
    summary: parts.join(" "),
    rules,
  };
}

/* ================================================================== */
/* Metadata                                                           */
/* ================================================================== */

/**
 * Provenance for the whole dataset: what it covers, when it was built, what it
 * was built from, and what it is not.
 */
export const ALLOCATION_META = {
  /** The date every source below was consulted. */
  retrieved: "2026-08-30",
  /** The frequency span the table attempts to cover. */
  lowHz: kHz(9),
  highHz: GHz(275),
  /** How many curated allocation rows there are. */
  entryCount: ALLOCATIONS.length,
  /** How many channel plans this module owns. */
  channelTableCount: CHANNEL_TABLES.length,
  disclaimer:
    "This is a hand curated educational summary of United States spectrum use, not a regulatory document. The FCC Table of Frequency Allocations in 47 CFR 2.106, the NTIA manual for federal bands, and the service rules in the relevant FCC parts are what actually govern. Many rows here collapse several co-primary services into one line, and footnotes, coordination zones and geographic restrictions are omitted. Verify against the primary sources before acting on anything.",
  sources: [
    {
      id: "fcc-table",
      title: "FCC Table of Frequency Allocations, 47 CFR 2.106",
      url: "https://www.fcc.gov/engineering-technology/policy-and-rules-division/general/radio-spectrum-allocation",
    },
    {
      id: "ntia-manual",
      title: "NTIA Manual of Regulations and Procedures for Federal Radio Frequency Management",
      url: "https://www.ntia.gov/page/2011/manual-regulations-and-procedures-federal-radio-frequency-management-redbook",
    },
    {
      id: "itu-rr",
      title: "ITU Radio Regulations, Article 5 Table of Frequency Allocations",
      url: "https://www.itu.int/pub/R-REG-RR",
    },
    {
      id: "part97",
      title: "47 CFR Part 97, Amateur Radio Service",
      url: "https://www.law.cornell.edu/cfr/text/47/part-97",
    },
    {
      id: "arrl-bands",
      title: "ARRL US Amateur Radio Bands chart",
      url: "https://www.arrl.org/band-plan",
    },
    {
      id: "part15",
      title: "47 CFR Part 15, Radio Frequency Devices",
      url: "https://www.law.cornell.edu/cfr/text/47/part-15",
    },
    {
      id: "part95",
      title: "47 CFR Part 95, Personal Radio Services",
      url: "https://www.law.cornell.edu/cfr/text/47/part-95",
    },
    {
      id: "rf-exposure",
      title: "47 CFR 1.1310 and 1.1307(b), RF exposure limits and evaluation exemptions",
      url: "https://www.law.cornell.edu/cfr/text/47/1.1310",
    },
    {
      id: "3gpp",
      title: "3GPP TS 36.101 and TS 38.101 operating bands",
      url: "https://www.3gpp.org/specifications-technologies",
    },
    {
      id: "lorawan",
      title: "LoRa Alliance LoRaWAN Regional Parameters",
      url: "https://lora-alliance.org/resource_hub/rp2-1-0-3-lorawan-regional-parameters/",
    },
    {
      id: "nist-time",
      title: "NIST radio stations WWV, WWVH and WWVB",
      url: "https://www.nist.gov/pml/time-and-frequency-division/time-distribution/radio-station-wwv",
    },
  ],
} as const;
