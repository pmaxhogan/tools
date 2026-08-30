import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolMeta } from "@/tools/types";

/**
 * The engine module is mocked, but `MediaJobError` is kept real: MediaShell
 * narrows errors with `instanceof`, so a `vi.fn()` stand in would silently
 * route every failure through the generic branch.
 */
const engine = vi.hoisted(() => ({
  isMediaSupported: vi.fn(() => true),
  isEngineReady: vi.fn(() => false),
  getFFmpeg: vi.fn(async () => ({})),
  runJob: vi.fn(async () => []),
  terminateEngine: vi.fn(),
}));

const connection = vi.hoisted(() => ({
  shouldAutoDownload: vi.fn(() => false),
  isMetered: vi.fn(() => true),
}));

vi.mock("@/lib/ffmpeg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ffmpeg")>();
  return { ...actual, ...engine };
});

vi.mock("@/lib/connection", () => ({
  ...connection,
  onConnectionChange: () => () => {},
}));

vi.mock("@/lib/download", () => ({ downloadUrl: vi.fn(), downloadBlob: vi.fn() }));

import MediaShell from "./MediaShell.vue";

const meta = { name: "Video converter", slug: "video-converter" } as unknown as ToolMeta;

const provide = { toolSlug: "video-converter", toolName: "Video converter" };

const PANEL_HINT =
  "Drop a video here or pick one, then trim it and choose a palette. Everything runs in this tab: your files and inputs never leave your device.";

function fileNamed(name: string, type = "video/mp4"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

/** happy-dom's DataTransfer is not worth fighting; hand the handler a shape. */
function dropPayload(files: File[]) {
  return { dataTransfer: { files } };
}

/**
 * The capability check runs in `onMounted`, so the first paint always shows the
 * gate. Every test waits a tick past mount to see the panel the browser gets.
 */
async function mountShell(props: Record<string, unknown> = {}) {
  const wrapper = mount(MediaShell, {
    props: {
      meta,
      accept: "video/*",
      buildArgs: () => ({ args: ["-i", "in.mp4", "out.gif"], outputs: ["out.gif"] }),
      ...props,
    },
    global: { provide },
  });
  await wrapper.vm.$nextTick();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  engine.isMediaSupported.mockReturnValue(true);
  engine.isEngineReady.mockReturnValue(false);
  connection.shouldAutoDownload.mockReturnValue(false);
  connection.isMetered.mockReturnValue(true);
});

describe("MediaShell", () => {
  it("explains an unsupported browser through the shared banner", async () => {
    engine.isMediaSupported.mockReturnValue(false);
    const wrapper = await mountShell();
    const banner = wrapper.get('[role="status"]');
    expect(banner.text()).toContain("Starting the media engine.");
    expect(banner.text()).toContain("Video converter runs ffmpeg inside this tab");
    // The drop zone is not rendered at all while the browser cannot run a job.
    expect(wrapper.find('[role="button"]').exists()).toBe(false);
  });

  it("renders the panel hint as the drop zone headline plus second line", async () => {
    const wrapper = await mountShell({ hint: PANEL_HINT });
    const zone = wrapper.get('[role="button"]');
    expect(zone.text()).toContain(
      "Drop a video here or pick one, then trim it and choose a palette",
    );
    expect(zone.text()).toContain(
      "Everything runs in this tab: your files and inputs never leave your device.",
    );
    // Every word of the panel's hint survives the split.
    const headline = zone.get("p").text();
    const rest = PANEL_HINT.slice(headline.length + 1);
    expect(`${headline} ${rest}`).toBe(PANEL_HINT);
  });

  it("keeps the standing privacy line in the default hint", async () => {
    const zone = (await mountShell()).get('[role="button"]');
    expect(zone.text()).toContain("Drop a file here or pick one to get started.");
    expect(zone.text()).toContain("your files and inputs never leave your device.");
  });

  it("takes a dropped file, reports it, and shows a chip with its size", async () => {
    const wrapper = await mountShell();
    await wrapper.get('[role="button"]').trigger("drop", dropPayload([fileNamed("clip.mp4")]));

    expect(wrapper.emitted("files")?.[0]?.[0]).toEqual([
      { name: "clip.mp4", size: 4, file: expect.any(File) },
    ]);
    const chips = wrapper.get('[data-testid="media-files"]');
    expect(chips.text()).toContain("clip.mp4");
    // The zone stays a zone, so the same file can be replaced by dropping again.
    expect(wrapper.find('[role="button"]').exists()).toBe(true);
  });

  it("removes a chip and reports the shorter list", async () => {
    const wrapper = await mountShell({ multiple: true });
    await wrapper
      .get('[role="button"]')
      .trigger("drop", dropPayload([fileNamed("a.mp4"), fileNamed("b.mp4")]));
    await wrapper.get('button[aria-label="Remove file"]').trigger("click");

    const emitted = wrapper.emitted("files");
    expect(emitted?.[1]?.[0]).toEqual([{ name: "b.mp4", size: 4, file: expect.any(File) }]);
  });

  it("offers the pick affordance inside the zone", async () => {
    const wrapper = await mountShell();
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    const pick = wrapper.findAll("button").find((button) => button.text().startsWith("Open file"));
    expect(pick).toBeDefined();
    await pick?.trigger("click");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("holds the engine download behind a click on a metered connection", async () => {
    const wrapper = await mountShell();
    expect(engine.getFFmpeg).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Your connection looks metered, so the engine waits for you");
    expect(wrapper.text()).toContain("Load media engine (about 31 MB)");
    expect(wrapper.text()).toContain("your files and inputs never leave your device");
  });

  it("reports engine download bytes through the shared bar", async () => {
    let report: ((loaded: number, total: number) => void) | undefined;
    engine.getFFmpeg.mockImplementation((async (
      _core: unknown,
      onDownload: (loaded: number, total: number) => void,
    ) => {
      report = onDownload;
      return new Promise(() => {});
    }) as unknown as typeof engine.getFFmpeg);

    const wrapper = await mountShell();
    const start = wrapper
      .findAll("button")
      .find((button) => button.text().startsWith("Load media engine"));
    await start?.trigger("click");
    report?.(12_897_484, 32_505_856);
    await wrapper.vm.$nextTick();

    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes("aria-label")).toBe("Downloading media engine (12.3 of 31.0 MB)");
    expect(bar.attributes("aria-valuenow")).toBe("40");
    expect(wrapper.text()).toContain("Downloading media engine");
    expect(wrapper.text()).toContain("12.3 of 31.0 MB");
  });

  it("refuses a build error through the shared error banner", async () => {
    const wrapper = await mountShell({
      buildArgs: () => ({ error: "Pick an end time after the start time.", fix: "Raise the end." }),
    });
    await wrapper.get('[role="button"]').trigger("drop", dropPayload([fileNamed("clip.mp4")]));
    const run = wrapper.findAll("button").find((button) => button.text() === "Run");
    await run?.trigger("click");

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain("Pick an end time after the start time.");
    expect(alert.text()).toContain("Raise the end.");
    expect(engine.runJob).not.toHaveBeenCalled();
  });
});
