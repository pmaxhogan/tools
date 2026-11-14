/**
 * `npm run check`: everything CI gates on, run at the same time.
 *
 * CI used to run lint, typecheck, test and build one after another on a
 * runner with four cores, most of which sat idle: eslint, astro check and
 * vue-tsc are each a single thread. Running them side by side on the same
 * runner finishes sooner and bills fewer minutes, with every check still
 * running in full.
 *
 * The list of what to run is not written down here. It is read from
 * package.json: `lint`, `typecheck`, `test` and `build` are expanded, and a
 * script whose whole body is `npm run a && npm run b` is replaced by its
 * parts so those can overlap too. Add a step to `lint` and CI picks it up; a
 * second hand-kept list would be one more thing to forget, and the failure
 * would be silent.
 *
 * Every task runs to the end even after one fails, so a single run reports
 * every problem. Output is buffered per task and printed whole when the task
 * finishes, so logs never interleave. The exit code is 1 if any task failed.
 *
 * One ordering rule, on small machines only. The test run uses every core by
 * itself. Started alongside two type checkers and the build on the runner's
 * four cores, all four ran about three times slower than alone and the step
 * took 144s. So with four cores or fewer, the tests wait until at most one
 * other task is still going. Nothing is skipped: it is the same work in a
 * better order. With more cores than that, everything starts at once.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scripts = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).scripts;

/** The scripts CI gates on. Composite ones are expanded into their parts. */
const ENTRY = ["lint", "typecheck", "test", "build"];

/** `npm run a && npm run b` and nothing else. */
const CHAIN = /^npm run [\w:-]+(?:\s*&&\s*npm run [\w:-]+)*$/;

function expand(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`check: npm script "${name}" refers to itself`);
  const body = scripts[name];
  if (body === undefined) throw new Error(`check: package.json has no "${name}" script`);
  if (!CHAIN.test(body.trim())) return [name];
  const next = new Set(seen).add(name);
  return body.split("&&").flatMap((part) => expand(part.trim().slice("npm run ".length), next));
}

const tasks = [...new Set(ENTRY.flatMap((name) => expand(name)))];

const inActions = process.env.GITHUB_ACTIONS === "true";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" };

/** Run one command with its output buffered. Resolves, never rejects. */
function run(cmd, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    const child = spawn(cmd, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ code: 1, out: `${out}\n${err.message}`, secs: 0 }));
    child.on("close", (code, signal) =>
      resolve({
        // A task killed by a signal has no exit code. That is a failure.
        code: code ?? 1,
        out: signal ? `${out}\nkilled by ${signal}` : out,
        secs: (Date.now() - started) / 1000,
      }),
    );
  });
}

function report(name, { code, out, secs }) {
  const title = `${name}: ${code === 0 ? "ok" : `FAILED (exit ${code})`} in ${secs.toFixed(1)}s`;
  // A passing task folds away in the Actions log. A failing one stays open.
  const fold = inActions && code === 0;
  console.log(fold ? `::group::${title}` : `\n== ${title}`);
  if (out.trim()) console.log(out.trimEnd());
  if (fold) console.log("::endgroup::");
}

const t0 = Date.now();

// astro check, astro build and vue-tsc all read .astro/types.d.ts, and the
// first two also write it. Generate it once up front so nothing reads a file
// that another task is halfway through writing.
const sync = await run(process.execPath, ["node_modules/astro/bin/astro.mjs", "sync"]);
if (sync.code !== 0) {
  report("astro sync", sync);
  process.exit(1);
}

/** Tasks that keep every core busy on their own. */
const WIDE = new Set(["test"]);
const cores = availableParallelism();
const crowded = cores <= 4;
const waits = crowded ? tasks.filter((name) => WIDE.has(name)) : [];

console.log(
  `check: ${cores} cores, ${(totalmem() / 2 ** 30).toFixed(1)} GB. Running ${tasks.join(", ")}` +
    (waits.length ? ` (${waits.join(", ")} after the others thin out)` : ""),
);

// Resolves once at most one task that started straight away is still running.
let running = tasks.length - waits.length;
let thinned;
const thinnedOut = new Promise((resolve) => (thinned = resolve));
if (running <= 1) thinned();

const results = await Promise.all(
  tasks.map(async (name) => {
    const waited = waits.includes(name);
    if (waited) await thinnedOut;
    const result = await run(npm, ["run", "--silent", name]);
    if (!waited && --running <= 1) thinned();
    report(name, result);
    return { name, ...result };
  }),
);

const width = Math.max(...results.map((r) => r.name.length));
console.log("");
for (const r of results) {
  console.log(`${r.code === 0 ? "ok  " : "FAIL"}  ${r.name.padEnd(width)}  ${r.secs.toFixed(1)}s`);
}
const failed = results.filter((r) => r.code !== 0);
const wall = ((Date.now() - t0) / 1000).toFixed(1);
const sum = results.reduce((total, r) => total + r.secs, 0).toFixed(1);
console.log(`check: ${wall}s wall for ${sum}s of work`);

// The Actions run page shows this table without anyone opening the log.
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(
    (r) => `| ${r.code === 0 ? "ok" : "FAILED"} | ${r.name} | ${r.secs.toFixed(1)}s |`,
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "| | check | time |",
      "| --- | --- | --- |",
      ...rows,
      "",
      `${wall}s wall for ${sum}s of work.`,
      "",
    ].join("\n"),
  );
}

if (failed.length) {
  console.error(`check: ${failed.length} failed: ${failed.map((f) => f.name).join(", ")}`);
  if (inActions) {
    for (const f of failed)
      console.log(`::error title=${f.name} failed::npm run ${f.name} exited ${f.code}`);
  }
  process.exit(1);
}
