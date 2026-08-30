import { describe, expect, it } from "vitest";
import {
  AUFBAU_EXCEPTIONS,
  aufbauFill,
  blockOf,
  boxDiagram,
  configurationOf,
  neutralConfiguration,
  nobleCore,
  parseSpecies,
  run,
  unpairedIn,
  valenceCount,
} from "./index";
import { ToolError } from "../types";

function config(input: string): string {
  return run(input, { showDiagram: false })["Electron configuration"]!;
}

function shorthand(input: string): string {
  return run(input, { showDiagram: false })["Noble gas shorthand"]!;
}

describe("parseSpecies", () => {
  it("accepts a symbol, a name and an atomic number", () => {
    expect(parseSpecies("Fe").atomicNumber).toBe(26);
    expect(parseSpecies("iron").atomicNumber).toBe(26);
    expect(parseSpecies("26").symbol).toBe("Fe");
  });

  it("accepts an ion in either notation", () => {
    expect(parseSpecies("Fe3+")).toMatchObject({ charge: 3, electrons: 23 });
    expect(parseSpecies("Cu^2+")).toMatchObject({ charge: 2, electrons: 27 });
    expect(parseSpecies("O2-")).toMatchObject({ charge: -2, electrons: 10 });
    expect(parseSpecies("Cl-")).toMatchObject({ charge: -1, electrons: 18 });
  });

  it("rejects an empty input", () => {
    expect(() => parseSpecies("")).toThrow(/No element to look up/);
  });

  it("rejects an unknown element", () => {
    expect(() => parseSpecies("Xq")).toThrow(/not an element symbol/);
    expect(() => parseSpecies("200")).toThrow(/no element with atomic number/);
  });

  it("rejects an impossible charge", () => {
    expect(() => parseSpecies("H2+")).toThrow(ToolError);
    expect(() => parseSpecies("He2+")).toThrow(/bare nucleus/);
  });
});

describe("aufbau filling", () => {
  it("fills in Madelung order", () => {
    expect(aufbauFill(20)).toEqual({
      "1s": 2,
      "2s": 2,
      "2p": 6,
      "3s": 2,
      "3p": 6,
      "4s": 2,
    });
  });

  it("keeps every exception at the right electron count", () => {
    for (const key of Object.keys(AUFBAU_EXCEPTIONS)) {
      const z = Number(key);
      const total = Object.values(neutralConfiguration(z)).reduce((a, b) => a + b, 0);
      expect(total).toBe(z);
    }
  });

  it("applies the chromium and copper exceptions", () => {
    expect(config("Cr")).toBe("1s2 2s2 2p6 3s2 3p6 3d5 4s1");
    expect(config("Cu")).toBe("1s2 2s2 2p6 3s2 3p6 3d10 4s1");
  });

  it("applies the palladium exception, which empties the 5s", () => {
    expect(shorthand("Pd")).toBe("[Kr] 4d10");
  });

  it("applies the lanthanide and actinide exceptions", () => {
    expect(shorthand("La")).toBe("[Xe] 5d1 6s2");
    expect(shorthand("Gd")).toBe("[Xe] 4f7 5d1 6s2");
    expect(shorthand("U")).toBe("[Rn] 5f3 6d1 7s2");
  });
});

describe("configurations", () => {
  it("writes iron by shell and by energy", () => {
    expect(config("Fe")).toBe("1s2 2s2 2p6 3s2 3p6 3d6 4s2");
    expect(run("Fe", { order: "energy", showDiagram: false })["Electron configuration"]).toBe(
      "1s2 2s2 2p6 3s2 3p6 4s2 3d6",
    );
  });

  it("removes the outer s electrons first for a cation", () => {
    expect(shorthand("Fe3+")).toBe("[Ar] 3d5");
    expect(shorthand("Fe2+")).toBe("[Ar] 3d6");
    expect(shorthand("Cu2+")).toBe("[Ar] 3d9");
  });

  it("adds electrons in Aufbau order for an anion", () => {
    expect(config("O2-")).toBe("1s2 2s2 2p6");
    expect(shorthand("Cl-")).toBe("[Ne] 3s2 3p6");
  });

  it("finds the right noble gas core", () => {
    const shells = configurationOf(parseSpecies("Br"));
    expect(nobleCore(shells)?.symbol).toBe("Ar");
    expect(nobleCore(configurationOf(parseSpecies("H")))).toBeNull();
  });
});

