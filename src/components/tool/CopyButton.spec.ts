import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { Link } from "lucide-vue-next";
import CopyButton from "./CopyButton.vue";
import { clearToasts, getToasts } from "@/lib/toast";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  clearToasts();
});

describe("CopyButton", () => {
  it("copies the text prop and toasts, the API the 57 existing users rely on", async () => {
    const wrapper = mount(CopyButton, { props: { text: "hello", label: "Copy" } });
    await wrapper.get("button").trigger("click");
    await wrapper.vm.$nextTick();

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]).toMatchObject({ title: "Copied", variant: "success" });
  });

  it("swaps the label to Copied and emits copied", async () => {
    vi.useFakeTimers();
    const wrapper = mount(CopyButton, { props: { text: "hello", label: "Copy JSON" } });
    expect(wrapper.text()).toBe("Copy JSON");

    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(wrapper.emitted("copied")).toHaveLength(1));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toBe("Copied");

    vi.advanceTimersByTime(1600);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toBe("Copy JSON");
    vi.useRealTimers();
  });

  it("renders no label text when none is given, but keeps an aria-label", () => {
    const wrapper = mount(CopyButton, { props: { text: "hello" } });
    expect(wrapper.text()).toBe("");
    expect(wrapper.get("button").attributes("aria-label")).toBe("Copy to clipboard");
  });

  it("uses the label as the aria-label when one is given", () => {
    const wrapper = mount(CopyButton, { props: { text: "x", label: "Copy SVG" } });
    expect(wrapper.get("button").attributes("aria-label")).toBe("Copy SVG");
  });

  it("defaults to the ghost small button, and passes a variant through", () => {
    const ghost = mount(CopyButton, { props: { text: "x" } });
    expect(ghost.get("button").attributes("data-variant")).toBe("ghost");
    expect(ghost.get("button").attributes("data-size")).toBe("sm");

    const outline = mount(CopyButton, {
      props: { text: "x", variant: "outline", size: "default" },
    });
    expect(outline.get("button").attributes("data-variant")).toBe("outline");
    expect(outline.get("button").attributes("data-size")).toBe("default");
  });

  it("honors disabled", async () => {
    const wrapper = mount(CopyButton, { props: { text: "x", disabled: true } });
    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
  });

  it("takes text from getText at click time, so a lazy value stays current", async () => {
    let counter = 0;
    const wrapper = mount(CopyButton, {
      props: { getText: () => `value ${(counter += 1)}`, label: "Copy link" },
    });

    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("value 1"));

    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("value 2"));
  });

  it("awaits an async getText", async () => {
    const wrapper = mount(CopyButton, {
      props: { getText: async () => "<svg />" },
    });
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("<svg />"));
  });

  it("prefers getText over text when both are given", async () => {
    const wrapper = mount(CopyButton, {
      props: { text: "stale", getText: () => "fresh" },
    });
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("fresh"));
  });

  it("raises an error toast and emits failed when the clipboard is blocked", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const wrapper = mount(CopyButton, { props: { text: "hello", label: "Copy" } });

    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(wrapper.emitted("failed")).toHaveLength(1));

    expect(getToasts()[0]).toMatchObject({ title: "Copy failed", variant: "error" });
    // The inline state must not lie about a copy that never happened.
    expect(wrapper.text()).toBe("Copy");
  });

  it("reports a getText that throws without copying an empty string", async () => {
    const wrapper = mount(CopyButton, {
      props: {
        getText: () => {
          throw new Error("no ink on the pad");
        },
      },
    });
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(wrapper.emitted("failed")).toHaveLength(1));

    expect(writeText).not.toHaveBeenCalled();
    expect(getToasts()[0]).toMatchObject({ title: "Copy failed", variant: "error" });
  });

  it("uses a custom toast title when one is given", async () => {
    const wrapper = mount(CopyButton, { props: { text: "x", toastTitle: "Link copied" } });
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(getToasts()).toHaveLength(1));
    expect(getToasts()[0]?.title).toBe("Link copied");
  });

  it("renders a custom rest-state icon", () => {
    const wrapper = mount(CopyButton, { props: { text: "x", icon: Link, label: "Copy link" } });
    expect(wrapper.findComponent(Link).exists()).toBe(true);
  });
});
