import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  AXIS_MAX_HZ,
  AXIS_MIN_HZ,
  aggregatedUses,
  bandPathAt,
  bandPathLabel,
  bandsCoveringAt,
  describeFrequency,
  energyEvToFrequency,
  flattenBands,
  formatEnergyEv,
  formatFrequency,
  formatWavelength,
  frequencyToBlackbodyKelvin,
  frequencyToColorHex,
  frequencyToEnergyEv,
  frequencyToPosition,
  frequencyToWavelength,
  isIonizing,
  parseJump,
  positionToFrequency,
  run,
  usesAt,
  wavelengthNmToRgb,
  wavelengthToFrequency,
} from "./index";

/** Relative closeness helper for physics anchors. */
function closeRel(actual: number, expected: number, rel = 1e-4): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(rel);
}

describe("core conversions", () => {
  it("green light at 550 nm maps to 545.08 THz", () => {
    const f = wavelengthToFrequency(550e-9);
    closeRel(f, 5.4508e14);
    closeRel(frequencyToWavelength(f), 550e-9);
  });

  it("round-trips frequency and wavelength", () => {
    closeRel(frequencyToWavelength(wavelengthToFrequency(0.21)), 0.21);
  });

  it("1 eV corresponds to 1239.84 nm and 2.41799e14 Hz", () => {
    const f = energyEvToFrequency(1);
    closeRel(f, 2.417989e14);
    closeRel(frequencyToWavelength(f) * 1e9, 1239.841984, 1e-5);
    closeRel(frequencyToEnergyEv(f), 1);
  });

  it("550 nm carries about 2.254 eV", () => {
    closeRel(frequencyToEnergyEv(wavelengthToFrequency(550e-9)), 2.2543, 1e-3);
  });

  it("Wien peak for 550 nm is about 5269 K", () => {
    closeRel(frequencyToBlackbodyKelvin(wavelengthToFrequency(550e-9)), 5269, 2e-3);
  });

  it("Wi-Fi at 2.45 GHz is 12.24 cm and about 1.013e-5 eV", () => {
    closeRel(frequencyToWavelength(2.45e9), 0.122364, 1e-4);
    closeRel(frequencyToEnergyEv(2.45e9), 1.0132e-5, 1e-3);
  });
});

describe("ionizing test", () => {
  it("is false for visible light", () => {
    expect(isIonizing(wavelengthToFrequency(550e-9))).toBe(false);
  });

  it("is true at and above the 10 eV threshold", () => {
    expect(isIonizing(energyEvToFrequency(10))).toBe(true);
    expect(isIonizing(energyEvToFrequency(9.9))).toBe(false);
    expect(isIonizing(energyEvToFrequency(100))).toBe(true);
  });

  it("is true for gamma rays", () => {
    expect(isIonizing(1e21)).toBe(true);
  });
});

