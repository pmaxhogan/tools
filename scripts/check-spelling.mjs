/**
 * check-spelling.mjs
 *
 * Zero dependency US English spelling gate for this repo.
 *
 * Scans text files under src/, worker/, scripts/, docs/, and the root
 * *.md files for British spellings (colour, centre, neighbour, and about
 * sixty other word families) and reports each hit as file:line:col plus
 * the American suggestion. Exits 1 when anything is found, 0 when clean.
 *
 * Flags:
 *   --fix          rewrite simple, unambiguous, case preserving hits in
 *                  place (never touches "flag only" families)
 *   --list         print the word table (British form, American form,
 *                  whether --fix can rewrite it) and exit, no scanning
 *   --self-test    run the built-in assertions against in-memory sample
 *                  strings and exit non-zero on failure. This is the test
 *                  suite for the script itself: vitest only picks up
 *                  src/**\/*.test.ts, so this file has to be able to test
 *                  itself.
 *   --files a b c  only scan these paths (resolved against the current
 *                  working directory) instead of walking the repo
 *
 * Skipped unconditionally: node_modules, dist, public, mc-pipeline,
 * src/tools/_generated, and any *.lock, *.csv, or *.json file (the
 * Wikipedia/PubChem source passthroughs under src/tools/_generated are
 * already excluded by the directory skip). Only recognized text
 * extensions are scanned; anything else, or a file that sniffs as
 * binary, is skipped.
 *
 * Allowlisting, in order of application:
 *   1. A line containing the marker comment "// spelling: allow" is
 *      never flagged, no matter what it contains.
 *   2. The contents of a top level `synonyms: [...]` or
 *      `searchTerms: [...]` array are blanked out before scanning, so
 *      British spellings kept there on purpose as search aliases never
 *      trip the check. Limitation: this is a bracket-depth scan, not a
 *      parser, so it assumes those arrays hold flat string literals (the
 *      only shape they take in this repo's meta.ts files) and does not
 *      understand a `synonyms` or `searchTerms` identifier that is not
 *      actually an array literal.
 *   3. A small per-file allowlist (PER_FILE_ALLOWLIST below) exempts
 *      specific whole words in specific files: the CSS Color 4 "grey"
 *      family in color-picker, the resistor color code "grey" key, and
 *      the "greyhound"/"greys" wordlist entries in password-generator.
 *   4. A handful of identifiers (AnalyserNode, aria-labelledby,
 *      programmer/programming/programmed, license_skus, and so on) are
 *      never at risk in the first place: every word family here matches
 *      on a full \b(word)\b boundary, and none of those identifiers
 *      contain one of the flagged words as a true standalone token (for
 *      example "neighbourFarmland" has no boundary between "neighbour"
 *      and "F", so \bneighbour\b never matches inside it, and "Analyser"
 *      is not in the analyse family at all since the family only lists
 *      analyse/analysed/analyses/analysing). GLOBAL_ALLOW_WORDS below
 *      still lists them for documentation and as a defensive no-op.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Word families
// ---------------------------------------------------------------------------

/**
 * Each entry is [britishForm, americanForm] or [britishForm, americanForm,
 * false] for a "flag only, do not auto-fix" pair. Forms are lowercase; case
 * is reapplied to the suggestion at match time.
 */
function family(name, pairs) {
  return { name, pairs };
}

