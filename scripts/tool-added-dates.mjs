/**
 * tool-added-dates.mjs
 *
 * Writes src/tools/added-dates.ts: the date each tool first landed, so the
 * homepage can put a "New" badge on the ones that shipped recently.
 *
 * The date comes from git, not from a hand-kept field in meta.ts, because a
 * hand-kept field is one more thing to forget. For every `src/tools/<slug>/`
 * that has a `meta.ts`, this runs:
 *
 *   git log --diff-filter=A --format=%aI --follow -- src/tools/<slug>/meta.ts
 *
 * and keeps the OLDEST addition, which is the commit that introduced the tool.
 * `--follow` is what makes a renamed slug keep its original date instead of
 * looking brand new, and it is also why this is one git call per tool rather
 * than one call for the whole tree: `--follow` only accepts a single path.
 *
 * The output is a checked-in snapshot, not a build step. Nothing in the site
 * build runs this; git history is not available in every deploy environment and
 * a badge is not worth making the build depend on it. Re-run it by hand after
 * adding tools:
 *
 *   node scripts/tool-added-dates.mjs           write the file
 *   node scripts/tool-added-dates.mjs --check   exit 1 if the file is stale
 *
 * Dates are stored as plain `YYYY-MM-DD` (author date, the local date of the
 * commit that added the tool). Day granularity is all a 30 day badge needs, and
 * it keeps the diff quiet when the file is regenerated.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_DIR = path.join(ROOT, "src", "tools");
const OUT_FILE = path.join(TOOLS_DIR, "added-dates.ts");

/** Directories under src/tools that are not tools. */
const SKIP = new Set(["_generated"]);

/** How many git processes to keep in flight. */
const CONCURRENCY = 8;

/** Every tool slug that has a meta.ts, sorted, so the output is stable. */
async function toolSlugs() {
  const entries = await readdir(TOOLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
    .map((entry) => entry.name)
    .filter((slug) => existsSync(path.join(TOOLS_DIR, slug, "meta.ts")))
    .sort();
}

function git(args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: ROOT, maxBuffer: 1 << 20 }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

/** The `YYYY-MM-DD` a tool's meta.ts was first committed, or null. */
async function addedDate(slug) {
  const stdout = await git([
    "log",
    "--diff-filter=A",
    "--format=%aI",
    "--follow",
    "--",
    `src/tools/${slug}/meta.ts`,
  ]);
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // git log is newest first, so the introducing commit is the last line.
  const oldest = lines[lines.length - 1];
  const day = oldest?.slice(0, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Run `worker` over `items` with a bounded number in flight. */
async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * A key written the way Prettier writes it (quoteProps "as-needed"), so
 * `npm run format` never fights this script and `--check` stays honest.
 */
function key(slug) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(slug) ? slug : JSON.stringify(slug);
}

function render(pairs) {
  const body = pairs.map(([slug, date]) => `  ${key(slug)}: ${JSON.stringify(date)},`);
  return `/**
 * When each tool first landed, as a plain YYYY-MM-DD date.
 *
 * GENERATED FILE. Do not edit by hand: run \`node scripts/tool-added-dates.mjs\`
 * after adding tools. The dates come from the git commit that introduced each
 * tool's meta.ts, so they survive a slug rename.
 *
 * Read it through src/lib/tool-dates.ts, which is where the "is this new"
 * question is answered. A tool missing from this map is simply never new,
 * which is the right answer for one that has not been committed yet.
 */
export const ADDED_DATES: Record<string, string> = {
${body.join("\n")}
};
`;
}

async function main() {
  const check = process.argv.includes("--check");
  const slugs = await toolSlugs();
  const dates = await pool(slugs, addedDate);

  const pairs = [];
  const missing = [];
  for (let i = 0; i < slugs.length; i++) {
    if (dates[i]) pairs.push([slugs[i], dates[i]]);
    else missing.push(slugs[i]);
  }

  const next = render(pairs);
  const current = existsSync(OUT_FILE) ? await readFile(OUT_FILE, "utf8") : "";

  if (check) {
    if (current === next) {
      console.log(`added-dates.ts is up to date (${pairs.length} tools).`);
      return;
    }
    console.error("added-dates.ts is stale. Run: node scripts/tool-added-dates.mjs");
    process.exitCode = 1;
    return;
  }

  if (current !== next) await writeFile(OUT_FILE, next, "utf8");
  console.log(
    `${current === next ? "unchanged" : "wrote"} src/tools/added-dates.ts: ${pairs.length} tools`,
  );
  if (missing.length) {
    console.log(`  not committed yet, omitted: ${missing.join(", ")}`);
  }
}

await main();
