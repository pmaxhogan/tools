import { describe, expect, it } from "vitest";
import { ALLOCATIONS, type Allocation } from "./allocations";
import {
  REGION_LABELS,
  SERVICE_LABELS,
  STATUS_HELP,
  STATUS_ORDER,
  allocationsForRegion,
  allocationsToCsv,
  allocationsToJson,
  describeAllocation,
  formatRange,
  packAllocations,
  regionIncludes,
  sourceLinkFor,
  visibleAllocations,
} from "./allocation-view";
import { ALLOCATION_SERVICES } from "./allocations";

const DASH = /[–—]/;

describe("vocabulary", () => {
  it("labels every service and status", () => {
    for (const s of ALLOCATION_SERVICES) {
      expect(SERVICE_LABELS[s]).toBeTruthy();
      expect(SERVICE_LABELS[s]).not.toMatch(DASH);
    }
    for (const s of STATUS_ORDER) expect(STATUS_HELP[s]).not.toMatch(DASH);
    expect(Object.keys(REGION_LABELS)).toHaveLength(5);
  });

  it("formats a range with both edges", () => {
    expect(formatRange(144e6, 148e6)).toBe("144 MHz to 148 MHz");
  });
});

describe("regionIncludes", () => {
  it("folds Region 2 and worldwide rows into the US view only", () => {
    expect(regionIncludes("global", "ITU1")).toBe(true);
    expect(regionIncludes("ITU2", "US")).toBe(true);
    expect(regionIncludes("US", "ITU2")).toBe(false);
    expect(regionIncludes("ITU1", "US")).toBe(false);
    expect(regionIncludes("US", "global")).toBe(false);
  });

  it("filters the table by region", () => {
    const us = allocationsForRegion("US");
    const global = allocationsForRegion("global");
    expect(us.length).toBeGreaterThan(global.length);
    expect(global.every((a) => a.region === "global")).toBe(true);
  });
});

describe("packAllocations", () => {
  const lanes = packAllocations(allocationsForRegion("US"));

  it("places every row exactly once", () => {
    expect(lanes.items).toHaveLength(allocationsForRegion("US").length);
    expect(new Set(lanes.items.map((p) => p.allocation.id)).size).toBe(lanes.items.length);
  });

  it("never overlaps two rows in one lane", () => {
    const byLane = new Map<number, Allocation[]>();
    for (const p of lanes.items) {
      const list = byLane.get(p.lane) ?? [];
      list.push(p.allocation);
      byLane.set(p.lane, list);
    }
    for (const list of byLane.values()) {
      list.sort((a, b) => a.lowHz - b.lowHz);
      for (let i = 1; i < list.length; i++) {
        expect(list[i]!.lowHz).toBeGreaterThanOrEqual(list[i - 1]!.highHz);
      }
    }
  });

  it("groups lanes by status in display order", () => {
    expect(lanes.laneStatus).toHaveLength(lanes.laneCount);
    const order = lanes.laneStatus.map((s) => STATUS_ORDER.indexOf(s));
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]!);
    for (const p of lanes.items) expect(lanes.laneStatus[p.lane]).toBe(p.allocation.status);
  });

  it("keeps the lane count sane for the full table", () => {
    expect(lanes.laneCount).toBeGreaterThan(4);
    expect(lanes.laneCount).toBeLessThan(40);
  });

  it("stores normalized positions in axis order", () => {
    for (const p of lanes.items) {
      expect(p.posLow).toBeLessThan(p.posHigh);
      expect(p.posLow).toBeGreaterThanOrEqual(0);
      expect(p.posHigh).toBeLessThanOrEqual(1);
    }
  });
});

describe("visibleAllocations", () => {
  it("culls rows outside the window and keeps partial overlaps", () => {
    const lanes = packAllocations(ALLOCATIONS);
    const all = visibleAllocations(lanes, 0, 1);
    expect(all).toHaveLength(lanes.items.length);
    const two = lanes.items.find((p) => p.allocation.id === "amateur-2m")!;
    const mid = (two.posLow + two.posHigh) / 2;
    const narrow = visibleAllocations(lanes, mid, mid + 1e-6);
    expect(narrow.some((p) => p.allocation.id === "amateur-2m")).toBe(true);
    expect(narrow.length).toBeLessThan(all.length);
    expect(visibleAllocations(lanes, mid + 1e-6, mid)).toEqual(narrow);
  });
});

describe("exports", () => {
  const sample: Allocation[] = [
    {
      id: "t-1",
      lowHz: 1e6,
      highHz: 2e6,
      service: "amateur",
      status: "primary",
      region: "US",
      label: 'Test "quoted", band',
      summary: "Line one\nline two",
      rules: ["a", "b"],
      source: "unit test",
    },
  ];

  it("quotes CSV cells that need it and writes a header", () => {
    const csv = allocationsToCsv(sample);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "id,label,service,status,region,low_hz,high_hz,summary,rules,notes,source",
    );
    expect(csv).toContain('"Test ""quoted"", band"');
    expect(csv).toContain('"Line one\nline two"');
    expect(csv).toContain("a | b");
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("round trips JSON", () => {
    expect(JSON.parse(allocationsToJson(sample))).toEqual(sample);
  });

  it("describes an allocation with its range, vocabulary and source", () => {
    const text = describeAllocation(sample[0]!);
    expect(text).toContain("1 MHz to 2 MHz");
    expect(text).toContain("Amateur radio, primary, United States");
    expect(text).toContain("Source: unit test");
  });
});

describe("sourceLinkFor", () => {
  it("maps citations to the meta source list with a sensible fallback", () => {
    expect(sourceLinkFor("47 CFR Part 97, section 97.301").url).toContain("part-97");
    expect(sourceLinkFor("47 CFR 1.1310 Table 1").url).toContain("1.1310");
    expect(sourceLinkFor("LoRa Alliance RP002").url).toContain("lora-alliance");
    expect(sourceLinkFor("ITU Radio Regulations Article 5").url).toContain("itu.int");
    expect(sourceLinkFor("some unknown text").title).toContain("FCC Table");
    for (const a of ALLOCATIONS.slice(0, 50)) expect(sourceLinkFor(a.source).url).toMatch(/^https:/);
  });
});