const WORD_FAMILIES = [
  family("colour", [
    ["colour", "color"],
    ["colours", "colors"],
    ["coloured", "colored"],
    ["colouring", "coloring"],
    ["colourful", "colorful"],
    ["colourless", "colorless"],
    ["colourise", "colorize"],
    ["colourised", "colorized"],
    ["colourises", "colorizes"],
    ["colourising", "colorizing"],
    ["colourize", "colorize"],
    ["colourized", "colorized"],
    ["colourizes", "colorizes"],
    ["colourizing", "colorizing"],
    ["colourisation", "colorization"],
    ["colourization", "colorization"],
  ]),
  family("neighbour", [
    ["neighbour", "neighbor"],
    ["neighbours", "neighbors"],
    ["neighbouring", "neighboring"],
    ["neighbourhood", "neighborhood"],
    ["neighbourhoods", "neighborhoods"],
  ]),
  family("metre", [
    ["metre", "meter"],
    ["metres", "meters"],
  ]),
  family("centimetre", [
    ["centimetre", "centimeter"],
    ["centimetres", "centimeters"],
  ]),
  family("kilometre", [
    ["kilometre", "kilometer"],
    ["kilometres", "kilometers"],
  ]),
  family("millimetre", [
    ["millimetre", "millimeter"],
    ["millimetres", "millimeters"],
  ]),
  family("centre", [
    ["centre", "center"],
    ["centres", "centers"],
    ["centred", "centered"],
    ["centring", "centering"],
  ]),
  family("litre", [
    ["litre", "liter"],
    ["litres", "liters"],
  ]),
  family("fibre", [
    ["fibre", "fiber"],
    ["fibres", "fibers"],
  ]),
  family("normalise", [
    ["normalise", "normalize"],
    ["normalised", "normalized"],
    ["normalises", "normalizes"],
    ["normalising", "normalizing"],
    ["normalisation", "normalization"],
  ]),
  family("serialise", [
    ["serialise", "serialize"],
    ["serialised", "serialized"],
    ["serialising", "serializing"],
    ["serialisation", "serialization"],
  ]),
  family("optimise", [
    ["optimise", "optimize"],
    ["optimised", "optimized"],
    ["optimises", "optimizes"],
    ["optimising", "optimizing"],
    ["optimisation", "optimization"],
  ]),
  family("organise", [
    ["organise", "organize"],
    ["organised", "organized"],
    ["organises", "organizes"],
    ["organising", "organizing"],
    ["organisation", "organization"],
  ]),
  family("recognise", [
    ["recognise", "recognize"],
    ["recognised", "recognized"],
    ["recognises", "recognizes"],
    ["recognising", "recognizing"],
    ["recognisation", "recognization"],
  ]),
  family("summarise", [
    ["summarise", "summarize"],
    ["summarised", "summarized"],
    ["summarises", "summarizes"],
    ["summarising", "summarizing"],
  ]),
  family("visualise", [
    ["visualise", "visualize"],
    ["visualised", "visualized"],
    ["visualiser", "visualizer"],
    ["visualisation", "visualization"],
  ]),
  family("initialise", [
    ["initialise", "initialize"],
    ["initialised", "initialized"],
    ["initialisation", "initialization"],
  ]),
  family("customise", [
    ["customise", "customize"],
    ["customised", "customized"],
    ["customisation", "customization"],
  ]),
  family("minimise", [
    ["minimise", "minimize"],
    ["minimised", "minimized"],
  ]),
  family("maximise", [
    ["maximise", "maximize"],
    ["maximised", "maximized"],
  ]),
  family("analyse", [
    ["analyse", "analyze"],
    ["analyses", "analyzes"],
    ["analysed", "analyzed"],
    ["analysing", "analyzing"],
  ]),
  family("behaviour", [
    ["behaviour", "behavior"],
    ["behaviours", "behaviors"],
    ["behavioural", "behavioral"],
  ]),
  family("favourite", [
    ["favourite", "favorite"],
    ["favourites", "favorites"],
  ]),
  family("licence", [
    ["licence", "license"],
    ["licences", "licenses"],
  ]),
  family("catalogue", [
    ["catalogue", "catalog"],
    ["catalogues", "catalogs"],
  ]),
  family("grey", [
    ["grey", "gray"],
    ["greys", "grays"],
    ["greyed", "grayed"],
    ["greyish", "grayish"],
    ["darkgrey", "darkgray"],
    ["dimgrey", "dimgray"],
    ["lightgrey", "lightgray"],
    ["slategrey", "slategray"],
    ["darkslategrey", "darkslategray"],
    ["lightslategrey", "lightslategray"],
  ]),
  family("cancelled", [
    ["cancelled", "canceled"],
    ["cancelling", "canceling"],
  ]),
  family("labelled", [
    ["labelled", "labeled"],
    ["labelling", "labeling"],
  ]),
  family("modelled", [
    ["modelled", "modeled"],
    ["modelling", "modeling"],
  ]),
  family("travelled", [
    ["travelled", "traveled"],
    ["travelling", "traveling"],
  ]),
  family("programme", [
    ["programme", "program"],
    ["programmes", "programs"],
  ]),
  family("defence", [
    ["defence", "defense"],
    ["defences", "defenses"],
  ]),
  family("aluminium", [["aluminium", "aluminum"]]),
  family("artefact", [
    ["artefact", "artifact"],
    ["artefacts", "artifacts"],
  ]),
  family("judgement", [
    ["judgement", "judgment"],
    ["judgements", "judgments"],
  ]),
  family("cheque", [
    ["cheque", "check"],
    ["cheques", "checks"],
  ]),
  family("honour", [
    ["honour", "honor"],
    ["honours", "honors"],
    ["honoured", "honored"],
    ["honouring", "honoring"],
    ["honourable", "honorable"],
  ]),
  family("flavour", [
    ["flavour", "flavor"],
    ["flavours", "flavors"],
    ["flavoured", "flavored"],
    ["flavouring", "flavoring"],
    ["flavourful", "flavorful"],
  ]),
  family("humour", [
    ["humour", "humor"],
    ["humours", "humors"],
    ["humoured", "humored"],
    ["humouring", "humoring"],
  ]),
  family("practise", [
    ["practise", "practice", false],
    ["practised", "practiced", false],
    ["practises", "practices", false],
    ["practising", "practicing", false],
  ]),
  family("tyre", [
    ["tyre", "tire"],
    ["tyres", "tires"],
  ]),
  family("sceptic", [
    ["sceptic", "skeptic"],
    ["sceptics", "skeptics"],
    ["sceptical", "skeptical"],
    ["scepticism", "skepticism"],
  ]),
  family("storey", [
    ["storey", "story"],
    ["storeys", "stories"],
  ]),
  family("draught", [
    ["draught", "draft"],
    ["draughts", "drafts"],
  ]),
  family("plough", [
    ["plough", "plow"],
    ["ploughs", "plows"],
    ["ploughed", "plowed"],
    ["ploughing", "plowing"],
  ]),
  family("enrol", [
    ["enrol", "enroll"],
    ["enrols", "enrolls"],
    ["enrolment", "enrollment"],
    ["enrolments", "enrollments"],
  ]),
  family("fulfil", [
    ["fulfil", "fulfill"],
    ["fulfils", "fulfills"],
    ["fulfilment", "fulfillment"],
    ["fulfilments", "fulfillments"],
  ]),
  family("instalment", [
    ["instalment", "installment"],
    ["instalments", "installments"],
  ]),
  family("skilful", [
    ["skilful", "skillful"],
    ["skilfully", "skillfully"],
  ]),
  family("jewellery", [["jewellery", "jewelry"]]),
  family("mould", [
    ["mould", "mold"],
    ["moulds", "molds"],
    ["moulded", "molded"],
    ["moulding", "molding"],
  ]),
  family("moustache", [
    ["moustache", "mustache"],
    ["moustaches", "mustaches"],
  ]),
  family("pyjamas", [["pyjamas", "pajamas"]]),
  family("sulphur", [["sulphur", "sulfur"]]),
  family("tonne", [
    ["tonne", "ton", false],
    ["tonnes", "tons", false],
  ]),
  family("whisky", [
    ["whisky", "whiskey", false],
    ["whiskies", "whiskeys", false],
  ]),
  family("ageing", [["ageing", "aging"]]),
  family("dialogue", [
    ["dialogue", "dialog", false],
    ["dialogues", "dialogs", false],
  ]),
  family("encyclopaedia", [
    ["encyclopaedia", "encyclopedia"],
    ["encyclopaedias", "encyclopedias"],
  ]),
  family("manoeuvre", [
    ["manoeuvre", "maneuver"],
    ["manoeuvres", "maneuvers"],
    ["manoeuvred", "maneuvered"],
    ["manoeuvring", "maneuvering"],
  ]),
  family("paediatric", [
    ["paediatric", "pediatric"],
    ["paediatrics", "pediatrics"],
  ]),
  family("oesophagus", [["oesophagus", "esophagus"]]),
  family("anaemia", [["anaemia", "anemia"]]),
  family("foetus", [
    ["foetus", "fetus"],
    ["foetuses", "fetuses"],
  ]),
  family("kerb", [
    ["kerb", "curb"],
    ["kerbs", "curbs"],
  ]),
  family("cosy", [
    ["cosy", "cozy"],
    ["cosier", "cozier"],
    ["cosiest", "coziest"],
  ]),
  family("doughnut", [
    ["doughnut", "donut", false],
    ["doughnuts", "donuts", false],
  ]),
  family("gaol", [
    ["gaol", "jail"],
    ["gaols", "jails"],
  ]),
  family("pretence", [["pretence", "pretense"]]),
  family("offence", [
    ["offence", "offense"],
    ["offences", "offenses"],
  ]),
  family("speciality", [
    ["speciality", "specialty"],
    ["specialities", "specialties"],
  ]),
  family("aeroplane", [
    ["aeroplane", "airplane"],
    ["aeroplanes", "airplanes"],
  ]),
];

