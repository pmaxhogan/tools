/**
 * Helpers behind `ToolMeta.examples` and `ToolMeta.inputOptional`, the two
 * first-visit affordances of the generic panel: a worked example so an empty
 * tool page still shows the tool doing something, and a collapsed quick-entry
 * box for tools whose text input is a shorthand rather than the main event.
 *
 * Pure by design. The panel owns every decision that needs the DOM (fetching a
 * sample file, writing the textarea); these functions only answer questions
 * about the metadata, so they are unit tested without a browser.
 */
import type { OptionSpec, ToolExample, ToolMeta, TypeSpec } from "../tools/types";
import { coerceOpts } from "./fragment";

/**
 * Input types the shell holds as text in its textarea. Everything else (File,
 * image bytes, audio, video) arrives as bytes, so an example for those tools
 * has to come from a sample file rather than a pre-filled string.
 */
const TEXT_LIKE: readonly TypeSpec[] = [
  "text/plain",
  "application/json",
  "text/csv",
  "text/html",
  "image/svg+xml",
];

export function isTextLike(type: TypeSpec): boolean {
  return TEXT_LIKE.includes(type);
}

/** The slice of a tool's metadata these helpers read. */
export type ExampleMeta = Pick<ToolMeta, "input" | "examples" | "sensitiveInput">;

/**
 * The example to pre-fill on first paint, or null to leave the input empty.
 *
 * Three things veto a pre-fill, in this order: a shared link (its fragment
 * input is the visitor's own state and always wins), a file the visitor has
 * already loaded, and a secret input, which must never be seeded with text
 * that looks like a real credential. Tools whose input is bytes get a sample
 * file button instead, so they return null here too.
 */
export function pickExample(
  meta: ExampleMeta,
  hasFragmentInput: boolean,
  hasFile: boolean,
): ToolExample | null {
  if (hasFragmentInput || hasFile) return null;
  if (meta.sensitiveInput) return null;
  if (!isTextLike(meta.input)) return null;
  return meta.examples?.find((example) => example.input !== undefined) ?? null;
}

/**
 * The option state an example asks for, coerced out of its string form the
 * same way a fragment is. Options the example does not mention are absent, so
 * callers spread this over the defaults rather than replacing them.
 */
export function exampleOptsToState(
  example: ToolExample,
  options: OptionSpec[] | undefined,
): Record<string, unknown> {
  return coerceOpts(options, example.opts ?? {});
}

/**
 * The placeholder for a quick-entry box. The hint is a sentence explaining
 * what the box accepts, which reads badly inside the box itself, so the first
 * quoted fragment of that sentence (the worked example) becomes the
 * placeholder. Hints with no quoted example fall back to the whole sentence.
 */
export function quickEntryPlaceholder(hint: string): string {
  return hint.match(/"([^"]+)"/)?.[1] ?? hint;
}
