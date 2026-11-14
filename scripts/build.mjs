/**
 * The one build entry point: `npm run build` runs this.
 *
 * Stage 1 runs every prepare-* script in parallel. They are independent by
 * construction: each stages a disjoint subtree of public/ (ffmpeg/, models/ +
 * tesseract/, pyodide/, wawoff2/) and none reads another's output.
 * Stage 2 is `astro build`, which consumes public/ and must see all of it.
 * Stage 3 generates the service worker from dist/, so it runs last.
 *
 * Output from parallel children is buffered per script and printed as each
 * finishes, so logs never interleave mid-line. Any child failing fails the
 * build with that child's output attached.
 *
 * The deploy gate lives here too. Cloudflare Workers Builds runs this script
 * on every push and deploys what it produces, and it does not wait for the
 * GitHub Actions run of the same commit: the two start together and the
 * deploy used to finish first, so a commit that failed CI was already live.
 * Workers Builds has no "wait for CI" setting. So when this script is run by
 * Workers Builds (it sets WORKERS_CI=1), it runs the whole gate instead,
 * `scripts/check.mjs`: lint, both type checkers, the tests, and this build as
 * one of its steps. Anything red fails the build, and a failed build is never
 * deployed. Locally and in GitHub Actions it is just the build.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// TOOLS_GATE_RUNNING marks the build step that check.mjs itself starts, so the
// gate runs once and that inner build is a plain build.
if (process.env.WORKERS_CI === "1" && !process.env.TOOLS_GATE_RUNNING) {
  console.log("build: Workers Builds detected, running the full gate before anything can deploy");
  const gate = spawnSync(process.execPath, ["scripts/check.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TOOLS_GATE_RUNNING: "1" },
  });
  if (gate.status !== 0) {
    console.error("build: the gate failed, so there is nothing to deploy");
  }
  process.exit(gate.status ?? 1);
}

const PREPARE = [
  "scripts/prepare-ffmpeg.mjs",
  "scripts/prepare-models.mjs",
  "scripts/prepare-pyodide.mjs",
  "scripts/prepare-wawoff2.mjs",
];

/** Run one command, buffering stdout+stderr. Resolves with the exit code. */
function run(cmd, args, { buffer = true } = {}) {
  return new Promise((resolve) => {
    // No shell: a shell would re-parse the node path ("C:\Program Files\...")
    // on Windows. Everything invoked here is node itself with a script path.
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: buffer ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let out = "";
    if (buffer) {
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
    }
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

const t0 = Date.now();

// Stage 1: prepares, in parallel.
const results = await Promise.all(
  PREPARE.map(async (script) => {
    const started = Date.now();
    const { code, out } = await run(process.execPath, [script]);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const text = out.trimEnd();
    if (text) console.log(text);
    console.log(`build: ${script} finished in ${secs}s${code === 0 ? "" : ` (exit ${code})`}`);
    return { script, code };
  }),
);
const failed = results.filter((r) => r.code !== 0);
if (failed.length) fail(`prepare step(s) failed: ${failed.map((f) => f.script).join(", ")}`);

// Stage 2: astro build (streams directly; it is the long, chatty step).
// Invoked through node + astro's own bin script so no shell is involved.
{
  const { code } = await run(process.execPath, ["node_modules/astro/bin/astro.mjs", "build"], {
    buffer: false,
  });
  if (code !== 0) fail(`astro build failed with exit ${code}`);
}

// Stage 3: service worker over dist/.
{
  const { code, out } = await run(process.execPath, ["scripts/generate-sw.mjs"]);
  const text = out.trimEnd();
  if (text) console.log(text);
  if (code !== 0) fail(`generate-sw failed with exit ${code}`);
}

console.log(`build: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