/** Documented as inert: none of these ever match a WORD_FAMILIES entry
 * under \b(word)\b matching, so this is a no-op safety net, not load
 * bearing logic. See the header comment for the boundary-matching
 * argument. */
const GLOBAL_ALLOW_WORDS = new Set(
  [
    "analyser",
    "analysers",
    "echocancellation",
    "labelledby",
    "programmer",
    "programmers",
    "programming",
    "programmed",
    "license_skus",
    "configlicenseskus",
  ].map((w) => w.toLowerCase()),
);

/**
 * Per-file whole-word allowances. `test` matches against the repo relative
 * path with forward slashes. `words` are lowercase whole words that are
 * never flagged in a matching file, even though they are real hits of a
 * WORD_FAMILIES entry elsewhere in the repo.
 */
/**
 * Files exempted in full, the same way a meta.ts `synonyms`/`searchTerms`
 * array is exempted, because the whole file is a curated non-US spelling
 * data set rather than prose: src/lib/search-synonyms.ts holds "colour",
 * "grey", and friends as deliberate search index keys (its own header
 * comment says as much and asks this script to exempt it), and its object
 * literal shape (`export const NAME: ... = { ... }`) is not the flat
 * `synonyms: [...]` array shape stripSearchAliasArrays understands. This
 * script cannot edit files under src/, so the exemption lives here instead
 * of as a per-line marker comment in that file.
 */
