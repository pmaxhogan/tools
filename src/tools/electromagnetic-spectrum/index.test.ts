import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  AXIS_DECADES,
  AXIS_MAX_HZ,
  AXIS_MIN_HZ,
  BANDS,
  ICON_NAMES,
  NAMED_CHANNELS,
  WIFI_CHANNELS,
  aggregatedUses,
  bandPathAt,
  bandPathLabel,
  bandsCoveringAt,
  describeFrequency,
  energyEvToFrequency,
  findNamedChannels,
  findWifiChannels,
  flattenBands,
  formatEnergyEv,
  formatFrequency,
  formatWavelength,
  frequencyToBlackbodyKelvin,
  frequencyToColorHex,
  frequencyToEnergyEv,
  frequencyToPosition,
  frequencyToWavelength,
  interpretQuery,
  isIonizing,
  parseJump,
  positionToFrequency,
  run,
  usesAt,
  wavelengthNmToRgb,
  wavelengthToFrequency,
  type Band,
} from "./index";
import {
  ICON_ONLY_ALONG,
  MIN_LABEL_ALONG,
  MIN_LABEL_CROSS,
  MIN_SPAN,
  TICK_MARGIN_H,
  TICK_MARGIN_V,
  axisLengthPx,
  axisPxToFreq,
  axisPxToPos,
  buildBandLabels,
  buildScene,
  centerHoldingAnchor,
  clampAxisPx,
  clampWindow,
  fitLabel,
  freqToAxisPx,
  laneFill,
  mapHeightPx,
  packBands,
  posToAxisPx,
  sceneToSvg,
  spectralStops,
  withAlpha,
  type AxisView,
  type BandLabelInput,
  type PackedBand,
  type Scene,
  type SceneColors,
  type SceneInput,
} from "./layout";

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
    // The readout now shows ONLY the most specific band's uses (the oven leaf),
    // not the aggregated pile from every band covering 2.45 GHz.
    expect(r.uses).toEqual(["Microwave ovens heat food at about 2.45 GHz"]);
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

/** Walk every band in the tree, parents then children. */
function eachBand(fn: (b: Band) => void, bands: Band[] = BANDS): void {
  for (const b of bands) {
    fn(b);
    if (b.children) eachBand(fn, b.children);
  }
}

describe("band icon and alias metadata", () => {
  it("uses exactly the icon names listed in ICON_NAMES (both directions)", () => {
    const used = new Set<string>();
    eachBand((b) => {
      if (b.icon) used.add(b.icon);
    });
    // Every icon on a band is declared, and every declared name is actually used.
    expect([...used].sort()).toEqual([...ICON_NAMES].sort());
  });

  it("keeps every alias lowercase for case-insensitive matching", () => {
    eachBand((b) => {
      for (const a of b.aliases ?? []) expect(a).toBe(a.toLowerCase());
    });
  });

  it("has no em or en dashes in names, aliases or uses", () => {
    eachBand((b) => {
      const strings = [b.name, ...(b.aliases ?? []), ...b.uses];
      for (const s of strings) {
        expect(s).not.toMatch(/[—–]/);
      }
    });
  });
});

describe("Wi-Fi channel dataset", () => {
  it("places the 2.4 GHz 20 MHz channels at 2407 + 5 * ch MHz", () => {
    for (let ch = 1; ch <= 11; ch++) {
      const [c] = findWifiChannels({ band: "2.4", channel: ch, width: 20 });
      expect(c!.centerHz).toBe((2407 + 5 * ch) * 1e6);
    }
    expect(findWifiChannels({ band: "2.4", channel: 1, width: 20 })[0]!.centerHz).toBe(2412e6);
    expect(findWifiChannels({ band: "2.4", channel: 11, width: 20 })[0]!.centerHz).toBe(2462e6);
  });

  it("models US 2.4 GHz 40 MHz composite channels 3 through 9 only", () => {
    const centers = WIFI_CHANNELS.filter((c) => c.band === "2.4" && c.width === 40).map(
      (c) => c.channel,
    );
    expect(centers).toEqual([3, 4, 5, 6, 7, 8, 9]);
    // Channel 3 as a 40 MHz channel is centered at 2422 MHz, spanning 2402 to 2442.
    const [c40] = findWifiChannels({ band: "2.4", channel: 3, width: 40 });
    expect(c40!.centerHz).toBe(2422e6);
    expect(c40!.lowerHz).toBe(2402e6);
    expect(c40!.upperHz).toBe(2442e6);
  });

  it("places 5 GHz channels at 5000 + 5 * ch MHz with correct bonded centers", () => {
    expect(findWifiChannels({ band: "5", channel: 36, width: 20 })[0]!.centerHz).toBe(5180e6);
    expect(findWifiChannels({ band: "5", channel: 165, width: 20 })[0]!.centerHz).toBe(5825e6);
    expect(findWifiChannels({ band: "5", channel: 149, width: 20 })[0]!.centerHz).toBe(5745e6);
    // Channel 42 is the 80 MHz channel bonding 36/40/44/48, center 5210 MHz.
    expect(findWifiChannels({ band: "5", channel: 42, width: 80 })[0]!.centerHz).toBe(5210e6);
    // Channel 50 is the 160 MHz channel bonding 36..64, center 5250 MHz.
    expect(findWifiChannels({ band: "5", channel: 50, width: 160 })[0]!.centerHz).toBe(5250e6);
    // Channel 38 is a 40 MHz channel, center 5190 MHz.
    expect(findWifiChannels({ band: "5", channel: 38, width: 40 })[0]!.centerHz).toBe(5190e6);
  });

  it("generates 6 GHz channels at 5950 + 5 * ch MHz to the standard maxima", () => {
    expect(findWifiChannels({ band: "6", channel: 1, width: 20 })[0]!.centerHz).toBe(5955e6);
    expect(findWifiChannels({ band: "6", channel: 37, width: 20 })[0]!.centerHz).toBe(6135e6);
    // 20 MHz tops out at channel 233 (center 7115 MHz), 237 does not fit.
    expect(findWifiChannels({ band: "6", channel: 233, width: 20 })[0]!.centerHz).toBe(7115e6);
    expect(findWifiChannels({ band: "6", channel: 237, width: 20 })).toHaveLength(0);
    // Bonded maxima: 40 -> 227, 80 -> 215, 160 -> 207.
    expect(findWifiChannels({ band: "6", channel: 227, width: 40 })).toHaveLength(1);
    expect(findWifiChannels({ band: "6", channel: 215, width: 80 })).toHaveLength(1);
    expect(findWifiChannels({ band: "6", channel: 207, width: 160 })).toHaveLength(1);
    expect(findWifiChannels({ band: "6", channel: 239, width: 160 })).toHaveLength(0);
  });

  it("computes channel edges as center plus and minus half the width", () => {
    const [c] = findWifiChannels({ band: "5", channel: 36, width: 20 });
    expect(c!.lowerHz).toBe(5170e6);
    expect(c!.upperHz).toBe(5190e6);
    const [c80] = findWifiChannels({ band: "5", channel: 42, width: 80 });
    expect(c80!.lowerHz).toBe(5170e6);
    expect(c80!.upperHz).toBe(5250e6);
  });

  it("disambiguates a channel number shared across bands", () => {
    const bands = findWifiChannels({ channel: 1, width: 20 }).map((c) => c.band);
    expect(bands).toContain("2.4");
    expect(bands).toContain("6");
  });
});

