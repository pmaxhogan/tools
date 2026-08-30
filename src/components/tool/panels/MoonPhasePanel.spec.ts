import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meta } from "@/tools/moon-phase-calculator/meta";
import MoonPhasePanel from "./MoonPhasePanel.vue";

/**
 * The phase arithmetic is covered in src/tools/moon-phase-calculator. What is
 * worth proving here is the wiring the panel owns: that the drawn disc really
 * comes from the tool's terminator path rather than a picture, that the month
 * strip has one entry per day of the month being shown, that the hemisphere
 * toggle changes the drawing, and that playback is not offered at all to a
 * reader who has asked for reduced motion.
 */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** matchMedia does not exist in happy-dom, so every test installs one. */
function stubMatchMedia(reducedMotion: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === REDUCED_MOTION ? reducedMotion : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  window.location.hash = "";
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 7, 30, 18, 45));
  stubMatchMedia(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountPanel() {
  const wrapper = mount(MoonPhasePanel, { props: { meta } });
  await flushPromises();
  return wrapper;
}

describe("MoonPhasePanel", () => {
  it("draws a real terminator path rather than a stock image", async () => {
    const wrapper = await mountPanel();
    const path = wrapper.find('svg[role="img"] path');
    expect(path.exists()).toBe(true);
    // Two arcs: the limb, then the terminator ellipse back to the top.
    expect(path.attributes("d")).toMatch(/^M50 4A46 46 0 0 [01] 50 96A[\d.]+ 46 0 0 [01] 50 4Z$/);
    expect(wrapper.find("img").exists()).toBe(false);
  });

  it("names the phase and the illumination in the accessible label", async () => {
    const wrapper = await mountPanel();
    const label = wrapper.find('svg[role="img"]').attributes("aria-label") ?? "";
    expect(label).toContain("2026-08-30");
    expect(label).toMatch(/percent lit/);
    expect(label).toContain("northern hemisphere");
  });

  it("puts one small disc in the strip for every day of the month", async () => {
    const wrapper = await mountPanel();
    // August has 31 days.
    expect(wrapper.findAll("ul li button")).toHaveLength(31);
  });

  it("redraws the strip and the disc when the hemisphere changes", async () => {
    const wrapper = await mountPanel();
    const before = wrapper.find('svg[role="img"] path').attributes("d");
    const buttons = wrapper.findAll("button");
    const southern = buttons.find((b) => b.text().includes("Southern"));
    expect(southern).toBeDefined();
    await southern?.trigger("click");
    await flushPromises();
    const after = wrapper.find('svg[role="img"] path').attributes("d");
    expect(after).not.toBe(before);
    expect(wrapper.find('svg[role="img"]').attributes("aria-label")).toContain(
      "southern hemisphere",
    );
  });

  it("moves the drawn day when a day in the strip is picked", async () => {
    const wrapper = await mountPanel();
    const first = wrapper.findAll("ul li button")[0];
    await first.trigger("click");
    await flushPromises();
    expect(wrapper.find('svg[role="img"]').attributes("aria-label")).toContain("2026-08-01");
  });

  it("shows the tool's own result table once it has run", async () => {
    const wrapper = await mountPanel();
    vi.advanceTimersByTime(200);
    await flushPromises();
    expect(wrapper.text()).toContain("Full result");
    expect(wrapper.text()).toContain("Next full moon");
  });

  it("offers playback normally", async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('button[aria-label="Play through the month"]').exists()).toBe(true);
  });

  it("offers no playback at all under prefers-reduced-motion", async () => {
    stubMatchMedia(true);
    const wrapper = await mountPanel();
    expect(wrapper.find('button[aria-label="Play through the month"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Playback is off");
  });
});
