import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "monitor-test",
  matrixSlug: "monitor",
  icon: "Monitor",
  name: "Monitor Test Suite",
  description:
    "Check your display for dead and stuck pixels, backlight bleed, ghosting, gradient banding, gamma, and more with a full catalog of classic test patterns.",
  category: "Testers",
  keywords: [
    "monitor test",
    "dead pixel test",
    "backlight bleed test",
    "monitor ghosting test",
    "gradient banding test",
    "screen test online",
    "stuck pixel test",
  ],
  searchTerms: [
    "display test",
    "lcd test",
    "oled test",
    "pixel test",
    "screen calibration",
    "response time test",
    "gamma test",
    "color bars",
    "smpte bars",
    "checkerboard pattern",
    "contrast ratio test",
    "viewing angle test",
    "panel inversion test",
    "ufo test",
    "blur busters",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "test",
      label: "Test",
      default: "all",
      options: [
        { value: "all", label: "All tests (list)", synonyms: ["overview", "list all", "index"] },
      ],
      groups: [
        {
          label: "Solid colors and gray levels",
          synonyms: ["dead pixel", "stuck pixel", "gray ladder", "grayscale steps"],
          options: [
            {
              value: "solid-white",
              label: "Solid white",
              synonyms: ["white screen", "dead pixel test", "full white"],
            },
            {
              value: "solid-black",
              label: "Solid black",
              synonyms: ["black screen", "stuck pixel test", "full black"],
            },
            {
              value: "solid-red",
              label: "Solid red",
              synonyms: ["red screen", "red channel test"],
            },
            {
              value: "solid-green",
              label: "Solid green",
              synonyms: ["green screen", "green channel test"],
            },
            {
              value: "solid-blue",
              label: "Solid blue",
              synonyms: ["blue screen", "blue channel test"],
            },
            {
              value: "color-cycle",
              label: "Color cycle (dead and stuck pixel scan)",
              synonyms: ["dead pixel test", "stuck pixel test", "color flash test", "pixel checker"],
            },
            {
              value: "gray-0",
              label: "Gray 0%",
              synonyms: ["black gray step", "0 percent gray"],
            },
            {
              value: "gray-25",
              label: "Gray 25%",
              synonyms: ["quarter gray", "25 percent gray"],
            },
            {
              value: "gray-50",
              label: "Gray 50%",
              synonyms: ["mid gray", "50 percent gray", "midtone"],
            },
            {
              value: "gray-75",
              label: "Gray 75%",
              synonyms: ["three quarter gray", "75 percent gray"],
            },
            {
              value: "gray-100",
              label: "Gray 100%",
              synonyms: ["white gray step", "100 percent gray"],
            },
          ],
        },
        {
          label: "Gradients",
          synonyms: ["banding", "8 bit color", "10 bit color", "smooth gradient"],
          options: [
            {
              value: "gradient-gray",
              label: "Grayscale gradient (banding)",
              synonyms: ["black to white gradient", "gradient banding test", "step banding"],
            },
            {
              value: "gradient-color",
              label: "Color gradient (hue sweep)",
              synonyms: ["rainbow gradient", "hue banding", "color banding test"],
            },
          ],
        },
        {
          label: "Sharpness and uniformity patterns",
          synonyms: ["scaling", "native resolution", "pixel sharpness"],
          options: [
            {
              value: "uniformity-bleed",
              label: "Backlight bleed / uniformity",
              synonyms: ["backlight bleed test", "clouding", "ips glow", "flashlighting"],
            },
            {
              value: "checkerboard",
              label: "Checkerboard",
              synonyms: ["checker pattern", "scaling test", "moire test"],
            },
            {
              value: "grid-fine",
              label: "Fine 1px grid",
              synonyms: ["pixel grid", "1 pixel lines", "sharpness test", "native resolution test"],
            },
            {
              value: "inversion",
              label: "Inversion artifacts",
              synonyms: ["panel inversion test", "sparkle", "flicker test", "row column inversion"],
            },
          ],
        },
        {
          label: "Color and contrast patterns",
          synonyms: ["calibration", "color accuracy"],
          options: [
            {
              value: "color-bars",
              label: "Color bars (SMPTE-style)",
              synonyms: ["smpte bars", "test card", "reference color bars"],
            },
            {
              value: "contrast",
              label: "Contrast steps (near-black and near-white)",
              synonyms: ["contrast ratio test", "black crush test", "white clipping test"],
            },
            {
              value: "gamma-check",
              label: "Gamma check",
              synonyms: ["gamma 2.2 test", "gamma calibration", "gamma pattern"],
            },
            {
              value: "viewing-angle",
              label: "Viewing angle",
              synonyms: ["off angle color shift", "va panel test", "ips viewing angle"],
            },
          ],
        },
        {
          label: "Motion and text",
          synonyms: ["response time", "clarity"],
          options: [
            {
              value: "ghosting",
              label: "Ghosting / pixel response (UFO)",
              synonyms: ["ufo test", "ghosting test", "pixel response time", "trailing"],
            },
            {
              value: "motion-blur",
              label: "Motion blur",
              synonyms: ["blur busters", "sample and hold blur", "fast motion test"],
            },
            {
              value: "text-clarity",
              label: "Text clarity",
              synonyms: ["subpixel rendering test", "cleartype test", "font sharpness test"],
            },
          ],
        },
      ],
    },
    { kind: "boolean", id: "svg", label: "Include SVG preview", default: false },
  ],
  copy: {
    what: "A catalog of every classic monitor diagnostic pattern in one place: solid colors and a gray ladder for dead and stuck pixels, grayscale and color gradients for banding, a black field with a border for backlight bleed, checkerboard and a fine 1 pixel grid for scaling and sharpness, SMPTE-style color bars, near-black and near-white contrast steps, a gamma check with the matching formula, a viewing angle patch layout, panel inversion stripes, text clarity samples, and moving-block ghosting and motion blur tests.",
    how: "Pick a test from the list, or leave it on All tests to see the full catalog with a one-line purpose for each. Each test's instructions explain exactly what to look for and how to judge a pass or fail; turn on the SVG preview option to see the pattern itself alongside the description.",
    why: "Most monitor test sites are a single page of static images with no explanation of what a good result even looks like. This one pairs every pattern with plain instructions on what to look for, includes tests that are often missing elsewhere (panel inversion, viewing angle, a real gamma formula), and your files and inputs never leave your device.",
    faq: [
      {
        q: "How do I tell a dead pixel from a stuck pixel?",
        a: "Run the color cycle test and watch the same spot as the screen changes color. A dead pixel stays black through every color because it gets no power at all. A stuck pixel stays lit in one color, usually red, green, or blue, while the rest of the screen changes around it.",
      },
      {
        q: "Why does a gradient show visible bands instead of a smooth sweep?",
        a: "Most panels only drive 8 bits per color channel (256 shades), so a wide gradient like black to white can show visible steps between shades, especially when the panel or its driver skips dithering. A true 10-bit panel with proper dithering shows a much smoother sweep.",
      },
      {
        q: "Can a test pattern actually fix a dead or stuck pixel?",
        a: "The flashing color cycle test can sometimes coax a stuck subpixel back to normal by rapidly toggling it through every color, though it is not guaranteed and may take several minutes of running. A truly dead pixel receives no power at all, so no test pattern, however long it runs, can fix it.",
      },
    ],
  },
};