const WHOLE_FILE_ALLOWLIST = new Set(["src/lib/search-synonyms.ts"]);

const PER_FILE_ALLOWLIST = [
  {
    // chart-maker accepts "doughnut" as an input alias for the donut type;
    // the map entry and its test assert the alias itself.
    test: (p) => p.startsWith("src/tools/chart-maker/"),
    words: ["doughnut", "Doughnut"],
  },
  {
    test: (p) => p.startsWith("src/tools/color-picker/"),
    words: [
      "grey",
      "greys",
      "greyed",
      "greyish",
      "darkgrey",
      "dimgrey",
      "lightgrey",
      "slategrey",
      "darkslategrey",
      "lightslategrey",
    ],
  },
  {
    test: (p) =>
      p === "src/tools/resistor-color-code-calculator/index.ts" ||
      p === "src/tools/resistor-color-code-calculator/index.test.ts",
    words: ["grey"],
  },
  {
    test: (p) => p === "src/tools/password-generator/wordlist.ts",
    words: ["greyhound", "greys"],
  },
  {
    test: (p) => p.startsWith("src/tools/gam-command-builder/"),
    words: ["license_skus", "configlicenseskus"],
  },
];

// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One compiled regex per family (per the "precompile one combined regex per
 * family" requirement), plus a lookup map from lowercase matched form to its
 * american replacement and fixability, so a single alternation match can be
 * resolved back to the right suggestion.
 */
