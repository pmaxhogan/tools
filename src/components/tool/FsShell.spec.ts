import { flushPromises, mount } from "@vue/test-utils";
import { h } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolMeta } from "@/tools/types";
import type { DirectoryHandleWrapper, FsScan, WriteOp, WritePlan } from "@/lib/fs-access";

/**
 * The File System Access layer is mocked wholesale; happy-dom has no picker and
 * no handles. Everything else in the module (the pure path helpers) is kept, so
 * a future assertion against them still works.
 */
const fs = vi.hoisted(() => ({
  isFsAccessSupported: vi.fn(() => true),
  pickDirectory: vi.fn(),
  scanDirectory: vi.fn(),
  planWrites: vi.fn(),
  executeWriteOps: vi.fn(),
}));

vi.mock("@/lib/fs-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fs-access")>();
  return { ...actual, ...fs };
});

vi.mock("@/lib/download", () => ({ downloadBlob: vi.fn(), downloadUrl: vi.fn() }));

import FsShell from "./FsShell.vue";

const meta = { name: "Bulk rename", slug: "bulk-rename" } as unknown as ToolMeta;

const handle = { name: "photos" } as unknown as DirectoryHandleWrapper;

const scan: FsScan = {
  entries: [],
  directories: ["raw"],
  fileCount: 12,
  totalBytes: 2048,
  truncated: false,
  depthCapped: false,
} as unknown as FsScan;

const ops: WriteOp[] = [
  { op: "rename", from: "a.jpg", to: "01.jpg" },
  { op: "rename", from: "b.jpg", to: "02.jpg" },
];

function planFor(conflicts: WritePlan["conflicts"] = []): WritePlan {
  return {
    ops,
    conflicts,
    irreversible: [],
    undoManifest: { tool: "bulk-rename", root: "photos", notes: [], ops: [] },
  } as unknown as WritePlan;
}

/** A controls slot with one button, which is how a real panel starts a batch. */
const controls = (slotProps: { applyWrites: (ops: WriteOp[]) => Promise<unknown> }) =>
  h("button", { type: "button", onClick: () => void slotProps.applyWrites(ops) }, "Apply renames");

async function mountShell(props: Record<string, unknown> = {}) {
  const wrapper = mount(FsShell, {
    props: { meta, mode: "readwrite", ...props },
    slots: { controls: controls as never },
    global: { provide: { toolSlug: "bulk-rename", toolName: "Bulk rename" } },
  });
  await wrapper.vm.$nextTick();
  return wrapper;
}

/** Drive the panel to the state a tool sees: a folder picked and scanned. */
async function withFolder(props: Record<string, unknown> = {}) {
  const wrapper = await mountShell(props);
  await wrapper
    .findAll("button")
    .find((button) => button.text() === "Choose a folder")
    ?.trigger("click");
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.isFsAccessSupported.mockReturnValue(true);
  fs.pickDirectory.mockResolvedValue(handle);
  fs.scanDirectory.mockResolvedValue(scan);
  fs.planWrites.mockImplementation(() => planFor());
  fs.executeWriteOps.mockResolvedValue({ done: ops, failed: [], stopped: false, dryRun: false });
});

