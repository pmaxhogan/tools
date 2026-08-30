import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import KeyValueGrid from "./KeyValueGrid.vue";

describe("KeyValueGrid", () => {
  it("renders one row per record entry, in insertion order, with copy off", () => {
    const wrapper = mount(KeyValueGrid, {
      props: {
        record: { Name: "Ada Lovelace", Born: "1815" },
        copy: false,
      },
    });

    const keys = wrapper.findAll("dt").map((dt) => dt.text());
    const values = wrapper.findAll("dd").map((dd) => dd.text());

    expect(keys).toEqual(["Name", "Born"]);
    expect(values).toEqual(["Ada Lovelace", "1815"]);
    // copy: false must suppress the CopyButton entirely, not just hide it.
    expect(wrapper.findComponent({ name: "CopyButton" }).exists()).toBe(false);
  });

  it("renders nothing when the record is empty", () => {
    const wrapper = mount(KeyValueGrid, { props: { record: {} } });

    expect(wrapper.findAll("dt")).toHaveLength(0);
  });
});
