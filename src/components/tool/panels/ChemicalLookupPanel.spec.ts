import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolMeta } from "@/tools/types";
import { CHEM_INDEX_URL } from "@/tools/_generated/chem-index";
import { meta } from "@/tools/chemical-lookup/meta";
import ChemicalLookupPanel from "./ChemicalLookupPanel.vue";

/**
 * The panel is the only surface that fetches, so this is where the two tier
 * behavior is worth proving: the bundled tier answers before the index has
 * downloaded, the index download is reported and recoverable, and picking a
 * broad tier compound costs exactly one shard fetch.
 *
 * Every fetch is stubbed. Nothing here touches the real /data/chem/ files:
 * they are 13 MB, and the point of the test is the panel's wiring rather than
 * the dataset's contents, which src/tools/chemical-lookup/index.test.ts covers.
 */

/** [id, name, formula, cas, molarMass, flags] */
const INDEX_ROWS = [
  [2244, "Aspirin", "C9H8O4", "50-78-2", 180.16, 4 | 2 | 8],
  [962, "Fictitious broad compound", "H2O", "7732-18-5", 18.02, 8],
];

const SHARD_FOR_2244 = {
  "2244": {
    name: "Aspirin",
    formula: "C9H8O4",
    cas: "50-78-2",
    molarMass: 180.16,
    cid: 2244,
    wikipedia: "Aspirin",
    description: "Aspirin is a nonsteroidal anti-inflammatory drug.",
    isDrug: true,
    synonyms: ["Acetylsalicylic acid"],
    ghs: { pictograms: ["GHS07"], signal: "Warning", h: ["H302"], p: ["P264"] },
  },
};

function jsonResponse(body: unknown, bytes = 100): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k === "content-length" ? String(bytes) : null) },
    body: null,
    json: async () => JSON.parse(text) as unknown,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.location.hash = "";
  fetchMock = vi.fn(async (url: string) => {
    if (url === CHEM_INDEX_URL) return jsonResponse(INDEX_ROWS);
    if (url === "/data/chem/68.json") return jsonResponse(SHARD_FOR_2244);
    return { ok: false, status: 404 } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountPanel(toolMeta: ToolMeta = meta) {
  return mount(ChemicalLookupPanel, { props: { meta: toolMeta } });
}

describe("ChemicalLookupPanel", () => {
  it("fetches the compound index exactly once on mount", async () => {
    mountPanel();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(CHEM_INDEX_URL);
  });

  it("opens the example compound from the bundled tier with no extra fetch", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    // "acetone" is example one, and it is a bundled row, so the sheet is on
    // screen without a shard ever being requested.
    expect(wrapper.text()).toContain("Acetone");
    expect(wrapper.text()).toContain("Example input");
    expect(wrapper.text()).toContain("C3H6O");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the reference only disclaimer and the data provenance", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain("Reference only");
    expect(wrapper.text()).toContain("25,248 compounds");
    expect(wrapper.text()).toContain("CC BY-SA 4.0");
  });

  it("keeps the bundled tier searchable when the index download fails", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.findComponent({ name: "ErrorBanner" }).exists()).toBe(true);
    expect(wrapper.text()).toContain("still searchable");
    // The example still resolved, from the bundled rows.
    expect(wrapper.text()).toContain("Acetone");
  });

  it("retries the index download from the error banner", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    const wrapper = mountPanel();
    await flushPromises();
    const retry = wrapper.findAll("button").find((b) => b.text() === "Retry");
    expect(retry).toBeDefined();
    await retry!.trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(CHEM_INDEX_URL);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("opens a broad tier compound from a shared link with one shard fetch", async () => {
    window.location.hash = "#i=aspirin&id=2244";
    const wrapper = mountPanel();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/data/chem/68.json");
    expect(wrapper.text()).toContain("Aspirin is a nonsteroidal anti-inflammatory drug.");
    expect(wrapper.text()).toContain("Text from Wikipedia: Aspirin, CC BY-SA 4.0");
    expect(wrapper.text()).toContain("Drug or medication");
    // No example chip on a shared link, and no prefill fighting the fragment.
    expect(wrapper.text()).not.toContain("Example input");
  });

  it("restores the filter chips from a shared link", async () => {
    window.location.hash = "#i=acetone&filters=nfpa,ghs";
    const wrapper = mountPanel();
    await flushPromises();
    const pressed = wrapper
      .findAll("button")
      .filter((b) => b.attributes("aria-pressed") === "true")
      .map((b) => b.text());
    expect(pressed).toContain("Has NFPA rating");
    expect(pressed).toContain("Has GHS classification");
    expect(pressed).not.toContain("Drugs");
  });

  it("writes the query and the opened compound into the fragment", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.get("#chem-search").setValue("sodium chloride");
    await vi.waitFor(() => {
      expect(window.location.hash).toContain("i=sodium+chloride");
    });
    expect(window.location.hash).toContain("id=");
  });

  it("moves the highlight with the arrow keys and opens with Enter", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const input = wrapper.get("#chem-search");
    await input.setValue("acetone");
    await vi.waitFor(() => {
      expect(wrapper.findAll("[data-active]").length).toBeGreaterThan(1);
    });
    await input.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    const active = wrapper.findAll('[data-active="true"]');
    expect(active).toHaveLength(1);
    const highlighted = active[0]!.text();
    expect(wrapper.get("h2").text()).toBe("Acetone");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    const opened = wrapper.get("h2").text();
    expect(opened).not.toBe("Acetone");
    expect(highlighted.startsWith(opened)).toBe(true);
  });

  it("offers a designed empty state when nothing matches", async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.get("#chem-search").setValue("zzzzzznotacompound");
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("Nothing matches that");
    });
  });
});
