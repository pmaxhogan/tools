/**
 * FavoriteButton, and with it the prefs plumbing underneath it: the star has to
 * read what storage already holds, write what it toggles, and follow a change
 * made by another instance of itself on the same page.
 *
 * Needs a DOM, so it is a `.spec.ts`, which vitest.config.ts routes to the
 * "components" project (happy-dom plus the Vue plugin), rather than a
 * `.test.ts`, which runs in node. Run it directly with:
 *
 *   npx vitest run src/components/tool/FavoriteButton.spec.ts
 */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import FavoriteButton from "./FavoriteButton.vue";
import { FAVORITES_KEY } from "@/lib/favorites";
import { PREFS_CHANGE_EVENT, writeList } from "@/lib/prefs";

function stored(): string[] {
  return JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]") as string[];
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("FavoriteButton", () => {
  it("renders an unpressed star for a tool that is not pinned", () => {
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    const button = wrapper.get("button");
    expect(button.attributes("aria-pressed")).toBe("false");
    expect(button.attributes("aria-label")).toBe("Add to favorites");
    expect(button.attributes("data-favorite")).toBeUndefined();
  });

  it("reads what storage already holds on mount", async () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(["json-formatter"]));
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    // Storage is read in onMounted, so the pressed state lands one tick later.
    // That is deliberate: the first render has to match the static HTML.
    await wrapper.vm.$nextTick();
    const button = wrapper.get("button");
    expect(button.attributes("aria-pressed")).toBe("true");
    expect(button.attributes("aria-label")).toBe("Remove from favorites");
    expect(button.attributes("data-favorite")).toBe("true");
  });

  it("fills the star only when the tool is pinned", async () => {
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    expect(wrapper.get("svg").attributes("fill")).toBe("none");
    await wrapper.get("button").trigger("click");
    expect(wrapper.get("svg").attributes("fill")).toBe("currentColor");
  });

  it("pins on click and writes the slug to storage", async () => {
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    await wrapper.get("button").trigger("click");
    expect(stored()).toEqual(["json-formatter"]);
    expect(wrapper.get("button").attributes("aria-pressed")).toBe("true");
  });

  it("unpins on a second click", async () => {
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    await wrapper.get("button").trigger("click");
    await wrapper.get("button").trigger("click");
    expect(stored()).toEqual([]);
    expect(wrapper.get("button").attributes("aria-pressed")).toBe("false");
  });

  it("puts the newest pin first and keeps the others", async () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(["uuid-generator"]));
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    await wrapper.get("button").trigger("click");
    expect(stored()).toEqual(["json-formatter", "uuid-generator"]);
  });

  it("follows a change made elsewhere on the same page", async () => {
    const card = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    const header = mount(FavoriteButton, { props: { slug: "json-formatter" } });

    await header.get("button").trigger("click");
    await card.vm.$nextTick();

    expect(card.get("button").attributes("aria-pressed")).toBe("true");
    expect(header.get("button").attributes("aria-pressed")).toBe("true");
  });

  it("ignores a prefs-change for a different key", async () => {
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(["json-formatter"]));
    writeList("recent-tools", ["json-formatter"]);
    await wrapper.vm.$nextTick();
    // Still unpressed: the star only re-reads for its own key.
    expect(wrapper.get("button").attributes("aria-pressed")).toBe("false");
  });

  it("survives a stored value that is not a list of strings", async () => {
    localStorage.setItem(FAVORITES_KEY, '{"nope":1}');
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    await wrapper.vm.$nextTick();
    expect(wrapper.get("button").attributes("aria-pressed")).toBe("false");
  });

  it("stops listening once it unmounts", async () => {
    const wrapper = mount(FavoriteButton, { props: { slug: "json-formatter" } });
    wrapper.unmount();
    // No listener left to throw on a change after teardown.
    expect(() =>
      window.dispatchEvent(new CustomEvent(PREFS_CHANGE_EVENT, { detail: { key: FAVORITES_KEY } })),
    ).not.toThrow();
  });
});
