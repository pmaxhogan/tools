import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ProgressBar from "./ProgressBar.vue";

describe("ProgressBar", () => {
  it("reports the value to assistive tech and fills the track", () => {
    const wrapper = mount(ProgressBar, { props: { value: 42 } });
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes("aria-valuenow")).toBe("42");
    expect(bar.attributes("aria-valuemin")).toBe("0");
    expect(bar.attributes("aria-valuemax")).toBe("100");
    expect(bar.get("div").attributes("style")).toContain("width: 42%");
  });

  it("clamps a value outside 0 to 100", () => {
    expect(
      mount(ProgressBar, { props: { value: 140 } })
        .get('[role="progressbar"] div')
        .attributes("style"),
    ).toContain("width: 100%");
    expect(
      mount(ProgressBar, { props: { value: -12 } })
        .get('[role="progressbar"] div')
        .attributes("style"),
    ).toContain("width: 0%");
  });

  it("drops aria-valuenow and shows the stripe when indeterminate", () => {
    const wrapper = mount(ProgressBar);
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes("aria-valuenow")).toBeUndefined();
    expect(bar.get("div").classes()).toContain("stripe");
  });

  it("renders the label and the right hand detail", () => {
    const wrapper = mount(ProgressBar, {
      props: { value: 25, label: "Reading files", detail: "3 of 12" },
    });
    expect(wrapper.text()).toContain("Reading files");
    expect(wrapper.text()).toContain("3 of 12");
    expect(wrapper.get('[role="progressbar"]').attributes("aria-label")).toBe("Reading files");
  });

  it("falls back to a generic aria-label and takes the small size", () => {
    const wrapper = mount(ProgressBar, { props: { value: 10, size: "sm" } });
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes("aria-label")).toBe("Progress");
    expect(bar.classes()).toContain("h-1.5");
  });

  it("names a captionless bar from ariaLabel", () => {
    const wrapper = mount(ProgressBar, { props: { value: 10, ariaLabel: "Encoding video" } });
    expect(wrapper.get('[role="progressbar"]').attributes("aria-label")).toBe("Encoding video");
    // No caption row, so nothing visible was added alongside it.
    expect(wrapper.text()).toBe("");
  });

  it("lets ariaLabel spell out a terse visible label", () => {
    const wrapper = mount(ProgressBar, {
      props: { value: 10, label: "Pass 2", ariaLabel: "Encoding, pass 2 of 2" },
    });
    expect(wrapper.get('[role="progressbar"]').attributes("aria-label")).toBe(
      "Encoding, pass 2 of 2",
    );
    expect(wrapper.text()).toContain("Pass 2");
  });

  it("takes the contrasting track and a tone for the fill", () => {
    const plain = mount(ProgressBar, { props: { value: 10 } });
    expect(plain.get('[role="progressbar"]').classes()).toContain("bg-secondary");
    expect(plain.get('[role="progressbar"] div').classes()).toContain(
      "bg-[image:var(--grad-brand)]",
    );

    const wrapper = mount(ProgressBar, {
      props: { value: 10, track: "card", tone: "destructive" },
    });
    expect(wrapper.get('[role="progressbar"]').classes()).toContain("bg-card");
    expect(wrapper.get('[role="progressbar"]').classes()).not.toContain("bg-secondary");
    expect(wrapper.get('[role="progressbar"] div').classes()).toContain("bg-destructive");
  });

  it("tones the indeterminate stripe too", () => {
    const wrapper = mount(ProgressBar, { props: { tone: "success" } });
    const stripe = wrapper.get('[role="progressbar"] div');
    expect(stripe.classes()).toContain("stripe");
    expect(stripe.classes()).toContain("bg-[color:var(--positive)]");
  });
});
