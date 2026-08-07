import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "json-schema-validator",
  icon: "FileCheck",
  matrixSlug: "json-schema",
  name: "JSON Schema Validator",
  description:
    "Validate a JSON document against a JSON Schema with readable, path-specific errors.",
  category: "Data",
  keywords: [
    "json schema validator",
    "validate json against schema",
    "json schema tester online",
    "json schema draft 2020-12 validator",
    "json schema error checker",
    "validate json document",
    "json schema draft 7 validator",
  ],
  searchTerms: [
    "ajv online",
    "jsonschema.net alternative",
    "validate api payload",
    "schema conformance checker",
    "openapi schema checker",
    "check json against spec",
    "json schema linter",
    "schema error path",
  ],
  input: "application/json",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "draft",
      label: "Draft",
      default: "2020-12",
      options: [
        {
          value: "2020-12",
          label: "2020-12",
          synonyms: ["latest", "draft 2020-12", "newest draft"],
        },
        { value: "2019-09", label: "2019-09", synonyms: ["draft 2019-09"] },
        { value: "7", label: "Draft 7", synonyms: ["draft-07", "draft7"] },
        { value: "4", label: "Draft 4", synonyms: ["draft-04", "draft4"] },
      ],
    },
    {
      kind: "boolean",
      id: "shortCircuit",
      label: "Stop at first error",
      default: false,
    },
  ],
  http: { method: "POST", contentType: "application/json" },
  copy: {
    what: "Validates a JSON document against a JSON Schema and reports every failure with the exact path in your data, the failing keyword, and the schema location that rejected it. Supports drafts 2020-12, 2019-09, 7, and 4, and filters out the nested wrapper noise that raw validator output usually buries the real error inside.",
    how: 'Paste a single JSON object with two keys, "schema" for your JSON Schema and "data" for the document to check, for example {"schema": {"type": "object", "required": ["name"]}, "data": {"age": 3}}. Pick the draft your schema was written for, and optionally stop at the first error instead of collecting all of them. Each result row is keyed by the instance path that failed, like #/name or #/items/2.',
    why: "Most online JSON Schema validators upload your document to a server and dump raw validator output full of internal jargon (allOf, anyOf branch numbers, duplicated wrapper errors). This one validates locally, so your files and inputs never leave your device, and it collapses the output down to the specific failing paths instead of the schema internals that produced them.",
    faq: [
      {
        q: "Which JSON Schema drafts are supported?",
        a: "Draft 2020-12, draft 2019-09, draft 7, and draft 4. Pick the draft that matches the $schema your document targets, since keyword behavior (like exclusiveMinimum or $ref alongside sibling keywords) differs between them.",
      },
      {
        q: "How do I provide the schema and the data to check?",
        a: 'Paste one JSON object with exactly two keys: "schema" holds your JSON Schema, and "data" holds the document to validate against it, like {"schema": {...}, "data": {...}}.',
      },
      {
        q: "Is my data uploaded anywhere?",
        a: "No. Your files and inputs never leave your device: validation runs entirely in your browser using a local JSON Schema engine.",
      },
    ],
  },
};
