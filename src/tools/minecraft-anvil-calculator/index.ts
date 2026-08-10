/**
 * Minecraft anvil calculator: an exact reimplementation of the game's anvil
 * cost algorithm per version, plus an optimal combine planner and a Too
 * Expensive horizon.
 *
 * The combine engine mirrors AnvilMenu.createResult() from the decompiled or
 * unobfuscated server source of every supported version, branch for branch:
 * repair-by-material units, the 12 percent sacrifice durability bonus, the
 * enchantment transfer loop with equal-level bump and max-level cap, the per
 * conflicting pair incompatibility penalty, book fee halving (minimum 1),
 * rename costs, the rename-only clamp to 39, prior-work growth via
 * calculateIncreasedRepairCost (2n+1), and the Too Expensive cutoff at 40.
 * Per-version data (fees, max levels, exclusive sets, item applicability) is
 * generated from game data by mc-pipeline/05-emit-anvil-data.mjs.
 */
import { ToolError, type ToolLogic } from "../types";
import { ANVIL_VERSIONS, type AnvilEnchant, type AnvilVersionData } from "./data";

export interface EnchantInstance {
  id: string;
  level: number;
}

export interface AnvilItem {
  /** Family id from the version data, or "book" for an enchanted book. */
  kind: string;
  enchants: EnchantInstance[];
  /** Stored repair cost (prior-work penalty): 0, 1, 3, 7, 15, 31, 63... */
  priorWork: number;
  /** Current damage (0 = pristine). Capped by the family's maxDamage. */
  damage: number;
  /** Stack size in the target slot; more than 1 forces the 40 level cost. */
  count?: number;
  /** Whether the item currently carries a custom name. */
  customName?: boolean;
}

export type RenameAction = "keep" | "set" | "clear";

export interface CombineOptions {
  version: string;
  creative?: boolean;
  rename?: RenameAction;
}

export type CombineStatus = "ok" | "too-expensive" | "no-change" | "no-result" | "invalid-pair";

export interface CostLine {
  label: string;
  amount: number;
}

export interface CombineOutcome {
  status: CombineStatus;
  /** What the anvil UI displays for this version. */
  displayedCost: number;
  /** Work portion (repairs, enchants, penalties, rename). */
  work: number;
  /** Prior-work portion (target plus sacrifice repair costs). */
  priorWorkCost: number;
  breakdown: CostLine[];
  result: AnvilItem | null;
  /** Units consumed in repair-by-material mode. */
  materialsUsed: number;
  /** Sacrifice enchantments that could not transfer and were dropped. */
  droppedEnchants: string[];
}

function versionData(version: string): AnvilVersionData {
  const data = ANVIL_VERSIONS[version];
  if (!data) {
    throw new ToolError(
      "unknown-version",
      `Version "${version}" is not in the anvil data set.`,
      `Use one of: ${Object.keys(ANVIL_VERSIONS).join(", ")}.`,
    );
  }
  return data;
}

function enchantData(data: AnvilVersionData, id: string): AnvilEnchant {
  const e = data.enchants.find((x) => x.id === id);
  if (!e) {
    throw new ToolError(
      "unknown-enchant",
      `Enchantment "${id}" does not exist in ${data.version}.`,
      "Pick an enchantment from this version's list.",
    );
  }
  return e;
}

function familyMaxDamage(data: AnvilVersionData, kind: string): number {
  const fam = data.families.find((f) => f.id === kind);
  if (!fam) {
    throw new ToolError(
      "unknown-item",
      `Item family "${kind}" does not exist in ${data.version}.`,
      "Pick an item from this version's list.",
    );
  }
  return fam.maxDamage;
}

function incompatible(a: AnvilEnchant, b: AnvilEnchant): boolean {
  // Lists are pre-symmetrized at generation time; check one side.
  return a.exclusiveWith.includes(b.id);
}

function cloneItem(item: AnvilItem): AnvilItem {
  return {
    kind: item.kind,
    enchants: item.enchants.map((e) => ({ ...e })),
    priorWork: item.priorWork,
    damage: item.damage,
    count: item.count,
    customName: item.customName,
  };
}

/** AnvilMenu.calculateIncreasedRepairCost: identical in every version. */
export function increasedRepairCost(priorWork: number): number {
  return Math.min(priorWork * 2 + 1, 2147483647);
}

const INT_MAX = 2147483647;

function displayedCostFor(data: AnvilVersionData, priorWorkCost: number, work: number): number {
  const total = Math.min(Math.max(priorWorkCost + work, 0), INT_MAX);
  if (data.zeroWorkShowsZero && work <= 0) return 0;
  return total;
}

