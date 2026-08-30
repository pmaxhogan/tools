import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "hash-identifier",
  matrixSlug: "hash-id",
  icon: "Fingerprint",
  name: "Hash Identifier",
  description: "Work out which algorithm likely produced an unknown hash, ranked by likelihood.",
  category: "Security",
  keywords: [
    "hash identifier",
    "what hash is this",
    "identify hash type",
    "hashcat mode lookup",
    "bcrypt argon2 detector",
    "unknown hash format",
  ],
  searchTerms: [
    "detect hash algorithm",
    "md5 or sha1",
    "md5 vs ntlm",
    "password hash format",
    "crypt format identifier",
    "hash type checker",
    "hashcat mode number",
    "what algorithm is this hash",
    "bcrypt identifier",
    "argon2 identifier",
    "sha512crypt identifier",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "boolean",
      id: "hashcatMode",
      label: "Show hashcat -m modes",
      default: false,
    },
  ],
  examples: [
    {
      label: "Ambiguous 32-char hex digest",
      input: "5f4dcc3b5aa765d61d8327deb882cf99",
      opts: { hashcatMode: "true" },
    },
    {
      label: "Identify a bcrypt hash",
      input: "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
      opts: { hashcatMode: "true" },
    },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Looks at the structure of a pasted hash (length, charset, and any $prefix$ it carries) and ranks which algorithm or password-hash format most likely produced it. Recognizes plain hex digests from MD5 through SHA-512, structured crypt formats like bcrypt, Argon2, and sha512crypt, plus non-hash lookalikes such as UUIDs and JWTs. Optionally shows the matching hashcat -m mode number for each candidate.",
    how: "Paste the hash or password-hash string into the input. The tool reports the most likely match plus a ranked list of alternatives when the length alone is ambiguous, such as 32 hex characters being MD5, NTLM, or MD4. Turn on the hashcat option to see the -m mode number for each recognized format.",
    why: "Most hash-identifier sites are ad-heavy and only guess from length. This one parses structured formats like bcrypt and sha512crypt directly from their prefix, explains why plain hex digests are ambiguous instead of pretending to be certain, runs entirely in your browser, and has no lookup limits.",
    faq: [
      {
        q: "How can it tell MD5 from NTLM?",
        a: "It cannot, not for certain. A bare 32-character hex string is structurally identical for MD5, NTLM, and MD4, so the tool lists all three ranked by how often each actually appears in the wild, with MD5 first. Structured formats like bcrypt carry a distinctive prefix, so those are identified with high confidence instead of a guess.",
      },
      {
        q: "What is a hashcat mode?",
        a: "It is the -m number hashcat needs to attack a given hash type, for example -m 0 for MD5 or -m 1000 for NTLM. Turning on the hashcat option appends the matching number to each recognized candidate so you do not have to look it up separately.",
      },
      {
        q: "Does it crack the hash?",
        a: "No. This only identifies the likely format from its structure; it never attempts to reverse, brute-force, or look up the original value.",
      },
    ],
  },
};
