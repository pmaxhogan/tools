import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EmptyState from "./EmptyState.vue";

describe("EmptyState", () => {
  it("renders the title and the hint", () => {
    const wrapper = mount(EmptyState, {
      props: { title: "No file yet", hint: "Drop a GPX track to see its profile." },
    });
    expect(wrapper.text()).toContain("No file yet");
    expect(wrapper.text()).toContain("Drop a GPX track to see its profile.");
  });

  it("renders no icon when none is named", () => {
    const wrapper = mount(EmptyState, { props: { title: "Nothing here" } });
    expect(wrapper.find("svg").exists()).toBe(false);
  });

  it("resolves a lucide name to an icon", () => {
    const wrapper = mount(EmptyState, { props: { title: "Nothing here", icon: "FileSearch" } });
    const svg = wrapper.get("svg");
    expect(svg.attributes("aria-hidden")).toBe("true");
  });

  it("renders the actions slot", () => {
    const wrapper = mount(EmptyState, {
      props: { title: "Nothing here" },
      slots: { actions: '<button type="button">Load example</button>' },
    });
    expect(wrapper.text()).toContain("Load example");
  });

  it("keeps the inset well look", () => {
    const wrapper = mount(EmptyState, { props: { title: "Nothing here" } });
    expect(wrapper.classes()).toContain("bg-secondary");
    expect(wrapper.classes()).toContain("text-center");
  });
});
