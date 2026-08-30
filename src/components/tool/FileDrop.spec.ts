import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileDrop from "./FileDrop.vue";
import { clearCarriedInput, getCarriedInput, setCarriedInput } from "@/lib/carry-input";

const provide = { toolSlug: "image-resizer", toolName: "Image resizer" };

function fileNamed(name: string, type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

/** happy-dom's DataTransfer is not worth fighting; hand the handler a shape. */
function dropPayload(files: File[]) {
  return { dataTransfer: { files } };
}

/** A document paste event carrying `files`, which happy-dom will not build. */
function pasteEvent(...files: File[]): Event {
  const event = new Event("paste");
  Object.defineProperty(event, "clipboardData", { value: { files } });
  return event;
}

beforeEach(() => {
  clearCarriedInput();
});

describe("FileDrop", () => {
  it("renders the default headline and a hint", () => {
    const wrapper = mount(FileDrop, {
      props: { hint: "PNG, JPEG or WebP up to 50 MB" },
      global: { provide },
    });
    expect(wrapper.text()).toContain("Drop a file here or click to choose");
    expect(wrapper.text()).toContain("PNG, JPEG or WebP up to 50 MB");
    const zone = wrapper.get('[role="button"]');
    expect(zone.attributes("tabindex")).toBe("0");
    expect(zone.attributes("aria-label")).toContain("Drop a file here");
  });

  it("emits files on drop and carries only the first when single", async () => {
    const wrapper = mount(FileDrop, { global: { provide } });
    const files = [fileNamed("a.png"), fileNamed("b.png")];
    await wrapper.get('[role="button"]').trigger("drop", dropPayload(files));
    const emitted = wrapper.emitted("files");
    expect(emitted).toHaveLength(1);
    expect(emitted?.[0]?.[0]).toEqual([files[0]]);
  });

  it("passes every file through when multiple is set", async () => {
    const wrapper = mount(FileDrop, { props: { multiple: true }, global: { provide } });
    const files = [fileNamed("a.png"), fileNamed("b.png")];
    await wrapper.get('[role="button"]').trigger("drop", dropPayload(files));
    expect(wrapper.emitted("files")?.[0]?.[0]).toEqual(files);
  });

  it("opens the picker on Enter and on Space", async () => {
    const wrapper = mount(FileDrop, { global: { provide } });
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    const zone = wrapper.get('[role="button"]');
    await zone.trigger("keydown.enter");
    await zone.trigger("keydown.space");
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("does not open the picker when disabled", async () => {
    const wrapper = mount(FileDrop, { props: { disabled: true }, global: { provide } });
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    await wrapper.get('[role="button"]').trigger("click");
    expect(click).not.toHaveBeenCalled();
    expect(wrapper.get('[role="button"]').attributes("tabindex")).toBe("-1");
  });

  it("leaves clicks that started on an action button to that button", async () => {
    const wrapper = mount(FileDrop, {
      global: { provide },
      slots: { actions: '<button type="button" id="sample">Try a sample</button>' },
    });
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    await wrapper.get("#sample").trigger("click");
    expect(click).not.toHaveBeenCalled();
  });

  it("shows the drag ring while a file is over the zone", async () => {
    const wrapper = mount(FileDrop, { global: { provide } });
    const zone = wrapper.get('[role="button"]');
    expect(zone.classes()).not.toContain("ring-2");
    await zone.trigger("dragenter");
    expect(zone.classes()).toContain("ring-2");
    await zone.trigger("dragleave");
    expect(zone.classes()).not.toContain("ring-2");
  });

  it("accepts a pasted file and ignores a paste with no files", async () => {
    const wrapper = mount(FileDrop, { attachTo: document.body, global: { provide } });
    const empty = new Event("paste") as Event & { clipboardData: unknown };
    Object.defineProperty(empty, "clipboardData", { value: { files: [] } });
    document.dispatchEvent(empty);
    expect(wrapper.emitted("files")).toBeUndefined();

    const file = fileNamed("pasted.png");
    const withFile = new Event("paste") as Event & { clipboardData: unknown };
    Object.defineProperty(withFile, "clipboardData", { value: { files: [file] } });
    document.dispatchEvent(withFile);
    expect(wrapper.emitted("files")?.[0]?.[0]).toEqual([file]);
    wrapper.unmount();
  });

  it("stops listening for paste once unmounted", () => {
    const wrapper = mount(FileDrop, { attachTo: document.body, global: { provide } });
    wrapper.unmount();
    const event = new Event("paste") as Event & { clipboardData: unknown };
    Object.defineProperty(event, "clipboardData", { value: { files: [fileNamed("late.png")] } });
    document.dispatchEvent(event);
    expect(wrapper.emitted("files")).toBeUndefined();
  });

  it("stores the file it received in the carry store", async () => {
    const wrapper = mount(FileDrop, { global: { provide } });
    const file = fileNamed("shot.png");
    await wrapper.get('[role="button"]').trigger("drop", dropPayload([file]));
    const carried = getCarriedInput();
    expect(carried?.kind).toBe("file");
    expect(carried?.file).toBe(file);
    expect(carried?.fromSlug).toBe("image-resizer");
    expect(carried?.fromName).toBe("Image resizer");
  });

  it("does not touch the carry store outside a panel", async () => {
    const wrapper = mount(FileDrop);
    await wrapper.get('[role="button"]').trigger("drop", dropPayload([fileNamed("loose.png")]));
    expect(getCarriedInput()).toBeNull();
  });

  it("offers a matching carried file and hands it over when clicked", async () => {
    const file = fileNamed("holiday.png");
    setCarriedInput({
      kind: "file",
      file,
      fromSlug: "exif-viewer",
      fromName: "EXIF viewer",
      at: Date.now(),
    });
    const wrapper = mount(FileDrop, { props: { accept: "image/*" }, global: { provide } });
    expect(wrapper.text()).toContain("Use holiday.png from EXIF viewer");
    await wrapper.get("span button:not([aria-label])").trigger("click");
    expect(wrapper.emitted("files")?.[0]?.[0]).toEqual([file]);
  });

  it("hides the chip for a file the accept filter rejects", () => {
    setCarriedInput({
      kind: "file",
      file: fileNamed("track.gpx", "application/gpx+xml"),
      fromSlug: "gpx-viewer",
      fromName: "GPX viewer",
      at: Date.now(),
    });
    const wrapper = mount(FileDrop, { props: { accept: "image/*" }, global: { provide } });
    expect(wrapper.text()).not.toContain("Use track.gpx");
  });

  it("hides the chip for a file this same tool carried", () => {
    setCarriedInput({
      kind: "file",
      file: fileNamed("mine.png"),
      fromSlug: "image-resizer",
      fromName: "Image resizer",
      at: Date.now(),
    });
    const wrapper = mount(FileDrop, { global: { provide } });
    expect(wrapper.text()).not.toContain("Use mine.png");
  });

  it("clears the carried file from the dismiss button", async () => {
    setCarriedInput({
      kind: "file",
      file: fileNamed("holiday.png"),
      fromSlug: "exif-viewer",
      fromName: "EXIF viewer",
      at: Date.now(),
    });
    const wrapper = mount(FileDrop, { global: { provide } });
    await wrapper.get('[aria-label="Dismiss the carried file"]').trigger("click");
    expect(getCarriedInput()).toBeNull();
    expect(wrapper.text()).not.toContain("Use holiday.png");
  });

  it("marks the input for a folder pick", () => {
    const wrapper = mount(FileDrop, { props: { directory: true }, global: { provide } });
    const input = wrapper.get('input[type="file"]');
    expect(input.attributes("webkitdirectory")).toBe("");
    expect(input.attributes("multiple")).toBeDefined();
  });

  it("gives a pasted file to one zone only when a panel has two", async () => {
    const first = mount(FileDrop, { attachTo: document.body, global: { provide } });
    const second = mount(FileDrop, { attachTo: document.body, global: { provide } });

    document.dispatchEvent(pasteEvent(fileNamed("shot.png")));
    expect(first.emitted("files")).toHaveLength(1);
    expect(second.emitted("files")).toBeUndefined();

    first.unmount();
    second.unmount();
  });

  it("gives a pasted file to the zone focus is inside", async () => {
    const first = mount(FileDrop, { attachTo: document.body, global: { provide } });
    const second = mount(FileDrop, { attachTo: document.body, global: { provide } });

    (second.get('[role="button"]').element as HTMLElement).focus();
    document.dispatchEvent(pasteEvent(fileNamed("shot.png")));
    expect(second.emitted("files")).toHaveLength(1);
    expect(first.emitted("files")).toBeUndefined();

    first.unmount();
    second.unmount();
  });

  it("skips a zone that opted out of paste", async () => {
    const off = mount(FileDrop, {
      attachTo: document.body,
      props: { paste: false },
      global: { provide },
    });
    const on = mount(FileDrop, { attachTo: document.body, global: { provide } });

    document.dispatchEvent(pasteEvent(fileNamed("shot.png")));
    expect(off.emitted("files")).toBeUndefined();
    expect(on.emitted("files")).toHaveLength(1);

    off.unmount();
    on.unmount();
  });

  it("renders the default slot instead of the built in body", () => {
    const wrapper = mount(FileDrop, {
      global: { provide },
      slots: { default: "<p>Bring your own body</p>" },
    });
    expect(wrapper.text()).toContain("Bring your own body");
    expect(wrapper.find('[data-testid="filedrop-body"]').exists()).toBe(false);
  });

  it("still renders the actions slot alongside a custom body", () => {
    const wrapper = mount(FileDrop, {
      global: { provide },
      slots: {
        default: "<p>Bring your own body</p>",
        actions: '<button type="button" id="camera">Use camera</button>',
      },
    });
    expect(wrapper.text()).toContain("Bring your own body");
    expect(wrapper.findAll("#camera")).toHaveLength(1);
  });

  it("hands the custom body a way to open the picker", async () => {
    const wrapper = mount(FileDrop, {
      global: { provide },
      slots: {
        default: `<button type="button" id="choose" @click="open">Choose file</button>`,
      },
    });
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    await wrapper.get("#choose").trigger("click");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("exposes open() to a button outside the zone", () => {
    const wrapper = mount(FileDrop, { global: { provide } });
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    (wrapper.vm as unknown as { open: () => void }).open();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("drops the zone padding when bare", () => {
    const padded = mount(FileDrop, { global: { provide } });
    expect(padded.get('[role="button"]').classes()).toContain("py-6");

    const wrapper = mount(FileDrop, { props: { bare: true }, global: { provide } });
    const zone = wrapper.get('[role="button"]').classes();
    expect(zone).not.toContain("py-6");
    expect(zone).not.toContain("py-2");
  });
});