describe("interpretQuery: numeric readings", () => {
  it("returns an empty list for empty input and never throws on garbage", () => {
    expect(interpretQuery("")).toEqual([]);
    expect(interpretQuery("   ")).toEqual([]);
    expect(() => interpretQuery("5 bananas")).not.toThrow();
    expect(interpretQuery("5 bananas")).toEqual([]);
    expect(() => interpretQuery("GHz")).not.toThrow();
  });

  it("reads a bare number as hertz: 1234567 is about 1.235 MHz", () => {
    const top = interpretQuery("1234567")[0]!;
    expect(top.kind).toBe("frequency");
    expect(top.frequencyHz).toBe(1234567);
    expect(top.label).toBe("1.235 MHz");
  });

  it("reads an SI frequency, a wavelength and an energy", () => {
    const freq = interpretQuery("2.45 GHz")[0]!;
    expect(freq.kind).toBe("frequency");
    closeRel(freq.frequencyHz, 2.45e9);

    const wl = interpretQuery("550 nm")[0]!;
    expect(wl.kind).toBe("wavelength");
    closeRel(wl.frequencyHz, wavelengthToFrequency(550e-9));

    const energy = interpretQuery("10 keV")[0]!;
    expect(energy.kind).toBe("energy");
    closeRel(energy.frequencyHz, energyEvToFrequency(10e3));
  });
});

describe("interpretQuery: Wi-Fi channels", () => {
  it("resolves 'wifi channel 42' to the 80 MHz center at exactly 5.210 GHz", () => {
    const top = interpretQuery("wifi channel 42")[0]!;
    expect(top.kind).toBe("wifi");
    expect(top.frequencyHz).toBe(5.21e9);
    expect(top.rangeHz).toEqual([5170e6, 5250e6]);
  });

  it("resolves '2.4ghz channel 3' to the 20 MHz center at exactly 2.422 GHz", () => {
    const cands = interpretQuery("2.4ghz channel 3");
    expect(cands[0]!.kind).toBe("wifi");
    expect(cands[0]!.frequencyHz).toBe(2.422e9);
    // The 40 MHz interpretation sharing that channel number is also offered.
    const widths = cands.filter((c) => c.kind === "wifi").map((c) => c.rangeHz![1] - c.rangeHz![0]);
    expect(widths).toContain(20e6);
    expect(widths).toContain(40e6);
  });

  it("resolves '5ghz channel 36' to exactly 5.180 GHz", () => {
    expect(interpretQuery("5ghz channel 36")[0]!.frequencyHz).toBe(5.18e9);
  });

  it("resolves '6ghz channel 37' to exactly 6.135 GHz", () => {
    expect(interpretQuery("6ghz channel 37")[0]!.frequencyHz).toBe(6.135e9);
  });

  it("resolves 'channel 149' by uniqueness to exactly 5.745 GHz", () => {
    expect(interpretQuery("channel 149")[0]!.frequencyHz).toBe(5.745e9);
  });

  it("resolves 'wifi ch 6' to exactly 2.437 GHz", () => {
    expect(interpretQuery("wifi ch 6")[0]!.frequencyHz).toBe(2.437e9);
  });

  it("offers one candidate per band when a channel number is ambiguous", () => {
    const wifi = interpretQuery("channel 1").filter((c) => c.kind === "wifi");
    const freqs = wifi.map((c) => c.frequencyHz);
    expect(freqs).toContain(2412e6); // 2.4 GHz channel 1
    expect(freqs).toContain(5955e6); // 6 GHz channel 1
  });
});

describe("interpretQuery: band and abbreviation search", () => {
  it("resolves an abbreviation to a band centered on the geometric mean", () => {
    const top = interpretQuery("VHF")[0]!;
    expect(top.kind).toBe("band");
    expect(top.label).toBe("VHF");
    expect(top.rangeHz).toEqual([30e6, 300e6]);
    closeRel(top.frequencyHz, Math.sqrt(30e6 * 300e6));
    expect(top.frequencyHz).toBeGreaterThan(30e6);
    expect(top.frequencyHz).toBeLessThan(300e6);
  });

  it("matches aliases like EUV, airband, GPS and the hydrogen line", () => {
    expect(interpretQuery("EUV").some((c) => c.label === "Extreme UV (EUV)")).toBe(true);
    expect(interpretQuery("airband").some((c) => c.label === "Airband")).toBe(true);
    expect(interpretQuery("GPS").some((c) => c.label === "GPS and GNSS")).toBe(true);

    const hline = interpretQuery("hydrogen line").find((c) => c.kind === "band")!;
    expect(hline).toBeDefined();
    closeRel(hline.frequencyHz, 1.4204e9, 1e-3);
    expect(hline.rangeHz![0]).toBeLessThan(hline.frequencyHz);
    expect(hline.rangeHz![1]).toBeGreaterThan(hline.frequencyHz);
  });

  it("handles every band-search example the spec enumerates", () => {
    expect(interpretQuery("UVC").some((c) => c.label === "UVC")).toBe(true);
    expect(interpretQuery("UNII").some((c) => c.kind === "band")).toBe(true);
    expect(interpretQuery("ISM").some((c) => c.label === "2.4 GHz ISM band")).toBe(true);
    expect(interpretQuery("FM").some((c) => c.label === "FM broadcast")).toBe(true);
    expect(interpretQuery("2 meter").some((c) => c.label === "Amateur 2 meter")).toBe(true);
  });

  it("ranks a numeric parse above fuzzy band matches", () => {
    // '550 nm' both parses numerically and could brush band names; the numeric
    // reading must lead.
    expect(interpretQuery("550 nm")[0]!.kind).toBe("wavelength");
  });

  it("caps the candidate list", () => {
    expect(interpretQuery("wifi").length).toBeLessThanOrEqual(8);
  });
});

