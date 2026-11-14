import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderOgPng } from "./og";

/**
 * Renders a real card and reads pixels back. The card is laid out by satori,
 * and a satori upgrade is free to resolve the same style object differently:
 * 0.63 sized the card's `100%` against the padded frame's outer box, so the
 * card ran off the right and bottom of the image and the footer was clipped
 * away. Nothing else in CI looks at these PNGs, so that shipped. These checks
 * are about where the card sits, not about exact glyph shapes, so a font or
 * antialiasing change does not trip them.
 */

const WIDTH = 1200;
const HEIGHT = 630;

interface Pixels {
  width: number;
  height: number;
  at: (x: number, y: number) => [number, number, number];
}

async function render(): Promise<Pixels> {
  const png = await renderOgPng({
    title: "QR Code Generator",
    description:
      "Generate SVG and PNG QR codes with a center logo, from links, Wi-Fi, contacts and more.",
    category: "QR",
  });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at: (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    },
  };
}

const isCard = ([r, g, b]: [number, number, number]) => r === 255 && g === 255 && b === 255;

describe("renderOgPng", () => {
  it("renders a 1200x630 image", async () => {
    const px = await render();
    expect([px.width, px.height]).toEqual([WIDTH, HEIGHT]);
  });

  it("keeps the card inside a 40px frame on every side", async () => {
    const px = await render();
    // Inside the card, away from any text.
    expect(isCard(px.at(600, 560))).toBe(true);
    expect(isCard(px.at(1150, 300))).toBe(true);
    // The frame around it is page background (tinted by the card's shadow),
    // never card white. A card that overflows paints these white.
    expect(isCard(px.at(20, 300))).toBe(false);
    expect(isCard(px.at(1180, 300))).toBe(false);
    expect(isCard(px.at(600, 20))).toBe(false);
    expect(isCard(px.at(600, 612))).toBe(false);
  });

  it("draws the footer inside the card", async () => {
    const px = await render();
    // The accent dot and the site name sit in the bottom left of the card.
    let ink = 0;
    for (let y = 490; y < 530; y++) {
      for (let x = 100; x < 400; x++) {
        const [r, g, b] = px.at(x, y);
        if (r < 160 && g < 160 && b < 230) ink++;
      }
    }
    expect(ink).toBeGreaterThan(200);
  });
});
