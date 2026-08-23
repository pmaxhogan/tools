export { default as Segmented } from "./Segmented.vue";

/**
 * One choice in a segmented control. Structurally compatible with
 * `SelectOption` from `src/tools/types.ts`, so a select spec's options can be
 * handed straight to the component. `synonyms` is accepted and ignored: it is
 * search text for the dropdown, never rendered here.
 */
export interface SegmentedOption {
  value: string;
  label: string;
  disabled?: boolean;
  synonyms?: string[];
}
