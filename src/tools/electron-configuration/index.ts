import { ELEMENTS } from "../_generated/elements";
import { ToolError, type ToolLogic } from "../types";

/**
 * Electron configuration, orbital diagram and magnetic behavior for an element
 * or a monatomic ion.
 *
 * Subshells are filled in Madelung order (increasing n + l, then increasing n),
 * which is the ordinary Aufbau sequence 1s 2s 2p 3s 3p 4s 3d 4p 5s 4d 5p 6s 4f
 * 5d 6p 7s 5f 6d 7p. Aufbau is a rule of thumb rather than a law, and about
 * twenty elements measurably disobey it because a half filled or filled d or f
 * subshell sits lower in energy than the extra s electron. Those are carried in
 * an explicit exception table rather than derived, and the output says when one
 * applied.
 *
 * The configurations in src/tools/_generated/elements.ts are deliberately not
 * used here: several of them are marked predicted, and their orbital ordering
 * is inconsistent. Only the element identity, period and group are read from
 * that file.
 *
 * Ionization removes electrons from the highest principal quantum number first,
 * and from the highest angular momentum within that shell, which is why iron
 * loses both 4s electrons before any 3d electron and Fe3+ is [Ar] 3d5 rather
 * than [Ar] 3d3 4s2. Adding electrons to make an anion follows the ordinary
 * Aufbau order.
 */

/** Subshell capacity by letter. */
const CAPACITY: Record<string, number> = { s: 2, p: 6, d: 10, f: 14 };
/** Orbitals per subshell, for the box diagram. */
const BOXES: Record<string, number> = { s: 1, p: 3, d: 5, f: 7 };
const L_INDEX: Record<string, number> = { s: 0, p: 1, d: 2, f: 3 };

/** The Madelung filling order, as far as any known element needs. */
export const AUFBAU_ORDER = [
  "1s",
  "2s",
  "2p",
  "3s",
  "3p",
  "4s",
  "3d",
  "4p",
  "5s",
  "4d",
  "5p",
  "6s",
  "4f",
  "5d",
  "6p",
  "7s",
  "5f",
  "6d",
  "7p",
];

/**
 * Elements whose measured ground state configuration differs from plain Aufbau.
 * Each entry gives the final occupancy of only the subshells that differ.
 */
export const AUFBAU_EXCEPTIONS: Record<number, Record<string, number>> = {
  24: { "4s": 1, "3d": 5 }, // chromium
  29: { "4s": 1, "3d": 10 }, // copper
  41: { "5s": 1, "4d": 4 }, // niobium
  42: { "5s": 1, "4d": 5 }, // molybdenum
  44: { "5s": 1, "4d": 7 }, // ruthenium
  45: { "5s": 1, "4d": 8 }, // rhodium
  46: { "5s": 0, "4d": 10 }, // palladium
  47: { "5s": 1, "4d": 10 }, // silver
  57: { "4f": 0, "5d": 1 }, // lanthanum
  58: { "4f": 1, "5d": 1 }, // cerium
  64: { "4f": 7, "5d": 1 }, // gadolinium
  78: { "6s": 1, "5d": 9 }, // platinum
  79: { "6s": 1, "5d": 10 }, // gold
  89: { "5f": 0, "6d": 1 }, // actinium
  90: { "5f": 0, "6d": 2 }, // thorium
  91: { "5f": 2, "6d": 1 }, // protactinium
  92: { "5f": 3, "6d": 1 }, // uranium
  93: { "5f": 4, "6d": 1 }, // neptunium
  96: { "5f": 7, "6d": 1 }, // curium
};

/** Atomic numbers of the noble gases, for the shorthand core. */
const NOBLE_GASES = [2, 10, 18, 36, 54, 86, 118];

export interface ElectronOpts {
  /** "shell" writes 3d before 4s; "energy" writes them in filling order. */
  order: string;
  /** Include the orbital box diagram. */
  showDiagram: boolean;
  [key: string]: unknown;
}

export interface Subshell {
  /** For example "3d". */
  label: string;
  n: number;
  /** "s", "p", "d" or "f". */
  l: string;
  electrons: number;
}