interface CoreInput {
  target: AnvilItem;
  /** Sacrifice item or book; null for rename-only. */
  sacrifice: AnvilItem | null;
  /** Repair-by-material mode: number of units in the sacrifice slot. */
  materialCount?: number;
  opts: CombineOptions;
}

/**
 * The faithful port of AnvilMenu.createResult(). One function covers all six
 * versions; the behavioral differences live in data (fees, exclusive sets,
 * applicability) and in the displayed-cost quirk flag.
 */
function createResult(input: CoreInput): CombineOutcome {
  const { target, sacrifice, materialCount, opts } = input;
  const data = versionData(opts.version);
  const creative = opts.creative === true;
  const rename = opts.rename ?? "keep";

  const maxDamage = familyMaxDamage(data, target.kind);
  const targetIsBook = target.kind === "book";
  const damageable = maxDamage > 0;
  const count = target.count ?? 1;

  const fail = (status: CombineStatus): CombineOutcome => ({
    status,
    displayedCost: 0,
    work: 0,
    priorWorkCost: 0,
    breakdown: [],
    result: null,
    materialsUsed: 0,
    droppedEnchants: [],
  });

  // Validate the target's own state up front (tool-level, not game-level).
  if (target.damage < 0 || (damageable && target.damage > maxDamage)) {
    throw new ToolError(
      "bad-damage",
      `Damage ${target.damage} is outside 0..${maxDamage} for ${target.kind}.`,
      "Set damage between 0 and the item's max damage.",
    );
  }
  for (const e of target.enchants) enchantData(data, e.id);

  let work = 0; // i in the source
  let renameCost = 0; // k in the source
  const priorWorkCost = target.priorWork + (sacrifice ? sacrifice.priorWork : 0); // j
  const breakdown: CostLine[] = [];
  const droppedEnchants: string[] = [];
  if (target.priorWork > 0) {
    breakdown.push({ label: "Prior work penalty (target)", amount: target.priorWork });
  }
  if (sacrifice && sacrifice.priorWork > 0) {
    breakdown.push({ label: "Prior work penalty (sacrifice)", amount: sacrifice.priorWork });
  }

  const result = cloneItem(target);
  const resultEnchants = new Map<string, number>();
  for (const e of target.enchants) resultEnchants.set(e.id, e.level);
  let materialsUsed = 0;

  if (materialCount !== undefined) {
    // Repair-by-material branch: Math.min(damage, maxDamage / 4) per unit,
    // one level each, up to the number of units offered.
    if (!damageable) return fail("invalid-pair");
    if (materialCount < 1) {
      throw new ToolError(
        "bad-materials",
        "Repair materials must be at least 1 unit.",
        "Set the material count to 1 or more.",
      );
    }
    let repairAmount = Math.min(result.damage, Math.floor(maxDamage / 4));
    if (repairAmount <= 0) return fail("no-change");
    let used = 0;
    for (; repairAmount > 0 && used < materialCount; used += 1) {
      result.damage -= repairAmount;
      work += 1;
      repairAmount = Math.min(result.damage, Math.floor(maxDamage / 4));
    }
    materialsUsed = used;
    breakdown.push({
      label: `Repair materials (${used} unit${used === 1 ? "" : "s"})`,
      amount: used,
    });
  } else if (sacrifice) {
    const sacrificeIsBook = sacrifice.kind === "book" && sacrifice.enchants.length > 0;
    if (!sacrificeIsBook && (target.kind !== sacrifice.kind || !damageable)) {
      return fail("invalid-pair");
    }
    for (const e of sacrifice.enchants) enchantData(data, e.id);

    // Sacrifice-item durability combine: remaining durability of both plus a
    // bonus of 12 percent of max damage (integer math as in the source).
    if (damageable && !sacrificeIsBook) {
      const targetRemaining = maxDamage - target.damage;
      const sacrificeRemaining = maxDamage - sacrifice.damage;
      const bonus = sacrificeRemaining + Math.floor((maxDamage * 12) / 100);
      let newDamage = maxDamage - (targetRemaining + bonus);
      if (newDamage < 0) newDamage = 0;
      if (newDamage < result.damage) {
        result.damage = newDamage;
        work += 2;
        breakdown.push({ label: "Sacrifice durability combine", amount: 2 });
      }
    }

    // Enchantment transfer loop, in sacrifice list order.
    let anyCompatible = false;
    let anyIncompatible = false;
    for (const se of sacrifice.enchants) {
      const spec = enchantData(data, se.id);
      const targetLevel = resultEnchants.get(se.id) ?? 0;
      let level = se.level;
      level = targetLevel === level ? level + 1 : Math.max(level, targetLevel);
      let compatible = spec.items.includes(target.kind);
      if (creative || targetIsBook) compatible = true;
      let conflicts = 0;
      for (const existingId of resultEnchants.keys()) {
        if (existingId !== se.id && incompatible(spec, enchantData(data, existingId))) {
          compatible = false;
          conflicts += 1;
          work += 1;
        }
      }
      if (conflicts > 0) {
        breakdown.push({
          label: `Incompatible: ${spec.name} clashes with ${conflicts} enchantment${conflicts === 1 ? "" : "s"}`,
          amount: conflicts,
        });
      }
      if (!compatible) {
        anyIncompatible = true;
        droppedEnchants.push(se.id);
      } else {
        anyCompatible = true;
        if (level > spec.maxLevel) level = spec.maxLevel;
        resultEnchants.set(se.id, level);
        let fee = spec.anvilCost;
        if (sacrificeIsBook) fee = Math.max(1, Math.floor(fee / 2));
        work += fee * level;
        breakdown.push({
          label: `${spec.name} ${level} (${fee} per level${sacrificeIsBook ? ", book rate" : ""})`,
          amount: fee * level,
        });
        if (count > 1) work = 40;
      }
    }
    if (anyIncompatible && !anyCompatible) return fail("no-result");
  }

  // Rename: +1 when the name actually changes, including clearing one.
  if (rename === "set") {
    renameCost = 1;
    work += renameCost;
    result.customName = true;
    breakdown.push({ label: "Rename", amount: 1 });
  } else if (rename === "clear" && target.customName) {
    renameCost = 1;
    work += renameCost;
    result.customName = false;
    breakdown.push({ label: "Remove custom name", amount: 1 });
  }

  let displayedCost = displayedCostFor(data, priorWorkCost, work);
  let hasResult = work > 0;

  const renameOnly = renameCost === work && renameCost > 0;
  if (renameOnly && displayedCost >= 40) displayedCost = 39;

  let status: CombineStatus = "ok";
  if (!hasResult) status = "no-change";
  if (displayedCost >= 40 && !creative && hasResult) {
    status = "too-expensive";
    hasResult = false;
  }

  let finalResult: AnvilItem | null = null;
  if (hasResult) {
    let newPriorWork = Math.max(target.priorWork, sacrifice ? sacrifice.priorWork : 0);
    if (!renameOnly) newPriorWork = increasedRepairCost(newPriorWork);
    result.priorWork = newPriorWork;
    result.enchants = [...resultEnchants.entries()].map(([id, level]) => ({ id, level }));
    finalResult = result;
  }

  return {
    status,
    displayedCost,
    work,
    priorWorkCost,
    breakdown,
    result: finalResult,
    materialsUsed,
    droppedEnchants,
  };
}

