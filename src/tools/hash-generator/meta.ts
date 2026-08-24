import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "hash-generator",
  icon: "Hash",
  matrixSlug: "hash",
  name: "Hash & Checksum",
  description: "Hash text or files and verify against a known-good value.",
  category: "Crypto",
  keywords: [
    "hash generator",
    "md5 generator",
    "sha256 checksum",
    "sha1 hash",
    "checksum calculator",
    "verify checksum",
    "hash text online",
  ],
  searchTerms: [
    "digest calculator",
    "sha512 generator",
    "sha384 generator",
    "file checksum verifier",
    "compare hashes",
    "md5sum online",
    "sha256sum online",
    "password hash lookup",
    "checksum mismatch",
    "md5",
    "sha256",
    "sha1",
    "checksum",
    "hash calculator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "text",
      id: "verify",
      label: "Verify against (optional)",
      default: "",
      placeholder: "Paste a known-good hash to check for a match",
    },
  ],
  examples: [
    {
      label: "Verify a checksum",
      input: "The quick brown fox jumps over the lazy dog",
      opts: { verify: "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592" },
    },
  ],
  http: { method: "POST", contentType: "application/json" },
  copy: {
    what: "Hashes text with MD5, SHA-1, SHA-256, SHA-384, and SHA-512 simultaneously, all computed locally. Paste a known-good hash into the verify field and it tells you which algorithm (if any) matches, so you can confirm a download or message checksum without guessing the algorithm.",
    how: "Type or paste text into the input and every digest updates immediately. To verify a checksum, paste the value you were given into the verify field: matching is case-insensitive, so it works whether the source used upper or lower case hex.",
    why: "Most online hash tools run one algorithm at a time and force you to pick it first. This one computes all five at once, never uploads your text anywhere, and works offline once the page has loaded.",
    faq: [
      {
        q: "What does hashing an empty input produce?",
        a: "The well-known empty-string digests: MD5 d41d8cd98f00b204e9800998ecf8427e, SHA-1 da39a3ee5e6b4b0d3255bfef95601890afd80709, and SHA-256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. These are standard test vectors, not errors.",
      },
      {
        q: "Can I hash a file instead of text?",
        a: "Not yet on this page: it currently hashes pasted or typed text. File hashing (via a drag-and-drop panel) is planned as a follow-up.",
      },
      {
        q: "Is MD5 or SHA-1 safe to use?",
        a: "No, both are cryptographically broken and should never be used for security (password storage, signatures). They are included here only for legacy checksum verification, such as confirming an old download.",
      },
    ],
  },
};