const COMPILED_FAMILIES = WORD_FAMILIES.map(({ name, pairs }) => {
  const forms = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const alternation = forms.map((p) => escapeRegex(p[0])).join("|");
  const regex = new RegExp(`\\b(?:${alternation})\\b`, "gi");
  const lookup = new Map(pairs.map(([b, a, fixable = true]) => [b, { american: a, fixable }]));
  return { name, regex, lookup };
});

/** Applies the case pattern of `matched` to `target`. Returns unambiguous:
 * false when the case pattern is neither all lower, all upper, nor a
 * leading capital, since --fix must skip anything it cannot preserve case
 * for cleanly. */
function applyCase(matched, target) {
  if (matched === matched.toLowerCase()) {
    return { text: target, unambiguous: true };
  }
  if (matched === matched.toUpperCase()) {
    return { text: target.toUpperCase(), unambiguous: true };
  }
  const leadingCapital = matched[0].toUpperCase() + matched.slice(1).toLowerCase();
  if (matched === leadingCapital) {
    return { text: target[0].toUpperCase() + target.slice(1), unambiguous: true };
  }
  return { text: target, unambiguous: false };
}

/** Blanks out the contents of top level `synonyms: [...]` / `searchTerms:
 * [...]` array literals, preserving length and newlines so line/col stay
 * accurate for everything else in the file. Bracket-depth scan, see the
 * header comment for the documented limitation. */
function stripSearchAliasArrays(content) {
  const keyPattern = /\b(synonyms|searchTerms)\s*:\s*\[/g;
  let result = content;
  let match;
  keyPattern.lastIndex = 0;
  while ((match = keyPattern.exec(content))) {
    const openBracket = match.index + match[0].length - 1;
    let depth = 1;
    let i = openBracket + 1;
    for (; i < content.length && depth > 0; i++) {
      if (content[i] === "[") depth++;
      else if (content[i] === "]") depth--;
    }
    const closeBracket = i - 1;
    const inner = content.slice(openBracket + 1, closeBracket);
    const blanked = inner.replace(/[^\n]/g, " ");
    result = result.slice(0, openBracket + 1) + blanked + result.slice(closeBracket);
  }
  return result;
}

/** Precomputed line-start byte offsets for fast index -> {line, col}. */
function buildLineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
}

/**
 * Scans one file's content for British spellings. `relPath` is the repo
 * relative path with forward slashes, used for the marker comment line
 * lookup, the per-file allowlist, and reporting.
 */
function scanContent(relPath, content) {
  if (WHOLE_FILE_ALLOWLIST.has(relPath)) return [];

  const allowedWords = new Set(GLOBAL_ALLOW_WORDS);
  for (const rule of PER_FILE_ALLOWLIST) {
    if (rule.test(relPath)) {
      for (const w of rule.words) allowedWords.add(w.toLowerCase());
    }
  }

  const markerLines = new Set();
  const rawLines = content.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    if (rawLines[i].includes("spelling: allow")) markerLines.add(i + 1);
  }

  const scanText = stripSearchAliasArrays(content);
  const lineStarts = buildLineStarts(content);

  const hits = [];
  for (const { name, regex, lookup } of COMPILED_FAMILIES) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(scanText))) {
      const matched = m[0];
      const lower = matched.toLowerCase();
      if (allowedWords.has(lower)) continue;
      const entry = lookup.get(lower);
      if (!entry) continue;
      const { line, col } = offsetToLineCol(lineStarts, m.index);
      if (markerLines.has(line)) continue;
      const cased = applyCase(matched, entry.american);
      hits.push({
        file: relPath,
        line,
        col,
        index: m.index,
        length: matched.length,
        word: matched,
        suggestion: cased.text,
        family: name,
        fixable: entry.fixable && cased.unambiguous,
      });
    }
  }
  hits.sort((a, b) => a.line - b.line || a.col - b.col);
  return hits;
}