describe("orbital diagrams and pairing", () => {
  it("follows Hund's rule when counting unpaired electrons", () => {
    expect(unpairedIn({ label: "2p", n: 2, l: "p", electrons: 3 })).toBe(3);
    expect(unpairedIn({ label: "2p", n: 2, l: "p", electrons: 4 })).toBe(2);
    expect(unpairedIn({ label: "3d", n: 3, l: "d", electrons: 6 })).toBe(4);
    expect(unpairedIn({ label: "3d", n: 3, l: "d", electrons: 10 })).toBe(0);
  });

  it("draws the boxes", () => {
    expect(boxDiagram({ label: "3d", n: 3, l: "d", electrons: 6 })).toBe(
      "[↑↓][↑ ][↑ ][↑ ][↑ ]",
    );
    expect(boxDiagram({ label: "2p", n: 2, l: "p", electrons: 2 })).toBe("[↑ ][↑ ][  ]");
  });

  it("calls iron paramagnetic and zinc diamagnetic", () => {
    expect(run("Fe")["Magnetic behavior"]).toBe("Paramagnetic, with 4 unpaired electrons");
    expect(run("Zn")["Magnetic behavior"]).toBe("Diamagnetic, every electron is paired");
    expect(run("Fe3+")["Unpaired electrons"]).toBe("5");
  });
});

describe("valence, block, period and group", () => {
  it("counts valence electrons the way a textbook does", () => {
    expect(valenceCount(configurationOf(parseSpecies("Br")))).toBe(7);
    expect(valenceCount(configurationOf(parseSpecies("Fe")))).toBe(8);
    expect(valenceCount(configurationOf(parseSpecies("Cu")))).toBe(1);
    expect(valenceCount(configurationOf(parseSpecies("O2-")))).toBe(8);
    expect(valenceCount(configurationOf(parseSpecies("Fe3+")))).toBe(5);
  });

  it("assigns the block from the period and group", () => {
    expect(blockOf(2, 18)).toBe("s");
    expect(blockOf(11, 1)).toBe("s");
    expect(blockOf(17, 17)).toBe("p");
    expect(blockOf(26, 8)).toBe("d");
    expect(blockOf(64, undefined)).toBe("f");
  });

  it("reports the period and group", () => {
    const out = run("Fe", { showDiagram: false });
    expect(out["Period"]).toBe("4");
    expect(out["Group"]).toBe("8");
    expect(out["Block"]).toBe("d block");
  });

  it("says why an f block element has no group", () => {
    expect(run("Gd", { showDiagram: false })["Group"]).toContain("f block");
  });
});

describe("run", () => {
  it("flags an Aufbau exception", () => {
    expect(run("Cr", { showDiagram: false })["Aufbau exception"]).toContain("breaks the Aufbau");
    expect(run("Fe", { showDiagram: false })["Aufbau exception"]).toBeUndefined();
  });

  it("explains the ionization order", () => {
    expect(run("Fe3+", { showDiagram: false })["Ionization note"]).toContain(
      "highest principal quantum number first",
    );
  });

  it("can hide the diagram", () => {
    expect(run("Fe", { showDiagram: false })["Orbital diagram 3d"]).toBeUndefined();
    expect(run("Fe")["Orbital diagram 3d"]).toContain("4 unpaired");
  });

  it("names the species and the element", () => {
    const out = run("O2-", { showDiagram: false });
    expect(out["Species"]).toBe("O2-");
    expect(out["Element"]).toBe("Oxygen (O), atomic number 8");
    expect(out["Electrons"]).toBe("10");
  });
});
