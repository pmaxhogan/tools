import { describe, expect, it } from "vitest";
import {
  FAVORITES_KEY,
  FAVORITES_MAX,
  isFavorite,
  normalizeFavorites,
  toggleFavorite,
} from "./favorites";

describe("FAVORITES_KEY", () => {
  it("is the documented storage key", () => {
    // Three surfaces read this key, and the sidebar, the grid and the star
    // button all have to agree on it. Renaming it silently drops what a
    // returning visitor pinned.
    expect(FAVORITES_KEY).toBe("favorite-tools");
  });
});

describe("normalizeFavorites", () => {
  it("passes a clean list through unchanged", () => {
    expect(normalizeFavorites(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("drops blanks and trims", () => {
    expect(normalizeFavorites([" a ", "", "   ", "b"])).toEqual(["a", "b"]);
  });

  it("removes duplicates, keeping the first", () => {
    expect(normalizeFavorites(["a", "b", "a", " a "])).toEqual(["a", "b"]);
  });

  it("caps the length", () => {
    const list = Array.from({ length: FAVORITES_MAX + 5 }, (_, i) => `tool-${i}`);
    const out = normalizeFavorites(list);
    expect(out).toHaveLength(FAVORITES_MAX);
    expect(out[0]).toBe("tool-0");
    expect(out[FAVORITES_MAX - 1]).toBe(`tool-${FAVORITES_MAX - 1}`);
  });

  it("returns nothing for a non-positive cap", () => {
    expect(normalizeFavorites(["a", "b"], 0)).toEqual([]);
    expect(normalizeFavorites(["a", "b"], -3)).toEqual([]);
  });

  it("never mutates the input", () => {
    const input = ["b", "b", "a"];
    normalizeFavorites(input);
    expect(input).toEqual(["b", "b", "a"]);
  });
});

describe("isFavorite", () => {
  it("finds a pinned slug", () => {
    expect(isFavorite(["json-formatter", "uuid-generator"], "uuid-generator")).toBe(true);
  });

  it("is false for a slug that is not pinned", () => {
    expect(isFavorite(["json-formatter"], "uuid-generator")).toBe(false);
    expect(isFavorite([], "uuid-generator")).toBe(false);
  });

  it("ignores whitespace on either side", () => {
    expect(isFavorite([" json-formatter "], "json-formatter")).toBe(true);
    expect(isFavorite(["json-formatter"], "  json-formatter  ")).toBe(true);
  });

  it("is false for a blank slug", () => {
    expect(isFavorite(["a", ""], "")).toBe(false);
    expect(isFavorite(["a"], "   ")).toBe(false);
  });

  it("does not match a prefix or a substring", () => {
    expect(isFavorite(["json-formatter"], "json")).toBe(false);
  });
});

describe("toggleFavorite", () => {
  it("pins an unpinned tool at the front", () => {
    expect(toggleFavorite(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("unpins a pinned tool and leaves the rest in order", () => {
    expect(toggleFavorite(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("round-trips: toggling twice returns the normalized list", () => {
    const list = ["a", "b", "c"];
    expect(toggleFavorite(toggleFavorite(list, "d"), "d")).toEqual(list);
    expect(toggleFavorite(toggleFavorite(list, "b"), "b")).toEqual(["b", "a", "c"]);
  });

  it("never mutates the input", () => {
    const input = ["a", "b"];
    toggleFavorite(input, "c");
    toggleFavorite(input, "a");
    expect(input).toEqual(["a", "b"]);
  });

  it("cleans a list that storage handed back in a bad shape", () => {
    expect(toggleFavorite([" a ", "a", "", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("drops the oldest pin once the cap is reached", () => {
    const full = Array.from({ length: FAVORITES_MAX }, (_, i) => `tool-${i}`);
    const out = toggleFavorite(full, "fresh");
    expect(out).toHaveLength(FAVORITES_MAX);
    expect(out[0]).toBe("fresh");
    expect(out).not.toContain(`tool-${FAVORITES_MAX - 1}`);
  });

  it("respects an explicit cap", () => {
    expect(toggleFavorite(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });

  it("normalizes but does not pin a blank slug", () => {
    expect(toggleFavorite(["a", " a ", "b"], "  ")).toEqual(["a", "b"]);
  });

  it("unpins through whitespace on either side", () => {
    expect(toggleFavorite([" a ", "b"], "a")).toEqual(["b"]);
  });
});