describe("named channel dataset (findNamedChannels)", () => {
  it("resolves marine channels to exact frequencies", () => {
    expect(findNamedChannels({ service: "marine", channel: 16 })[0]!.centerHz).toBe(156.8e6);
    expect(findNamedChannels({ service: "marine", channel: 13 })[0]!.centerHz).toBe(156.65e6);
    expect(findNamedChannels({ service: "marine", channel: 70 })[0]!.centerHz).toBe(156.525e6);
    // 22A is the US simplex variant on the ship transmit frequency of channel 22.
    const ch22a = findNamedChannels({ service: "marine", channel: "22A" })[0]!;
    expect(ch22a.centerHz).toBe(157.1e6);
    expect(ch22a.channel).toBe("22A");
    expect(ch22a.simplex).toBe(true);
    // A bare "marine 22" resolves the same channel the user knows as 22A.
    expect(findNamedChannels({ service: "marine", channel: 22 })[0]!.channel).toBe("22A");
  });

  it("keeps duplex marine coast frequencies 4.6 MHz above the ship frequency", () => {
    const ch20 = findNamedChannels({ service: "marine", channel: 20 })[0]!;
    expect(ch20.simplex).toBe(false);
    expect(ch20.shipHz).toBe(157.0e6);
    expect(ch20.coastHz).toBe(161.6e6);
  });

  it("resolves the international-only marine channels the US does not assign", () => {
    expect(findNamedChannels({ service: "marine", channel: 3 })[0]!.centerHz).toBe(156.15e6);
  });

  it("resolves CB channels including the out-of-order 23, 24, 25", () => {
    expect(findNamedChannels({ service: "cb", channel: 19 })[0]!.centerHz).toBe(27.185e6);
    expect(findNamedChannels({ service: "cb", channel: 9 })[0]!.centerHz).toBe(27.065e6);
    // 23 sits ABOVE 24 and 25 in frequency, the well known CB irregularity.
    expect(findNamedChannels({ service: "cb", channel: 23 })[0]!.centerHz).toBe(27.255e6);
    expect(findNamedChannels({ service: "cb", channel: 24 })[0]!.centerHz).toBe(27.235e6);
    expect(findNamedChannels({ service: "cb", channel: 25 })[0]!.centerHz).toBe(27.245e6);
    expect(findNamedChannels({ service: "cb", channel: 1 })[0]!.centerHz).toBe(26.965e6);
    expect(findNamedChannels({ service: "cb", channel: 40 })[0]!.centerHz).toBe(27.405e6);
  });

  it("resolves NOAA weather channels with WX1 as the highest frequency", () => {
    expect(findNamedChannels({ service: "noaa", channel: 1 })[0]!.centerHz).toBe(162.55e6);
    expect(findNamedChannels({ service: "noaa", channel: 2 })[0]!.centerHz).toBe(162.4e6);
    expect(findNamedChannels({ service: "noaa", channel: 3 })[0]!.centerHz).toBe(162.475e6);
    expect(findNamedChannels({ service: "noaa", channel: 7 })[0]!.centerHz).toBe(162.525e6);
    expect(findNamedChannels({ service: "noaa", channel: "WX1" })[0]!.channel).toBe("WX1");
  });

  it("resolves FM channels with center = 87.9 + 0.2 (ch - 200) MHz", () => {
    expect(findNamedChannels({ service: "fm", channel: 201 })[0]!.centerHz).toBe(88.1e6);
    expect(findNamedChannels({ service: "fm", channel: 300 })[0]!.centerHz).toBe(107.9e6);
    const ch201 = findNamedChannels({ service: "fm", channel: 201 })[0]!;
    expect(ch201.lowerHz).toBe(88.0e6);
    expect(ch201.upperHz).toBe(88.2e6);
  });

  it("resolves US TV channels to their 6 MHz slots and centers", () => {
    const ch7 = findNamedChannels({ service: "tv", channel: 7 })[0]!;
    expect(ch7.centerHz).toBe(177e6);
    expect(ch7.lowerHz).toBe(174e6);
    expect(ch7.upperHz).toBe(180e6);
    // UHF channel 14 starts at 470 MHz; the post-repack top is channel 36.
    expect(findNamedChannels({ service: "tv", channel: 14 })[0]!.lowerHz).toBe(470e6);
    expect(findNamedChannels({ service: "tv", channel: 36 })[0]!.upperHz).toBe(608e6);
    expect(findNamedChannels({ service: "tv", channel: 37 })).toHaveLength(0);
  });

  it("has no em or en dashes in any named channel string", () => {
    for (const c of NAMED_CHANNELS) {
      const strings = [c.channel, c.name ?? "", c.notes ?? "", ...(c.uses ?? [])];
      for (const s of strings) expect(s).not.toMatch(/[—–]/);
    }
  });

  it("keeps every channel edge on the correct side of its center", () => {
    for (const c of NAMED_CHANNELS) {
      expect(c.lowerHz).toBeLessThan(c.centerHz);
      expect(c.upperHz).toBeGreaterThan(c.centerHz);
    }
  });
});

