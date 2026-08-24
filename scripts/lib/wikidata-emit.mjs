/**
 * Writes the generated TypeScript modules for the Wikidata snapshots.
 *
 * The one non-obvious rule here is idempotence. `builtAt` is a timestamp, so
 * writing it unconditionally would rewrite every module on every run even when
 * the underlying data is byte for byte identical, which defeats the point of
 * a cached build step. Instead the payload (everything except the timestamp)
 * is hashed into a marker comment; when the marker still matches, the previous
 * `builtAt` is preserved and the file is left alone.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MARKER = "// wikidata-payload-sha256:";

function hashPayload(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

function previousBuiltAt(path, hash) {
  if (!existsSync(path)) return null;
  let existing;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!existing.includes(`${MARKER} ${hash}`)) return null;
  const match = /builtAt:\s*"([^"]+)"/.exec(existing);
  return match ? match[1] : null;
}

/**
 * @param {object} params
 * @param {string} params.path      absolute path of the module to write
 * @param {string} params.header    the leading block comment, already formatted
 * @param {string} params.body      type declarations and data exports
 * @param {Record<string, number>} params.counts value for WIKIDATA_META.counts
 * @returns {{ path: string, bytes: number, changed: boolean, builtAt: string }}
 */
export function writeGeneratedModule({ path, header, body, counts }) {
  const payload = `${header}\n${body}\n${JSON.stringify(counts)}`;
  const hash = hashPayload(payload);
  const kept = previousBuiltAt(path, hash);
  const builtAt = kept ?? new Date().toISOString();

  const countLines = Object.entries(counts)
    .map(([key, value]) => `    ${key}: ${value},`)
    .join("\n");

  const text =
    `${header}\n` +
    `${MARKER} ${hash}\n` +
    `\n` +
    `${body}\n` +
    `\n` +
    `/** Provenance for the snapshot in this module. */\n` +
    `export const WIKIDATA_META = {\n` +
    `  /** ISO 8601 instant the snapshot last changed, not the last build. */\n` +
    `  builtAt: "${builtAt}",\n` +
    `  counts: {\n` +
    `${countLines}\n` +
    `  },\n` +
    `  license: "CC0 1.0 (Wikidata)",\n` +
    `} as const;\n`;

  if (kept !== null && existsSync(path) && readFileSync(path, "utf8") === text) {
    return { path, bytes: statSync(path).size, changed: false, builtAt };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, bytes: statSync(path).size, changed: true, builtAt };
}

/**
 * Serialises an array of plain objects as a TypeScript array literal, one row
 * per line, with `undefined` and `null` keys dropped. One row per line keeps
 * the diff of a nine thousand row file reviewable.
 *
 * Empty arrays are deliberately kept. The generated interfaces declare array
 * fields as required, so dropping `[]` would make the emitted data disagree
 * with its own type and hand every consumer an undefined where it was
 * promised a list.
 */
export function rowsLiteral(rows) {
  if (rows.length === 0) return "[]";
  const lines = rows.map((row) => {
    const clean = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined || value === null) continue;
      clean[key] = value;
    }
    return `  ${JSON.stringify(clean)},`;
  });
  return `[\n${lines.join("\n")}\n]`;
}