/** Combine a target with a sacrifice item or enchanted book. */
export function combineItems(
  target: AnvilItem,
  sacrifice: AnvilItem,
  opts: CombineOptions,
): CombineOutcome {
  return createResult({ target, sacrifice, opts });
}

/** Repair a damaged item with raw material units (one level per unit). */
export function repairWithMaterials(
  target: AnvilItem,
  materialCount: number,
  opts: CombineOptions,
): CombineOutcome {
  return createResult({ target, sacrifice: null, materialCount, opts });
}

/** Rename (or clear the name of) an item with nothing in the second slot. */
export function renameOnly(target: AnvilItem, opts: CombineOptions): CombineOutcome {
  const rename = opts.rename ?? "set";
  return createResult({ target, sacrifice: null, opts: { ...opts, rename } });
}

/* ------------------------------------------------------------------ */
/* Optimal combine planner                                             */
/* ------------------------------------------------------------------ */

export interface PlanStep {
  target: AnvilItem;
  sacrifice: AnvilItem;
  outcome: CombineOutcome;
}

export interface PlanResult {
  steps: PlanStep[];
  totalCost: number;
  maxStepCost: number;
  finalItem: AnvilItem;
}

function stateKey(states: AnvilItem[]): string {
  const parts = states.map((s) =>
    JSON.stringify({
      k: s.kind,
      e: [...s.enchants].sort((a, b) => a.id.localeCompare(b.id)),
      p: s.priorWork,
      d: s.damage,
      n: s.customName === true,
    }),
  );
  // Keep the non-book item (if any) first so identical books dedupe cleanly.
  return parts.sort().join("|");
}

