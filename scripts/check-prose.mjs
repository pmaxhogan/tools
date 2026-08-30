/**
 * check-prose.mjs
 *
 * Zero dependency gate for two DESIGN.md/CLAUDE.md copy rules:
 *   1. No em dash (U+2014) or en dash (U+2013) in user-facing prose.
 *   2. Never claim "zero network requests" or "no network requests" (the
 *      sanctioned privacy claim is exactly "your files and inputs never
 *      leave your device").
 *
 * Scans src/**\/*.{vue,astro,ts}, skipping src/tools/_generated/ (fetched
 * snapshot data, not authored copy) and *.test.ts / *.spec.ts (test
 * descriptions are not user-facing prose either).
 *
 * Both rules govern *prose*, not source code, so comments are stripped
 * before scanning: block comments (/* *\/), line comments (// to end of
 * line), and HTML/template comments (<!-- -->).
 *
 * This is a heuristic, not a parser, so an opener only counts when what
 * precedes it looks like code rather than the middle of a token: start of
 * line, whitespace, or one of ( , { [ ; = . That matters. Without it,
 * `accept="image/*"` reads as the start of a block comment and blanks
 * everything up to the next `*\/`, which was silently skipping thousands of
 * lines of real page copy (every meta.ts whose examples mention a MIME
 * wildcard), and `https://` reads as a line comment and blanks the rest of
 * that line. Formatted code always puts whitespace or an opening bracket
 * before a real comment, so nothing genuine is missed by the rule.
 *
 * DASH_ALLOWLIST exempts specific file:line pairs where an em or en dash is
 * the literal subject of the code, not prose: a regex character class that
 * strips dash variants from input, and lookup tables whose values are the
 * dash characters themselves. Each entry documents why. This allowlist is
 * for genuine code, never for user-facing copy. A real prose violation must
 * be fixed, not allowlisted.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const SCAN_EXTENSIONS = new Set([".vue", ".astro", ".ts"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".astro", ".wrangler", "_generated"]);

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const DASH_RE = new RegExp(`[${EM_DASH}${EN_DASH}]`);
const NETWORK_PHRASE_RES = [/\b(zero|no) network requests\b/i, /makes no network requests/i];

/**
 * file:line -> reason. Line numbers are 1-based, against the original file
 * (not the comment-stripped copy), so they stay stable no matter how
 * comment-stripping is implemented.
 */
const DASH_ALLOWLIST = new Map([
  [
    "src/tools/distance-bearing-calculator/index.ts:126",
    "regex character class that strips dash variants (minus sign, en dash, em dash) from user input; the dashes are the code's subject, not prose",
  ],
  [
    "src/tools/document-converter/index.ts:117",
    "HTML named-entity lookup table: the value for &mdash; is literally an em dash character",
  ],
  [
    "src/tools/document-converter/index.ts:118",
    "HTML named-entity lookup table: the value for &ndash; is literally an en dash character",
  ],
  [
    "src/tools/unicode-picker/data.ts:299",
    "Unicode character catalog entry: the row for U+2013 is literally an en dash character",
  ],
  [
    "src/tools/unicode-picker/data.ts:300",
    "Unicode character catalog entry: the row for U+2014 is literally an em dash character",
  ],
]);

function isTestOrSpec(name) {
  return /\.(test|spec)\.ts$/.test(name);
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    if (!SCAN_EXTENSIONS.has(extname(entry.name))) continue;
    if (isTestOrSpec(entry.name)) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

/** A `/` that starts a comment is preceded by one of these, or by nothing. */
const COMMENT_LEAD = new Set(["(", ",", "{", "[", ";", "="]);

/**
 * True when the `/` at `i` can open a comment: only at the start of the file,
 * after whitespace, or after an opening punctuation. Inside a token, as in
 * `image/*` or `https://`, it is data, not an opener.
 */
function opensComment(text, i) {
  if (i === 0) return true;
  const prev = text[i - 1];
  return /\s/.test(prev) || COMMENT_LEAD.has(prev);
}

/**
 * Blanks out block comments, line comments, and HTML/template comments,
 * replacing every non-newline character with a space so line and column
 * numbers in the result line up exactly with the original source.
 */
function stripComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const two = text.slice(i, i + 2);
    const four = text.slice(i, i + 4);
    if (four === "<!--") {
      const end = text.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (two === "/*" && opensComment(text, i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (two === "//" && opensComment(text, i)) {
      let end = text.indexOf("\n", i);
      if (end === -1) end = n;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

function relPath(absPath) {
  return relative(ROOT, absPath).split("\\").join("/");
}

function scanFile(absPath) {
  const rel = relPath(absPath);
  const original = readFileSync(absPath, "utf8");
  const stripped = stripComments(original);
  const strippedLines = stripped.split(/\r?\n/);
  const originalLines = original.split(/\r?\n/);
  const hits = [];

  strippedLines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (DASH_RE.test(line)) {
      const key = `${rel}:${lineNo}`;
      if (!DASH_ALLOWLIST.has(key)) {
        hits.push({
          file: rel,
          line: lineNo,
          text: originalLines[idx]?.trim() ?? "",
          reason: "em dash or en dash in prose",
        });
      }
    }
    for (const re of NETWORK_PHRASE_RES) {
      if (re.test(line)) {
        hits.push({
          file: rel,
          line: lineNo,
          text: originalLines[idx]?.trim() ?? "",
          reason: `banned privacy phrasing (use "your files and inputs never leave your device")`,
        });
        break;
      }
    }
  });

  return hits;
}

function main() {
  const files = walk(join(ROOT, "src"), []).filter((f) => statSync(f).isFile());
  const hits = files.flatMap(scanFile);

  if (hits.length === 0) {
    console.log(`check-prose: clean (${files.length} files scanned)`);
    process.exit(0);
  }

  console.error(`check-prose: ${hits.length} hit(s):\n`);
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line} - ${hit.reason}`);
    console.error(`    ${hit.text}`);
  }
  process.exit(1);
}

main();
