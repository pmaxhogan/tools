import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "bcrypt-generator",
  matrixSlug: "bcrypt",
  icon: "LockKeyhole",
  name: "Bcrypt & Argon2 Hasher",
  description:
    "Hash and verify passwords with bcrypt, argon2, and scrypt, entirely in your browser.",
  category: "Crypto",
  sensitiveInput: true,
  keywords: [
    "bcrypt generator",
    "bcrypt online",
    "argon2 hash generator",
    "verify bcrypt hash",
    "argon2id",
    "password hash checker",
  ],
  searchTerms: [
    "bcrypt hash generator",
    "check bcrypt password",
    "argon2id online",
    "scrypt hash",
    "password hashing tool",
    "phc string format",
    "2y hash php",
    "bcrypt cost factor",
    "compare password to hash",
    "salted password hash",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "hash",
      options: [
        {
          value: "hash",
          label: "Hash a password",
          synonyms: ["generate", "encrypt", "create hash", "make hash"],
        },
        {
          value: "verify",
          label: "Verify a hash",
          synonyms: ["check", "compare", "match password", "test hash", "validate"],
        },
      ],
    },
    {
      kind: "select",
      id: "algorithm",
      label: "Algorithm",
      default: "bcrypt",
      options: [
        {
          value: "bcrypt",
          label: "bcrypt",
          synonyms: ["blowfish", "2a", "2b", "2y", "php password_hash"],
        },
        {
          value: "argon2id",
          label: "argon2id (recommended)",
          synonyms: ["argon2", "argon 2id", "owasp", "phc winner"],
        },
        {
          value: "argon2i",
          label: "argon2i",
          synonyms: ["argon 2i", "side channel resistant argon2"],
        },
        {
          value: "argon2d",
          label: "argon2d",
          synonyms: ["argon 2d", "gpu resistant argon2"],
        },
        {
          value: "scrypt",
          label: "scrypt",
          synonyms: ["s crypt", "memory hard kdf", "litecoin kdf"],
        },
      ],
    },
    {
      kind: "number",
      id: "cost",
      label: "Bcrypt cost (10 is about 100 ms)",
      default: 10,
      min: 4,
      max: 15,
      step: 1,
    },
    { kind: "number", id: "iterations", label: "Argon2 iterations", default: 3, min: 1, max: 10 },
    {
      kind: "number",
      id: "memoryKiB",
      label: "Argon2 memory in KiB",
      default: 65536,
      min: 8192,
      max: 1048576,
      step: 1024,
    },
    { kind: "number", id: "parallelism", label: "Argon2 parallelism", default: 1, min: 1, max: 8 },
    {
      kind: "number",
      id: "hashLength",
      label: "Argon2 hash length in bytes",
      default: 32,
      min: 16,
      max: 64,
    },
    {
      kind: "number",
      id: "scryptN",
      label: "Scrypt cost as log2 N",
      default: 15,
      min: 10,
      max: 20,
    },
  ],
  copy: {
    what: "Hashes a password with bcrypt, argon2id, argon2i, argon2d, or scrypt and returns the complete encoded string you would store in a database, alongside the parameters that string encodes. Verify mode goes the other way: paste a password and an existing hash and it reads the algorithm and cost settings out of the hash itself, including the $2y$ hashes PHP writes. Every hash gets a fresh random 16 byte salt from the browser's cryptographic random source. scrypt has no standard encoded string, so this tool defines one, $scrypt$ln=15,r=8,p=1$salt$hash with both values in unpadded base64, and reads that same format back in Verify mode.",
    how: "Leave Mode on Hash, pick an algorithm, and type the password into the input. Adjust the knobs that belong to your algorithm: cost for bcrypt, iterations and memory for argon2, log2 N for scrypt. To check an existing hash, switch Mode to Verify and paste the password on one line and the hash on the other; the hash is spotted by its $ prefix, so either order works.",
    why: "Most bcrypt generators post your password to their server and hash it there, which is exactly what a password tool should never do. This one runs bcrypt, argon2, and scrypt as WebAssembly inside the tab, so your inputs never leave your device, there is no rate limit, and there is deliberately no curl endpoint for hashing. It also tells you what the cost settings actually mean instead of hiding a mystery slider.",
    faq: [
      {
        q: "Which algorithm should I use in 2026?",
        a: "argon2id. It is the current first recommendation for new password storage because it is memory hard and resists both GPU cracking and side channel attacks. bcrypt is still perfectly acceptable for a legacy system that already uses it, and scrypt is a reasonable middle ground. Plain argon2i and argon2d are here for compatibility, not as a default.",
      },
      {
        q: "Why does the same password produce a different hash every time?",
        a: "Because every run draws a fresh random 16 byte salt, and that salt is stored inside the encoded string. Identical passwords therefore get different hashes, which is what stops a single rainbow table from cracking every account at once. Never compare two hashes by eye; use Verify mode, which reads the salt back out of the hash.",
      },
      {
        q: "Is my password sent anywhere?",
        a: "No. The hashing runs in WebAssembly inside your browser tab, so your inputs never leave your device, and the page keeps working offline after the first load. This is also the one tool here with no curl endpoint on purpose, because a hosted hashing endpoint would mean real passwords traveling over the network.",
      },
    ],
  },
};