/** Applies fixable hits to `content`, returning the rewritten string. Hits
 * are applied back to front so earlier offsets stay valid. */
function applyFixes(content, hits) {
  const fixable = hits.filter((h) => h.fixable).sort((a, b) => b.index - a.index);
  let result = content;
  for (const h of fixable) {
    result = result.slice(0, h.index) + h.suggestion + result.slice(h.index + h.length);
  }
  return result;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "public", "mc-pipeline", "_generated"]);
const SKIP_EXTENSIONS = new Set([".lock", ".csv", ".json"]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".astro",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".html",
  ".txt",
  ".yml",
  ".yaml",
  ".sh",
  ".ps1",
]);

function isLikelyBinary(buffer) {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function shouldScanFile(absPath) {
  // This script is its own dictionary: WORD_FAMILIES necessarily holds the
  // British spellings as literal string data, and the header comment names
  // some of them as examples of what the tool checks for. Neither is a
  // spelling mistake in prose, so the file skips scanning itself.
  if (absPath === SELF_PATH) return false;
  const ext = extname(absPath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  if (!TEXT_EXTENSIONS.has(ext)) return false;
  return true;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(abs, out);
    } else if (entry.isFile()) {
      if (shouldScanFile(abs)) out.push(abs);
    }
  }
}

function discoverFiles() {
  const files = [];
  for (const dir of ["src", "worker", "scripts", "docs"]) {
    walk(join(ROOT, dir), files);
  }
  let rootEntries;
  try {
    rootEntries = readdirSync(ROOT, { withFileTypes: true });
  } catch {
    rootEntries = [];
  }
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(join(ROOT, entry.name));
    }
  }
  return files;
}

function readSafely(absPath) {
  let buffer;
  try {
    buffer = readFileSync(absPath);
  } catch {
    return null;
  }
  if (isLikelyBinary(buffer)) return null;
  return buffer.toString("utf8");
}

