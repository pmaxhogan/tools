import { describe, expect, it } from "vitest";
import { BAND_EDUCATION, educationAt, educationFor } from "./education";
import { BANDS } from "./data";

const DASH = /[–—]/;

describe("band education", () => {
  it("covers every top level band with the four notes and no dashes", () => {
    for (const band of BANDS) {
      const note = educationFor(band.id);
      expect(note, band.id).toBeDefined();
    }
    for (const note of BAND_EDUCATION) {
      for (const text of [note.what, note.propagation, note.penetration, note.health]) {
        expect(text.length).toBeGreaterThan(40);
        expect(text).not.toMatch(DASH);
      }
    }
  });

  it("references only real band ids", () => {
    const ids = new Set<string>();
    const walk = (list: typeof BANDS): void => {
      for (const b of list) {
        ids.add(b.id);
        if (b.children) walk(b.children);
      }
    };
    walk(BANDS);
    for (const note of BAND_EDUCATION) expect(ids.has(note.bandId), note.bandId).toBe(true);
  });

  it("picks the most specific note along the band path", () => {
    expect(educationAt(146e6)?.bandId).toBe("radio-vhf");
    expect(educationAt(7.1e6)?.bandId).toBe("radio-hf");
    expect(educationAt(2.45e9)?.bandId).toBe("microwave");
    expect(educationAt(5.5e14)?.bandId).toBe("visible");
    expect(educationAt(1e-3)).toBeUndefined();
  });
});