describe("interpretQuery: named channels", () => {
  it("resolves marine, CB, NOAA, FM and TV channel queries to exact centers", () => {
    const marine = interpretQuery("marine channel 16")[0]!;
    expect(marine.kind).toBe("channel");
    expect(marine.frequencyHz).toBe(156.8e6);
    expect(marine.rangeHz).toEqual([156.8e6 - 12500, 156.8e6 + 12500]);

    expect(interpretQuery("cb channel 19")[0]!.frequencyHz).toBe(27.185e6);
    expect(interpretQuery("cb 19")[0]!.frequencyHz).toBe(27.185e6);
    expect(interpretQuery("noaa weather channel 3")[0]!.frequencyHz).toBe(162.475e6);
    expect(interpretQuery("wx1")[0]!.frequencyHz).toBe(162.55e6);
    expect(interpretQuery("fm channel 201")[0]!.frequencyHz).toBe(88.1e6);
    expect(interpretQuery("fm 201")[0]!.frequencyHz).toBe(88.1e6);
    expect(interpretQuery("tv channel 7")[0]!.frequencyHz).toBe(177e6);
  });

  it("accepts the bare 'marine 16' and 'marine 22a' forms", () => {
    expect(interpretQuery("marine 16")[0]!.frequencyHz).toBe(156.8e6);
    const ch22a = interpretQuery("marine 22a")[0]!;
    expect(ch22a.kind).toBe("channel");
    expect(ch22a.frequencyHz).toBe(157.1e6);
  });

  it("ranks the exact channel above fuzzy band-name matches", () => {
    // "cb 19" also brushes the CB radio band by alias, but the channel leads.
    const cands = interpretQuery("cb 19");
    expect(cands[0]!.kind).toBe("channel");
    expect(cands[0]!.frequencyHz).toBe(27.185e6);
    expect(cands.some((c) => c.kind === "band")).toBe(true);
  });

  it("does not let a Wi-Fi channel steal a named service query", () => {
    // 6 GHz Wi-Fi has a channel 201 and 2.4 GHz has a channel 7, but the named
    // service must win: no Wi-Fi candidate should appear for these.
    expect(interpretQuery("fm channel 201").every((c) => c.kind !== "wifi")).toBe(true);
    expect(interpretQuery("tv channel 7").every((c) => c.kind !== "wifi")).toBe(true);
  });

  it("still resolves bare and 'wifi' flavored channel queries to Wi-Fi", () => {
    expect(interpretQuery("channel 149")[0]!.kind).toBe("wifi");
    expect(interpretQuery("wifi ch 6")[0]!.frequencyHz).toBe(2.437e9);
    expect(interpretQuery("5ghz channel 36")[0]!.frequencyHz).toBe(5.18e9);
  });

  it("never throws on a channel-shaped garbage query", () => {
    expect(() => interpretQuery("marine channel banana")).not.toThrow();
    expect(() => interpretQuery("tv")).not.toThrow();
  });
});

describe("describeFrequency shows the most specific uses (deliverable 3)", () => {
  it("returns only the deepest band's uses at a 2.4 GHz Wi-Fi channel point", () => {
    // 2.437 GHz is the center of Wi-Fi channel 6; the readout must show just that
    // leaf's short list, not the aggregated pile of every 2.4 GHz occupant.
    const r = describeFrequency(2.437e9);
    expect(r.pathLabel).toBe("Microwave > UHF > 2.4 GHz ISM band > Wi-Fi channel 6");
    expect(r.uses).toEqual(["2.4 GHz Wi-Fi centered on 2437 MHz"]);
    // The aggregated view (kept exported) still lists more than one use there.
    expect(aggregatedUses(2.437e9).length).toBeGreaterThan(1);
  });

  it("matches usesAt, the most-specific selector, at several points", () => {
    for (const f of [100e6, 2.437e9, 2.45e9, 1575.42e6, 27.185e6]) {
      expect(describeFrequency(f).uses).toEqual(usesAt(f));
    }
  });

  it("resolves the new NOAA WX leaves in the visible tree", () => {
    expect(bandPathLabel(bandPathAt(162.55e6))).toBe(
      "Radio > VHF > NOAA weather radio > Weather channel WX1",
    );
    expect(bandPathLabel(bandPathAt(162.4e6))).toBe(
      "Radio > VHF > NOAA weather radio > Weather channel WX2",
    );
  });
});

/* ================================================================== */
/* Layout: lane packing, axis transforms, labels, colors, scene        */
/* ================================================================== */

/** A minimal band. Only the range and the tree shape matter to the layout. */
function testBand(id: string, fLow: number, fHigh: number, children?: Band[]): Band {
  const band: Band = { id, name: id, fLow, fHigh, uses: [] };
  if (children) band.children = children;
  return band;
}

/** lane by band id, so packing assertions read as a table. */
function laneById(packed: PackedBand[]): Record<string, number> {
  return Object.fromEntries(packed.map((p) => [p.band.id, p.lane]));
}

