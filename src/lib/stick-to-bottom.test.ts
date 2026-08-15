import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { useStickToBottom } from "./stick-to-bottom";

/**
 * A stand in for the log box: enough of an element to drive the scroll math,
 * with the three measurements writable so a test can grow the content.
 */
interface FakeBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

function fakeBox(opts: { clientHeight?: number } = {}): FakeBox {
  return { scrollTop: 0, scrollHeight: 0, clientHeight: opts.clientHeight ?? 100 };
}

/** The composable only reads scroll geometry, so a fake box stands in fine. */
function asElement(box: FakeBox): HTMLElement {
  return box as unknown as HTMLElement;
}

/** Runs `body` inside an effect scope so the watchers are torn down after. */
async function withScope(body: () => Promise<void>) {
  const scope = effectScope();
  try {
    await scope.run(body);
  } finally {
    scope.stop();
  }
}

describe("useStickToBottom", () => {
  it("follows new rows while the reader sits at the bottom", async () => {
    await withScope(async () => {
      const rows = ref<string[]>([]);
      const { el } = useStickToBottom(() => rows.value.length);
      const box = fakeBox();
      el.value = asElement(box);
      await nextTick();

      rows.value.push("first");
      box.scrollHeight = 240;
      await nextTick();
      await nextTick();

      expect(box.scrollTop).toBe(240);
    });
  });

  it("stops following once the reader scrolls up", async () => {
    await withScope(async () => {
      const rows = ref<string[]>([]);
      const { el, onScroll, stuck } = useStickToBottom(() => rows.value.length);
      const box = fakeBox();
      el.value = asElement(box);
      await nextTick();

      // The reader drags the bar well clear of the bottom.
      box.scrollHeight = 500;
      box.scrollTop = 100;
      onScroll();
      expect(stuck.value).toBe(false);

      rows.value.push("later");
      box.scrollHeight = 560;
      await nextTick();
      await nextTick();

      expect(box.scrollTop).toBe(100);
    });
  });

  it("resumes following when the reader scrolls back down", async () => {
    await withScope(async () => {
      const rows = ref<string[]>([]);
      const { el, onScroll, stuck } = useStickToBottom(() => rows.value.length);
      const box = fakeBox();
      el.value = asElement(box);
      await nextTick();

      box.scrollHeight = 500;
      box.scrollTop = 100;
      onScroll();
      expect(stuck.value).toBe(false);

      box.scrollTop = 400;
      onScroll();
      expect(stuck.value).toBe(true);

      rows.value.push("later");
      box.scrollHeight = 560;
      await nextTick();
      await nextTick();

      expect(box.scrollTop).toBe(560);
    });
  });

  it("treats a near miss of a few pixels as still at the bottom", async () => {
    await withScope(async () => {
      const rows = ref<string[]>([]);
      const { el, onScroll, stuck } = useStickToBottom(() => rows.value.length);
      const box = fakeBox();
      el.value = asElement(box);
      await nextTick();

      // 12 px short of the end, which fractional scroll positions produce at
      // some zoom levels.
      box.scrollHeight = 500;
      box.scrollTop = 388;
      onScroll();
      expect(stuck.value).toBe(true);
    });
  });

  it("lands at the bottom the first time the box appears", async () => {
    await withScope(async () => {
      const rows = ref<string[]>(["already", "here"]);
      const { el } = useStickToBottom(() => rows.value.length);

      const box = fakeBox();
      box.scrollHeight = 300;
      el.value = asElement(box);
      await nextTick();
      await nextTick();

      expect(box.scrollTop).toBe(300);
    });
  });

  it("ignores appends while the box is not mounted", async () => {
    await withScope(async () => {
      const rows = ref<string[]>([]);
      const { el } = useStickToBottom(() => rows.value.length);

      rows.value.push("no box yet");
      await nextTick();
      await nextTick();

      expect(el.value).toBeNull();
    });
  });
});
