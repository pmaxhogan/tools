import { ToolError, type ToolLogic } from "../types";

export interface HashIdOpts {
  /** Append the hashcat -m mode number to every recognized candidate. */
  hashcatMode: boolean;
  [key: string]: unknown;
}

export type HashIdResult = Record<string, string>;

export interface HashCandidate {
  name: string;
  confidence: "high" | "medium" | "low";
  /** hashcat -m mode number, when a stable one exists for this format. */
  hashcat?: number;
  /** Extra structural detail: crypt parameters, why it's ambiguous, etc. */
  note?: string;
}

/** Well-known hashcat -m mode numbers, keyed by the candidate name used below. */
const HASHCAT_MODES: Record<string, number> = {
  MD5: 0,
  MD4: 900,
  NTLM: 1000,
  "LM hash": 3000,
  "SHA-1": 100,
  "RIPEMD-160": 6000,
  "SHA-224": 1300,
  "SHA3-224": 17300,
  "SHA-256": 1400,
  "SHA3-256": 17400,
  "SHA-384": 10800,
  "SHA3-384": 17500,
  "SHA-512": 1700,
  "SHA3-512": 17600,
  Whirlpool: 6100,
  CRC32: 11500,
  "MySQL 3.23": 200,
  "MySQL 4.1+": 300,
  bcrypt: 3200,
  md5crypt: 500,
  "Apache apr1": 1600,
  sha256crypt: 7400,
  sha512crypt: 1800,
  phpass: 400,
  "Django PBKDF2-SHA256": 10000,
  scrypt: 8900,
  "SSHA (LDAP)": 111,
  "SHA (LDAP)": 101,
};

/** Ambiguous plain-hex digests, ranked by real-world prevalence at each length. */
const HEX_LENGTH_CANDIDATES: Record<number, HashCandidate[]> = {
  4: [{ name: "CRC16", confidence: "medium", note: "16-bit checksum, 4 hex characters." }],
  8: [
    {
      name: "CRC32",
      confidence: "medium",
      hashcat: HASHCAT_MODES.CRC32,
      note: "32-bit checksum, 8 hex characters.",
    },
    {
      name: "Adler32",
      confidence: "low",
      note: "zlib's 32-bit checksum, same length as CRC32.",
    },
  ],
  16: [
    {
      name: "MySQL 3.23",
      confidence: "medium",
      hashcat: HASHCAT_MODES["MySQL 3.23"],
      note: "old MySQL PASSWORD() format, 16 hex characters, deprecated since MySQL 4.1.",
    },
  ],
  32: [
    {
      name: "MD5",
      confidence: "high",
      hashcat: HASHCAT_MODES.MD5,
      note: "most common 32-character hex digest.",
    },
    {
      name: "NTLM",
      confidence: "medium",
      hashcat: HASHCAT_MODES.NTLM,
      note: "Windows NTLM password hash, same length as MD5.",
    },
    {
      name: "MD4",
      confidence: "low",
      hashcat: HASHCAT_MODES.MD4,
      note: "rarely used directly; NTLM is MD4 internally.",
    },
    {
      name: "LM hash",
      confidence: "low",
      hashcat: HASHCAT_MODES["LM hash"],
      note: "legacy Windows LAN Manager hash, weak and rarely seen today.",
    },
  ],
  40: [
    {
      name: "SHA-1",
      confidence: "high",
      hashcat: HASHCAT_MODES["SHA-1"],
      note: "most common 40-character hex digest.",
    },
    {
      name: "RIPEMD-160",
      confidence: "low",
      hashcat: HASHCAT_MODES["RIPEMD-160"],
      note: "same length as SHA-1, far less common.",
    },
  ],
  56: [
    {
      name: "SHA-224",
      confidence: "high",
      hashcat: HASHCAT_MODES["SHA-224"],
      note: "56-character hex digest.",
    },
    {
      name: "SHA3-224",
      confidence: "low",
      hashcat: HASHCAT_MODES["SHA3-224"],
      note: "same length as SHA-224, less common.",
    },
  ],
  64: [
    {
      name: "SHA-256",
      confidence: "high",
      hashcat: HASHCAT_MODES["SHA-256"],
      note: "most common 64-character hex digest.",
    },
    {
      name: "SHA3-256",
      confidence: "low",
      hashcat: HASHCAT_MODES["SHA3-256"],
      note: "same length as SHA-256, less common.",
    },
  ],
  96: [
    {
      name: "SHA-384",
      confidence: "high",
      hashcat: HASHCAT_MODES["SHA-384"],
      note: "96-character hex digest.",
    },
    {
      name: "SHA3-384",
      confidence: "low",
      hashcat: HASHCAT_MODES["SHA3-384"],
      note: "same length as SHA-384, less common.",
    },
  ],
  128: [
    {
      name: "SHA-512",
      confidence: "high",
      hashcat: HASHCAT_MODES["SHA-512"],
      note: "most common 128-character hex digest.",
    },
    {
      name: "SHA3-512",
      confidence: "low",
      hashcat: HASHCAT_MODES["SHA3-512"],
      note: "same length as SHA-512, less common.",
    },
    {
      name: "Whirlpool",
      confidence: "low",
      hashcat: HASHCAT_MODES.Whirlpool,
      note: "512-bit digest, same length as SHA-512.",
    },
  ],
};