interface PlanInternal {
  totalCost: number;
  maxStepCost: number;
  steps: PlanStep[];
  finalItem: AnvilItem;
}

function better(a: PlanInternal, b: PlanInternal | null): boolean {
  if (!b) return true;
  if (a.totalCost !== b.totalCost) return a.totalCost < b.totalCost;
  if (a.maxStepCost !== b.maxStepCost) return a.maxStepCost < b.maxStepCost;
  return a.steps.length < b.steps.length;
}

/**
 * Exact search over every merge tree for an item plus up to 7 enchanted
 * books. Any state may absorb a book (books can merge into books first), and
 * both orders of a book pair are distinct because level bumps and drops
 * depend on which side is the sacrifice. Memoized on the canonical multiset
 * of intermediate item states; minimizes total levels, then the largest
 * single step, then step count. Survival rules: any step that is Too
 * Expensive or produces no result is not a legal move.
 */
export function planCombine(
  item: AnvilItem,
  books: AnvilItem[],
  opts: CombineOptions,
): PlanResult | null {
  if (books.length === 0) return null;
  if (books.length > 7) {
    throw new ToolError(
      "too-many-books",
      "The planner searches up to 7 books at once.",
      "Remove books until 7 or fewer remain.",
    );
  }
  for (const b of books) {
    if (b.kind !== "book" || b.enchants.length === 0) {
      throw new ToolError(
        "bad-book",
        "Every planner sacrifice must be an enchanted book with at least one enchantment.",
        "Add an enchantment to each book or remove the empty one.",
      );
    }
  }
  const memo = new Map<string, PlanInternal | null>();

  function search(states: AnvilItem[]): PlanInternal | null {
    if (states.length === 1) {
      return { totalCost: 0, maxStepCost: 0, steps: [], finalItem: states[0]! };
    }
    const key = stateKey(states);
    if (memo.has(key)) return memo.get(key)!;
    memo.set(key, null); // cycle guard; overwritten below
    let best: PlanInternal | null = null;
    const tried = new Set<string>();
    for (let t = 0; t < states.length; t += 1) {
      for (let s = 0; s < states.length; s += 1) {
        if (t === s) continue;
        const sacrifice = states[s]!;
        if (sacrifice.kind !== "book") continue; // the item is never sacrificed
        const target = states[t]!;
        const moveKey = `${stateKey([target])}>${stateKey([sacrifice])}`;
        if (tried.has(moveKey)) continue;
        tried.add(moveKey);
        const outcome = combineItems(target, sacrifice, opts);
        if (outcome.status !== "ok" || !outcome.result) continue;
        const rest = states.filter((_, i) => i !== t && i !== s);
        const sub = search([outcome.result, ...rest]);
        if (!sub) continue;
        const candidate: PlanInternal = {
          totalCost: outcome.displayedCost + sub.totalCost,
          maxStepCost: Math.max(outcome.displayedCost, sub.maxStepCost),
          steps: [{ target, sacrifice, outcome }, ...sub.steps],
          finalItem: sub.finalItem,
        };
        if (better(candidate, best)) best = candidate;
      }
    }
    memo.set(key, best);
    return best;
  }

  const best = search([item, ...books]);
  if (!best) return null;
  return {
    steps: best.steps,
    totalCost: best.totalCost,
    maxStepCost: best.maxStepCost,
    finalItem: best.finalItem,
  };
}

/** Total cost of applying the books one by one in the given order. */
export function sequentialPlan(
  item: AnvilItem,
  books: AnvilItem[],
  opts: CombineOptions,
): PlanResult | null {
  let current = item;
  const steps: PlanStep[] = [];
  let total = 0;
  let maxStep = 0;
  for (const book of books) {
    const outcome = combineItems(current, book, opts);
    if (outcome.status !== "ok" || !outcome.result) return null;
    steps.push({ target: current, sacrifice: book, outcome });
    total += outcome.displayedCost;
    maxStep = Math.max(maxStep, outcome.displayedCost);
    current = outcome.result;
  }
  return { steps, totalCost: total, maxStepCost: maxStep, finalItem: current };
}

/* ------------------------------------------------------------------ */
/* Too Expensive horizon                                               */
/* ------------------------------------------------------------------ */

export interface HorizonStep {
  combine: number;
  priorWorkBefore: number;
  /** Highest work portion that still fits under the 40 cap (39 total). */
  maxAffordableWork: number;
  priorWorkAfter: number;
}