export interface Species {
  atomicNumber: number;
  symbol: string;
  name: string;
  charge: number;
  electrons: number;
  period: number;
  group?: number;
  block: string;
  /** True when the neutral atom's configuration breaks the Aufbau order. */
  exception: boolean;
}

const BY_SYMBOL: Record<string, (typeof ELEMENTS)[number]> = {};
const BY_NAME: Record<string, (typeof ELEMENTS)[number]> = {};
const BY_NUMBER: Record<number, (typeof ELEMENTS)[number]> = {};
for (const el of ELEMENTS) {
  BY_SYMBOL[el.symbol.toLowerCase()] = el;
  BY_NAME[el.name.toLowerCase()] = el;
  BY_NUMBER[el.atomicNumber] = el;
}

/** The block an element belongs to, from its period and group. */
export function blockOf(atomicNumber: number, group: number | undefined): string {
  if (atomicNumber === 2) return "s";
  if (group === undefined) return "f";
  if (group <= 2) return "s";
  if (group >= 13) return "p";
  return "d";
}

/** Parse "Fe", "iron", "26", "Fe3+", "O2-" or "Cu^2+" into an element and a charge. */
export function parseSpecies(raw: string): Species {
  let s = (raw ?? "").trim().replace(/\s+/g, "");
  if (!s)
    throw new ToolError(
      "empty-input",
      "No element to look up.",
      'Type a symbol, a name, an atomic number, or an ion: "Fe", "iron", "26" or "Fe3+".',
    );

  let charge = 0;
  const caret = /\^(\d*)([+-]+)$/.exec(s);
  const trailing = caret ?? /(\d*)([+-]+)$/.exec(s);
  if (trailing) {
    const digits = trailing[1]!;
    const signs = trailing[2]!;
    const sign = signs.includes("-") ? -1 : 1;
    charge = sign * (digits ? Number(digits) : signs.length);
    s = s.slice(0, -trailing[0]!.length);
  }
  if (!s)
    throw new ToolError(
      "empty-input",
      "That input is a charge with no element in front of it.",
      'Write the ion as the symbol then the charge, such as "Fe3+" or "O2-".',
    );

  const key = s.toLowerCase();
  const el = /^\d+$/.test(s) ? BY_NUMBER[Number(s)] : (BY_SYMBOL[key] ?? BY_NAME[key]);
  if (!el) {
    if (/^\d+$/.test(s))
      throw new ToolError(
        "unknown-element",
        `There is no element with atomic number ${s}.`,
        "Atomic numbers run from 1 (hydrogen) to 118 (oganesson).",
      );
    throw new ToolError(
      "unknown-element",
      `"${s}" is not an element symbol, name or atomic number.`,
      'Use a symbol such as Fe, a name such as iron, or an atomic number such as 26. American spellings are used, so it is sulfur, aluminum and cesium.',
    );
  }

  const electrons = el.atomicNumber - charge;
  if (electrons < 0)
    throw new ToolError(
      "too-positive",
      `${el.name} only has ${el.atomicNumber} electrons, so a charge of ${charge}+ is impossible.`,
      `Use a charge no larger than ${el.atomicNumber}+.`,
    );
  if (electrons === 0)
    throw new ToolError(
      "bare-nucleus",
      `Stripping all ${el.atomicNumber} electrons leaves a bare nucleus, which has no configuration.`,
      "Use a smaller positive charge.",
    );
  if (electrons > 118)
    throw new ToolError(
      "too-negative",
      `A charge of ${Math.abs(charge)}- would give ${electrons} electrons, past the ${118} that any known configuration covers.`,
      "Use a smaller negative charge.",
    );

  const species: Species = {
    atomicNumber: el.atomicNumber,
    symbol: el.symbol,
    name: el.name,
    charge,
    electrons,
    period: el.period,
    block: blockOf(el.atomicNumber, el.group),
    exception: AUFBAU_EXCEPTIONS[el.atomicNumber] !== undefined,
  };
  if (el.group !== undefined) species.group = el.group;
  return species;
}