/** Structured / prefixed password-hash formats, checked before plain hex-length guessing. */
function matchStructured(s: string): HashCandidate[] | null {
  let m: RegExpExecArray | null;

  if ((m = /^\$2([abxy]?)\$(\d{2})\$/.exec(s))) {
    return [
      {
        name: "bcrypt",
        confidence: "high",
        hashcat: HASHCAT_MODES.bcrypt,
        note: `bcrypt, variant $2${m[1] || "b"}$, cost factor ${Number(m[2])}.`,
      },
    ];
  }
  if ((m = /^\$argon2(id|i|d)\$/.exec(s))) {
    return [
      {
        name: "Argon2",
        confidence: "high",
        note: `Argon2 variant argon2${m[1]}. Memory, time, and parallelism cost are encoded in the next segment.`,
      },
    ];
  }
  if (/^\$7\$/.test(s) || /^\$scrypt\$/.test(s)) {
    return [
      {
        name: "scrypt",
        confidence: "high",
        hashcat: HASHCAT_MODES.scrypt,
        note: "scrypt key derivation function hash.",
      },
    ];
  }
  if (/^\$pbkdf2(-sha256|-sha512)?\$/.test(s)) {
    return [
      {
        name: "PBKDF2 (passlib)",
        confidence: "high",
        note: "passlib-style PBKDF2 hash: $pbkdf2-<digest>$rounds$salt$hash.",
      },
    ];
  }
  if (/^pbkdf2_sha256\$/.test(s)) {
    return [
      {
        name: "Django PBKDF2-SHA256",
        confidence: "high",
        hashcat: HASHCAT_MODES["Django PBKDF2-SHA256"],
        note: "Django's default password hasher: pbkdf2_sha256$iterations$salt$hash.",
      },
    ];
  }
  if (/^\$6\$/.test(s)) {
    return [
      {
        name: "sha512crypt",
        confidence: "high",
        hashcat: HASHCAT_MODES.sha512crypt,
        note: "glibc SHA-512 crypt ($6$), used in /etc/shadow.",
      },
    ];
  }
  if (/^\$5\$/.test(s)) {
    return [
      {
        name: "sha256crypt",
        confidence: "high",
        hashcat: HASHCAT_MODES.sha256crypt,
        note: "glibc SHA-256 crypt ($5$), used in /etc/shadow.",
      },
    ];
  }
  if (/^\$apr1\$/.test(s)) {
    return [
      {
        name: "Apache apr1",
        confidence: "high",
        hashcat: HASHCAT_MODES["Apache apr1"],
        note: "Apache's md5crypt variant ($apr1$), used in .htpasswd.",
      },
    ];
  }
  if (/^\$1\$/.test(s)) {
    return [
      {
        name: "md5crypt",
        confidence: "high",
        hashcat: HASHCAT_MODES.md5crypt,
        note: "traditional Unix md5crypt ($1$).",
      },
    ];
  }
  if (/^\$[PH]\$/.test(s)) {
    return [
      {
        name: "phpass",
        confidence: "high",
        hashcat: HASHCAT_MODES.phpass,
        note: "phpass portable hash, used by older WordPress and phpBB ($P$ or $H$).",
      },
    ];
  }
  if (/^\$S\$/.test(s)) {
    return [
      {
        name: "Drupal",
        confidence: "high",
        note: "Drupal 7 password hash ($S$, SHA-512 based).",
      },
    ];
  }
  if (/^\{SSHA\}/.test(s)) {
    return [
      {
        name: "SSHA (LDAP)",
        confidence: "high",
        hashcat: HASHCAT_MODES["SSHA (LDAP)"],
        note: "salted SHA-1, base64-encoded, used by LDAP ({SSHA}).",
      },
    ];
  }
  if (/^\{SHA\}/.test(s)) {
    return [
      {
        name: "SHA (LDAP)",
        confidence: "high",
        hashcat: HASHCAT_MODES["SHA (LDAP)"],
        note: "unsalted SHA-1, base64-encoded, used by LDAP ({SHA}).",
      },
    ];
  }
  if (/^\{MD5\}/.test(s)) {
    return [
      {
        name: "MD5 (LDAP)",
        confidence: "high",
        note: "unsalted MD5, base64-encoded, used by LDAP ({MD5}).",
      },
    ];
  }
  if (/^\*[0-9A-F]{40}$/.test(s)) {
    return [
      {
        name: "MySQL 4.1+",
        confidence: "high",
        hashcat: HASHCAT_MODES["MySQL 4.1+"],
        note: "MySQL 4.1+ password hash: '*' followed by 40 uppercase hex characters (SHA-1 applied twice).",
      },
    ];
  }
  return null;
}