describe("visible light to sRGB", () => {
  it("renders 550 nm as dominantly green", () => {
    const rgb = wavelengthNmToRgb(550)!;
    expect(rgb).not.toBeNull();
    expect(rgb.g).toBeGreaterThan(rgb.r);
    expect(rgb.g).toBeGreaterThan(rgb.b);
  });

  it("renders 470 nm as dominantly blue and 650 nm as dominantly red", () => {
    const blue = wavelengthNmToRgb(470)!;
    expect(blue.b).toBeGreaterThan(blue.r);
    const red = wavelengthNmToRgb(650)!;
    expect(red.r).toBeGreaterThan(red.g);
  });

  it("returns null outside the visible range", () => {
    expect(wavelengthNmToRgb(300)).toBeNull();
    expect(wavelengthNmToRgb(900)).toBeNull();
  });

  it("gives a hex color for visible frequencies only", () => {
    expect(frequencyToColorHex(wavelengthToFrequency(550e-9))).toMatch(/^#[0-9a-f]{6}$/);
    expect(frequencyToColorHex(2.45e9)).toBeNull();
  });
});

describe("log10 position mapping", () => {
  it("puts gamma at the start and ELF at the end", () => {
    expect(frequencyToPosition(AXIS_MAX_HZ)).toBeCloseTo(0, 6);
    expect(frequencyToPosition(AXIS_MIN_HZ)).toBeCloseTo(1, 6);
  });

  it("clamps out-of-range frequencies to the ends", () => {
    expect(frequencyToPosition(AXIS_MAX_HZ * 100)).toBe(0);
    expect(frequencyToPosition(AXIS_MIN_HZ / 100)).toBe(1);
  });

  it("round-trips position and frequency", () => {
    for (const f of [3, 1e6, 2.45e9, 5.45e14, 1e19]) {
      closeRel(positionToFrequency(frequencyToPosition(f)), f, 1e-9);
    }
  });

  it("positionToFrequency clamps positions to the axis", () => {
    closeRel(positionToFrequency(-1), AXIS_MAX_HZ, 1e-9);
    closeRel(positionToFrequency(2), AXIS_MIN_HZ, 1e-9);
  });
});

describe("band lookup", () => {
  it("resolves FM broadcast at 100 MHz", () => {
    expect(bandPathLabel(bandPathAt(100e6))).toBe("Radio > VHF > FM broadcast");
  });

  it("resolves 2.45 GHz to the narrowest leaf (microwave ovens) inside the ISM band", () => {
    expect(bandPathLabel(bandPathAt(2.45e9))).toBe(
      "Microwave > UHF > 2.4 GHz ISM band > Microwave ovens",
    );
  });

  it("resolves a Wi-Fi channel 6 center to its channel leaf", () => {
    expect(bandPathLabel(bandPathAt(2.437e9))).toBe(
      "Microwave > UHF > 2.4 GHz ISM band > Wi-Fi channel 6",
    );
  });

  it("resolves a deep aviation leaf: 121.5 MHz emergency guard", () => {
    expect(bandPathLabel(bandPathAt(121.5e6))).toBe(
      "Radio > VHF > Airband > 121.5 MHz emergency guard",
    );
    expect(usesAt(121.5e6)).toContain(
      "The international aviation emergency and distress frequency",
    );
  });

  it("resolves GPS L1 and the 21 cm hydrogen line as named leaves", () => {
    expect(bandPathLabel(bandPathAt(1575.42e6))).toBe("Microwave > UHF > GPS and GNSS > GPS L1");
    expect(bandPathLabel(bandPathAt(1420.405e6))).toBe("Microwave > UHF > 21 cm hydrogen line");
  });

  it("resolves CB Channel 19 inside the CB band inside HF", () => {
    expect(bandPathLabel(bandPathAt(27.185e6))).toBe(
      "Radio > HF (shortwave) > CB radio > CB Channel 19",
    );
  });

  it("resolves visible green at 550 nm", () => {
    expect(bandPathLabel(bandPathAt(wavelengthToFrequency(550e-9)))).toBe("Visible light > Green");
  });

  it("resolves gamma rays", () => {
    expect(bandPathLabel(bandPathAt(1e21))).toBe("Gamma rays");
  });

  it("collects uses from the deepest band that lists them", () => {
    expect(usesAt(100e6)).toContain("FM radio stations in the United States");
  });

  it("flattens every band with its depth, parents before children", () => {
    const flat = flattenBands();
    expect(flat[0]!.band.id).toBe("gamma");
    expect(flat.some((f) => f.band.id === "vhf-fm" && f.depth === 2)).toBe(true);
    // Every child sits inside its parent's range.
    for (const { band } of flat) {
      if (band.children) {
        for (const child of band.children) {
          expect(child.fLow).toBeGreaterThanOrEqual(band.fLow - 1e-6);
          expect(child.fHigh).toBeLessThanOrEqual(band.fHigh + 1e-6);
        }
      }
    }
  });
});

describe("multi-use aggregation", () => {
  it("returns every overlapping allocation at 2.45 GHz, most specific first", () => {
    const uses = aggregatedUses(2.45e9);
    expect(uses.length).toBeGreaterThan(1);
    // The narrowest leaf (microwave ovens) comes first.
    expect(uses[0]).toBe("Microwave ovens heat food at about 2.45 GHz");
    // And the shared 2.4 GHz occupants are all present.
    expect(uses).toContain("Bluetooth and Bluetooth Low Energy");
    expect(uses).toContain("Zigbee");
  });

  it("gathers overlapping bands with bandsCoveringAt", () => {
    const ids = bandsCoveringAt(2.45e9).map((b) => b.id);
    expect(ids).toContain("microwave");
    expect(ids).toContain("uhf");
    expect(ids).toContain("uhf-ism24");
    expect(ids).toContain("ism24-oven");
    expect(ids).toContain("ism24-bt");
    // Wi-Fi channel 6 ends at 2448 MHz, so 2450 MHz is not inside it.
    expect(ids).not.toContain("ism24-wifi6");
  });

  it("caps the aggregated list for readability", () => {
    expect(aggregatedUses(2.437e9).length).toBeLessThanOrEqual(8);
  });

  it("still returns a single use for an unshared frequency", () => {
    expect(aggregatedUses(100e6)).toContain("FM radio stations in the United States");
  });
});

describe("jump parser: frequency forms", () => {
  it("parses SI-prefixed frequencies", () => {
    closeRel(parseJump("2.45 GHz"), 2.45e9);
    closeRel(parseJump("100 MHz"), 100e6);
    closeRel(parseJump("500 THz"), 500e12);
    closeRel(parseJump("1 kHz"), 1e3);
  });

  it("parses scientific and bare numbers as hertz", () => {
    closeRel(parseJump("1e15 Hz"), 1e15);
    closeRel(parseJump("3e8"), 3e8);
    closeRel(parseJump("60"), 60);
  });

  it("case-folds a lowercase frequency prefix when strict lands off-axis", () => {
    // "mhz" strictly is milli-Hz (0.1 Hz, below the floor) so it folds to MHz.
    closeRel(parseJump("100 mhz"), 100e6);
    closeRel(parseJump("2.4 ghz"), 2.4e9);
  });
});

describe("jump parser: wavelength forms", () => {
  it("parses metric wavelengths", () => {
    closeRel(parseJump("550 nm"), wavelengthToFrequency(550e-9));
    closeRel(parseJump("21 cm"), wavelengthToFrequency(0.21));
    closeRel(parseJump("1 m"), wavelengthToFrequency(1));
    closeRel(parseJump("3 mm"), wavelengthToFrequency(3e-3));
    closeRel(parseJump("1 km"), wavelengthToFrequency(1000));
  });

  it("parses micron spellings equivalently", () => {
    const target = wavelengthToFrequency(1e-6);
    closeRel(parseJump("1 um"), target);
    closeRel(parseJump("1 µm"), target);
    closeRel(parseJump("1 micron"), target);
  });

  it("parses imperial lengths and the angstrom", () => {
    closeRel(parseJump("1 mile"), wavelengthToFrequency(1609.344));
    closeRel(parseJump("1 inch"), wavelengthToFrequency(0.0254));
    closeRel(parseJump("1 ft"), wavelengthToFrequency(0.3048));
    closeRel(parseJump("5000 angstrom"), wavelengthToFrequency(5000e-10));
  });

  it("distinguishes millimeter from megameter by case", () => {
    closeRel(parseJump("1 mm"), wavelengthToFrequency(1e-3));
    closeRel(parseJump("1 Mm"), wavelengthToFrequency(1e6));
  });
});

describe("jump parser: energy forms", () => {
  it("parses electronvolt forms", () => {
    closeRel(parseJump("1 eV"), energyEvToFrequency(1));
    closeRel(parseJump("10 keV"), energyEvToFrequency(10e3));
    closeRel(parseJump("2 MeV"), energyEvToFrequency(2e6));
  });

  it("keeps eV case sensitive: meV is milli, MeV is mega", () => {
    closeRel(parseJump("500 meV"), energyEvToFrequency(0.5));
    closeRel(parseJump("500 MeV"), energyEvToFrequency(500e6));
    expect(parseJump("500 MeV")).toBeGreaterThan(parseJump("500 meV"));
  });

  it("parses joules", () => {
    closeRel(parseJump("1e-19 J"), 1e-19 / 6.62607015e-34);
  });
});

describe("jump parser: errors", () => {
  it("rejects empty input", () => {
    expect(() => parseJump("   ")).toThrow(ToolError);
  });

  it("rejects a missing number", () => {
    expect(() => parseJump("GHz")).toThrow(ToolError);
  });

  it("rejects an unknown unit", () => {
    expect(() => parseJump("5 bananas")).toThrow(ToolError);
  });

  it("rejects zero and negative values", () => {
    expect(() => parseJump("0 Hz")).toThrow(ToolError);
    expect(() => parseJump("-5 GHz")).toThrow(ToolError);
  });

  it("carries an actionable fix hint", () => {
    try {
      parseJump("nonsense");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).fix).toBeTruthy();
    }
  });
});

