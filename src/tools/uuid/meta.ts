import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "uuid-generator",
  matrixSlug: "uuid",
  icon: "FingerprintPattern",
  name: "UUID Generator",
  description: "Generate v4 (random) or v7 (time-ordered) UUIDs, one or a thousand at a time.",
  category: "Generators",
  keywords: ["uuid", "guid", "uuid v4", "uuid v7", "uuid generator", "random id"],
  searchTerms: [
    "generate unique id",
    "random guid generator",
    "ulid alternative",
    "nanoid alternative",
    "primary key generator",
    "bulk uuid generator",
    "v4 uuid online",
    "v7 uuid online",
    "rfc 9562 uuid",
    "unique identifier generator",
    "database id generator",
    "uuid online generator",
    "batch uuid generator",
    "guid maker",
  ],
  input: "none",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "version",
      label: "Version",
      default: "v4",
      options: [
        {
          value: "v4",
          label: "v4 (random)",
          synonyms: ["random uuid", "version 4", "uuidv4"],
        },
        {
          value: "v7",
          label: "v7 (time-ordered)",
          synonyms: ["time ordered", "version 7", "uuidv7", "sortable uuid"],
        },
      ],
    },
    { kind: "number", id: "count", label: "Count", default: 1, min: 1, max: 1000 },
    { kind: "boolean", id: "uppercase", label: "Uppercase", default: false },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Generates RFC 9562 UUIDs in your browser using the cryptographically secure random source. Supports v4 (fully random) and v7 (time-ordered: sortable by creation time, ideal for database keys).",
    how: "Pick a version and a count, hit Generate, and copy the result. Generate up to 1000 at once. The options are stored in the URL so you can bookmark your preferred setup.",
    why: "No ads, no artificial caps on how many you can generate, and nothing is requested from a server. The IDs are generated locally and never logged anywhere.",
    faq: [
      {
        q: "Are these UUIDs cryptographically random?",
        a: "Yes. Randomness comes from crypto.getRandomValues, the same secure source used for key generation.",
      },
      {
        q: "When should I use v7 instead of v4?",
        a: "Use v7 when IDs will be database keys or need to sort by creation time, since the timestamp prefix keeps indexes efficient. Use v4 when you want no information leakage at all.",
      },
      {
        q: "Can anyone else see the generated IDs?",
        a: "No. Generation happens entirely on your device; your files and inputs never leave your device.",
      },
    ],
  },
};