function toRelPath(absPath) {
  return relative(ROOT, absPath).split("\\").join("/");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printList() {
  for (const { name, pairs } of WORD_FAMILIES) {
    console.log(name);
    for (const [british, american, fixable = true] of pairs) {
      console.log(`  ${british} -> ${american}${fixable ? "" : "  (flag only)"}`);
    }
  }
}

function printReport(allHits, fixedCount) {
  const fixing = fixedCount !== undefined;

  if (allHits.length === 0) {
    if (fixing) {
      console.log(`check-spelling: fixed ${fixedCount} hit(s) automatically. No hits remain.`);
    } else {
      console.log("check-spelling: no British spellings found.");
    }
    return 0;
  }

  for (const h of allHits) {
    console.log(`${h.file}:${h.line}:${h.col}  ${h.word} -> ${h.suggestion}`);
  }

  const byWord = new Map();
  const byFile = new Map();
  let fixableCount = 0;
  for (const h of allHits) {
    byWord.set(h.family, (byWord.get(h.family) ?? 0) + 1);
    byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
    if (h.fixable) fixableCount++;
  }

  console.log("");
  console.log("Hits per word family:");
  for (const [word, count] of [...byWord.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${word}: ${count}`);
  }

  console.log("");
  console.log("Top files:");
  for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${count}  ${file}`);
  }

  console.log("");
  if (!fixing) {
    console.log(
      `check-spelling: ${allHits.length} hit(s) across ${byFile.size} file(s), ` +
        `${fixableCount} auto-fixable with --fix.`,
    );
  } else {
    console.log(`check-spelling: fixed ${fixedCount} hit(s) automatically.`);
    console.log(
      `${allHits.length} hit(s) remain and need a manual look (flag-only families or ambiguous case).`,
    );
  }

  return 1;
}

function runScan(targetFiles) {
  const allHits = [];
  for (const absPath of targetFiles) {
    const content = readSafely(absPath);
    if (content === null) continue;
    const relPath = toRelPath(absPath);
    const hits = scanContent(relPath, content);
    allHits.push(...hits);
  }
  return allHits;
}

function runFix(targetFiles) {
  let fixedCount = 0;
  const remainingHits = [];
  for (const absPath of targetFiles) {
    const content = readSafely(absPath);
    if (content === null) continue;
    const relPath = toRelPath(absPath);
    const hits = scanContent(relPath, content);
    if (hits.length === 0) continue;
    const fixableHits = hits.filter((h) => h.fixable);
    let finalContent = content;
    if (fixableHits.length > 0) {
      finalContent = applyFixes(content, hits);
      writeFileSync(absPath, finalContent, "utf8");
      fixedCount += fixableHits.length;
    }
    if (fixableHits.length !== hits.length) {
      // Re-scan the written content rather than reusing the pre-fix `hits`:
      // a fixed word can change length, which shifts the column of a later
      // flag-only or ambiguous-case hit on the same line.
      remainingHits.push(...scanContent(relPath, finalContent));
    }
  }
  return { fixedCount, remainingHits };
}

function parseArgs(argv) {
  const fix = argv.includes("--fix");
  const list = argv.includes("--list");
  const selfTest = argv.includes("--self-test");
  const filesIdx = argv.indexOf("--files");
  let files = null;
  if (filesIdx !== -1) {
    files = [];
    for (let i = filesIdx + 1; i < argv.length; i++) {
      if (argv[i].startsWith("--")) break;
      files.push(argv[i]);
    }
  }
  return { fix, list, selfTest, files };
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------

function assertHits(label, relPath, content, expectedWords, failures) {
  const hits = scanContent(relPath, content).map((h) => h.word.toLowerCase());
  const expected = [...expectedWords].sort();
  const actual = [...hits].sort();
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (!ok) {
    failures.push(`${label}: expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
  }
}

function runSelfTest() {
  const failures = [];

  assertHits(
    "basic detection",
    "src/example.ts",
    "The colour is nice and the centre holds.",
    ["colour", "centre"],
    failures,
  );

  {
    const hits = scanContent("src/example.ts", "Colour and COLOUR and colour");
    const suggestions = hits.map((h) => h.suggestion);
    if (JSON.stringify(suggestions) !== JSON.stringify(["Color", "COLOR", "color"])) {
      failures.push(`case preservation: got ${JSON.stringify(suggestions)}`);
    }
  }

  assertHits(
    "marker comment suppresses the whole line",
    "src/example.ts",
    "const colourWord = 'colour'; // spelling: allow\nconst x = 'colour';",
    ["colour"],
    failures,
  );

  assertHits(
    "synonyms array is stripped, code around it (including keywords) is not",
    "src/tools/foo/meta.ts",
    'export const meta = {\n  name: "colour",\n  synonyms: ["colour", "grey", "centre"],\n  keywords: ["colour palette"],\n};',
    ["colour", "colour"],
    failures,
  );

  {
    const content =
      'export const meta = {\n  name: "colour",\n  synonyms: ["colour", "grey"],\n  searchTerms: ["neighbour"],\n};';
    const hits = scanContent("src/tools/foo/meta.ts", content).map((h) => h.word.toLowerCase());
    if (hits.length !== 1 || hits[0] !== "colour") {
      failures.push(
        `array stripping: expected only the meta.name colour hit, got [${hits.join(", ")}]`,
      );
    }
  }

  assertHits(
    "compound identifiers are never false positives",
    "src/tools/audio-recorder/index.ts",
    "const node: AnalyserNode = createAnalyser(); node.echoCancellation = true;",
    [],
    failures,
  );

  assertHits(
    "aria-labelledby is not flagged",
    "src/components/Foo.vue",
    '<div aria-labelledby="foo-label"></div>',
    [],
    failures,
  );

  assertHits(
    "programmer/programming/programmed are not flagged, programme is",
    "src/tools/foo/index.ts",
    "A skilled programmer wrote this programme while programming and programmed carefully.",
    ["programme"],
    failures,
  );

  assertHits(
    "camelCase identifiers built on neighbour are not flagged, prose is",
    "src/tools/minecraft-crop-growth-calculator/data.ts",
    '{"speedNeighbourDivisor": 4, "neighbourFarmland": 8} // No neighbouring plant, and the neighbours help.',
    ["neighbouring", "neighbours"],
    failures,
  );

  assertHits(
    "grey is allowed in color-picker but not elsewhere",
    "src/tools/color-picker/index.ts",
    'export const COLORS = { grey: "#808080", darkgrey: "#a9a9a9" };',
    [],
    failures,
  );
  assertHits(
    "grey is flagged outside the allowlisted folders",
    "src/tools/some-other-tool/index.ts",
    "The result is a flat grey.",
    ["grey"],
    failures,
  );

  assertHits(
    "resistor-color-code-calculator allows grey but not other tools",
    "src/tools/resistor-color-code-calculator/index.ts",
    "const COLOR_INFO = { grey: { digit: 8 } };",
    [],
    failures,
  );

  assertHits(
    "password-generator wordlist allows greyhound and greys",
    "src/tools/password-generator/wordlist.ts",
    'export const WORDS = ["greyhound", "greys"];',
    [],
    failures,
  );

  assertHits(
    "search-synonyms.ts is exempted in full, including its doc comment",
    "src/lib/search-synonyms.ts",
    '// Non US spellings are deliberate KEYS here (colour, grey, centre, licence, analyse).\nexport const SEARCH_SYNONYMS = { colour: ["color"], grey: ["gray"] };',
    [],
    failures,
  );

  {
    const hits = scanContent("src/example.ts", "cOlOuR is a strange way to write it.");
    if (hits.length !== 1 || hits[0].fixable !== false) {
      failures.push(`ambiguous case: expected one non-fixable hit, got ${JSON.stringify(hits)}`);
    }
  }

  {
    const hits = scanContent("src/example.ts", "We drank a tonne of whisky and ate a doughnut.");
    const flagOnly = hits.every((h) => h.fixable === false);
    const words = hits.map((h) => h.word).sort();
    if (!flagOnly || JSON.stringify(words) !== JSON.stringify(["doughnut", "tonne", "whisky"])) {
      failures.push(
        `flag-only families: got ${JSON.stringify(hits.map((h) => [h.word, h.fixable]))}`,
      );
    }
  }

  {
    const content = "The colour is nice.\nWe practise practising here.";
    const hits = scanContent("src/example.ts", content);
    const fixed = applyFixes(content, hits);
    const expected = "The color is nice.\nWe practise practising here.";
    if (fixed !== expected) {
      failures.push(
        `applyFixes: expected ${JSON.stringify(expected)}, got ${JSON.stringify(fixed)}`,
      );
    }
  }

  {
    const content = "line one\nline two has a colour word here\nline three";
    const hits = scanContent("src/example.ts", content);
    if (hits.length !== 1 || hits[0].line !== 2 || hits[0].col !== 16) {
      failures.push(`line/col computation: got ${JSON.stringify(hits)}`);
    }
  }

  if (failures.length > 0) {
    console.error("check-spelling --self-test: FAILED");
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log("check-spelling --self-test: all assertions passed.");
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { fix, list, selfTest, files } = parseArgs(process.argv.slice(2));

  if (selfTest) {
    process.exit(runSelfTest());
  }

  if (list) {
    printList();
    process.exit(0);
  }

  const targetFiles = files
    ? files.map((f) => (isAbsolute(f) ? f : join(process.cwd(), f)))
    : discoverFiles();

  if (fix) {
    const { fixedCount, remainingHits } = runFix(targetFiles);
    process.exit(printReport(remainingHits, fixedCount));
  }

  const allHits = runScan(targetFiles);
  const exitCode = printReport(allHits);
  process.exit(exitCode);
}

main();
