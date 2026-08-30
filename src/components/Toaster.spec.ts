import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import Toaster from "./Toaster.vue";
import { DEFAULT_TOAST_MS, clearToasts, toast } from "@/lib/toast";

// The store is module state shared by every subscriber, so a Toaster left
// mounted from an earlier test would keep arming its own dismissal timers over
// the next test's toasts. One page only ever has one Toaster; enforce that.
enableAutoUnmount(afterEach);

afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

function texts(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-testid="toast"]').map((el) => el.text());
}

describe("Toaster", () => {
  it("renders a polite live region even with nothing queued", () => {
    const wrapper = mount(Toaster);
    const region = wrapper.get('[data-testid="toaster"]');
    // The region has to exist before the first message or it is not announced.
    expect(region.attributes("aria-live")).toBe("polite");
    expect(region.attributes("role")).toBe("status");
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("shows a toast raised from anywhere, which is how a panel island reaches it", async () => {
    const wrapper = mount(Toaster);
    toast({ title: "Copied", variant: "success" });
    await wrapper.vm.$nextTick();
    expect(texts(wrapper).join(" ")).toContain("Copied");
    expect(wrapper.get('[data-testid="toast"]').attributes("data-variant")).toBe("success");
  });

  it("renders the description line", async () => {
    const wrapper = mount(Toaster);
    toast({ title: "Copy failed", description: "Copy it by hand.", variant: "error" });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Copy it by hand.");
  });

  it("shows at most three at once, dropping the oldest", async () => {
    const wrapper = mount(Toaster);
    for (const title of ["one", "two", "three", "four"]) toast({ title });
    await wrapper.vm.$nextTick();
    const rendered = texts(wrapper).join(" ");
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(3);
    expect(rendered).not.toContain("one");
    expect(rendered).toContain("four");
  });

  it("auto dismisses after the default window", async () => {
    vi.useFakeTimers();
    const wrapper = mount(Toaster);
    toast({ title: "Copied" });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(1);

    vi.advanceTimersByTime(DEFAULT_TOAST_MS + 10);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("honors a custom duration", async () => {
    vi.useFakeTimers();
    const wrapper = mount(Toaster);
    toast({ title: "Slow", durationMs: 9000 });
    await wrapper.vm.$nextTick();

    vi.advanceTimersByTime(DEFAULT_TOAST_MS + 10);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(1);

    vi.advanceTimersByTime(9000);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("pauses the clock while the pointer is over the toast", async () => {
    vi.useFakeTimers();
    const wrapper = mount(Toaster);
    toast({ title: "Copied" });
    await wrapper.vm.$nextTick();

    await wrapper.get('[data-testid="toast"]').trigger("pointerenter");
    vi.advanceTimersByTime(DEFAULT_TOAST_MS * 3);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(1);

    await wrapper.get('[data-testid="toast"]').trigger("pointerleave");
    vi.advanceTimersByTime(DEFAULT_TOAST_MS + 10);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("dismisses on the close button", async () => {
    const wrapper = mount(Toaster);
    toast({ title: "Copied" });
    await wrapper.vm.$nextTick();

    await wrapper.get('button[aria-label="Dismiss notification"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("picks up a toast that was queued before it mounted, with the time left", async () => {
    vi.useFakeTimers();
    toast({ title: "Queued early" });
    // Half the window has already gone by the time the island hydrates.
    vi.advanceTimersByTime(DEFAULT_TOAST_MS / 2);

    const wrapper = mount(Toaster);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(1);

    vi.advanceTimersByTime(DEFAULT_TOAST_MS / 2 + 10);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('[data-testid="toast"]')).toHaveLength(0);
  });

  it("stops listening once unmounted", async () => {
    const wrapper = mount(Toaster);
    wrapper.unmount();
    // No subscriber left, so this must not throw or schedule anything.
    expect(() => toast({ title: "after unmount" })).not.toThrow();
  });
});

describe("Toaster stacking", () => {
  beforeEach(() => {
    clearToasts();
  });

  it("keeps every live toast in one region so they are announced in order", async () => {
    const wrapper = mount(Toaster);
    toast({ title: "First" });
    toast({ title: "Second" });
    await wrapper.vm.$nextTick();
    expect(texts(wrapper)).toHaveLength(2);
    expect(texts(wrapper)[0]).toContain("First");
    expect(texts(wrapper)[1]).toContain("Second");
  });
});
