import { describe, expect, it } from "vitest";
import {
  carriedFileMatches,
  clearCarriedInput,
  getCarriedInput,
  setCarriedInput,
  shouldOfferCarried,
  subscribeCarriedInput,
  type CarriedInput,
} from "./carry-input";

function fileInput(name: string, type: string, fromSlug = "image-toolbox"): CarriedInput {
  return {
    kind: "file",
    file: new File([new Uint8Array([1, 2, 3])], name, { type }),
    fromSlug,
    fromName: "Image Toolbox",
    at: 1_000,
  };
}

describe("carry-input store", () => {
  it("starts empty, holds the last value, and clears", () => {
    clearCarriedInput();
    expect(getCarriedInput()).toBeNull();
    const a = fileInput("a.png", "image/png");
    setCarriedInput(a);
    expect(getCarriedInput()).toBe(a);
    const b = fileInput("b.png", "image/png");
    setCarriedInput(b);
    expect(getCarriedInput()).toBe(b);
    clearCarriedInput();
    expect(getCarriedInput()).toBeNull();
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    clearCarriedInput();
    const seen: (CarriedInput | null)[] = [];
    const off = subscribeCarriedInput((v) => seen.push(v));
    const a = fileInput("a.png", "image/png");
    setCarriedInput(a);
    clearCarriedInput();
    clearCarriedInput(); // no-op when already empty
    off();
    setCarriedInput(a);
    expect(seen).toEqual([a, null]);
    clearCarriedInput();
  });
});

describe("carriedFileMatches", () => {
  it("admits anything when accept is empty", () => {
    expect(carriedFileMatches(fileInput("x.bin", ""), "")).toBe(true);
    expect(carriedFileMatches(fileInput("x.bin", ""), undefined)).toBe(true);
  });

  it("matches wildcard mime, exact mime, and extensions", () => {
    const png = fileInput("photo.PNG", "image/png");
    expect(carriedFileMatches(png, "image/*")).toBe(true);
    expect(carriedFileMatches(png, "image/png")).toBe(true);
    expect(carriedFileMatches(png, ".png,.jpg")).toBe(true);
    expect(carriedFileMatches(png, "audio/*")).toBe(false);
    expect(carriedFileMatches(png, ".gpx")).toBe(false);
  });

  it("rejects text inputs and null", () => {
    expect(carriedFileMatches(null, "image/*")).toBe(false);
    expect(
      carriedFileMatches(
        { kind: "text", text: "hi", fromSlug: "a", fromName: "A", at: 0 },
        "image/*",
      ),
    ).toBe(false);
  });
});

describe("shouldOfferCarried", () => {
  it("skips the originating tool and stale inputs", () => {
    const a = fileInput("a.png", "image/png", "image-toolbox");
    expect(shouldOfferCarried(a, "image-toolbox", 2_000)).toBe(false);
    expect(shouldOfferCarried(a, "image-redactor", 2_000)).toBe(true);
    expect(shouldOfferCarried(a, "image-redactor", 1_000 + 31 * 60 * 1000)).toBe(false);
    expect(shouldOfferCarried(null, "image-redactor")).toBe(false);
  });
});
