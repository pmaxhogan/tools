import { describe, expect, it } from "vitest";
import {
  allocationInterpretation,
  findPlanChannels,
  parsePlanQuery,
  planChannelInterpretation,
  unifiedSearch,
} from "./lookup";
import { ALLOCATIONS, CHANNEL_TABLES } from "./allocations";

describe("parsePlanQuery", () => {
  it("recognizes plan aliases with and without a channel", () => {
    expect(parsePlanQuery("zigbee 15")).toEqual({ tableId: "zigbee-802154", channelId: "15" });
    expect(parsePlanQuery("zigbee channel 26")).toEqual({
      tableId: "zigbee-802154",
      channelId: "26",
    });
    expect(parsePlanQuery("ble 37")).toEqual({ tableId: "bluetooth-le", channelId: "37" });
    expect(parsePlanQuery("bluetooth 39")).toEqual({
      tableId: "bluetooth-classic",
      channelId: "39",
    });
    expect(parsePlanQuery("lora downlink 3")).toEqual({
      tableId: "lora-us915-downlink",
      channelId: "3",
    });
    expect(parsePlanQuery("GMRS 19")).toEqual({ tableId: "frs-gmrs", channelId: "19" });
    expect(parsePlanQuery("murs")).toEqual({ tableId: "murs", channelId: undefined });
    expect(parsePlanQuery("wigig ch 2")).toEqual({ tableId: "wigig-60ghz", channelId: "2" });
  });

  it("ignores aliases buried inside other words and unrelated text", () => {
    expect(parsePlanQuery("obtain 5")).toBeNull();
    expect(parsePlanQuery("2.4 GHz")).toBeNull();
    expect(parsePlanQuery("")).toBeNull();
  });
});

describe("findPlanChannels", () => {
  it("returns one channel by id or the whole plan", () => {
    const one = findPlanChannels({ tableId: "zigbee-802154", channelId: "15" })!;
    expect(one.channels).toHaveLength(1);
    expect(one.channels[0]!.centerHz).toBe(2425e6);
    const all = findPlanChannels({ tableId: "zigbee-802154" })!;
    expect(all.channels).toHaveLength(16);
    expect(findPlanChannels({ tableId: "nope" })).toBeNull();
    expect(findPlanChannels({ tableId: "zigbee-802154", channelId: "99" })!.channels).toEqual([]);
  });

  it("builds a candidate with a range when the channel has a width", () => {
    const table = CHANNEL_TABLES.find((t) => t.id === "zigbee-802154")!;
    const ch = table.channels[0]!;
    const it = planChannelInterpretation(table, ch);
    expect(it.kind).toBe("plan");
    expect(it.tableId).toBe(table.id);
    expect(it.frequencyHz).toBe(ch.centerHz);
    expect(it.label).toContain("channel 11");
    if (ch.widthHz) expect(it.rangeHz![1]! - it.rangeHz![0]!).toBeCloseTo(ch.widthHz, 0);
  });
});

describe("allocationInterpretation", () => {
  it("centers on the geometric mean and carries the id", () => {
    const a = ALLOCATIONS.find((x) => x.id === "amateur-2m")!;
    const it = allocationInterpretation(a);
    expect(it.kind).toBe("allocation");
    expect(it.allocationId).toBe("amateur-2m");
    expect(it.frequencyHz).toBeCloseTo(Math.sqrt(144e6 * 148e6), 0);
    expect(it.rangeHz).toEqual([144e6, 148e6]);
    expect(it.detail).toContain("144 MHz to 148 MHz");
  });
});

describe("unifiedSearch", () => {
  it("leads with the numeric reading, then channels, then allocations", () => {
    const hits = unifiedSearch("915 MHz");
    expect(hits[0]!.kind).toBe("frequency");
    expect(hits.some((h) => h.kind === "allocation")).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(12);
  });

  it("finds plan channels and physical bands for the same word", () => {
    const hits = unifiedSearch("zigbee 15");
    expect(hits.some((h) => h.kind === "plan" && h.label.includes("channel 15"))).toBe(true);
  });

  it("returns allocations for a band name and respects the region", () => {
    const us = unifiedSearch("2m");
    expect(us.some((h) => h.allocationId === "amateur-2m")).toBe(true);
    const itu1 = unifiedSearch("2m", "ITU1");
    expect(itu1.some((h) => h.allocationId === "amateur-2m")).toBe(false);
  });

  it("still returns the old candidates and handles empty input", () => {
    expect(unifiedSearch("")).toEqual([]);
    const wifi = unifiedSearch("wifi channel 6");
    expect(wifi.some((h) => h.kind === "wifi")).toBe(true);
    const band = unifiedSearch("vhf");
    expect(band.some((h) => h.kind === "band")).toBe(true);
  });

  it("never duplicates an id", () => {
    const hits = unifiedSearch("amateur");
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });
});
