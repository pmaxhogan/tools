/**
 * Pure helpers for the dropdown option model (see `SelectOptionSpec` in
 * `src/tools/types.ts`).
 *
 * These live outside any Vue component on purpose: the searchable-select
 * component, the generic OptionControl, and the Cloudflare Worker's curl-API
 * index all need to count, list, and search options in exactly the same way,
 * and node-only unit tests can only reach pure modules. No DOM, no Vue.
 */
import type { SelectGroup, SelectOption, SelectOptionSpec } from "../tools/types";

/**
 * The leaf-option-count threshold above which the searchable-select shows its
 * search field. Counted once from `flattenSelectOptions(spec)`. Strictly
 * greater than 6, so a select with exactly 6 options shows no search field.
 */
export const SEARCH_THRESHOLD = 6;

/** Collect every leaf option from a group subtree, depth first, in order. */
function collectGroup(group: SelectGroup, out: SelectOption[]): void {
  for (const option of group.options ?? []) out.push(option);
  for (const child of group.groups ?? []) collectGroup(child, out);
}

/**
 * The flat list of every leaf option a select offers, whether it uses `groups`
 * or a flat `options` list. Order is the natural reading order: grouped options
 * come out in tree order.
 *
 * Consumers use this to count options (for the search threshold and the curl
 * API index), to resolve a value back to its label (the trigger display), and
 * as the universal leaf list.
 */
export function flattenSelectOptions(spec: SelectOptionSpec): SelectOption[] {
  const out: SelectOption[] = [];
  if (spec.groups?.length) {
    for (const group of spec.groups) collectGroup(group, out);
  }
  for (const option of spec.options ?? []) out.push(option);
  return out;
}

/** Whether the select has enough leaf options to warrant a search field. */
export function shouldShowSearch(spec: SelectOptionSpec): boolean {
  return flattenSelectOptions(spec).length > SEARCH_THRESHOLD;
}

/**
 * The largest leaf-option count that still reads well as a row of buttons.
 * Above this the generic panel falls back to the searchable dropdown.
 */
export const SEGMENTED_MAX = 4;

/**
 * Whether the generic panel should render this select as a segmented button
 * group instead of the searchable dropdown.
 *
 * The default rule: a short, flat list of two to four options is a segmented
 * control, because every choice stays visible and reachable in one click.
 * Anything grouped is a dropdown, since a segmented row cannot show category
 * headers. A meta overrides either way with `ui`: "select" forces the dropdown
 * on a small list whose labels are full sentences, and "segmented" forces
 * buttons on a longer list that still reads well as a row.
 */
export function shouldRenderSegmented(spec: SelectOptionSpec): boolean {
  if (spec.ui === "segmented") return true;
  if (spec.ui === "select") return false;
  if (spec.groups?.length) return false;
  const count = flattenSelectOptions(spec).length;
  return count >= 2 && count <= SEGMENTED_MAX;
}

/** Split a raw query into lowercased, non-empty tokens (whitespace separated). */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** True when `haystack` contains `token` (case-insensitive, already lowercased token). */
function hit(haystack: string | undefined, token: string): boolean {
  return haystack !== undefined && haystack.toLowerCase().includes(token);
}

/** The searchable text of one option: its label plus every synonym. */
function optionText(option: SelectOption): string[] {
  return [option.label, ...(option.synonyms ?? [])];
}

/** The searchable text contributed by a group node itself: label plus synonyms. */
function groupText(group: SelectGroup): string[] {
  return [group.label, ...(group.synonyms ?? [])];
}

/** True when every query token matches at least one of the candidate strings. */
function matchesAllTokens(tokens: string[], candidates: string[]): boolean {
  return tokens.every((token) => candidates.some((c) => hit(c, token)));
}

/**
 * A group after filtering. Same shape as `SelectGroup` but only the surviving
 * options and child groups remain. `null` means the whole subtree was pruned.
 */
export type FilteredGroup = {
  label: string;
  synonyms?: string[];
  options: SelectOption[];
  groups: FilteredGroup[];
};

/**
 * Filter one group subtree against the query tokens, given the searchable text
 * inherited from ancestor groups.
 *
 * Semantics (AND across query tokens, case-insensitive substring per token):
 * - A token may match on option label/synonyms, on this group's label/synonyms,
 *   or on any ancestor group's label/synonyms.
 * - If the ancestor-plus-this-group text already satisfies every token, the
 *   whole group is surfaced: all of its options and descendants pass. This is
 *   the "matching a category surfaces its options" rule.
 * - Otherwise, an option survives when the group-path text plus that option's
 *   own text jointly satisfy every token, and a child group survives when its
 *   own recursion keeps anything.
 */
function filterGroup(
  group: SelectGroup,
  tokens: string[],
  ancestorText: string[],
): FilteredGroup | null {
  const pathText = [...ancestorText, ...groupText(group)];

  // The category (with its ancestors) alone satisfies the query: surface it
  // whole, keeping the full subtree.
  if (matchesAllTokens(tokens, pathText)) {
    return {
      label: group.label,
      synonyms: group.synonyms,
      options: [...(group.options ?? [])],
      groups: (group.groups ?? []).map((child) => surfaceAll(child)),
    };
  }

  const options = (group.options ?? []).filter((option) =>
    matchesAllTokens(tokens, [...pathText, ...optionText(option)]),
  );
  const groups = (group.groups ?? [])
    .map((child) => filterGroup(child, tokens, pathText))
    .filter((child): child is FilteredGroup => child !== null);

  if (options.length === 0 && groups.length === 0) return null;
  return { label: group.label, synonyms: group.synonyms, options, groups };
}

/** Keep an entire group subtree unfiltered (used when an ancestor matched). */
function surfaceAll(group: SelectGroup): FilteredGroup {
  return {
    label: group.label,
    synonyms: group.synonyms,
    options: [...(group.options ?? [])],
    groups: (group.groups ?? []).map((child) => surfaceAll(child)),
  };
}

/**
 * The result of filtering a select's whole option tree by a query.
 *
 * `groups` are the surviving hierarchical categories; `options` are the
 * surviving ungrouped leaf options (from a flat `options` list, or left at the
 * top level alongside groups). `count` is the total number of
 * surviving leaf options, so a consumer can render a "no matches" state when it
 * is zero.
 */
export interface FilteredSelect {
  groups: FilteredGroup[];
  options: SelectOption[];
  count: number;
}

function countGroup(group: FilteredGroup): number {
  let n = group.options.length;
  for (const child of group.groups) n += countGroup(child);
  return n;
}

/**
 * Filter a select spec's options by a free-text query. An empty or whitespace
 * query returns everything (groups intact, all flat options). Matching is
 * case-insensitive substring, AND across query tokens, over option labels,
 * option synonyms, group labels, and group synonyms.
 */
export function filterSelectTree(spec: SelectOptionSpec, query: string): FilteredSelect {
  const tokens = tokenize(query);
  const flatOptions: SelectOption[] = [...(spec.options ?? [])];

  if (tokens.length === 0) {
    const groups = (spec.groups ?? []).map((g) => surfaceAll(g));
    const result: FilteredSelect = { groups, options: flatOptions, count: 0 };
    result.count = groups.reduce((n, g) => n + countGroup(g), 0) + flatOptions.length;
    return result;
  }

  const groups = (spec.groups ?? [])
    .map((g) => filterGroup(g, tokens, []))
    .filter((g): g is FilteredGroup => g !== null);
  const options = flatOptions.filter((option) => matchesAllTokens(tokens, optionText(option)));

  const count = groups.reduce((n, g) => n + countGroup(g), 0) + options.length;
  return { groups, options, count };
}
