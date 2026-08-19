import { ToolError, type ToolLogic } from "../types";

/**
 * Monitor Test Suite: a catalog of classic display-diagnostic patterns (dead
 * and stuck pixels, backlight bleed, gradient banding, ghosting, gamma, and
 * so on). This file only knows how to describe each test and render its
 * static SVG preview; the fullscreen, keyboard-driven, canvas-animated panel
 * that actually walks a user through them lives outside this pure logic
 * layer (rule 27), which never touches fullscreen APIs, canvas, rAF, or the
 * DOM.
 */

/** Which family of rendering a test needs. Motion tests only get a static
 * preview frame here; the panel draws the real animation on canvas. */
export type MonitorTestKind = "solid" | "gradient" | "pattern" | "motion" | "text";

/** One diagnostic test in the suite. `params` is the data the (future) panel
 * needs to actually run the test: colors, speeds, step counts, and so on. */
export interface MonitorTest {
  id: string;
  label: string;
  /** One-line summary of what the test is for, shown in the test list. */
  purpose: string;
  /** What to look for and how to judge a pass/fail, shown for a single test. */
  instructions: string;
  kind: MonitorTestKind;
  params: Record<string, unknown>;
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 450;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Converts a 0..100 gray percent to a #rrggbb hex string. */
function grayHex(percent: number): string {
  const v = Math.round((percent / 100) * 255);
  const h = v.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

/* ------------------------------------------------------------------ *
 * the test catalog
 * ------------------------------------------------------------------ */

export const TESTS: MonitorTest[] = [
  // -- solid colors --------------------------------------------------
  {
    id: "solid-white",
    label: "Solid white",
    purpose: "Full white screen: spot dark or dead subpixels and panel discoloration.",
    instructions:
      "Fill the whole screen with pure white and look closely, corner to corner, for any pixel that stays darker than its neighbors, and for an overall color tint (pink, green, or blue cast) that points at panel discoloration or backlight aging.",
    kind: "solid",
    params: { color: "#ffffff" },
  },
  {
    id: "solid-black",
    label: "Solid black",
    purpose: "Full black screen: spot bright stuck subpixels and light leaking through.",
    instructions:
      "Fill the whole screen with pure black in a dark room and look for any pixel or subpixel that glows red, green, or blue (a stuck pixel), and for any patches of gray light bleeding in from the edges (backlight bleed).",
    kind: "solid",
    params: { color: "#000000" },
  },
  {
    id: "solid-red",
    label: "Solid red",
    purpose: "Full red screen: isolate the red subpixel channel for dead or stuck pixels.",
    instructions:
      "Fill the whole screen with pure red. A dead pixel shows as a black dot; a stuck pixel shows as a dot that stays a different color (white, green, or blue) instead of red.",
    kind: "solid",
    params: { color: "#ff0000" },
  },
  {
    id: "solid-green",
    label: "Solid green",
    purpose: "Full green screen: isolate the green subpixel channel for dead or stuck pixels.",
    instructions:
      "Fill the whole screen with pure green. Green is the channel the eye is most sensitive to, so this pass tends to catch subpixel problems the other solid colors miss.",
    kind: "solid",
    params: { color: "#00ff00" },
  },
  {
    id: "solid-blue",
    label: "Solid blue",
    purpose: "Full blue screen: isolate the blue subpixel channel for dead or stuck pixels.",
    instructions:
      "Fill the whole screen with pure blue and scan the panel again. Comparing all three solid colors against the same spot tells you whether a stuck pixel is missing one subpixel or all three.",
    kind: "solid",
    params: { color: "#0000ff" },
  },
  {
    id: "color-cycle",
    label: "Color cycle (dead and stuck pixel scan)",
    purpose: "Cycles white, black, red, green, blue, cyan, magenta, and yellow full screen.",
    instructions:
      "Step through each solid color full screen in turn, pausing on each one to scan the whole panel. A spot that never changes color while everything around it does is either dead (stays black) or stuck (stays one color). The flashing sequence can sometimes unstick a stuck pixel, but it never repairs a dead one.",
    kind: "solid",
    params: {
      colors: [
        "#ffffff",
        "#000000",
        "#ff0000",
        "#00ff00",
        "#0000ff",
        "#00ffff",
        "#ff00ff",
        "#ffff00",
      ],
      intervalMs: 2000,
    },
  },
  // -- gray levels ------------------------------------------------------
  {
    id: "gray-0",
    label: "Gray 0%",
    purpose: "Solid black reference patch for the gray step ladder.",
    instructions:
      "This is the 0 percent step of the gray ladder (identical to solid black). Use it alongside the other gray steps to judge how evenly the panel renders each shade.",
    kind: "solid",
    params: { color: grayHex(0), percent: 0 },
  },
  {
    id: "gray-25",
    label: "Gray 25%",
    purpose: "Quarter-brightness gray patch for the gray step ladder.",
    instructions:
      "Fill the screen with a flat 25 percent gray and look for banding, blotchiness, or uneven brightness across the panel rather than a single smooth tone.",
    kind: "solid",
    params: { color: grayHex(25), percent: 25 },
  },
  {
    id: "gray-50",
    label: "Gray 50%",
    purpose: "Mid-gray patch for the gray step ladder, also used by the gamma check.",
    instructions:
      "Fill the screen with a flat 50 percent gray. This is the most sensitive brightness for spotting uneven backlighting, since the eye notices small differences best around mid-tones.",
    kind: "solid",
    params: { color: grayHex(50), percent: 50 },
  },
  {
    id: "gray-75",
    label: "Gray 75%",
    purpose: "Three-quarter-brightness gray patch for the gray step ladder.",
    instructions:
      "Fill the screen with a flat 75 percent gray and check the same trouble spots you saw at other gray levels; a blemish that only shows up at one brightness usually points at a backlight zone, not a full panel defect.",
    kind: "solid",
    params: { color: grayHex(75), percent: 75 },
  },
  {
    id: "gray-100",
    label: "Gray 100%",
    purpose: "Solid white reference patch for the gray step ladder.",
    instructions:
      "This is the 100 percent step of the gray ladder (identical to solid white), included so the ladder runs black to white in five even steps.",
    kind: "solid",
    params: { color: grayHex(100), percent: 100 },
  },
  // -- gradients ---------------------------------------------------------
  {
    id: "gradient-gray",
    label: "Grayscale gradient (banding)",
    purpose: "Smooth black to white sweep: reveals gradient banding and 8-bit steps.",
    instructions:
      "Watch the sweep from black to white for visible steps or bands instead of a smooth ramp. Hard bands usually mean 8-bit color plus dithering off, or a panel that cannot really drive the color depth it claims.",
    kind: "gradient",
    params: {
      from: "#000000",
      to: "#ffffff",
      direction: "horizontal",
      steps: 256,
      dither: true,
    },
  },
  {
    id: "gradient-color",
    label: "Color gradient (hue sweep)",
    purpose: "Full-hue rainbow sweep: reveals banding and hue shift across color transitions.",
    instructions:
      "Watch the rainbow sweep for hard color bands, especially in the yellow to green and cyan to blue transitions, where cheap panels tend to band first.",
    kind: "gradient",
    params: {
      stops: ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ff0000"],
      direction: "horizontal",
    },
  },
  // -- patterns ------------------------------------------------------------
  {
    id: "uniformity-bleed",
    label: "Backlight bleed / uniformity",
    purpose: "Black field with a dim border frame: reveals backlight bleed at the edges.",
    instructions:
      "In a dark room, look at the edges and corners of the black screen for patches of gray or yellow light leaking through (backlight bleed) rather than staying uniformly black all the way to the frame.",
    kind: "pattern",
    params: {
      patternType: "uniformity",
      fill: "#000000",
      borderColor: "#333333",
      borderWidthPx: 24,
    },
  },
  {
    id: "checkerboard",
    label: "Checkerboard",
    purpose: "Alternating black and white squares: checks scaling and sharpness.",
    instructions:
      "Look for moire patterns, blurred edges between squares, or squares that are not perfectly square, which point at incorrect scaling (the panel is not running its native resolution) or a soft focus.",
    kind: "pattern",
    params: { patternType: "checkerboard", cellPx: 40, colorA: "#000000", colorB: "#ffffff" },
  },
  {
    id: "grid-fine",
    label: "Fine 1px grid",
    purpose: "One-pixel-wide grid lines: checks native resolution and pixel sharpness.",
    instructions:
      "Every line should be a crisp single pixel, evenly spaced in both directions. Fuzzy, doubled, or unevenly spaced lines mean the display is scaling the image rather than showing it at native resolution.",
    kind: "pattern",
    params: {
      patternType: "grid",
      spacingPx: 10,
      lineWidthPx: 1,
      lineColor: "#000000",
      background: "#ffffff",
    },
  },
  {
    id: "color-bars",
    label: "Color bars (SMPTE-style)",
    purpose: "Seven vertical reference bars: checks color accuracy and separation.",
    instructions:
      "Compare the seven bars (white, yellow, cyan, green, magenta, red, blue) against a reference image or known good display. Muddy separation between adjacent bars suggests poor color accuracy or a low-quality panel.",
    kind: "pattern",
    params: {
      patternType: "color-bars",
      bars: ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"],
    },
  },
  {
    id: "contrast",
    label: "Contrast steps (near-black and near-white)",
    purpose: "1 to 10 percent patches near black and near white: checks contrast detail.",
    instructions:
      "Count how many of the ten numbered patches you can tell apart from the background in each row. Losing detail near black means crushed shadows; losing detail near white means clipped highlights.",
    kind: "pattern",
    params: {
      patternType: "contrast",
      blackSteps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      whiteSteps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
  },
  {
    id: "gamma-check",
    label: "Gamma check",
    purpose: "50% gray next to a black/white line pattern: measures effective gamma.",
    instructions:
      "From a normal viewing distance, the striped 1 pixel black and white pattern should optically blend into the same gray as the solid patch next to it when gamma is exactly 2.2. Step the striped pattern's gray level in the panel until the two match, then feed that fraction into gammaFromMatch to see your measured gamma.",
    kind: "pattern",
    params: { patternType: "gamma", grayPercent: 50, targetGamma: 2.2 },
  },
  {
    id: "viewing-angle",
    label: "Viewing angle",
    purpose: "Identical gray patches at five screen positions: checks off-angle color shift.",
    instructions:
      "All five patches are the same gray. View the screen from an angle, off to the side or from above and below, and see which patches shift in brightness or color first. A panel with poor viewing angles will show the corner patches darkening or discoloring long before the center one does.",
    kind: "pattern",
    params: {
      patternType: "viewing-angle",
      grayPercent: 50,
      positions: ["Center", "Top left", "Top right", "Bottom left", "Bottom right"],
    },
  },
  {
    id: "inversion",
    label: "Inversion artifacts",
    purpose: "Near-identical gray stripes: reveals row/column inversion errors and flicker.",
    instructions:
      "The stripes are two grays so close together they should look almost flat. Sparkle, flicker, or a checkerboard shimmer instead of a calm near-solid field points at panel inversion artifacts, most visible on older or lower-quality LCD panels.",
    kind: "pattern",
    params: { patternType: "inversion", colorA: "#7a7a7a", colorB: "#858585", stripeWidthPx: 4 },
  },
  // -- text -----------------------------------------------------------
  {
    id: "text-clarity",
    label: "Text clarity",
    purpose: "Small text at several sizes: checks subpixel rendering and sharpness.",
    instructions:
      "Read each line without leaning in. Fringed colors around letter edges, blurring, or text that is only readable at the larger sizes points at subpixel rendering problems, incorrect scaling, or a soft panel.",
    kind: "text",
    params: {
      lines: [
        "The quick brown fox jumps over the lazy dog.",
        "0123456789 ABCDEFGHIJKLM abcdefghijklm",
        "Hamburgefonstiv 8pt 10pt 12pt 16pt 24pt",
      ],
      sizesPx: [8, 10, 12, 16, 24],
    },
  },
  // -- motion -----------------------------------------------------------
  {
    id: "ghosting",
    label: "Ghosting / pixel response (UFO)",
    purpose: "A block moves across the screen: reveals ghosting and slow pixel response.",
    instructions:
      "Watch the moving block. A trailing smear, a faded duplicate, or streaking behind it is ghosting caused by slow pixel response time. Try a slower speed first, then increase it: ghosting usually gets worse as the block moves faster.",
    kind: "motion",
    params: {
      blockSizePx: 60,
      speedPxPerFrame: 6,
      direction: "horizontal",
      background: "#000000",
      blockColor: "#ffffff",
    },
  },
  {
    id: "motion-blur",
    label: "Motion blur",
    purpose: "A fast-moving colored block: checks perceived motion blur at higher speeds.",
    instructions:
      "Increase the speed until the block is moving quickly, and watch how much it smears versus staying sharp. Sample-and-hold displays (most LCD and OLED panels without black frame insertion) will always show some blur; excessive blur at moderate speeds suggests a slow response time or a low refresh rate.",
    kind: "motion",
    params: {
      blockSizePx: 80,
      speedPxPerFrame: 12,
      direction: "horizontal",
      background: "#808080",
      blockColor: "#ff0000",
    },
  },
];

/* ------------------------------------------------------------------ *
 * lookup
 * ------------------------------------------------------------------ */

function badTestError(id: string): ToolError {
  return new ToolError(
    "bad-test",
    `Unknown test "${id}".`,
    `Choose one of: ${TESTS.map((t) => t.id).join(", ")}.`,
  );
}

function findTest(id: string): MonitorTest {
  const test = TESTS.find((t) => t.id === id);
  if (!test) throw badTestError(id);
  return test;
}

/** Full detail for one test, as labeled rows. */
export function describeTest(testId: string): Record<string, string> {
  const test = findTest(testId);
  return {
    Label: test.label,
    Kind: test.kind,
    Purpose: test.purpose,
    Instructions: test.instructions,
  };
}

/* ------------------------------------------------------------------ *
 * gamma math
 * ------------------------------------------------------------------ */

/**
 * Derives the display's effective gamma from the gray fraction (0..1,
 * exclusive) that visually matches the dithered black/white stripe pattern
 * in the gamma check test. A correctly calibrated 2.2 gamma display matches
 * around 0.729; a match at exactly 0.5 means an (unusual) gamma of 1.
 */
export function gammaFromMatch(matchedGray: number): number {
  if (!Number.isFinite(matchedGray) || matchedGray <= 0 || matchedGray >= 1) {
    throw new ToolError(
      "bad-gamma-input",
      `The matched gray value must be a number between 0 and 1 (exclusive), got ${matchedGray}.`,
      "Enter the fraction of full white (0 to 1) where the striped pattern visually matches the solid gray patch, for example 0.5.",
    );
  }
  return Math.log(0.5) / Math.log(matchedGray);
}

/* ------------------------------------------------------------------ *
 * SVG rendering (deterministic, static preview for every test)
 * ------------------------------------------------------------------ */

function svgWrap(width: number, height: number, body: string): string {
  return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function clampDim(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSolidBody(test: MonitorTest, width: number, height: number): string {
  const colors = Array.isArray(test.params.colors)
    ? (test.params.colors as string[])
    : [String(test.params.color ?? "#808080")];

  if (colors.length === 1) {
    return `<rect x="0" y="0" width="${width}" height="${height}" fill="${colors[0]}"/>`;
  }

  // A cycle test: show every color as an equal-width swatch strip so the
  // static preview still communicates the full sequence.
  const swatchWidth = width / colors.length;
  return colors
    .map(
      (c, i) =>
        `<rect x="${Math.round(i * swatchWidth)}" y="0" width="${Math.ceil(swatchWidth) + 1}" height="${height}" fill="${c}"/>`,
    )
    .join("");
}

function renderGradientBody(test: MonitorTest, width: number, height: number): string {
  const gradId = `grad-${test.id}`;
  const direction = test.params.direction === "vertical" ? "vertical" : "horizontal";
  const x2 = direction === "horizontal" ? "100%" : "0%";
  const y2 = direction === "horizontal" ? "0%" : "100%";

  let stops: string[];
  if (Array.isArray(test.params.stops)) {
    const colors = test.params.stops as string[];
    stops = colors.map((c, i) => {
      const offset = colors.length > 1 ? (i / (colors.length - 1)) * 100 : 0;
      return `<stop offset="${offset}%" stop-color="${c}"/>`;
    });
  } else {
    const from = String(test.params.from ?? "#000000");
    const to = String(test.params.to ?? "#ffffff");
    stops = [`<stop offset="0%" stop-color="${from}"/>`, `<stop offset="100%" stop-color="${to}"/>`];
  }

  const defs = `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="${x2}" y2="${y2}">${stops.join("")}</linearGradient></defs>`;
  const rect = `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${gradId})"/>`;

  // Optional subtle dither overlay: a fine checker of near-transparent white
  // on top, deterministic (no randomness) so the banding test approximates
  // a smoother sweep on 8-bit panels without breaking test determinism.
  let ditherOverlay = "";
  if (test.params.dither === true) {
    const patId = `dither-${test.id}`;
    ditherOverlay =
      `<defs><pattern id="${patId}" width="2" height="2" patternUnits="userSpaceOnUse">` +
      `<rect width="1" height="1" fill="#ffffff" fill-opacity="0.02"/>` +
      `<rect x="1" y="1" width="1" height="1" fill="#000000" fill-opacity="0.02"/>` +
      `</pattern></defs>` +
      `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${patId})"/>`;
  }

  return defs + rect + ditherOverlay;
}

function renderUniformityBody(test: MonitorTest, width: number, height: number): string {
  const fill = String(test.params.fill ?? "#000000");
  const borderColor = String(test.params.borderColor ?? "#333333");
  const borderWidth = Number(test.params.borderWidthPx ?? 24);
  return (
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${fill}"/>` +
    `<rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${width - borderWidth}" height="${height - borderWidth}" fill="none" stroke="${borderColor}" stroke-width="${borderWidth}"/>`
  );
}

function renderCheckerboardBody(test: MonitorTest, width: number, height: number): string {
  const cell = Number(test.params.cellPx ?? 40);
  const colorA = String(test.params.colorA ?? "#000000");
  const colorB = String(test.params.colorB ?? "#ffffff");
  const patId = `checker-${test.id}`;
  return (
    `<defs><pattern id="${patId}" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">` +
    `<rect width="${cell * 2}" height="${cell * 2}" fill="${colorB}"/>` +
    `<rect x="0" y="0" width="${cell}" height="${cell}" fill="${colorA}"/>` +
    `<rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="${colorA}"/>` +
    `</pattern></defs>` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${patId})"/>`
  );
}

function renderGridBody(test: MonitorTest, width: number, height: number): string {
  const spacing = Number(test.params.spacingPx ?? 10);
  const lineWidth = Number(test.params.lineWidthPx ?? 1);
  const lineColor = String(test.params.lineColor ?? "#000000");
  const background = String(test.params.background ?? "#ffffff");
  const patId = `grid-${test.id}`;
  return (
    `<defs><pattern id="${patId}" width="${spacing}" height="${spacing}" patternUnits="userSpaceOnUse">` +
    `<rect width="${spacing}" height="${spacing}" fill="${background}"/>` +
    `<rect x="0" y="0" width="${spacing}" height="${lineWidth}" fill="${lineColor}"/>` +
    `<rect x="0" y="0" width="${lineWidth}" height="${spacing}" fill="${lineColor}"/>` +
    `</pattern></defs>` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${patId})"/>`
  );
}

function renderColorBarsBody(test: MonitorTest, width: number, height: number): string {
  const bars = Array.isArray(test.params.bars) ? (test.params.bars as string[]) : [];
  const barWidth = width / Math.max(1, bars.length);
  return bars
    .map(
      (c, i) =>
        `<rect x="${Math.round(i * barWidth)}" y="0" width="${Math.ceil(barWidth) + 1}" height="${height}" fill="${c}"/>`,
    )
    .join("");
}

function renderContrastBody(test: MonitorTest, width: number, height: number): string {
  const blackSteps = Array.isArray(test.params.blackSteps)
    ? (test.params.blackSteps as number[])
    : [];
  const whiteSteps = Array.isArray(test.params.whiteSteps)
    ? (test.params.whiteSteps as number[])
    : [];
  const rowHeight = height / 2;
  const patchWidth = width / Math.max(1, blackSteps.length);

  // Near-black row: patches step up from black by percent, on a black field.
  const blackRow = blackSteps
    .map((pct, i) => {
      const x = Math.round(i * patchWidth);
      const fill = grayHex(pct);
      return (
        `<rect x="${x}" y="0" width="${Math.ceil(patchWidth) + 1}" height="${rowHeight}" fill="${fill}"/>` +
        `<text x="${x + patchWidth / 2}" y="${rowHeight - 6}" font-size="10" fill="#ffffff" text-anchor="middle">${pct}%</text>`
      );
    })
    .join("");

  // Near-white row: patches step down from white by percent, on a white field.
  const whiteRow = whiteSteps
    .map((pct, i) => {
      const x = Math.round(i * patchWidth);
      const fill = grayHex(100 - pct);
      return (
        `<rect x="${x}" y="${rowHeight}" width="${Math.ceil(patchWidth) + 1}" height="${rowHeight}" fill="${fill}"/>` +
        `<text x="${x + patchWidth / 2}" y="${height - 6}" font-size="10" fill="#000000" text-anchor="middle">${pct}%</text>`
      );
    })
    .join("");

  const backdrop = `<rect x="0" y="0" width="${width}" height="${rowHeight}" fill="#000000"/><rect x="0" y="${rowHeight}" width="${width}" height="${rowHeight}" fill="#ffffff"/>`;
  return backdrop + blackRow + whiteRow;
}

function renderGammaBody(test: MonitorTest, width: number, height: number): string {
  const grayPercent = Number(test.params.grayPercent ?? 50);
  const half = width / 2;
  const solid = `<rect x="0" y="0" width="${half}" height="${height}" fill="${grayHex(grayPercent)}"/>`;
  const patId = `gamma-stripe-${test.id}`;
  const stripes =
    `<defs><pattern id="${patId}" width="2" height="2" patternUnits="userSpaceOnUse">` +
    `<rect width="1" height="2" fill="#000000"/>` +
    `<rect x="1" width="1" height="2" fill="#ffffff"/>` +
    `</pattern></defs>` +
    `<rect x="${half}" y="0" width="${half}" height="${height}" fill="url(#${patId})"/>`;
  return solid + stripes;
}

function renderViewingAngleBody(test: MonitorTest, width: number, height: number): string {
  const grayPercent = Number(test.params.grayPercent ?? 50);
  const positions = Array.isArray(test.params.positions)
    ? (test.params.positions as string[])
    : ["Center", "Top left", "Top right", "Bottom left", "Bottom right"];
  const fill = grayHex(grayPercent);
  const patchW = width / 4;
  const patchH = height / 4;
  const coords: [number, number][] = [
    [width / 2 - patchW / 2, height / 2 - patchH / 2], // center
    [0, 0], // top left
    [width - patchW, 0], // top right
    [0, height - patchH], // bottom left
    [width - patchW, height - patchH], // bottom right
  ];
  const background = `<rect x="0" y="0" width="${width}" height="${height}" fill="#1a1a1a"/>`;
  const patches = coords
    .slice(0, positions.length)
    .map(
      ([x, y], i) =>
        `<rect x="${x}" y="${y}" width="${patchW}" height="${patchH}" fill="${fill}"/>` +
        `<text x="${x + patchW / 2}" y="${y + patchH / 2}" font-size="11" fill="#888888" text-anchor="middle">${escapeXml(positions[i] ?? "")}</text>`,
    )
    .join("");
  return background + patches;
}

function renderInversionBody(test: MonitorTest, width: number, height: number): string {
  const colorA = String(test.params.colorA ?? "#7a7a7a");
  const colorB = String(test.params.colorB ?? "#858585");
  const stripeWidth = Number(test.params.stripeWidthPx ?? 4);
  const patId = `inversion-${test.id}`;
  return (
    `<defs><pattern id="${patId}" width="${stripeWidth * 2}" height="${stripeWidth * 2}" patternUnits="userSpaceOnUse">` +
    `<rect width="${stripeWidth}" height="${stripeWidth * 2}" fill="${colorA}"/>` +
    `<rect x="${stripeWidth}" width="${stripeWidth}" height="${stripeWidth * 2}" fill="${colorB}"/>` +
    `</pattern></defs>` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${patId})"/>`
  );
}

const PATTERN_RENDERERS: Record<
  string,
  (test: MonitorTest, width: number, height: number) => string
> = {
  uniformity: renderUniformityBody,
  checkerboard: renderCheckerboardBody,
  grid: renderGridBody,
  "color-bars": renderColorBarsBody,
  contrast: renderContrastBody,
  gamma: renderGammaBody,
  "viewing-angle": renderViewingAngleBody,
  inversion: renderInversionBody,
};

function renderPatternBody(test: MonitorTest, width: number, height: number): string {
  const patternType = String(test.params.patternType ?? "");
  const renderer = PATTERN_RENDERERS[patternType];
  if (!renderer) {
    // Unknown pattern subtype: still return a valid, honest placeholder
    // rather than throwing, since the id itself was already validated.
    return `<rect x="0" y="0" width="${width}" height="${height}" fill="#808080"/>`;
  }
  return renderer(test, width, height);
}

function renderTextBody(test: MonitorTest, width: number, height: number): string {
  const lines = Array.isArray(test.params.lines) ? (test.params.lines as string[]) : [];
  const sizes = Array.isArray(test.params.sizesPx) ? (test.params.sizesPx as number[]) : [12];
  const background = `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`;
  let y = 24;
  const rows: string[] = [];
  for (const size of sizes) {
    const line = lines[rows.length % Math.max(1, lines.length)] ?? "Sample text";
    rows.push(
      `<text x="16" y="${y}" font-size="${size}" fill="#000000" font-family="sans-serif">${escapeXml(line)}</text>`,
    );
    y += size + 12;
  }
  return background + rows.join("");
}

function renderMotionBody(test: MonitorTest, width: number, height: number): string {
  // Static reference frame: the block at its start position, plus an arrow
  // hinting at the direction of travel. The panel draws the real animation.
  const background = String(test.params.background ?? "#000000");
  const blockColor = String(test.params.blockColor ?? "#ffffff");
  const blockSize = Number(test.params.blockSizePx ?? 60);
  const direction = test.params.direction === "vertical" ? "vertical" : "horizontal";
  const bg = `<rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>`;
  const x = direction === "horizontal" ? Math.max(0, width * 0.1) : width / 2 - blockSize / 2;
  const y = direction === "horizontal" ? height / 2 - blockSize / 2 : Math.max(0, height * 0.1);
  const block = `<rect x="${x}" y="${y}" width="${blockSize}" height="${blockSize}" fill="${blockColor}"/>`;
  const arrow =
    direction === "horizontal"
      ? `<text x="${width / 2}" y="${height - 12}" font-size="12" fill="${blockColor}" text-anchor="middle">moves left to right at the chosen speed</text>`
      : `<text x="${width / 2}" y="${height - 12}" font-size="12" fill="${blockColor}" text-anchor="middle">moves top to bottom at the chosen speed</text>`;
  return bg + block + arrow;
}

/**
 * Renders the deterministic static SVG preview for one test. Motion tests
 * get a single reference frame (the block at its start position); every
 * other kind renders the full static pattern.
 */
export function renderPatternSvg(
  testId: string,
  opts: { width: number; height: number },
): string {
  const test = findTest(testId);
  const width = clampDim(opts?.width, DEFAULT_WIDTH);
  const height = clampDim(opts?.height, DEFAULT_HEIGHT);

  let body: string;
  switch (test.kind) {
    case "solid":
      body = renderSolidBody(test, width, height);
      break;
    case "gradient":
      body = renderGradientBody(test, width, height);
      break;
    case "pattern":
      body = renderPatternBody(test, width, height);
      break;
    case "text":
      body = renderTextBody(test, width, height);
      break;
    case "motion":
      body = renderMotionBody(test, width, height);
      break;
  }

  return svgWrap(width, height, body);
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface MonitorTestOpts {
  /** A test id, or "all" to list every test. Mirrors the free-text input. */
  test?: string;
  /** Include a rendered SVG preview row for the selected test. */
  svg?: boolean;
  [key: string]: unknown;
}

function listTests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const test of TESTS) out[test.label] = test.purpose;
  return out;
}

export function run(input: string, opts: MonitorTestOpts): Record<string, string> {
  const raw = (input ?? "").trim();
  const optTest = (opts?.test ?? "all").trim();
  const testId = raw || optTest;

  if (!testId || testId.toLowerCase() === "all") {
    return listTests();
  }

  const test = findTest(testId);
  const out = describeTest(test.id);
  if (opts?.svg) {
    out["SVG"] = renderPatternSvg(test.id, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  }
  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, MonitorTestOpts>;
