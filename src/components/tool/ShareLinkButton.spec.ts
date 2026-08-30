import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ShareLinkButton from "./ShareLinkButton.vue";
import { clearToasts, getToasts } from "@/lib/toast";

const writeText = vi.fn<(text: string) => Promise<void>>();

/** Pretend the pointer is coarse (a phone) or fine (a mouse). */
function setPointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({
      matches: query.includes("pointer: coarse") ? coarse : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
    configurable: true,
    writable: true,
  });
}

function setShare(fn: ((data: ShareData) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, "share", {
    value: fn,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  setShare(undefined);
  setPointer(false);
});

afterEach(() => {
  clearToasts();
});

describe("ShareLinkButton", () => {
  it("renders a labeled ghost button", () => {
    const wrapper = mount(ShareLinkButton);
    const button = wrapper.get("button");
    expect(button.attributes("data-variant")).toBe("ghost");
    expect(button.attributes("data-size")).toBe("sm");
    expect(button.attributes("aria-label")).toBe("Share a link to this tool");
    expect(wrapper.text()).toContain("Share");
  });

  it("takes a custom label", () => {
    const wrapper = mount(ShareLinkButton, { props: { label: "Copy link" } });
    expect(wrapper.text()).toContain("Copy link");
    // A specific label speaks for itself; it is not glued into a sentence.
    expect(wrapper.get("button").attributes("aria-label")).toBe("Copy link");
  });

  it("copies the current URL on a desktop pointer, fragment state and all", async () => {
    window.location.hash = "#s=abc";
    const wrapper = mount(ShareLinkButton);
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    expect(writeText.mock.calls[0]?.[0]).toBe(window.location.href);
    expect(writeText.mock.calls[0]?.[0]).toContain("#s=abc");
    expect(getToasts()[0]).toMatchObject({ title: "Link copied", variant: "success" });
  });

  it("copies rather than sharing when the pointer is fine, even if share exists", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setShare(share);
    setPointer(false);

    const wrapper = mount(ShareLinkButton);
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(share).not.toHaveBeenCalled();
  });

  it("uses the share sheet on a coarse pointer and does not also copy", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setShare(share);
    setPointer(true);

    const wrapper = mount(ShareLinkButton);
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));

    expect(share.mock.calls[0]?.[0]).toMatchObject({
      title: document.title,
      url: window.location.href,
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(getToasts()).toHaveLength(0);
  });

  it("stays quiet when the share sheet is canceled", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("canceled", "AbortError"));
    setShare(share);
    setPointer(true);

    const wrapper = mount(ShareLinkButton);
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));

    // Canceling is not an error, so there is nothing to report.
    expect(getToasts()).toHaveLength(0);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports a blocked clipboard with a fix hint", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const wrapper = mount(ShareLinkButton);
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(getToasts()).toHaveLength(1));

    expect(getToasts()[0]).toMatchObject({ title: "Copy failed", variant: "error" });
    expect(getToasts()[0]?.description).toBeTruthy();
  });
});