describe("lane packing: siblings", () => {
  it("shares one lane between siblings that do not overlap", () => {
    const { packed, totalLanes } = packBands([
      testBand("root", 1, 1000, [
        testBand("a", 1, 10),
        testBand("b", 20, 100),
        testBand("c", 200, 900),
      ]),
    ]);
    expect(laneById(packed)).toEqual({ root: 0, a: 1, b: 1, c: 1 });
    expect(totalLanes).toBe(2);
  });

  it("stacks overlapping siblings into one lane each", () => {
    const { packed, totalLanes } = packBands([
      testBand("root", 1, 1000, [
        testBand("wide", 1, 500),
        testBand("inner", 10, 20),
        testBand("also", 15, 30),
      ]),
    ]);
    // Three mutually overlapping ranges cannot share a row at any assignment.
    expect(laneById(packed)).toEqual({ root: 0, wide: 1, inner: 2, also: 3 });
    expect(totalLanes).toBe(4);
  });

  it("reuses a lane once the band occupying it has ended", () => {
    const { packed, totalLanes } = packBands([
      testBand("root", 1, 1000, [testBand("a", 1, 10), testBand("b", 2, 3), testBand("c", 20, 30)]),
    ]);
    // b is forced onto a second row by a, but c starts after a ends and drops
    // back onto a's row. Without the reuse the lane count would grow forever.
    expect(laneById(packed)).toEqual({ root: 0, a: 1, b: 2, c: 1 });
    expect(totalLanes).toBe(3);
  });

  it("treats an exactly shared edge as no overlap", () => {
    const { packed, totalLanes } = packBands([
      testBand("root", 1, 1000, [
        testBand("x", 1, 10),
        testBand("y", 10, 100),
        testBand("z", 100, 1000),
      ]),
    ]);
    // A clean partition (the color bands are one) must not stack three deep.
    expect(laneById(packed)).toEqual({ root: 0, x: 1, y: 1, z: 1 });
    expect(totalLanes).toBe(2);
  });

  it("keeps overlapping top-level bands in a single lane", () => {
    // Depth 0 is drawn as one continuous strip. An overlap there double-draws a
    // sliver rather than opening a second row and leaving a gap in the top row.
    const { packed, totalLanes } = packBands([testBand("a", 1, 100), testBand("b", 90, 1000)]);
    expect(packed.every((p) => p.lane === 0)).toBe(true);
    expect(totalLanes).toBe(1);
  });

  it("allocates lanes depth by depth, so a child never sits above its parent", () => {
    const { packed } = packBands([
      testBand("root", 1, 1e6, [
        testBand("mid", 1, 1000, [testBand("leafA", 1, 10), testBand("leafB", 5, 20)]),
      ]),
    ]);
    const byDepth = new Map<number, number[]>();
    for (const p of packed) byDepth.set(p.depth, [...(byDepth.get(p.depth) ?? []), p.lane]);
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const shallower = byDepth.get(depth - 1);
      if (shallower)
        expect(Math.min(...byDepth.get(depth)!)).toBeGreaterThan(Math.max(...shallower));
    }
  });
});

describe("lane packing: the real band tree", () => {
  const { packed, totalLanes } = packBands();

  it("places every band in the tree exactly once", () => {
    expect(packed).toHaveLength(flattenBands().length);
    expect(new Set(packed.map((p) => p.band.id)).size).toBe(packed.length);
  });

  it("reports a lane count that covers every lane used", () => {
    expect(totalLanes).toBe(Math.max(...packed.map((p) => p.lane)) + 1);
  });

  it("puts all seven top-level bands in lane 0, overlap and all", () => {
    const top = packed.filter((p) => p.depth === 0);
    expect(top).toHaveLength(BANDS.length);
    expect(top.every((p) => p.lane === 0)).toBe(true);
    // The rule earns its keep only because a real overlap exists up there: the
    // 380 to 400 nm sliver where ultraviolet and visible meet.
    const uv = BANDS.find((b) => b.id === "uv")!;
    const visible = BANDS.find((b) => b.id === "visible")!;
    expect(uv.fLow).toBeLessThan(visible.fHigh);
    expect(visible.fLow).toBeLessThan(uv.fHigh);
  });

  it("never mixes depths inside one lane", () => {
    const depthOfLane = new Map<number, number>();
    for (const p of packed) {
      const seen = depthOfLane.get(p.lane);
      if (seen === undefined) depthOfLane.set(p.lane, p.depth);
      else expect(p.depth).toBe(seen);
    }
  });

  it("never overlaps two bands drawn in the same sub-lane", () => {
    const byLane = new Map<number, Band[]>();
    for (const p of packed) {
      if (p.lane === 0) continue; // depth 0 is the deliberate exception above
      byLane.set(p.lane, [...(byLane.get(p.lane) ?? []), p.band]);
    }
    for (const bands of byLane.values()) {
      const sorted = [...bands].sort((a, b) => a.fLow - b.fLow);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i - 1]!.fHigh).toBeLessThanOrEqual(sorted[i]!.fLow * (1 + 1e-9));
      }
    }
  });
});

describe("map height", () => {
  it("gives every lane its target thickness plus the tick strip", () => {
    expect(mapHeightPx(10)).toBe(10 * 38 + TICK_MARGIN_H);
  });

  it("floors a shallow tree and caps a deep one", () => {
    expect(mapHeightPx(1)).toBe(300);
    expect(mapHeightPx(100)).toBe(660);
  });
});

describe("view window clamping", () => {
  it("never zooms out past the whole axis", () => {
    expect(clampWindow({ center: 0.5, span: 4 })).toEqual({ center: 0.5, span: 1 });
  });

  it("never zooms in past the minimum span", () => {
    expect(clampWindow({ center: 0.5, span: 0 }).span).toBe(MIN_SPAN);
    expect(clampWindow({ center: 0.5, span: -1 }).span).toBe(MIN_SPAN);
  });

  it("pulls a window that hangs off either end back inside", () => {
    expect(clampWindow({ center: 0, span: 0.2 })).toEqual({ center: 0.1, span: 0.2 });
    expect(clampWindow({ center: 1, span: 0.2 })).toEqual({ center: 0.9, span: 0.2 });
  });

  it("leaves a window that already fits alone", () => {
    expect(clampWindow({ center: 0.42, span: 0.2 })).toEqual({ center: 0.42, span: 0.2 });
  });

  it("clamps the span first, so an over-wide off-center window recenters", () => {
    // Clamping the center first would leave center 0.99 with span 1, which hangs
    // half the window off the low frequency end.
    expect(clampWindow({ center: 0.99, span: 5 })).toEqual({ center: 0.5, span: 1 });
  });
});

