import { ToolError, type ToolLogic } from "../types";
import { CATEGORIES, RECIPES, type Recipe, type RecipeCategory } from "./data";

export interface GamOpts {
  /** 'all' or one of the ids in CATEGORIES. */
  category: string;
  /**
   * Prefer GAMADV-XTD3 spellings and flag the recipes that are GAM7 only.
   * Left off, the tool prefers GAM7 and flags the GAMADV-XTD3 only recipes.
   */
  gamadv: boolean;
  [key: string]: unknown;
}

export type GamResult = Record<string, string>;

/** Rows shown in list mode before the "and N more" summary row. */
export const MAX_RESULTS = 40;

const CATEGORY_LABELS = new Map(CATEGORIES.map((c) => [c.id, c.label]));
const BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

/** Split any text into lowercase word tokens. Used for both query and haystack. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/** Everything a query is matched against, tokenized once per recipe. */
const TASK_WORDS = new Map<Recipe, string[]>(RECIPES.map((r) => [r, words(r.task)]));
const ALL_WORDS = new Map<Recipe, string[]>(
  RECIPES.map((r) => [
    r,
    words(
      [
        r.id,
        r.task,
        r.category,
        CATEGORY_LABELS.get(r.category) ?? "",
        r.template,
        ...r.notes,
      ].join(" "),
    ),
  ]),
);

function hasExactWord(pool: string[], term: string): boolean {
  return pool.includes(term);
}

function hasWordPrefix(pool: string[], term: string): boolean {
  return pool.some((w) => w.startsWith(term));
}

/**
 * Lower is better. Matching whole words in the task beats matching a prefix of
 * one, which beats matching anywhere in the template or the notes. That keeps
 * "suspend user" on "Suspend a user" rather than on "Unsuspend a user", whose
 * task never contains the word "suspend" even though its template does.
 */
function score(r: Recipe, terms: string[]): number {
  if (!terms.length) return 3;
  const task = TASK_WORDS.get(r)!;
  const all = ALL_WORDS.get(r)!;
  if (terms.every((t) => hasExactWord(task, t))) return 1;
  if (terms.every((t) => hasWordPrefix(task, t))) return 2;
  if (terms.every((t) => hasWordPrefix(all, t))) return 3;
  return -1; // no match
}

/** Rank recipes written for the fork the reader actually runs a little higher. */
function variantRank(r: Recipe, gamadv: boolean): number {
  const v = r.variant ?? "both";
  if (v === "both") return 0;
  if (gamadv) return v === "gamadv" ? 0 : 1;
  return v === "gam7" ? 0 : 1;
}

export interface Hit {
  recipe: Recipe;
  score: number;
}

/**
 * Case-insensitive search over the recipe id, task, category, template and
 * notes. Multi-word queries are AND-ed, so "transfer drive" needs both words.
 */
export function search(query: string, category: string, gamadv: boolean): Hit[] {
  const terms = words(query ?? "");
  const pool = category === "all" ? RECIPES : RECIPES.filter((r) => r.category === category);

  return pool
    .map((recipe, i) => ({ recipe, i, s: score(recipe, terms) }))
    .filter((h) => h.s >= 0)
    .sort(
      (a, b) =>
        a.s - b.s || variantRank(a.recipe, gamadv) - variantRank(b.recipe, gamadv) || a.i - b.i,
    )
    .map((h) => ({ recipe: h.recipe, score: h.s }));
}

/** Swap every `<placeholder>` for its parameter's example value. */
export function fillExample(r: Recipe): string {
  const examples = new Map(r.params.map((p) => [p.name, p.example]));
  return r.template.replace(/<([^<>]+)>/g, (whole, name: string) => examples.get(name) ?? whole);
}

