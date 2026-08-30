import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ErrorBanner from "./ErrorBanner.vue";

describe("ErrorBanner", () => {
  it("renders the message with the alert role by default", () => {
    const wrapper = mount(ErrorBanner, { props: { message: "That file is not a PNG." } });
    expect(wrapper.text()).toContain("That file is not a PNG.");
    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.attributes("aria-live")).toBe("polite");
    expect(wrapper.classes()).toContain("bg-destructive/10");
  });

  it("renders a title above the message and the fix hint below it", () => {
    const wrapper = mount(ErrorBanner, {
      props: {
        title: "The image could not be read",
        message: "The bytes stop before the end of the file.",
        hint: "Re-export it and try again.",
      },
    });
    const text = wrapper.text();
    expect(text).toContain("The image could not be read");
    expect(text).toContain("The bytes stop before the end of the file.");
    expect(text).toContain("Re-export it and try again.");
  });

  it("uses the status role for warning and info", () => {
    const warning = mount(ErrorBanner, { props: { message: "Large file.", variant: "warning" } });
    expect(warning.attributes("role")).toBe("status");
    expect(warning.classes()).toContain("bg-amber-500/10");

    const info = mount(ErrorBanner, { props: { message: "Nothing to do.", variant: "info" } });
    expect(info.attributes("role")).toBe("status");
    expect(info.classes()).toContain("bg-secondary/60");
  });

  it("emits dismiss only when dismissible", async () => {
    const plain = mount(ErrorBanner, { props: { message: "Broken." } });
    expect(plain.find('[aria-label="Dismiss this message"]').exists()).toBe(false);

    const wrapper = mount(ErrorBanner, { props: { message: "Broken.", dismissible: true } });
    await wrapper.get('[aria-label="Dismiss this message"]').trigger("click");
    expect(wrapper.emitted("dismiss")).toHaveLength(1);
  });

  it("appends the default slot below the message", () => {
    const wrapper = mount(ErrorBanner, {
      props: { message: "Broken." },
      slots: { default: '<button type="button">Retry</button>' },
    });
    expect(wrapper.text()).toContain("Retry");
  });
});