describe("axis coordinate transforms", () => {
  const full: AxisView = { center: 0.5, span: 1, lengthPx: 800 };
  const zoomed: AxisView = { center: frequencyToPosition(2.45e9), span: 0.05, lengthPx: 640 };

  it("picks the long dimension by orientation", () => {
    expect(axisLengthPx(800, 400, "horizontal")).toBe(800);
    expect(axisLengthPx(800, 400, "vertical")).toBe(400);
  });

  it("draws gamma at pixel zero and ELF at the far end", () => {
    expect(freqToAxisPx(AXIS_MAX_HZ, full)).toBeCloseTo(0, 9);
    expect(freqToAxisPx(AXIS_MIN_HZ, full)).toBeCloseTo(800, 6);
  });

  it("round-trips frequency through pixels, zoomed out and zoomed in", () => {
    for (const view of [full, zoomed]) {
      for (const f of [3, 1e5, 100e6, 2.45e9, 5.45e14, 1e20, 3e24]) {
        closeRel(axisPxToFreq(freqToAxisPx(f, view), view), f, 1e-9);
      }
    }
  });

  it("puts the leading edge of the window at pixel zero", () => {
    const view: AxisView = { center: 0.25, span: 0.1, lengthPx: 800 };
    expect(posToAxisPx(0.2, view)).toBeCloseTo(0, 9);
    expect(posToAxisPx(0.3, view)).toBeCloseTo(800, 6);
    expect(axisPxToPos(400, view)).toBeCloseTo(0.25, 12);
    // Positions outside the window map to pixels outside the drawing.
    expect(posToAxisPx(0.15, view)).toBeCloseTo(-400, 6);
  });

  it("clamps a pixel to the drawn axis at both ends", () => {
    expect(clampAxisPx(-50, full)).toBe(0);
    expect(clampAxisPx(1200, full)).toBe(800);
    expect(clampAxisPx(123, full)).toBe(123);
  });

  it("reads the axis ends rather than off it for out-of-range pixels", () => {
    closeRel(axisPxToFreq(-500, full), AXIS_MAX_HZ, 1e-9);
    closeRel(axisPxToFreq(5000, full), AXIS_MIN_HZ, 1e-9);
  });

  it("keeps the anchored frequency under the pointer while zooming", () => {
    const px = 200;
    const anchorFreq = axisPxToFreq(px, full);
    // What the ctrl and scroll handler does: change the span, then recenter.
    const after: AxisView = { center: 0, span: full.span / 4, lengthPx: full.lengthPx };
    after.center = centerHoldingAnchor(axisPxToPos(px, full), px, after);
    closeRel(axisPxToFreq(px, after), anchorFreq, 1e-9);
  });

  it("keeps the anchor when zooming out as well", () => {
    const px = 610;
    const anchorFreq = axisPxToFreq(px, zoomed);
    const after: AxisView = { center: 0, span: zoomed.span * 3, lengthPx: zoomed.lengthPx };
    after.center = centerHoldingAnchor(axisPxToPos(px, zoomed), px, after);
    closeRel(axisPxToFreq(px, after), anchorFreq, 1e-9);
  });
});

describe("label fitting", () => {
  it("returns the text untouched when it fits", () => {
    expect(fitLabel("FM broadcast", 400, 11)).toBe("FM broadcast");
  });

  it("truncates with an ellipsis when it does not", () => {
    expect(fitLabel("Ultraviolet", 40, 11)).toBe("Ultr…");
  });

  it("keeps the truncated label inside the box it was given", () => {
    const out = fitLabel("Ultraviolet", 40, 11)!;
    expect(out.length * 11 * 0.58).toBeLessThanOrEqual(40);
  });

  it("gives up rather than print a single letter and an ellipsis", () => {
    expect(fitLabel("ABCDEF", 24, 10)).toBe("AB…"); // three characters fit
    expect(fitLabel("ABCDEF", 23, 10)).toBeNull(); // only two would
  });

  it("gives up on a box narrower than the padding", () => {
    expect(fitLabel("Radio", 6, 11)).toBeNull();
    expect(fitLabel("Radio", 0, 11)).toBeNull();
    expect(fitLabel("Radio", -20, 11)).toBeNull();
  });

  it("scales the estimate with the font size", () => {
    expect(fitLabel("Microwave", 60, 8)).toBe("Microwave");
    expect(fitLabel("Microwave", 60, 16)).toBe("Micr…");
  });
});

