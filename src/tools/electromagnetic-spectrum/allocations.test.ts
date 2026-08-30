import { describe, expect, it } from "vitest";

import {
  ALLOCATION_META,
  ALLOCATION_SERVICES,
  ALLOCATIONS,
  CHANNEL_TABLES,
  REFERENCED_CHANNEL_TABLES,
  RF_EXPOSURE,
  allocationsAt,
  allocationsInRange,
  exemptionThresholdAt,
  isExemptFromEvaluation,
  licenseNeededAt,
  mpeAt,
  searchAllocations,
  type Allocation,
  type AllocationService,
} from "./allocations";

const kHz = (v: number): number => Math.round(v * 1e3);
const MHz = (v: number): number => Math.round(v * 1e6);
const GHz = (v: number): number => Math.round(v * 1e9);

const byId = (id: string): Allocation => {
  const hit = ALLOCATIONS.find((a) => a.id === id);
  if (!hit) throw new Error(`no allocation with id ${id}`);
  return hit;
};

/* ------------------------------------------------------------------ */
/* Structural integrity                                                */
/* ------------------------------------------------------------------ */

describe("allocation table integrity", () => {
  it("has a useful number of entries", () => {
    expect(ALLOCATIONS.length).toBeGreaterThanOrEqual(250);
    expect(ALLOCATIONS.length).toBeLessThanOrEqual(450);
  });

  it("has no duplicate ids", () => {
    const ids = ALLOCATIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses kebab case ids", () => {
    for (const a of ALLOCATIONS) {
      expect(a.id, a.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("has lowHz strictly below highHz everywhere", () => {
    for (const a of ALLOCATIONS) {
      expect(a.lowHz, a.id).toBeLessThan(a.highHz);
    }
  });

  it("stores every edge as a finite integer number of hertz", () => {
    for (const a of ALLOCATIONS) {
      expect(Number.isInteger(a.lowHz), a.id).toBe(true);
      expect(Number.isInteger(a.highHz), a.id).toBe(true);
    }
  });

  it("stays inside the 9 kHz to 275 GHz coverage window", () => {
    for (const a of ALLOCATIONS) {
      expect(a.lowHz, a.id).toBeGreaterThanOrEqual(ALLOCATION_META.lowHz);
      expect(a.highHz, a.id).toBeLessThanOrEqual(ALLOCATION_META.highHz);
    }
  });

  it("only uses services from the exported union", () => {
    const known = new Set<string>(ALLOCATION_SERVICES);
    for (const a of ALLOCATIONS) {
      expect(known.has(a.service), `${a.id} uses ${a.service}`).toBe(true);
    }
  });

  it("uses every declared service at least once", () => {
    const used = new Set<AllocationService>(ALLOCATIONS.map((a) => a.service));
    for (const service of ALLOCATION_SERVICES) {
      expect(used.has(service), `${service} is declared but never used`).toBe(true);
    }
  });

  it("only uses known statuses, regions and user categories", () => {
    for (const a of ALLOCATIONS) {
      expect(["primary", "secondary", "unlicensed", "restricted"]).toContain(a.status);
      expect(["US", "ITU1", "ITU2", "ITU3", "global"]).toContain(a.region);
      for (const u of a.users ?? []) {
        expect(["federal", "non-federal"]).toContain(u);
      }
    }
  });

  it("gives every entry a label, a summary and a source", () => {
    for (const a of ALLOCATIONS) {
      expect(a.label.length, a.id).toBeGreaterThan(3);
      expect(a.summary.length, a.id).toBeGreaterThan(20);
      expect(a.source.length, a.id).toBeGreaterThan(5);
    }
  });

  it("is sorted by lower edge", () => {
    for (let i = 1; i < ALLOCATIONS.length; i += 1) {
      expect(ALLOCATIONS[i].lowHz).toBeGreaterThanOrEqual(ALLOCATIONS[i - 1].lowHz);
    }
  });

  it("uses no em dashes or en dashes anywhere in the dataset", () => {
    const blob = JSON.stringify([
      ALLOCATIONS,
      CHANNEL_TABLES,
      REFERENCED_CHANNEL_TABLES,
      ALLOCATION_META,
      RF_EXPOSURE.notes,
    ]);
    expect(blob).not.toMatch(/[–—]/);
  });
});

/* ------------------------------------------------------------------ */
/* Amateur band edges, checked against the ARRL band chart             */
/* ------------------------------------------------------------------ */

describe("amateur band edges", () => {
  const cases: [string, number, number][] = [
    ["amateur-2200m", kHz(135.7), kHz(137.8)],
    ["amateur-630m", kHz(472), kHz(479)],
    ["amateur-160m", kHz(1800), kHz(2000)],
    ["amateur-80m", kHz(3500), kHz(4000)],
    ["amateur-40m", kHz(7000), kHz(7300)],
    ["amateur-30m", kHz(10100), kHz(10150)],
    ["amateur-20m", kHz(14000), kHz(14350)],
    ["amateur-17m", kHz(18068), kHz(18168)],
    ["amateur-15m", kHz(21000), kHz(21450)],
    ["amateur-12m", kHz(24890), kHz(24990)],
    ["amateur-10m", MHz(28), MHz(29.7)],
    ["amateur-6m", MHz(50), MHz(54)],
    ["amateur-2m", MHz(144), MHz(148)],
    ["amateur-1p25m", MHz(222), MHz(225)],
    ["amateur-70cm", MHz(420), MHz(450)],
    ["amateur-33cm", MHz(902), MHz(928)],
    ["amateur-23cm", MHz(1240), MHz(1300)],
    ["amateur-3cm", GHz(10), GHz(10.5)],
  ];

  for (const [id, low, high] of cases) {
    it(`${id} spans the ARRL chart edges`, () => {
      const band = byId(id);
      expect(band.lowHz).toBe(low);
      expect(band.highHz).toBe(high);
      expect(band.service).toBe("amateur");
    });
  }

  it("carries license class sub bands as rules on the split HF bands", () => {
    for (const id of ["amateur-80m", "amateur-40m", "amateur-20m", "amateur-15m", "amateur-10m"]) {
      const rules = byId(id).rules ?? [];
      const joined = rules.join(" ");
      expect(joined, id).toMatch(/Extra/);
      expect(joined, id).toMatch(/General/);
      expect(joined, id).toMatch(/Technician/);
    }
  });

  it("records the 2026 change to the 60 m band", () => {
    const worldwide = byId("amateur-60m-band");
    expect(worldwide.lowHz).toBe(kHz(5351.5));
    expect(worldwide.highHz).toBe(kHz(5366.5));
    expect((worldwide.rules ?? []).join(" ")).toMatch(/9\.15 W/);
    const channels = byId("amateur-60m-channels");
    expect((channels.rules ?? []).join(" ")).toMatch(/5332/);
  });

  it("keeps the 9 cm band at its surviving lower half", () => {
    const band = byId("amateur-9cm");
    expect(band.lowHz).toBe(MHz(3300));
    expect(band.highHz).toBe(MHz(3450));
    expect(band.status).toBe("secondary");
  });
});

/* ------------------------------------------------------------------ */
/* allocationsAt and allocationsInRange                                */
/* ------------------------------------------------------------------ */

describe("allocationsAt", () => {
  it("finds the 2 m band at the national FM simplex calling frequency", () => {
    const hits = allocationsAt(MHz(146.52));
    expect(hits.map((a) => a.id)).toContain("amateur-2m");
  });

  it("sorts primary allocations before everything else", () => {
    const hits = allocationsAt(MHz(915));
    expect(hits.length).toBeGreaterThan(1);
    const statuses = hits.map((a) => a.status);
    const firstUnlicensed = statuses.indexOf("unlicensed");
    const lastPrimary = statuses.lastIndexOf("primary");
    if (firstUnlicensed !== -1 && lastPrimary !== -1) {
      expect(lastPrimary).toBeLessThan(firstUnlicensed);
    }
  });

  it("returns several co-primary rows at 915 MHz, which is expected", () => {
    const ids = allocationsAt(MHz(915)).map((a) => a.id);
    expect(ids).toContain("ism-915");
    expect(ids).toContain("amateur-33cm");
    expect(ids).toContain("rfid-uhf-902-928");
  });

  it("includes band edges on both sides", () => {
    expect(allocationsAt(MHz(144)).map((a) => a.id)).toContain("amateur-2m");
    expect(allocationsAt(MHz(148)).map((a) => a.id)).toContain("amateur-2m");
  });

  it("treats a US query as including ITU Region 2 and worldwide rows", () => {
    const ids = allocationsAt(MHz(3.95), "US").map((a) => a.id);
    expect(ids).toContain("amateur-80m");
    expect(ids).not.toContain("sw-75m-region1");
  });

  it("shows the Region 1 broadcast overlap when asked for Region 1", () => {
    const ids = allocationsAt(MHz(3.95), "ITU1").map((a) => a.id);
    expect(ids).toContain("sw-75m-region1");
    expect(ids).not.toContain("amateur-80m");
  });

  it("shows the 7 MHz regional clash", () => {
    expect(allocationsAt(MHz(7.25), "US").map((a) => a.id)).toContain("amateur-40m");
    expect(allocationsAt(MHz(7.25), "ITU1").map((a) => a.id)).toContain("sw-41m");
  });

  it("returns nothing for a non finite frequency", () => {
    expect(allocationsAt(Number.NaN)).toEqual([]);
  });

  it("finds the protected hydrogen line band", () => {
    const hits = allocationsAt(MHz(1420.405751));
    expect(hits.map((a) => a.id)).toContain("ra-1400-1427");
    expect(byId("ra-1400-1427").status).toBe("restricted");
  });
});

describe("allocationsInRange", () => {
  it("returns everything overlapping the 2.4 GHz band", () => {
    const ids = allocationsInRange(MHz(2400), MHz(2483.5)).map((a) => a.id);
    expect(ids).toContain("wifi-24ghz");
    expect(ids).toContain("bluetooth-24ghz");
    expect(ids).toContain("zigbee-24ghz");
    expect(ids).toContain("ism-2450");
  });

  it("accepts reversed arguments", () => {
    const a = allocationsInRange(MHz(88), MHz(108));
    const b = allocationsInRange(MHz(108), MHz(88));
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });

  it("comes back in frequency order", () => {
    const rows = allocationsInRange(MHz(400), MHz(1000));
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].lowHz).toBeGreaterThanOrEqual(rows[i - 1].lowHz);
    }
  });

  it("returns nothing for a non finite range", () => {
    expect(allocationsInRange(Number.NaN, 1)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

describe("searchAllocations", () => {
  it("resolves amateur band shorthand without spaces", () => {
    expect(searchAllocations("2m").map((a) => a.id)).toContain("amateur-2m");
    expect(searchAllocations("70cm").map((a) => a.id)).toContain("amateur-70cm");
    expect(searchAllocations("160m").map((a) => a.id)).toContain("amateur-160m");
  });

  it("resolves the same shorthand with a space", () => {
    expect(searchAllocations("70 cm").map((a) => a.id)).toContain("amateur-70cm");
    expect(searchAllocations("2 m").map((a) => a.id)).toContain("amateur-2m");
  });

  it("does not let 2m match 12m or 2200m", () => {
    const ids = searchAllocations("2m").map((a) => a.id);
    expect(ids).not.toContain("amateur-12m");
    expect(ids).not.toContain("amateur-2200m");
  });

  it("finds 3GPP band numbers", () => {
    expect(searchAllocations("band 41").map((a) => a.id)).toContain("cellular-brs-2500-2690");
    expect(searchAllocations("n77").map((a) => a.id)).toContain("cellular-cband-3700-3980");
    expect(searchAllocations("band 71").map((a) => a.id)).toContain("cellular-600-n71");
  });

  it("resolves a bare frequency to what is allocated there", () => {
    const ids = searchAllocations("6 GHz").map((a) => a.id);
    expect(ids).toContain("wifi-6ghz-5925-7125");
    const gps = searchAllocations("1575.42 MHz").map((a) => a.id);
    expect(gps).toContain("gps-l1");
  });

  it("matches service names and free text", () => {
    expect(searchAllocations("radio astronomy").length).toBeGreaterThan(5);
    expect(searchAllocations("hydrogen line").map((a) => a.id)).toContain("ra-1400-1427");
    expect(searchAllocations("microwave oven").map((a) => a.id)).toContain("ism-2450");
  });

  it("finds the consumer services people ask about by name", () => {
    expect(searchAllocations("lora").map((a) => a.id)).toContain("ism-915");
    expect(searchAllocations("bluetooth").map((a) => a.id)).toContain("bluetooth-24ghz");
    expect(searchAllocations("gmrs").map((a) => a.id)).toContain("frs-gmrs-462-467");
    expect(searchAllocations("adsb").length + searchAllocations("ads-b").length).toBeGreaterThan(0);
  });

  it("is case insensitive and trims whitespace", () => {
    expect(searchAllocations("  WWVB  ").map((a) => a.id)).toContain("wwvb-60k");
  });

  it("returns an empty array for an empty query", () => {
    expect(searchAllocations("")).toEqual([]);
    expect(searchAllocations("   ")).toEqual([]);
  });

  it("returns no duplicates", () => {
    const ids = searchAllocations("915 MHz").map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ------------------------------------------------------------------ */
/* licenseNeededAt                                                     */
/* ------------------------------------------------------------------ */

describe("licenseNeededAt", () => {
  it("says no license is needed on Wi-Fi channel 6", () => {
    const r = licenseNeededAt(MHz(2437));
    expect(r.unlicensed).toBe(true);
    expect(r.summary).toMatch(/Unlicensed/);
  });

  it("says an amateur license covers 146.52 MHz", () => {
    const r = licenseNeededAt(MHz(146.52));
    expect(r.amateur).toBe(true);
    expect(r.unlicensed).toBe(false);
    expect(r.summary).toMatch(/amateur radio license/i);
    expect(r.rules.join(" ")).toMatch(/Technician/);
  });

  it("flags federal only spectrum", () => {
    const r = licenseNeededAt(MHz(300));
    expect(r.federalOnly).toBe(true);
    expect(r.summary).toMatch(/federal government spectrum/i);
  });

  it("flags a passive band as restricted", () => {
    const r = licenseNeededAt(MHz(1420));
    expect(r.restricted).toBe(true);
    expect(r.summary).toMatch(/restricted/i);
  });

  it("degrades honestly where the curated table has no entry", () => {
    const r = licenseNeededAt(1);
    expect(r.services).toEqual([]);
    expect(r.summary).toMatch(/no curated entry/i);
  });
});

/* ------------------------------------------------------------------ */
/* Channel tables                                                      */
/* ------------------------------------------------------------------ */

const table = (id: string) => {
  const hit = CHANNEL_TABLES.find((t) => t.id === id);
  if (!hit) throw new Error(`no channel table ${id}`);
  return hit;
};

describe("channel tables", () => {
  it("has unique table ids and unique channel ids inside each table", () => {
    const ids = CHANNEL_TABLES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of CHANNEL_TABLES) {
      const channelIds = t.channels.map((c) => c.id);
      expect(new Set(channelIds).size, t.id).toBe(channelIds.length);
    }
  });

  it("gives every channel a finite positive center frequency", () => {
    for (const t of CHANNEL_TABLES) {
      for (const c of t.channels) {
        expect(Number.isFinite(c.centerHz), `${t.id} ${c.id}`).toBe(true);
        expect(c.centerHz, `${t.id} ${c.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("uses only declared services", () => {
    const known = new Set<string>(ALLOCATION_SERVICES);
    for (const t of CHANNEL_TABLES) {
      expect(known.has(t.service), t.id).toBe(true);
    }
  });

  it("builds the 802.15.4 grid from 2405 MHz on 5 MHz steps", () => {
    const zigbee = table("zigbee-802154");
    expect(zigbee.channels).toHaveLength(16);
    expect(zigbee.channels[0].id).toBe("11");
    expect(zigbee.channels[0].centerHz).toBe(MHz(2405));
    expect(zigbee.channels[15].id).toBe("26");
    expect(zigbee.channels[15].centerHz).toBe(MHz(2480));
  });

  it("gives Thread the same grid as Zigbee", () => {
    expect(table("thread-802154").channels.map((c) => c.centerHz)).toEqual(
      table("zigbee-802154").channels.map((c) => c.centerHz),
    );
  });

  it("builds the LoRaWAN US915 plan", () => {
    const up125 = table("lora-us915-uplink-125k");
    expect(up125.channels).toHaveLength(64);
    expect(up125.channels[0].centerHz).toBe(MHz(902.3));
    expect(up125.channels[63].centerHz).toBe(MHz(914.9));
    expect(up125.channels[0].widthHz).toBe(kHz(125));

    const up500 = table("lora-us915-uplink-500k");
    expect(up500.channels).toHaveLength(8);
    expect(up500.channels[0].id).toBe("64");
    expect(up500.channels[0].centerHz).toBe(MHz(903));
    expect(up500.channels[7].centerHz).toBe(MHz(914.2));

    const down = table("lora-us915-downlink");
    expect(down.channels).toHaveLength(8);
    expect(down.channels[0].centerHz).toBe(MHz(923.3));
    expect(down.channels[7].centerHz).toBe(MHz(927.5));
  });

  it("builds both Bluetooth grids and marks the BLE advertising channels", () => {
    const classic = table("bluetooth-classic");
    expect(classic.channels).toHaveLength(79);
    expect(classic.channels[0].centerHz).toBe(MHz(2402));
    expect(classic.channels[78].centerHz).toBe(MHz(2480));

    const le = table("bluetooth-le");
    expect(le.channels).toHaveLength(40);
    const advertising = le.channels.filter((c) => ["37", "38", "39"].includes(c.id));
    expect(advertising.map((c) => c.centerHz).sort((a, b) => a - b)).toEqual([
      MHz(2402),
      MHz(2426),
      MHz(2480),
    ]);
    for (const c of advertising) {
      expect(c.note).toMatch(/BLE numbering/);
    }
    const data0 = le.channels.find((c) => c.id === "0");
    expect(data0?.centerHz).toBe(MHz(2404));
    const data36 = le.channels.find((c) => c.id === "36");
    expect(data36?.centerHz).toBe(MHz(2478));
  });

  it("builds the five DECT 6.0 carriers inside the UPCS band", () => {
    const dect = table("dect-6");
    expect(dect.channels).toHaveLength(5);
    expect(dect.channels[0].centerHz).toBe(Math.round(1921.536e6));
    expect(dect.channels[4].centerHz).toBe(Math.round(1928.448e6));
    for (const c of dect.channels) {
      expect(c.centerHz).toBeGreaterThan(MHz(1920));
      expect(c.centerHz).toBeLessThan(MHz(1930));
    }
  });

  it("builds FRS and GMRS channels 1 to 22 with the right power notes", () => {
    const frs = table("frs-gmrs");
    expect(frs.channels).toHaveLength(22);
    expect(frs.channels[0].centerHz).toBe(MHz(462.5625));
    expect(frs.channels[7].centerHz).toBe(MHz(467.5625));
    expect(frs.channels[14].centerHz).toBe(MHz(462.55));
    expect(frs.channels[21].centerHz).toBe(MHz(462.725));
    expect(frs.channels[9].note).toMatch(/0\.5 W/);
    expect(frs.channels[20].note).toMatch(/50 W/);
  });

  it("offsets GMRS repeater inputs by 5 MHz", () => {
    const inputs = table("gmrs-repeater-inputs");
    const outputs = table("frs-gmrs").channels.slice(14);
    expect(inputs.channels).toHaveLength(8);
    inputs.channels.forEach((c, i) => {
      expect(c.centerHz - outputs[i].centerHz).toBe(MHz(5));
    });
  });

  it("builds the five MURS channels", () => {
    const murs = table("murs");
    expect(murs.channels.map((c) => c.centerHz)).toEqual([
      MHz(151.82),
      MHz(151.88),
      MHz(151.94),
      MHz(154.57),
      MHz(154.6),
    ]);
  });

  it("builds six 60 GHz WiGig channels 2.16 GHz apart", () => {
    const wigig = table("wigig-60ghz");
    expect(wigig.channels).toHaveLength(6);
    expect(wigig.channels[0].centerHz).toBe(GHz(58.32));
    expect(wigig.channels[5].centerHz).toBe(GHz(69.12));
    for (let i = 1; i < wigig.channels.length; i += 1) {
      expect(wigig.channels[i].centerHz - wigig.channels[i - 1].centerHz).toBe(
        Math.round(GHz(2.16)),
      );
    }
  });

  it("points at the channel tables that live in ./data instead of copying them", () => {
    const ids = REFERENCED_CHANNEL_TABLES.map((t) => t.id);
    expect(ids).toEqual(["wifi", "marine-vhf", "cb", "noaa", "fm", "tv"]);
    for (const t of REFERENCED_CHANNEL_TABLES) {
      expect(t.channelCount, t.id).toBeGreaterThan(0);
      expect(t.module).toBe("./data");
    }
    expect(REFERENCED_CHANNEL_TABLES.find((t) => t.id === "cb")?.channelCount).toBe(40);
    expect(REFERENCED_CHANNEL_TABLES.find((t) => t.id === "noaa")?.channelCount).toBe(7);
  });
});

/* ------------------------------------------------------------------ */
/* RF exposure                                                         */
/* ------------------------------------------------------------------ */

describe("mpeAt", () => {
  it("matches the CFR at 7.15 MHz for uncontrolled exposure", () => {
    // 47 CFR 1.1310(B), 1.34 to 30 MHz: E = 824/f, H = 2.19/f, S = 180/f^2.
    const r = mpeAt(MHz(7.15), "uncontrolled");
    expect(r).not.toBeNull();
    expect(r?.electricFieldVm).toBeCloseTo(824 / 7.15, 6);
    expect(r?.magneticFieldAm).toBeCloseTo(2.19 / 7.15, 6);
    expect(r?.powerDensityMwCm2).toBeCloseTo(180 / 7.15 ** 2, 6);
    expect(r?.planeWaveEquivalent).toBe(true);
    expect(r?.averagingMinutes).toBe(30);
  });

  it("matches the CFR at 7.15 MHz for controlled exposure", () => {
    const r = mpeAt(MHz(7.15), "controlled");
    expect(r?.electricFieldVm).toBeCloseTo(1842 / 7.15, 6);
    expect(r?.magneticFieldAm).toBeCloseTo(4.89 / 7.15, 6);
    expect(r?.powerDensityMwCm2).toBeCloseTo(900 / 7.15 ** 2, 6);
    expect(r?.averagingMinutes).toBe(6);
  });

  it("uses the flat VHF row at 146 MHz", () => {
    expect(mpeAt(MHz(146), "uncontrolled")?.powerDensityMwCm2).toBe(0.2);
    expect(mpeAt(MHz(146), "uncontrolled")?.electricFieldVm).toBe(27.5);
    expect(mpeAt(MHz(146), "controlled")?.powerDensityMwCm2).toBe(1);
    expect(mpeAt(MHz(146), "controlled")?.electricFieldVm).toBe(61.4);
  });

  it("uses f/1500 and f/300 in the 300 to 1500 MHz row", () => {
    expect(mpeAt(MHz(450), "uncontrolled")?.powerDensityMwCm2).toBeCloseTo(450 / 1500, 9);
    expect(mpeAt(MHz(450), "controlled")?.powerDensityMwCm2).toBeCloseTo(450 / 300, 9);
    expect(mpeAt(MHz(1200), "uncontrolled")?.powerDensityMwCm2).toBeCloseTo(0.8, 9);
  });

  it("flattens above 1500 MHz", () => {
    expect(mpeAt(GHz(2.4), "uncontrolled")?.powerDensityMwCm2).toBe(1);
    expect(mpeAt(GHz(2.4), "controlled")?.powerDensityMwCm2).toBe(5);
    expect(mpeAt(GHz(60), "uncontrolled")?.powerDensityMwCm2).toBe(1);
  });

  it("restates power density in watts per square meter", () => {
    expect(mpeAt(GHz(2.4), "uncontrolled")?.powerDensityWm2).toBe(10);
  });

  it("has no magnetic field limit above 300 MHz", () => {
    expect(mpeAt(MHz(450), "uncontrolled")?.magneticFieldAm).toBeNull();
    expect(mpeAt(MHz(146), "uncontrolled")?.magneticFieldAm).toBe(0.073);
  });

  it("defaults to uncontrolled exposure", () => {
    expect(mpeAt(MHz(146))?.environment).toBe("uncontrolled");
  });

  it("uses half open rows so a boundary lands in the upper row", () => {
    expect(mpeAt(MHz(30), "uncontrolled")?.lowHz).toBe(MHz(30));
    expect(mpeAt(MHz(300), "uncontrolled")?.lowHz).toBe(MHz(300));
  });

  it("returns null outside 300 kHz to 100 GHz, but resolves 100 GHz exactly", () => {
    expect(mpeAt(kHz(60))).toBeNull();
    expect(mpeAt(GHz(200))).toBeNull();
    expect(mpeAt(0)).toBeNull();
    expect(mpeAt(Number.NaN)).toBeNull();
    expect(mpeAt(GHz(100))).not.toBeNull();
  });

  it("exposes both tables through RF_EXPOSURE", () => {
    expect(RF_EXPOSURE.limits).toHaveLength(10);
    expect(RF_EXPOSURE.limits.filter((r) => r.environment === "controlled")).toHaveLength(5);
    expect(RF_EXPOSURE.exemptionThresholds).toHaveLength(5);
    expect(RF_EXPOSURE.source).toMatch(/1\.1310/);
  });
});

describe("exemptionThresholdAt", () => {
  it("matches 3450 R^2 / f^2 on HF", () => {
    // 47 CFR 1.1307(b)(3)(i)(C), 1.34 to 30 MHz. 5 m clears the lambda over
    // 2 pi floor of about 3.36 m at 14.2 MHz, so the distance is used as given.
    const r = exemptionThresholdAt(MHz(14.2), 5);
    expect(r?.clampedToMinimum).toBe(false);
    expect(r?.thresholdErpWatts).toBeCloseTo((3450 * 25) / 14.2 ** 2, 6);
    expect(r?.formula).toMatch(/3450/);
  });

  it("matches 3.83 R^2 on VHF and 0.0128 R^2 f on UHF", () => {
    expect(exemptionThresholdAt(MHz(146), 2)?.thresholdErpWatts).toBeCloseTo(3.83 * 4, 9);
    expect(exemptionThresholdAt(MHz(446), 2)?.thresholdErpWatts).toBeCloseTo(0.0128 * 4 * 446, 9);
  });

  it("matches 19.2 R^2 above 1.5 GHz", () => {
    expect(exemptionThresholdAt(GHz(2.4), 0.5)?.thresholdErpWatts).toBeCloseTo(19.2 * 0.25, 9);
  });

  it("raises a separation below lambda over 2 pi to the floor and says so", () => {
    const r = exemptionThresholdAt(MHz(7.15), 0.5);
    expect(r?.clampedToMinimum).toBe(true);
    expect(r?.minSeparationM).toBeCloseTo(299_792_458 / MHz(7.15) / (2 * Math.PI), 6);
    expect(r?.separationM).toBe(r?.minSeparationM);
  });

  it("leaves a generous separation alone", () => {
    const r = exemptionThresholdAt(MHz(146), 5);
    expect(r?.clampedToMinimum).toBe(false);
    expect(r?.separationM).toBe(5);
  });

  it("returns null for bad inputs and out of range frequencies", () => {
    expect(exemptionThresholdAt(kHz(60), 3)).toBeNull();
    expect(exemptionThresholdAt(MHz(146), 0)).toBeNull();
    expect(exemptionThresholdAt(Number.NaN, 3)).toBeNull();
  });
});

describe("isExemptFromEvaluation", () => {
  it("exempts anything at or below 1 mW at any distance", () => {
    expect(isExemptFromEvaluation(MHz(146), 0.001, 0.01)).toBe(true);
    expect(isExemptFromEvaluation(GHz(5.8), 0.0005, 0.001)).toBe(true);
  });

  it("exempts a 5 W handheld at 2 m on 2 m", () => {
    // Threshold is 3.83 * 4 = 15.32 W.
    expect(isExemptFromEvaluation(MHz(146), 5, 2)).toBe(true);
  });

  it("does not exempt a kilowatt HF station at 3 m on 20 m", () => {
    expect(isExemptFromEvaluation(MHz(14.2), 1000, 3)).toBe(false);
  });

  it("rejects a negative power", () => {
    expect(isExemptFromEvaluation(MHz(146), -1, 2)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

describe("ALLOCATION_META", () => {
  it("records the retrieval date and the true entry count", () => {
    expect(ALLOCATION_META.retrieved).toBe("2026-08-30");
    expect(ALLOCATION_META.entryCount).toBe(ALLOCATIONS.length);
    expect(ALLOCATION_META.channelTableCount).toBe(CHANNEL_TABLES.length);
  });

  it("covers 9 kHz to 275 GHz", () => {
    expect(ALLOCATION_META.lowHz).toBe(kHz(9));
    expect(ALLOCATION_META.highHz).toBe(GHz(275));
  });

  it("carries a disclaimer that names the governing table", () => {
    expect(ALLOCATION_META.disclaimer).toMatch(/47 CFR 2\.106/);
    expect(ALLOCATION_META.disclaimer).toMatch(/educational summary/i);
  });

  it("lists sources with https urls", () => {
    expect(ALLOCATION_META.sources.length).toBeGreaterThanOrEqual(8);
    for (const s of ALLOCATION_META.sources) {
      expect(s.url, s.id).toMatch(/^https:\/\//);
      expect(s.title.length, s.id).toBeGreaterThan(5);
    }
  });
});
