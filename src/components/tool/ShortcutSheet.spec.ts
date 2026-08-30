import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ShortcutSheet from "./ShortcutSheet.vue";
import { TOOL_SHORTCUTS } from "@/lib/shortcuts";

function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
}

const ORIGINAL_PLATFORM = navigator.platform;

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  document.body.innerHTML = "";
});

/**
 * DialogContent teleports to document.body (see DialogPortal in
 * ui/dialog/DialogContent.vue) one tick after mount, so the rendered sheet
 * never sits inside the mounted wrapper's own element and is not there yet on
 * the synchronous return of `mount`. Every test below awaits `nextTick`
 * before reading the DOM, then queries `document.body` instead of `wrapper`.
 */
function bodyKbds(): string[] {
  return [...document.body.querySelectorAll("kbd")].map((el) => el.textContent ?? "");
}

describe("ShortcutSheet", () => {
  it("lists every shortcut's label, including the documentation-only palette entry", async () => {
    mount(ShortcutSheet, { props: { open: true }, attachTo: document.body });
    await nextTick();
    const text = document.body.textContent ?? "";
    for (const spec of TOOL_SHORTCUTS) {
      expect(text).toContain(spec.label);
    }
  });

  it("shows Ctrl combos on a non-Apple platform", async () => {
    setPlatform("Win32");
    mount(ShortcutSheet, { props: { open: true }, attachTo: document.body });
    await nextTick();
    const kbds = bodyKbds();
    expect(kbds).toContain("Ctrl");
    expect(kbds).not.toContain("Cmd");
  });

  it("shows Cmd combos on macOS", async () => {
    setPlatform("MacIntel");
    mount(ShortcutSheet, { props: { open: true }, attachTo: document.body });
    await nextTick();
    const kbds = bodyKbds();
    expect(kbds).toContain("Cmd");
    expect(kbds).not.toContain("Ctrl");
  });

  it("renders the shift modifier for copy-output", async () => {
    setPlatform("Win32");
    mount(ShortcutSheet, { props: { open: true }, attachTo: document.body });
    await nextTick();
    const kbds = bodyKbds();
    expect(kbds).toContain("Shift");
    expect(kbds).toContain("C");
  });

  it("renders no shortcuts when closed", async () => {
    mount(ShortcutSheet, { props: { open: false }, attachTo: document.body });
    await nextTick();
    expect(bodyKbds().length).toBe(0);
  });

  it("emits update:open(false) when the dialog's own close button is clicked", async () => {
    const wrapper = mount(ShortcutSheet, { props: { open: true }, attachTo: document.body });
    await nextTick();
    const closeButton = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="dialog-close"]',
    );
    closeButton?.click();
    await nextTick();
    expect(wrapper.emitted("update:open")).toEqual([[false]]);
  });
});
