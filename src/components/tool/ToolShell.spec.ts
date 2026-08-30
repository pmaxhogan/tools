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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ToolShell from "./ToolShell.vue";
import { clearCarriedInput, getCarriedInput, setCarriedInput } from "@/lib/carry-input";
import { meta as hmacMeta } from "@/tools/hmac-generator/meta";
import { meta as icsMeta } from "@/tools/ics-inspector/meta";
import { meta as raidzMeta } from "@/tools/raidz-calculator/meta";
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
  // Attached to the document because FileDrop's shared paste dispatcher only
  // considers zones whose element is connected: a detached shell never gets a
  // paste, so the paste cases below would pass for the wrong reason.
  const wrapper = mount(ToolShell, { props: { meta }, attachTo: document.body });
  mountedShells.push(wrapper);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !wrapper.text().includes(emptyInputMessage)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await nextTick();
  }
  expect(wrapper.text()).toContain(emptyInputMessage);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return wrapper;
}

/** Attached shells, torn down in afterEach so the next case starts clean. */
const mountedShells: VueWrapper[] = [];

const WASM_EMPTY = "Provide a .wasm module.";
const ICS_EMPTY = "Paste .ics text or drop a calendar file.";
const HMAC_EMPTY = "Nothing to authenticate.";

/** The fragment as it stands right now, parsed rather than matched as text. */
function fragmentParams(): URLSearchParams {
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

/** Puts the page on a shared link before a shell is mounted onto it. */
function setFragment(hash: string): void {
  history.replaceState(null, "", hash);
}

function sampleButton(wrapper: VueWrapper) {
  const button = wrapper.findAll("button").find((b) => b.text().includes("Try a sample"));
  if (!button) throw new Error("no sample button rendered");
  return button;
}

/**
 * The carry store is a module global that FileDrop now writes to on every file
 * the shell receives, so a leftover entry would leak between cases.
 */
beforeEach(() => {
  clearCarriedInput();
});

afterEach(() => {
  // The fragment is a document global, so a case that wrote one would put the
  // next mount on a shared link it never asked for.
  history.replaceState(null, "", window.location.pathname);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const wrapper of mountedShells.splice(0)) wrapper.unmount();
  clearCarriedInput();
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

/**
 * The input well is a `bare` FileDrop now, so drop, the picker, and clipboard
 * paste all arrive through the shared component instead of the shell's own
 * handlers. These cases pin the three routes down to `readFile`, plus the two
 * things the migration must not break: a text paste into the textarea, and the
 * fact that clicking inside the well does not fire the file picker.
 */
describe("ToolShell file input through FileDrop", () => {
  /** A real module off disk, so `run()` has something it can actually parse. */
  function wasmFile(name: string): File {
    return new File([sampleBytes("sample.wasm")], name, { type: "application/wasm" });
  }

  function buttonSaying(wrapper: VueWrapper, text: string) {
    const button = wrapper.findAll("button").find((b) => b.text().includes(text));
    if (!button) throw new Error(`no button saying ${text}`);
    return button;
  }

  /** Throws rather than silently skipping, so a renamed chip fails the case. */
  function spanSaying(wrapper: VueWrapper, text: string) {
    const span = wrapper.findAll("span").find((s) => s.text() === text);
    if (!span) throw new Error(`no span saying ${text}`);
    return span;
  }

  it("reads a file dropped on the well and carries it to the next tool", async () => {
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    const file = wasmFile("dropped.wasm");

    // The well is not a role="button" any more (`:interactive="false"`), so it
    // is addressed by its test id; drop still works exactly as before.
    await wrapper
      .get('[data-testid="filedrop-zone"]')
      .trigger("drop", { dataTransfer: { files: [file] } });
    await settleUntil(wrapper, "env.log");

    expect(wrapper.text()).toContain("dropped.wasm");
    expect(wrapper.text()).toContain("env.log");
    // FileDrop, not the shell, owns the file half of the cross tool carry.
    const carried = getCarriedInput();
    expect(carried?.kind).toBe("file");
    expect(carried?.file).toBe(file);
    expect(carried?.fromSlug).toBe("wasm-inspector");
  });

  it("reads a file chosen from the picker", async () => {
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    const picker = wrapper.get('input[type="file"]');
    Object.defineProperty(picker.element, "files", {
      value: [wasmFile("picked.wasm")],
      configurable: true,
    });

    await picker.trigger("change");
    await settleUntil(wrapper, "env.log");

    expect(wrapper.text()).toContain("picked.wasm");
    expect(wrapper.text()).toContain("env.log");
  });

  it("opens the picker from the Open file button", async () => {
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    const picker = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const click = vi.spyOn(picker, "click").mockImplementation(() => {});

    await buttonSaying(wrapper, "Open file").trigger("click");

    expect(click).toHaveBeenCalledTimes(1);
  });

  it("reads a file pasted from the clipboard", async () => {
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    const event = new Event("paste");
    Object.defineProperty(event, "clipboardData", { value: { files: [wasmFile("pasted.wasm")] } });

    document.dispatchEvent(event);
    await settleUntil(wrapper, "env.log");

    expect(wrapper.text()).toContain("pasted.wasm");
  });

  it("leaves a text paste in the textarea alone", async () => {
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    (wrapper.get("textarea").element as HTMLTextAreaElement).focus();

    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [] } });
    document.dispatchEvent(event);
    await nextTick();

    // Nothing intercepted it, so the browser's own paste into the box stands.
    expect(event.defaultPrevented).toBe(false);
    expect(wrapper.text()).toContain(WASM_EMPTY);
    expect(wrapper.text()).not.toContain("35 B");
  });

  it("does not open the picker from the textarea, the label, or the file chip", async () => {
    stubSamples();
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    await sampleButton(wrapper).trigger("click");
    await settleUntil(wrapper, "env.log");

    const picker = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const click = vi.spyOn(picker, "click").mockImplementation(() => {});

    await wrapper.get("textarea").trigger("click");
    await spanSaying(wrapper, "Input").trigger("click");
    await spanSaying(wrapper, "sample.wasm").trigger("click");

    expect(click).not.toHaveBeenCalled();
    // The chip's own x still works, and it is not a picker click either.
    await wrapper.get('[aria-label="Remove file"]').trigger("click");
    await settleUntil(wrapper, WASM_EMPTY);
    expect(click).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("sample.wasm");
  });

  /*
   * A quick entry box is hidden with v-show, so its FileDrop stays mounted and
   * connected and would still be a candidate for the page wide paste listener.
   * A file pasted with the box shut would then load into a well nobody can see.
   */
  it("ignores a file paste while a quick entry box is collapsed", async () => {
    const wrapper = mount(ToolShell, { props: { meta: raidzMeta }, attachTo: document.body });
    mountedShells.push(wrapper);
    await nextTick();

    const event = new Event("paste");
    Object.defineProperty(event, "clipboardData", {
      value: { files: [new File(["6x4TB raidz2"], "layout.txt", { type: "text/plain" })] },
    });
    document.dispatchEvent(event);
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      await nextTick();
    }

    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("");

    // Opened, it takes pastes like any other well.
    await buttonSaying(wrapper, "Quick entry").trigger("click");
    const second = new Event("paste");
    Object.defineProperty(second, "clipboardData", {
      value: { files: [new File(["6x4TB raidz2"], "layout.txt", { type: "text/plain" })] },
    });
    document.dispatchEvent(second);
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      await nextTick();
      if ((wrapper.get("textarea").element as HTMLTextAreaElement).value) break;
    }
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("6x4TB raidz2");
  });

  it("puts one focus ring on the well and none on the textarea", async () => {
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    const well = wrapper.get("#tool-input-well");

    expect(well.classes()).toContain("focus-within:ring-3");
    expect(well.classes()).toContain("focus-within:ring-ring/50");
    expect(wrapper.get("textarea").classes()).toContain("focus-visible:ring-0");
  });
});