function toSubshell(label: string, electrons: number): Subshell {
  return { label, n: Number(label[0]), l: label[1]!, electrons };
}

/** Fill `count` electrons into the Madelung order, with no exceptions applied. */
export function aufbauFill(count: number): Record<string, number> {
  const filled: Record<string, number> = {};
  let left = count;
  for (const orbital of AUFBAU_ORDER) {
    if (left <= 0) break;
    const cap = CAPACITY[orbital[1]!]!;
    const take = Math.min(cap, left);
    filled[orbital] = take;
    left -= take;
  }
  if (left > 0)
    throw new ToolError(
      "too-many-electrons",
      `${count} electrons do not fit in the subshells this tool models.`,
      "Configurations here cover up to 118 electrons.",
    );
  return filled;
}

/** The ground state configuration of a neutral atom, exceptions included. */
export function neutralConfiguration(atomicNumber: number): Record<string, number> {
  const filled = aufbauFill(atomicNumber);
  const override = AUFBAU_EXCEPTIONS[atomicNumber];
  if (override) for (const [orbital, n] of Object.entries(override)) filled[orbital] = n;
  return filled;
}

/** The configuration of a species, ionization included, as ordered subshells. */
export function configurationOf(species: Species): Subshell[] {
  const filled = neutralConfiguration(species.atomicNumber);

  if (species.charge > 0) {
    let toRemove = species.charge;
    while (toRemove > 0) {
      // Highest principal quantum number first, then highest angular momentum.
      let best: string | undefined;
      for (const [orbital, count] of Object.entries(filled)) {
        if (count <= 0) continue;
        if (!best) {
          best = orbital;
          continue;
        }
        const a = toSubshell(orbital, count);
        const b = toSubshell(best, filled[best]!);
        if (a.n > b.n || (a.n === b.n && L_INDEX[a.l]! > L_INDEX[b.l]!)) best = orbital;
      }
      if (!best) break;
      filled[best] = filled[best]! - 1;
      toRemove--;
    }
  } else if (species.charge < 0) {
    let toAdd = -species.charge;
    for (const orbital of AUFBAU_ORDER) {
      if (toAdd <= 0) break;
      const cap = CAPACITY[orbital[1]!]!;
      const have = filled[orbital] ?? 0;
      const room = cap - have;
      if (room <= 0) continue;
      const take = Math.min(room, toAdd);
      filled[orbital] = have + take;
      toAdd -= take;
    }
    if (toAdd > 0)
      throw new ToolError(
        "too-many-electrons",
        "That many extra electrons do not fit in the subshells this tool models.",
        "Configurations here cover up to 118 electrons.",
      );
  }

  return Object.entries(filled)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => toSubshell(label, count))
    .sort((a, b) => a.n - b.n || L_INDEX[a.l]! - L_INDEX[b.l]!);
}

/** Order a configuration by filling energy instead of by shell. */
function byEnergy(shells: Subshell[]): Subshell[] {
  return shells
    .slice()
    .sort((a, b) => AUFBAU_ORDER.indexOf(a.label) - AUFBAU_ORDER.indexOf(b.label));
}

function render(shells: Subshell[]): string {
  return shells.map((s) => `${s.label}${s.electrons}`).join(" ");
}

