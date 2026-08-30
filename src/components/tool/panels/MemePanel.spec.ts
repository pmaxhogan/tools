import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meta } from "@/tools/meme-generator/meta";
import MemePanel from "./MemePanel.vue";

/**
 * Regression coverage for the two bugs QA found on the deployed panel: a
 * loaded picture never appeared, the page kept saying "No picture loaded
 * yet", and there was no console error to point at either problem.
 *
 * The first was a Vue reactivity gap: `sourceSize` read a plain, non
 * reactive `picture` variable behind `!picture ||`, which short circuited
 * past the reactive `hasPicture` read on the very first evaluation (picture
 * still null then), so the computed never subscribed to it and stayed
 * cached at `null` forever after. The second, uncovered once the first was
 * fixed, was a timing bug: the panel called `render()` synchronously right
 * after the picture loaded, before Vue had patched the DOM, so the
 * `<canvas>` the `v-if` was about to mount did not exist yet and the draw
 * silently no-opped.
 *
 * Neither needs a real decode: `Image` and `HTMLCanvasElement#getContext`
 * are stubbed below, so this checks the panel's own wiring rather than the
 * browser's image or canvas implementation.
 */

function fileNamed(name: string, type = "image/jpeg"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

function dropPayload(files: File[]): { dataTransfer: { files: File[] } } {
  return { dataTransfer: { files } };
}

/** A same-shape stand-in for the browser's Image, decoding on a microtask. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;

  set src(_value: string) {
    queueMicrotask(() => {
      this.naturalWidth = 800;
      this.naturalHeight = 600;
      this.onload?.();
    });
  }
}

function fakeContext() {
  return {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "",
    textAlign: "",
    textBaseline: "",
    measureText: (text: string) => ({ width: text.length * 10 }),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    drawImage: vi.fn(),
  };
}

let ctx: ReturnType<typeof fakeContext>;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  ctx = fakeContext();
  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctx,
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe("MemePanel", () => {
  it("says no picture is loaded before anything is dropped", () => {
    const wrapper = mount(MemePanel, { props: { meta } });
    expect(wrapper.text()).toContain("No picture loaded yet");
    expect(wrapper.find("canvas").exists()).toBe(false);
  });

  it("draws the picture and drops the empty state once a dropped file decodes", async () => {
    const wrapper = mount(MemePanel, { props: { meta } });
    await wrapper.get('[role="button"]').trigger("drop", dropPayload([fileNamed("cat.jpg")]));
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).not.toContain("No picture loaded yet");
    expect(wrapper.find("canvas").exists()).toBe(true);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600);
  });

  it("shows a decode error instead of staying silent on a bad file", async () => {
    class FailingImage extends FakeImage {
      override set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", FailingImage);

    const wrapper = mount(MemePanel, { props: { meta } });
    await wrapper.get('[role="button"]').trigger("drop", dropPayload([fileNamed("cat.jpg")]));
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("could not be decoded");
    expect(wrapper.find("canvas").exists()).toBe(false);
  });
});