/**
 * The text half of the cross tool carry, which lives in the shell because only
 * the shell knows what is in the box. The file half is FileDrop's and is
 * covered by FileDrop.spec.ts.
 */
describe("ToolShell text carry", () => {
  function carryText(text: string): void {
    setCarriedInput({
      kind: "text",
      text,
      fromSlug: "json-formatter",
      fromName: "JSON formatter",
      at: Date.now(),
    });
  }

  it("offers text from another tool and fills the box with it", async () => {
    carryText("(module)");
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    expect(wrapper.text()).toContain("Use text from JSON formatter");

    const fill = wrapper.findAll("button").find((b) => b.text().includes("Use text from"));
    if (!fill) throw new Error("no chip offering the carried text");
    await fill.trigger("click");
    await nextTick();

    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("(module)");
    // Filled, so the offer has nothing left to offer.
    expect(wrapper.text()).not.toContain("Use text from JSON formatter");
  });

  it("drops the offer when the chip is dismissed", async () => {
    carryText("(module)");
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);

    await wrapper.get('[aria-label="Dismiss the carried text"]').trigger("click");
    await nextTick();

    expect(wrapper.text()).not.toContain("Use text from");
    expect(getCarriedInput()).toBeNull();
  });

  it("does not offer text this same tool carried", async () => {
    setCarriedInput({
      kind: "text",
      text: "(module)",
      fromSlug: "wasm-inspector",
      fromName: "WASM Inspector",
      at: Date.now(),
    });
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);
    expect(wrapper.text()).not.toContain("Use text from");
  });

  it("carries the text it just ran with", async () => {
    const wrapper = await mountShell(wasmMeta, WASM_EMPTY);

    await wrapper.get("textarea").setValue("(module)");
    vi.advanceTimersByTime(200);
    await nextTick();

    const carried = getCarriedInput();
    expect(carried?.kind).toBe("text");
    expect(carried?.text).toBe("(module)");
    expect(carried?.fromSlug).toBe("wasm-inspector");
    expect(carried?.fromName).toBe("WASM Inspector");
  });
});