/** The largest noble gas core the configuration fully contains. */
export function nobleCore(shells: Subshell[]): { symbol: string; rest: Subshell[] } | null {
  const have: Record<string, number> = {};
  for (const s of shells) have[s.label] = s.electrons;
  for (let i = NOBLE_GASES.length - 1; i >= 0; i--) {
    const z = NOBLE_GASES[i]!;
    const total = shells.reduce((a, s) => a + s.electrons, 0);
    if (z >= total) continue;
    const core = aufbauFill(z);
    let matches = true;
    for (const [orbital, count] of Object.entries(core)) {
      if ((have[orbital] ?? 0) !== count) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const rest = shells.filter((s) => core[s.label] === undefined);
    return { symbol: BY_NUMBER[z]!.symbol, rest };
  }
  return null;
}

/** Unpaired electrons in one subshell, following Hund's rule. */
export function unpairedIn(shell: Subshell): number {
  const boxes = BOXES[shell.l]!;
  return shell.electrons <= boxes ? shell.electrons : 2 * boxes - shell.electrons;
}

/** One subshell drawn as boxes of up and down arrows. */
export function boxDiagram(shell: Subshell): string {
  const boxes = BOXES[shell.l]!;
  const singles = shell.electrons <= boxes ? shell.electrons : 2 * boxes - shell.electrons;
  const pairs = shell.electrons <= boxes ? 0 : shell.electrons - boxes;
  const cells: string[] = [];
  for (let i = 0; i < boxes; i++) {
    if (i < pairs) cells.push("[↑↓]");
    else if (i < pairs + singles) cells.push("[↑ ]");
    else cells.push("[  ]");
  }
  return cells.join("");
}

/**
 * Valence electrons: everything outside the noble gas core, less any inner d or
 * f subshell that is completely full and sits below the outermost shell. That
 * gives 7 for bromine, 8 for iron, 1 for copper and 5 for the iron(III) ion.
 */
export function valenceCount(shells: Subshell[]): number {
  const core = nobleCore(shells);
  const outer = core ? core.rest : shells;
  const maxN = outer.reduce((a, s) => Math.max(a, s.n), 0);
  let total = 0;
  for (const s of outer) {
    const full = s.electrons === CAPACITY[s.l];
    if (full && s.n < maxN && (s.l === "d" || s.l === "f")) continue;
    total += s.electrons;
  }
  return total;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function chargeLabel(charge: number): string {
  if (charge === 0) return "";
  const size = Math.abs(charge);
  return `${size === 1 ? "" : size}${charge < 0 ? "-" : "+"}`;
}

export function run(input: string, opts?: Partial<ElectronOpts>): Record<string, string> {
  const species = parseSpecies(input);
  const shells = configurationOf(species);
  const order = String(opts?.order ?? "shell") === "energy" ? byEnergy(shells) : shells;
  const showDiagram = bool(opts?.showDiagram, true);
  const core = nobleCore(shells);
  const unpaired = shells.reduce((a, s) => a + unpairedIn(s), 0);

  const out: Record<string, string> = {
    Species: `${species.symbol}${chargeLabel(species.charge)}`,
    Element: `${species.name} (${species.symbol}), atomic number ${species.atomicNumber}`,
    Electrons: String(species.electrons),
    "Electron configuration": render(order),
    "Noble gas shorthand": core
      ? `[${core.symbol}] ${render(String(opts?.order ?? "shell") === "energy" ? byEnergy(core.rest) : core.rest)}`
      : "none, this configuration has no noble gas core below it",
    "Valence electrons": String(valenceCount(shells)),
    Block: `${species.block} block`,
    Period: String(species.period),
    Group: species.group === undefined ? "none, it sits in the f block" : String(species.group),
    "Unpaired electrons": String(unpaired),
    "Magnetic behavior":
      unpaired > 0
        ? `Paramagnetic, with ${unpaired} unpaired electron${unpaired === 1 ? "" : "s"}`
        : "Diamagnetic, every electron is paired",
  };

  if (species.charge !== 0)
    out["Ionization note"] =
      species.charge > 0
        ? "Electrons come off the highest principal quantum number first, and the highest angular momentum within it, so the outer s electrons go before any inner d electron."
        : "Added electrons follow the ordinary Aufbau order into the next subshell with room.";

  if (species.exception)
    out["Aufbau exception"] =
      `${species.name} is one of the elements whose measured ground state breaks the Aufbau order, because a half filled or filled inner subshell sits lower in energy than the extra outer s electron. The configuration above is the measured one, not what plain Aufbau predicts.`;

  if (showDiagram) {
    for (const shell of order) {
      out[`Orbital diagram ${shell.label}`] =
        `${boxDiagram(shell)}  ${shell.electrons} electron${shell.electrons === 1 ? "" : "s"}, ${unpairedIn(shell)} unpaired`;
    }
  }

  return out;
}

export default { run } satisfies ToolLogic<string, Record<string, string>, Partial<ElectronOpts>>;