describe("color helpers", () => {
  it("expands a six digit hex to rgba", () => {
    expect(withAlpha("#5b4bd6", 0.16)).toBe("rgba(91, 75, 214, 0.16)");
  });

  it("expands a three digit shorthand", () => {
    expect(withAlpha("#fff", 1)).toBe("rgba(255, 255, 255, 1)");
    expect(withAlpha("#0a0", 0.5)).toBe("rgba(0, 170, 0, 0.5)");
  });

  it("does not require the leading hash", () => {
    expect(withAlpha("2f7d5b", 0.5)).toBe("rgba(47, 125, 91, 0.5)");
  });

  it("falls back to black rather than NaN on an unreadable color", () => {
    expect(withAlpha("#zzzzzz", 0.5)).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("keeps a band's own swatch at any depth", () => {
    const swatch: Band = { ...testBand("green", 1, 2), color: "#22c55e" };
    expect(laneFill(0, swatch, "#5b4bd6")).toBe("#22c55e");
    expect(laneFill(3, swatch, "#5b4bd6")).toBe("#22c55e");
  });

  it("deepens the brand tint with depth, then holds", () => {
    const plain = testBand("plain", 1, 2);
    const fills = [0, 1, 2, 3, 9].map((d) => laneFill(d, plain, "#5b4bd6"));
    expect(fills).toEqual([
      "rgba(91, 75, 214, 0.1)",
      "rgba(91, 75, 214, 0.16)",
      "rgba(91, 75, 214, 0.22)",
      "rgba(91, 75, 214, 0.28)",
      "rgba(91, 75, 214, 0.28)",
    ]);
  });

  it("samples the visible curve from violet through green to red", () => {
    const stops = spectralStops();
    expect(stops).toHaveLength(25);
    expect(stops[0]).toEqual({ offset: 0, color: "#610061" }); // 380 nm, dimmed violet
    expect(stops[12]).toEqual({ offset: 0.5, color: "#d2ff00" }); // 565 nm, green dominant
    expect(stops[24]).toEqual({ offset: 1, color: "#610000" }); // 750 nm, dimmed red
  });

  it("takes a step count and spaces the offsets evenly", () => {
    expect(spectralStops(4).map((s) => s.offset)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

/* Scene building. */

const SCENE_COLORS: SceneColors = {
  fg: "#111111",
  muted: "#888888",
  border: "#cccccc",
  card: "#ffffff",
  primary: "#5b4bd6",
  positive: "#2f7d5b",
};

const REAL_PACKING = packBands();

/** The full-axis horizontal scene, with any field overridden per test. */
function scene(over: Partial<SceneInput> = {}): Scene {
  return buildScene({
    width: 800,
    height: 400,
    orientation: "horizontal",
    window: { center: 0.5, span: 1 },
    packed: REAL_PACKING.packed,
    totalLanes: REAL_PACKING.totalLanes,
    colors: SCENE_COLORS,
    pinnedFreqHz: null,
    cursorFreqHz: null,
    ...over,
  });
}

describe("scene building", () => {
  it("keeps every band box inside the map and clear of the tick strip", () => {
    const lanesExtent = 400 - TICK_MARGIN_H;
    for (const r of scene().rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(800 + 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(lanesExtent + 1e-9);
    }
  });

  it("gives every lane the same thickness", () => {
    const laneSize = (400 - TICK_MARGIN_H) / REAL_PACKING.totalLanes;
    for (const r of scene().rects) expect(r.h).toBeCloseTo(laneSize, 9);
  });

  it("marks only the visible band with a spectral gradient, violet end first", () => {
    const spectral = scene().rects.filter((r) => r.spectral);
    expect(spectral).toHaveLength(1);
    const s = spectral[0]!.spectral!;
    expect(s.x1).toBeLessThan(s.x2); // high frequency start to low frequency end
    expect(s.y1).toBe(0);
    expect(s.y2).toBe(0);
  });

  it("culls bands that fall outside the view", () => {
    const tree = [testBand("low", 3, 30), testBand("high", 1e24, 3e24)];
    const { packed, totalLanes } = packBands(tree);
    const zoomed = scene({
      packed,
      totalLanes,
      window: { center: frequencyToPosition(10), span: 0.02 },
    });
    expect(zoomed.rects).toHaveLength(1);
    expect(scene({ packed, totalLanes }).rects).toHaveLength(2);
  });

  it("draws the locked marker dashed and the live cursor solid", () => {
    const markers = scene({ pinnedFreqHz: 100e6, cursorFreqHz: 2.45e9 }).lines.filter(
      (l) => l.width === 2,
    );
    expect(markers).toHaveLength(2);
    expect(markers.find((l) => l.dash)!.color).toBe(SCENE_COLORS.positive);
    expect(markers.find((l) => !l.dash)!.color).toBe(SCENE_COLORS.primary);
  });

  it("draws one marker when the cursor sits on the lock", () => {
    const s = scene({ pinnedFreqHz: 100e6, cursorFreqHz: 100e6 });
    expect(s.lines.filter((l) => l.width === 2)).toHaveLength(1);
  });

  it("omits a marker that has been scrolled off screen", () => {
    const s = scene({
      window: { center: frequencyToPosition(2.45e9), span: 0.01 },
      pinnedFreqHz: AXIS_MIN_HZ,
    });
    expect(s.lines.filter((l) => l.width === 2)).toHaveLength(0);
  });

  it("labels one tick per decade across the whole axis", () => {
    const s = scene();
    // 3 Hz to 3e24 Hz: the decade ticks 10^1 through 10^24 fall inside.
    expect(s.texts).toHaveLength(24);
    expect(s.texts[0]!.text).toBe("10 Hz");
    expect(s.texts[23]!.text).toBe("1 YHz");
    expect(s.texts.map((t) => t.text)).toContain("1 GHz");
    // Every label reads back as the exact power of ten it marks, which also
    // proves the SI prefix on it is the right one.
    for (const t of s.texts) {
      const decade = Math.log10(parseJump(t.text));
      expect(decade).toBeCloseTo(Math.round(decade), 9);
    }
  });

  it("adds the 2 and 5 subticks once the view is under six decades", () => {
    const s = scene({
      window: { center: frequencyToPosition(2.45e9), span: 5 / AXIS_DECADES },
    });
    const texts = s.texts.map((t) => t.text);
    expect(texts).toContain("2 GHz");
    expect(texts).toContain("5 GHz");
  });

  it("moves the ticks to the other axis when rotated", () => {
    const v = scene({ orientation: "vertical" });
    const laneSize = (800 - TICK_MARGIN_V) / REAL_PACKING.totalLanes;
    for (const r of v.rects) expect(r.w).toBeCloseTo(laneSize, 9);
    for (const l of v.lines.filter((l) => l.width === 1)) expect(l.x1).toBe(TICK_MARGIN_V);
    for (const t of v.texts) expect(t.x).toBe(4);
    // Horizontal keeps its tick labels on a single baseline under the lanes.
    for (const t of scene().texts) expect(t.y).toBe(400 - TICK_MARGIN_H + 15);
  });

  it("plates a band label only where it sits on a color swatch", () => {
    // Zoomed onto the visible band, where the colored sub-bands are drawn: a
    // label on a saturated swatch needs the card-colored plate behind it to keep
    // its contrast, and a label on a brand tint does not.
    const s = scene({ window: { center: frequencyToPosition(5.4e14), span: 0.02 } });
    const plated = s.bandTexts.filter((t) => t.plate);
    expect(plated.map((t) => t.text)).toContain("Visible light");
    expect(s.bandTexts.filter((t) => !t.plate).map((t) => t.text)).toContain("Ultraviolet");
    for (const t of plated) {
      expect(t.plate!.w).toBeCloseTo(t.text.length * t.size * 0.58 + 8, 9);
      expect(t.plate!.h).toBe(t.size + 4);
    }
  });
});

describe("SVG serialization", () => {
  it("emits the background, every rect, and every text plate", () => {
    const s = scene();
    const plates = [...s.texts, ...s.bandTexts].filter((t) => t.plate).length;
    const svg = sceneToSvg(s, SCENE_COLORS);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg.match(/<rect /g)).toHaveLength(1 + s.rects.length + plates);
    expect(svg.match(/<line /g)).toHaveLength(s.lines.length);
    expect(svg.match(/<text /g)).toHaveLength(s.texts.length + s.bandTexts.length);
  });

  it("defines and references a gradient for the visible band", () => {
    const svg = sceneToSvg(scene(), SCENE_COLORS);
    expect(svg).toContain('<linearGradient id="spec0"');
    expect(svg).toContain('fill="url(#spec0)"');
    expect(svg.match(/<stop /g)).toHaveLength(25);
  });

  it("dashes the locked marker", () => {
    const svg = sceneToSvg(scene({ pinnedFreqHz: 100e6 }), SCENE_COLORS);
    expect(svg).toContain('stroke-dasharray="4 3"');
  });

  it("escapes markup characters in label text", () => {
    const hostile: Scene = {
      rects: [],
      lines: [],
      texts: [{ x: 1, y: 2, text: 'a & b <c> "d"', color: "#000000", size: 10, align: "start" }],
      bandTexts: [],
      w: 10,
      h: 10,
    };
    const svg = sceneToSvg(hostile, SCENE_COLORS);
    expect(svg).toContain('a &amp; b &lt;c&gt; "d"');
    expect(svg).not.toContain("<c>");
  });
});

describe("band label overlay", () => {
  const NARROW_ICON = "Wifi";
  const narrow: Band = { ...testBand("narrow", 1e9, 1.02e9), icon: NARROW_ICON };
  const tree = [testBand("root", AXIS_MIN_HZ, AXIS_MAX_HZ, [narrow])];
  const { packed, totalLanes } = packBands(tree);

  /** The normalized width of the narrow band, and its center. */
  const bandWidth = frequencyToPosition(narrow.fLow) - frequencyToPosition(narrow.fHigh);
  const bandCenter = (frequencyToPosition(narrow.fLow) + frequencyToPosition(narrow.fHigh)) / 2;

  /** The span that draws the narrow band exactly `px` wide at 800px of axis. */
  const spanDrawing = (px: number) => (bandWidth * 800) / px;

  function labels(span: number, over: Partial<BandLabelInput> = {}) {
    return buildBandLabels({
      width: 800,
      height: 400,
      orientation: "horizontal",
      window: { center: bandCenter, span },
      packed,
      totalLanes,
      ...over,
    });
  }

  it("shows a full label once the box clears the legibility threshold", () => {
    const l = labels(spanDrawing(MIN_LABEL_ALONG * 2)).find((x) => x.key === "narrow")!;
    expect(l).toBeDefined();
    expect(l.iconOnly).toBe(false);
    expect(l.w).toBeCloseTo(MIN_LABEL_ALONG * 2, 6);
    expect(l.name).toBe("narrow");
  });

  it("falls back to the icon alone in the band between the thresholds", () => {
    const px = (MIN_LABEL_ALONG + ICON_ONLY_ALONG) / 2;
    const l = labels(spanDrawing(px)).find((x) => x.key === "narrow")!;
    expect(l).toBeDefined();
    expect(l.iconOnly).toBe(true);
    expect(l.showIcon).toBe(true);
    expect(l.icon).toBe(NARROW_ICON);
  });

  it("drops the label entirely below the icon threshold", () => {
    const px = ICON_ONLY_ALONG - 2;
    expect(labels(spanDrawing(px)).some((x) => x.key === "narrow")).toBe(false);
  });

  it("shows the icon beside the name only in a wide box", () => {
    expect(labels(spanDrawing(50)).find((x) => x.key === "narrow")!.showIcon).toBe(false);
    expect(labels(spanDrawing(120)).find((x) => x.key === "narrow")!.showIcon).toBe(true);
  });

  it("returns nothing at all when the lanes are too thin to read", () => {
    const thin = (MIN_LABEL_CROSS - 1) * totalLanes + TICK_MARGIN_H;
    expect(labels(1, { height: thin })).toEqual([]);
    expect(labels(1, { height: 400 }).length).toBeGreaterThan(0);
  });

  it("positions each label box exactly on the rect the canvas paints", () => {
    // The overlay and the canvas are two renderers of one geometry; if they ever
    // disagree the labels visibly slide off their bands.
    const only = packBands([{ ...testBand("only", 1e9, 1e12), icon: NARROW_ICON }]);
    const window = { center: 0.5, span: 1 };
    const s = buildScene({
      width: 800,
      height: 400,
      orientation: "horizontal",
      window,
      packed: only.packed,
      totalLanes: only.totalLanes,
      colors: SCENE_COLORS,
      pinnedFreqHz: null,
      cursorFreqHz: null,
    });
    const [label] = buildBandLabels({
      width: 800,
      height: 400,
      orientation: "horizontal",
      window,
      packed: only.packed,
      totalLanes: only.totalLanes,
    });
    expect(label).toBeDefined();
    expect(label!.x).toBeCloseTo(s.rects[0]!.x, 9);
    expect(label!.y).toBeCloseTo(s.rects[0]!.y, 9);
    expect(label!.w).toBeCloseTo(s.rects[0]!.w, 9);
    expect(label!.h).toBeCloseTo(s.rects[0]!.h, 9);
  });

  it("swaps the axes when rotated", () => {
    // A band covering the whole axis draws long along it and one lane thick
    // across it, whichever way the map is turned.
    const h = labels(1).find((x) => x.key === "root")!;
    const v = labels(1, { orientation: "vertical", width: 400, height: 800 }).find(
      (x) => x.key === "root",
    )!;
    expect(h.w).toBeGreaterThan(h.h);
    expect(v.h).toBeGreaterThan(v.w);
    expect(v.w).toBeCloseTo((400 - TICK_MARGIN_V) / totalLanes, 9);
  });

  it("asks for a larger label on a top-level band", () => {
    const found = labels(1);
    expect(found.find((x) => x.key === "root")!.max).toBe(15);
    expect(labels(spanDrawing(120)).find((x) => x.key === "narrow")!.max).toBe(12);
  });
});
