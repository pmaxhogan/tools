/**
 * ToolShell's sample-file path, which is the one place the generic panel feeds
 * `run()` something other than the textarea.
 *
 * The regression this guards: "Try a sample" on a binary tool loaded the bytes
 * and showed the file chip, but the run stayed behind the 150ms keystroke
 * debounce, so for that frame the panel showed a fresh file next to the old
 * "provide a file" message, promoted to a red error because `isHint` reads
 * `fileBytes`. Live QA read that frame as the bytes never reaching `run()`.
 *
 * From the click onward `setTimeout` is faked and never advanced, so
 * everything asserted below happened without the debounce ever firing: if a
 * sample only landed on the timer, these fail.
 *
 * Needs a DOM, so it is a `.spec.ts` (the happy-dom "components" project):
 *
 *   npx vitest run src/components/tool/ToolShell.spec.ts
 */
import { readFileSync } from "node:fs";
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ToolShell from "./ToolShell.vue";
import { meta as icsMeta } from "@/tools/ics-inspector/meta";
import { meta as wasmMeta } from "@/tools/wasm-inspector/meta";

/**
 * The samples are served straight off disk, so this spec fails if a bundled
 * sample stops being what its tool can read, not only if the shell breaks.
 */
function sampleBytes(name: string): ArrayBuffer {
  const buffer = readFileSync(`public/samples/${name}`);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/** Serves /samples/<name> from public/, the way the deployed site does. */
function stubSamples(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const name = /^\/samples\/(.+)$/.exec(String(url))?.[1];
      if (!name) throw new Error(`unexpected fetch: ${String(url)}`);
      return new Response(sampleBytes(name), { status: 200 });
    }),
  );
}

/**
 * Drain promises and renders until `text` is on screen, or give up.
 *
 * Deliberately never touches the clock, because this is what runs after the
 * click: loading a sample is a chain of awaits (fetch, blob, arrayBuffer) and
 * not one of them is a timer, so if the panel updates here it did so without
 * the debounce, which is the whole point of the spec.
 */
async function settleUntil(wrapper: VueWrapper, text: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
    if (wrapper.text().includes(text)) return;
  }
}

/**
 * Mount and wait for the tool's logic module to arrive, which it announces by
 * rejecting the empty input the shell starts with. Clicking before that would
 * test nothing: `run()` is a no-op until the module lands.
 *
 * The clock stays real until that has happened, because the lazy import is a
 * transform that costs real milliseconds, and more of them when the rest of
 * the suite is running. The debounce is frozen only once the panel is ready,
 * so it can never be what delivers the sample.
 */
async function mountShell(meta: typeof wasmMeta, emptyInputMessage: string) {
  const wrapper = mount(ToolShell, { props: { meta } });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !wrapper.text().includes(emptyInputMessage)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await nextTick();
  }
  expect(wrapper.text()).toContain(emptyInputMessage);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return wrapper;
}

const WASM_EMPTY = "Provide a .wasm module.";
const ICS_EMPTY = "Paste .ics text or drop a calendar file.";

function sampleButton(wrapper: VueWrapper) {
  const button = wrapper.findAll("button").find((b) => b.text().includes("Try a sample"));
  if (!button) throw new Error("no sample button rendered");
  return button;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ToolShell sample files", () => {
  it("feeds a binary sample to run() without waiting for the debounce", async () => {
    stubSamples();
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);

    await sampleButton(wrapper).trigger("click");
    await settleUntil(wrapper, "env.log");

    const text = wrapper.text();
    // The chip reports the bytes the shell holds...
    expect(text).toContain("sample.wasm");
    expect(text).toContain("35 B");
    // ...and run() parsed those same bytes, with the debounce still frozen.
    expect(text).toContain("env.log");
    expect(text).toContain("35 bytes");
    expect(text).not.toContain(WASM_EMPTY);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("does the same for a sample whose bytes are text", async () => {
    stubSamples();
    const wrapper = await mountShell(icsMeta, ICS_EMPTY);

    await sampleButton(wrapper).trigger("click");
    await settleUntil(wrapper, "Quarterly planning sync");

    const text = wrapper.text();
    expect(text).toContain("sample.ics");
    expect(text).toContain("Quarterly planning sync");
    expect(text).not.toContain(ICS_EMPTY);
  });

  it("clears the output and the chip when the file chip's x is pressed", async () => {
    stubSamples();
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);

    await sampleButton(wrapper).trigger("click");
    await settleUntil(wrapper, "env.log");
    expect(wrapper.text()).toContain("env.log");

    await wrapper.get('[aria-label="Remove file"]').trigger("click");
    await settleUntil(wrapper, WASM_EMPTY);

    expect(wrapper.text()).not.toContain("sample.wasm");
    expect(wrapper.text()).toContain(WASM_EMPTY);
    // Back to waiting for input, so the message is a neutral hint, not an alert.
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("reports a sample that could not be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);

    await sampleButton(wrapper).trigger("click");
    await settleUntil(wrapper, "Could not load the sample file.");

    expect(wrapper.text()).toContain("Could not load the sample file.");
  });
});