describe("FsShell", () => {
  it("explains an unsupported browser through the shared banner", async () => {
    fs.isFsAccessSupported.mockReturnValue(false);
    const wrapper = await mountShell();
    const banner = wrapper.get('[role="status"]');
    expect(banner.text()).toContain("Checking folder access.");
    expect(banner.text()).toContain("which needs the File System Access API");
  });

  it("keeps the write warning wording exactly", async () => {
    const wrapper = await mountShell();
    expect(wrapper.text()).toContain(
      "This tool can change the folder you pick: it renames, writes and deletes files in place. Nothing happens until you review the exact list of changes and confirm, and you can download an undo file first.",
    );
  });

  it("drops the write warning for a read only tool", async () => {
    const wrapper = await mountShell({ mode: "read" });
    expect(wrapper.text()).not.toContain("This tool can change the folder you pick");
  });

  it("shows a designed empty state before a folder is chosen", async () => {
    const wrapper = await mountShell();
    expect(wrapper.text()).toContain("Pick a folder to get started.");
    expect(wrapper.text()).toContain(
      "Nothing is uploaded and nothing is copied anywhere: the folder is opened in place, in this tab.",
    );
    expect(wrapper.text()).toContain("your files and inputs never leave your device");
  });

  it("reports scan progress on the shared bar", async () => {
    let report: ((count: number) => void) | undefined;
    fs.scanDirectory.mockImplementation((async (
      _ref: unknown,
      opts: { onProgress?: (count: number) => void },
    ) => {
      report = opts.onProgress;
      return new Promise(() => {});
    }) as never);

    const wrapper = await withFolder();
    report?.(1234);
    await wrapper.vm.$nextTick();

    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes("aria-label")).toBe("Reading folder…");
    // A walk has no total, so the bar stays indeterminate.
    expect(bar.attributes("aria-valuenow")).toBeUndefined();
    expect(wrapper.text()).toContain("1,234 items");
    expect(wrapper.text()).toContain("Stop");
  });

  it("summarizes the folder and hands the controls slot the scan", async () => {
    const wrapper = await withFolder();
    expect(fs.pickDirectory).toHaveBeenCalledWith("readwrite");
    expect(wrapper.emitted("picked")?.[0]?.[0]).toBe(handle);
    expect(wrapper.emitted("scan")?.[0]?.[0]).toBe(scan);
    expect(wrapper.text()).toContain("photos");
    expect(wrapper.text()).toContain("12 files");
    expect(wrapper.text()).toContain("1 folder");
    expect(wrapper.text()).toContain("Apply renames");
  });

  it("routes a batch through the review panel and writes only on confirm", async () => {
    const wrapper = await withFolder();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Apply renames")
      ?.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Review 2 changes to photos");
    expect(wrapper.text()).toContain("2 renames.");
    expect(wrapper.get("pre").element.textContent).toContain("Rename  a.jpg  ->  01.jpg");
    expect(wrapper.text()).toContain(
      "The undo file lists the changes that put this folder back the way it was. Download it before you apply anything: it is the only record, and it stays on your device.",
    );
    expect(fs.executeWriteOps).not.toHaveBeenCalled();

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Confirm and apply")
      ?.trigger("click");
    await flushPromises();

    expect(fs.executeWriteOps).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("2 changes applied.");
    // The folder is not what it was, so the shell walks it again.
    expect(fs.scanDirectory).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when the review is canceled", async () => {
    const wrapper = await withFolder();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Apply renames")
      ?.trigger("click");
    await flushPromises();

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Cancel")
      ?.trigger("click");
    await flushPromises();

    expect(fs.executeWriteOps).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("Review 2 changes");
  });

  it("calls out skipped changes in the review panel", async () => {
    fs.planWrites.mockImplementation(() =>
      planFor([{ index: 0, reason: "a.jpg is already called 01.jpg" }] as WritePlan["conflicts"]),
    );
    const wrapper = await withFolder();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Apply renames")
      ?.trigger("click");
    await flushPromises();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain("1 change will be skipped.");
    expect(alert.text()).toContain("a.jpg is already called 01.jpg");
  });

  it("reports write progress on the shared bar", async () => {
    let report: ((done: number, total: number) => void) | undefined;
    fs.executeWriteOps.mockImplementation((async (
      _dir: unknown,
      _plan: unknown,
      opts: { onProgress?: (done: number, total: number) => void },
    ) => {
      report = opts.onProgress;
      return new Promise(() => {});
    }) as never);

    const wrapper = await withFolder();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Apply renames")
      ?.trigger("click");
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Confirm and apply")
      ?.trigger("click");
    await flushPromises();

    report?.(1, 2);
    await wrapper.vm.$nextTick();
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes("aria-label")).toBe("Applying changes");
    expect(bar.attributes("aria-valuenow")).toBe("50");
    expect(wrapper.text()).toContain("1 of 2");
  });

  it("surfaces a failed pick through the shared error banner", async () => {
    fs.pickDirectory.mockRejectedValue(new Error("The folder could not be opened."));
    const wrapper = await withFolder();
    expect(wrapper.get('[role="alert"]').text()).toContain("The folder could not be opened.");
  });
});