describe("formatting", () => {
  it("formats frequency with SI prefixes", () => {
    expect(formatFrequency(2.45e9)).toBe("2.45 GHz");
    expect(formatFrequency(100e6)).toBe("100 MHz");
    expect(formatFrequency(60)).toBe("60 Hz");
  });

  it("formats wavelength with a sensible metric unit", () => {
    expect(formatWavelength(550e-9)).toBe("550 nm");
    expect(formatWavelength(0.122364)).toBe("12.24 cm");
  });

  it("formats photon energy with an eV prefix", () => {
    expect(formatEnergyEv(1)).toBe("1 eV");
    expect(formatEnergyEv(10e3)).toBe("10 keV");
  });
});

describe("describeFrequency and run", () => {
  it("builds a full readout for the 2.45 GHz ISM band", () => {
    const r = describeFrequency(2.45e9);
    expect(r.pathLabel).toBe("Microwave > UHF > 2.4 GHz ISM band > Microwave ovens");
    expect(r.ionizing).toBe(false);
    expect(r.colorHex).toBeNull();
    // The aggregated readout lists more than the single narrowest use.
    expect(r.uses.length).toBeGreaterThan(1);
  });

  it("run() reads the query option", () => {
    const rows = run(undefined, { query: "100 MHz" });
    expect(rows.Band).toBe("Radio > VHF > FM broadcast");
    expect(rows.Frequency).toBe("100 MHz");
  });

  it("run() falls back to a string input, then to 550 nm", () => {
    expect(run("2.45 GHz", {}).Band).toBe("Microwave > UHF > 2.4 GHz ISM band > Microwave ovens");
    expect(run(undefined, {}).Band).toBe("Visible light > Green");
  });

  it("run() throws a ToolError on a bad query", () => {
    expect(() => run(undefined, { query: "5 bananas" })).toThrow(ToolError);
  });
});
