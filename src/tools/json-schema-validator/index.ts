import { Validator } from "@cfworker/json-schema";
import type { Schema, SchemaDraft, OutputUnit } from "@cfworker/json-schema";
import { ToolError, type ToolLogic } from "../types";

export interface SchemaOpts {
  /** JSON Schema draft to validate against. */
  draft: string;
  /** Stop validating a branch at its first error. */
  shortCircuit: boolean;
  [key: string]: unknown;
}

export type SchemaResult = Record<string, string>;

interface ParsedInput {
  schema: unknown;
  data: unknown;
}

const WRAPPER_EXAMPLE = '{"schema": {"type": "object"}, "data": {}}';

/** Parse the single input box: a JSON object with exactly "schema" and "data" keys. */
function parseInput(raw: string): ParsedInput {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new ToolError(
      "empty-input",
      'Enter a JSON object with "schema" and "data" keys.',
      `Example: ${WRAPPER_EXAMPLE}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ToolError(
      "invalid-json",
      `Input is not valid JSON: ${detail}`,
      `Provide a single JSON object shaped like ${WRAPPER_EXAMPLE}.`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError(
      "invalid-json",
      "Input must be a JSON object, not an array or primitive.",
      `Wrap your schema and data like ${WRAPPER_EXAMPLE}.`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (!("schema" in obj)) {
    throw new ToolError(
      "missing-key",
      'Missing the "schema" key.',
      `Wrap your input as ${WRAPPER_EXAMPLE}.`,
    );
  }
  if (!("data" in obj)) {
    throw new ToolError(
      "missing-key",
      'Missing the "data" key.',
      `Wrap your input as ${WRAPPER_EXAMPLE}.`,
    );
  }

  return { schema: obj.schema, data: obj.data };
}

/**
 * The library reports both a wrapper error for every subschema keyword
 * (allOf, anyOf, oneOf, properties, items, $ref, ...) and the specific leaf
 * error(s) underneath it. keywordLocation always grows by appending a
 * "/segment" for every nested call, so a unit is a wrapper (not a leaf)
 * exactly when some other unit's keywordLocation extends it with a "/".
 * Drop wrappers and keep only the most specific errors.
 */
function filterLeafErrors(errors: OutputUnit[]): OutputUnit[] {
  return errors.filter((unit, i) => {
    const prefix = `${unit.keywordLocation}/`;
    return !errors.some((other, j) => j !== i && other.keywordLocation.startsWith(prefix));
  });
}

function formatRows(errors: OutputUnit[]): SchemaResult {
  const rows: SchemaResult = {};
  const seen = new Map<string, number>();

  for (const unit of errors) {
    const baseKey = unit.instanceLocation || "#";
    const count = seen.get(baseKey) ?? 0;
    seen.set(baseKey, count + 1);
    const key = count === 0 ? baseKey : `${baseKey} (${count + 1})`;
    rows[key] = `${unit.error} (keyword: ${unit.keyword}, at ${unit.keywordLocation})`;
  }

  return rows;
}

export function run(input: string, opts: SchemaOpts): SchemaResult {
  const { schema, data } = parseInput(input);

  const draft = (opts.draft || "2020-12") as SchemaDraft;
  const shortCircuit = Boolean(opts.shortCircuit);

  let validator: Validator;
  try {
    validator = new Validator(schema as Schema | boolean, draft, shortCircuit);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ToolError(
      "invalid-schema",
      `The schema could not be compiled: ${detail}`,
      'Check that "schema" is a valid JSON Schema object for the selected draft.',
    );
  }

  const result = validator.validate(data);

  if (result.valid) {
    return { Result: "Valid" };
  }

  const leafErrors = filterLeafErrors(result.errors);
  const rows = formatRows(leafErrors);

  return {
    Result: `Invalid (${leafErrors.length} error${leafErrors.length === 1 ? "" : "s"})`,
    ...rows,
  };
}

export default { run } satisfies ToolLogic<string, SchemaResult, SchemaOpts>;
