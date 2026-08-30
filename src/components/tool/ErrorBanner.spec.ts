import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
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

  it("renders an engine message in the mono face when asked", () => {
    const plain = mount(ErrorBanner, { props: { message: 'near "SELCT": syntax error' } });
    expect(plain.get("p").classes()).not.toContain("font-mono");

    const wrapper = mount(ErrorBanner, {
      props: { message: 'near "SELCT": syntax error', mono: true },
    });
    const message = wrapper.get("p");
    expect(message.classes()).toContain("font-mono");
    expect(message.text()).toBe('near "SELCT": syntax error');
  });

  it("appends the default slot below the message", () => {
    const wrapper = mount(ErrorBanner, {
      props: { message: "Broken." },
      slots: { default: '<button type="button">Retry</button>' },
    });
    expect(wrapper.text()).toContain("Retry");
    expect(wrapper.find(".mt-2").exists()).toBe(true);
  });

  it("leaves out the slot wrapper when no slot is passed", () => {
    const wrapper = mount(ErrorBanner, { props: { message: "Broken." } });
    expect(wrapper.find(".mt-2").exists()).toBe(false);
  });

  it("leaves out the slot wrapper when the slot renders nothing", () => {
    // A `v-if` that fails still hands the slot down as a comment placeholder,
    // which used to be enough to draw the wrapper and its empty mt-2 gap.
    const conditional = mount(ErrorBanner, {
      props: { message: "Broken." },
      slots: { default: '<button v-if="false" type="button">Retry</button>' },
    });
    expect(conditional.find(".mt-2").exists()).toBe(false);

    const whitespace = mount(ErrorBanner, {
      props: { message: "Broken." },
      slots: { default: "   " },
    });
    expect(whitespace.find(".mt-2").exists()).toBe(false);
  });

  it("follows a slot that appears and disappears after mount", async () => {
    const host = defineComponent({
      components: { ErrorBanner },
      props: { show: { type: Boolean, default: false } },
      template: `<ErrorBanner message="Broken."><button v-if="show" type="button">Retry</button></ErrorBanner>`,
    });

    const wrapper = mount(host);
    expect(wrapper.find(".mt-2").exists()).toBe(false);

    await wrapper.setProps({ show: true });
    expect(wrapper.find(".mt-2").exists()).toBe(true);

    await wrapper.setProps({ show: false });
    expect(wrapper.find(".mt-2").exists()).toBe(false);
  });

  it("draws the wrapper for slot text and for a rendered v-if", () => {
    const text = mount(ErrorBanner, {
      props: { message: "Broken." },
      slots: { default: "Try a smaller file." },
    });
    expect(text.find(".mt-2").exists()).toBe(true);

    const shown = mount(ErrorBanner, {
      props: { message: "Broken." },
      slots: { default: '<button v-if="true" type="button">Retry</button>' },
    });
    expect(shown.find(".mt-2").exists()).toBe(true);
  });
});