/** Rough charset classification, used both to describe input and to pick the fallback path. */
function charsetOf(s: string): string {
  if (/^[0-9a-fA-F]+$/.test(s)) return "hex";
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return "base64";
  if (/^[A-Za-z0-9_-]+$/.test(s)) return "base64url";
  return "mixed";
}

/**
 * Identify what an unknown hash or password-hash string probably is, ranked by
 * likelihood. Never throws; returns an empty array when nothing matches.
 */
export function identify(hashRaw: string): HashCandidate[] {
  const s = (hashRaw ?? "").trim();
  if (!s) return [];

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return [
      {
        name: "UUID, not a hash",
        confidence: "high",
        note: "Matches the UUID 8-4-4-4-12 hex format, not a hash digest.",
      },
    ];
  }

  const jwtParts = s.split(".");
  if (
    jwtParts.length === 3 &&
    jwtParts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part))
  ) {
    return [
      {
        name: "JWT, not a hash",
        confidence: "high",
        note: "Three base64url segments separated by dots (header.payload.signature): a JSON Web Token, not a hash digest.",
      },
    ];
  }

  const structured = matchStructured(s);
  if (structured) return structured;

  if (/^[0-9a-fA-F]+$/.test(s)) {
    const byLength = HEX_LENGTH_CANDIDATES[s.length];
    if (byLength) return byLength.map((c) => ({ ...c }));
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0 && s.length >= 8) {
    const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
    const byteLength = (s.length / 4) * 3 - padding;
    return [
      {
        name: "Base64-encoded data",
        confidence: "low",
        note: `Decodes to roughly ${byteLength} bytes. Could be a base64-encoded binary digest (SHA-256 is 32 bytes, SHA-1 is 20) or unrelated data.`,
      },
    ];
  }

  return [];
}

function formatCandidate(c: HashCandidate, showHashcat: boolean): string {
  let line = `${c.name} (${c.confidence})`;
  if (showHashcat) {
    if (c.hashcat !== undefined) line += ` [hashcat -m ${c.hashcat}]`;
    else if (c.name === "Argon2") line += " [no hashcat mode: unsupported historically]";
  }
  return line;
}

export function run(input: string, opts: HashIdOpts): HashIdResult {
  const hash = (input ?? "").trim();
  if (!hash) {
    throw new ToolError(
      "empty-input",
      "Paste a hash to identify.",
      "For example 5f4dcc3b5aa765d61d8327deb882cf99.",
    );
  }

  const candidates = identify(hash);
  const result: HashIdResult = {
    "Input length": `${hash.length} characters`,
    Charset: charsetOf(hash),
  };

  if (candidates.length === 0) {
    result["Most likely"] = "Unknown";
    result["Candidates"] =
      `No known hash or password-hash format matched. Length ${hash.length} characters, charset ${charsetOf(hash)}. It may be a custom, truncated, or proprietary format.`;
    return result;
  }

  if (candidates.length === 1 && candidates[0]!.note) {
    result["Format"] = candidates[0]!.note!;
  }

  result["Most likely"] = candidates[0]!.name;
  result["Candidates"] = candidates
    .map((c) => formatCandidate(c, opts.hashcatMode === true))
    .join("\n");

  return result;
}

export default { run } satisfies ToolLogic<string, HashIdResult, HashIdOpts>;
