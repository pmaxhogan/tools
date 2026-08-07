import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "json-to-typescript",
  icon: "FileType",
  matrixSlug: "json-to-types",
  name: "JSON to Types",
  description:
    "Generate TypeScript interfaces, Zod schemas, or Kotlin data classes from sample JSON.",
  category: "Data",
  keywords: [
    "json to typescript",
    "json to interface",
    "json to zod schema",
    "json to kotlin data class",
    "generate types from json",
    "json type generator",
    "typescript interface generator",
    "json to data class",
  ],
  searchTerms: [
    "quicktype alternative",
    "json to interface generator",
    "api response to types",
    "json to schema types",
    "generate zod from json",
    "json to model class",
    "transform.tools alternative",
    "infer types from json",
  ],
  input: "application/json",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "target",
      label: "Target",
      default: "typescript",
      choices: [
        { value: "typescript", label: "TypeScript interfaces" },
        { value: "zod", label: "Zod schemas" },
        { value: "kotlin", label: "Kotlin data classes" },
      ],
    },
    {
      kind: "text",
      id: "rootName",
      label: "Root type name",
      default: "Root",
      placeholder: "Root",
    },
    {
      kind: "boolean",
      id: "optionalNulls",
      label: "Nulls make a property optional",
      default: true,
    },
  ],
  http: { method: "POST", contentType: "application/json" },
  copy: {
    what: "Turns a sample JSON document into TypeScript interfaces, Zod schemas, or Kotlin data classes. Every element of an array is merged rather than sampled from the first item, so a key that only some records carry comes out optional and a key with two different value types comes out as a union. Nested objects become their own named types, full ISO date-time strings are flagged with a comment, and keys that are not valid identifiers are quoted or given a @SerialName annotation.",
    how: "Paste your JSON, drop a .json file, or pick one from disk. Choose a target and set the name you want for the root type. Turn the nulls option off if you would rather get a required nullable property than an optional one. The generated code appears immediately with a copy button, and your settings live in the URL so you can share the exact output.",
    why: "The well known JSON to TypeScript converter sites are ad walled, cap the payload size, and post your JSON to their servers to do the work. This one runs in your browser, so your files and inputs never leave your device, and it merges the shapes of all array elements instead of only reading the first one, which is where the popular converters quietly lose optional and union fields.",
    faq: [
      {
        q: "How are arrays with mixed objects handled?",
        a: "The shapes of every element are merged into one type. A key missing from some elements becomes optional, and a key with conflicting value types becomes a union: string | number in TypeScript, z.union in Zod. Kotlin has no structural union, so it falls back to JsonElement with a comment naming the types that were mixed.",
      },
      {
        q: "Which Zod version does the output target?",
        a: "Zod v3 syntax, which is also what Zod v4 accepts for these constructs: z.object, z.array, z.union, .optional(), .nullable(), .describe(), and z.infer. Child schemas are always declared before the schema that references them, and each one gets an exported z.infer type.",
      },
      {
        q: "Is my JSON uploaded anywhere?",
        a: "No. Parsing and code generation run entirely in your browser, so your files and inputs never leave your device. The page keeps working offline after the first load.",
      },
    ],
  },
};