/*
 * Sensitive options. hmac-generator declares a `key` option flagged sensitive
 * (a signing key) alongside plain ones, so one tool exercises both paths. The
 * fragment is parsed rather than string matched, because "keyEncoding" is a
 * visible option whose id starts with the sensitive one's.
 */
describe("ToolShell sensitive options", () => {
  it("keeps a sensitive value out of the fragment and round-trips the rest", async () => {
    const wrapper = await mountShell(hmacMeta, HMAC_EMPTY);

    await wrapper.get("#tool-input-well textarea").setValue("what do ya want for nothing?");
    await wrapper.get("#key").setValue("Jefe");
    await wrapper.get("#expected").setValue("abc123");
    vi.advanceTimersByTime(300);
    await nextTick();

    // hmac-generator also sets `sensitiveInput`, because its message box still
    // accepts the older "--- then the key" form, so the input stays out too.
    const params = fragmentParams();
    expect(params.has("i")).toBe(false);
    expect(params.get("expected")).toBe("abc123");
    expect(params.get("keyEncoding")).toBe("utf8");
    expect(params.has("key")).toBe(false);
    expect(window.location.hash).not.toContain("Jefe");
  });

  it("masks the sensitive control and leaves the others as they were", async () => {
    const wrapper = await mountShell(hmacMeta, HMAC_EMPTY);
    expect(wrapper.get("#key").attributes("type")).toBe("password");
    expect(wrapper.get("#key").attributes("autocomplete")).toBe("off");
    expect(wrapper.get("#expected").attributes("type")).toBeUndefined();
  });

  it("never pre-fills a sensitive option from a shared link", async () => {
    setFragment("#key=leaked-signing-key&expected=abc123&encoding=base64");
    const wrapper = await mountShell(hmacMeta, HMAC_EMPTY);

    expect((wrapper.get("#key").element as HTMLInputElement).value).toBe("");
    expect((wrapper.get("#expected").element as HTMLInputElement).value).toBe("abc123");

    // And the link is rewritten without it as soon as the shell syncs again.
    await wrapper.get("#tool-input-well textarea").setValue("hello there");
    vi.advanceTimersByTime(300);
    await nextTick();
    expect(fragmentParams().has("key")).toBe(false);
    expect(window.location.hash).not.toContain("leaked-signing-key");
  });
});