/** Every distinct `<placeholder>` in a template, in first-seen order. */
export function placeholders(template: string): string[] {
  const found: string[] = [];
  for (const m of template.matchAll(/<([^<>]+)>/g)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

const DESTRUCTIVE_WARNING =
  "This one changes or removes data. Run it against a single test account or a small test org unit before you point it at the whole domain, and where GAM supports a dry run, run it once without the doit argument to see the blast radius first.";

function variantLine(r: Recipe, gamadv: boolean): string {
  const v = r.variant ?? "both";
  if (v === "both")
    return "Accepted by both GAM7 and GAMADV-XTD3. GAMADV-XTD3 was replaced by GAM7 rather than diverging from it, so almost all syntax carries across unchanged. Legacy GAM 4, 5 and 6 are a different lineage and may not accept this.";
  if (v === "gam7")
    return gamadv
      ? "GAM7 syntax. GAMADV-XTD3 spells this one differently, so read the notes before you run it on a GAMADV-XTD3 install."
      : "GAM7 syntax. GAMADV-XTD3 spells this one differently, so read the notes if you switch forks.";
  return gamadv
    ? "GAMADV-XTD3 syntax."
    : "GAMADV-XTD3 only. GAM7 does not accept this form, so read the notes for the GAM7 route.";
}

/** Short marker appended to a list row so a fork mismatch is visible up front. */
function variantTag(r: Recipe, gamadv: boolean): string {
  const v = r.variant ?? "both";
  if (v === "both") return "";
  if (v === "gam7") return gamadv ? " [GAM7 only]" : "";
  return gamadv ? "" : " [GAMADV-XTD3 only]";
}

function categoryList(): string {
  return CATEGORIES.map((c) => c.id).join(", ");
}

/** Full breakdown of one recipe: command, parameters, filled example, notes. */
export function expand(r: Recipe, gamadv: boolean): GamResult {
  const out: GamResult = {};
  out.Task = `${r.task} · ${CATEGORY_LABELS.get(r.category) ?? r.category} · id: ${r.id}`;
  out.Command = r.template;
  if (r.destructive) out["Read this first"] = DESTRUCTIVE_WARNING;

  for (const p of r.params) {
    out[`<${p.name}>`] =
      `${p.required ? "Required" : "Optional"}. ${p.description} Example: ${p.example}`;
  }

  out["Example command"] = fillExample(r);
  out.Notes = r.notes.length
    ? r.notes.join(" ")
    : "Nothing surprising about this one. Check the output of a read only command before you run anything that writes.";
  out["GAM version"] = variantLine(r, gamadv);
  return out;
}

/**
 * A recipe that is a sequence of commands would swamp a list row, so show the
 * first line and say how many there are. Expanding it still gives the lot.
 */
function shortTemplate(r: Recipe): string {
  const lines = r.template.split("\n");
  if (lines.length === 1) return r.template;
  return `${lines[0]} (plus ${lines.length - 1} more command${lines.length === 2 ? "" : "s"})`;
}

/** One line per match: the command plus the single most useful caveat. */
function listRow(r: Recipe, gamadv: boolean): string {
  const bits = [shortTemplate(r) + variantTag(r, gamadv)];
  if (r.destructive) bits.push("Destructive.");
  if (r.notes.length) bits.push(r.notes[0]);
  bits.push(`Search "${r.id}" for the parameters and a filled in example.`);
  return bits.join(" · ");
}

export function run(input: string, opts: GamOpts): GamResult {
  const category = String(opts?.category ?? "all").trim() || "all";
  if (category !== "all" && !CATEGORY_LABELS.has(category as RecipeCategory))
    throw new ToolError(
      "unknown-category",
      `Unknown category "${category}".`,
      `Use "all" or one of: ${categoryList()}.`,
    );

  const query = (input ?? "").trim();
  if (!query)
    throw new ToolError(
      "empty-input",
      "There is nothing to look up.",
      'Describe the task in plain English, like "suspend a user", "transfer drive ownership" or "wipe a mobile device".',
    );

  // The curl endpoint hands options over as strings, so accept "true" as well
  // as true rather than silently falling back to GAM7.
  const raw = opts?.gamadv;
  const gamadv = raw === true || (typeof raw === "string" && /^(true|on|yes|1)$/i.test(raw));

  // An exact recipe id always wins, whatever the category filter says.
  const byId = BY_ID.get(query.toLowerCase());
  if (byId) return expand(byId, gamadv);

  const hits = search(query, category, gamadv);

  if (!hits.length) {
    const where =
      category === "all"
        ? "any category"
        : `the ${CATEGORY_LABELS.get(category as RecipeCategory)} category`;
    return {
      "No matches": `Nothing in ${where} matches "${query}". This catalog is hand written and covers common Workspace admin tasks, not the whole of GAM. Categories: ${categoryList()}. Try one verb on its own, like "suspend", "undelete", "delegate", "transfer", "license", "deprovision" or "wipe".`,
    };
  }

  // When exactly one recipe reaches the best score, the intent is unambiguous
  // enough to show the whole thing rather than a one line summary.
  const best = hits[0].score;
  const top = hits.filter((h) => h.score === best);
  if (top.length === 1) {
    const out = expand(top[0].recipe, gamadv);
    const others = hits.slice(1);
    if (others.length)
      out["Other matches"] = others
        .slice(0, MAX_RESULTS)
        .map((h) => `${h.recipe.task} (${h.recipe.id})`)
        .join(" · ");
    return out;
  }

  const out: GamResult = {};
  const shown = hits.slice(0, MAX_RESULTS);
  const scope =
    category === "all"
      ? "all categories"
      : (CATEGORY_LABELS.get(category as RecipeCategory) ?? category);
  out.Matches = `${hits.length} recipe${hits.length === 1 ? "" : "s"} match "${query}" in ${scope}, ranked for ${gamadv ? "GAMADV-XTD3" : "GAM7"}. Search a recipe id to see its parameters, notes and a filled in example.`;

  for (const h of shown) out[h.recipe.task] = listRow(h.recipe, gamadv);

  const extra = hits.length - shown.length;
  if (extra > 0)
    out[`and ${extra} more`] =
      "Add another word to the search or pick a category to narrow it down.";

  return out;
}

export default { run } satisfies ToolLogic<string, GamResult, GamOpts>;