/**
 * From a current prior-work penalty, list each future combine: the penalty
 * paid, the most work that still fits under 40, and the penalty after.
 * A combine is possible while priorWork + 1 <= 39. Renames are exempt: the
 * rename-only price clamps to 39 and never raises prior work, so renaming
 * stays possible forever.
 */
export function tooExpensiveHorizon(priorWork: number, maxSteps = 12): HorizonStep[] {
  if (priorWork < 0) {
    throw new ToolError(
      "bad-prior-work",
      "Prior work cannot be negative.",
      "Use the stored repair cost: 0, 1, 3, 7, 15, 31...",
    );
  }
  const steps: HorizonStep[] = [];
  let pw = priorWork;
  for (let n = 1; n <= maxSteps; n += 1) {
    const maxWork = 39 - pw;
    if (maxWork < 1) break;
    const after = increasedRepairCost(pw);
    steps.push({
      combine: n,
      priorWorkBefore: pw,
      maxAffordableWork: maxWork,
      priorWorkAfter: after,
    });
    pw = after;
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* Generic run() surface (the page uses the bespoke panel)             */
/* ------------------------------------------------------------------ */

interface RunOpts {
  version?: string;
  creative?: boolean;
}

function describeItem(item: AnvilItem | null): string {
  if (!item) return "none";
  const enchants =
    item.enchants.length > 0
      ? item.enchants.map((e) => `${e.id} ${e.level}`).join(", ")
      : "no enchantments";
  return `${item.kind} (${enchants}; prior work ${item.priorWork}; damage ${item.damage})`;
}

/**
 * JSON-in, record-out surface for tests and the generic shell: input is a
 * JSON object {"target": {...}, "sacrifice": {...}} or {"target": {...},
 * "materials": n} or {"target": {...}, "rename": "set"|"clear"}.
 */
function run(input: string, opts: RunOpts = {}): Record<string, string> {
  const version = opts.version ?? "1.21.11";
  if (!input || input.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Provide a JSON object describing the anvil slots.",
      'Example: {"target":{"kind":"sword","enchants":[],"priorWork":0,"damage":0},"sacrifice":{"kind":"book","enchants":[{"id":"sharpness","level":5}],"priorWork":0,"damage":0}}',
    );
  }
  let parsed: {
    target?: Partial<AnvilItem> & { kind: string };
    sacrifice?: Partial<AnvilItem> & { kind: string };
    materials?: number;
    rename?: RenameAction;
  };
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new ToolError(
      "invalid-json",
      "The input is not valid JSON.",
      "Check for missing quotes or trailing commas.",
    );
  }
  if (!parsed.target) {
    throw new ToolError(
      "missing-target",
      'The input needs a "target" item.',
      'Add a "target" object.',
    );
  }
  const target: AnvilItem = {
    enchants: [],
    priorWork: 0,
    damage: 0,
    ...parsed.target,
  };
  const combineOpts: CombineOptions = {
    version,
    creative: opts.creative === true,
    rename: parsed.rename ?? "keep",
  };
  let outcome: CombineOutcome;
  if (parsed.materials !== undefined) {
    outcome = repairWithMaterials(target, parsed.materials, combineOpts);
  } else if (parsed.sacrifice) {
    const sacrifice: AnvilItem = { enchants: [], priorWork: 0, damage: 0, ...parsed.sacrifice };
    outcome = combineItems(target, sacrifice, combineOpts);
  } else if (parsed.rename) {
    outcome = renameOnly(target, combineOpts);
  } else {
    throw new ToolError(
      "missing-sacrifice",
      'Add a "sacrifice" item, a "materials" count, or a "rename" action.',
      'Example: "sacrifice": {"kind":"book","enchants":[{"id":"mending","level":1}],"priorWork":0,"damage":0}',
    );
  }
  const out: Record<string, string> = {
    Version: version,
    Status: outcome.status,
    "Level cost": String(outcome.displayedCost),
    "Work portion": String(outcome.work),
    "Prior work portion": String(outcome.priorWorkCost),
    Result: describeItem(outcome.result),
  };
  if (outcome.breakdown.length > 0) {
    out.Breakdown = outcome.breakdown.map((l) => `${l.label}: +${l.amount}`).join("; ");
  }
  if (outcome.droppedEnchants.length > 0) {
    out["Dropped enchantments"] = outcome.droppedEnchants.join(", ");
  }
  if (outcome.materialsUsed > 0) {
    out["Materials used"] = String(outcome.materialsUsed);
  }
  return out;
}

export { run };
export default { run } satisfies ToolLogic<string, Record<string, string>, RunOpts>;
