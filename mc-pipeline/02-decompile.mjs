// Produce readable reference source for a version under work/<id>/src/.
// Mapped versions (official mappings present): extract the real server jar
// from the bundler, remap obfuscated names to Mojang names with Reconstruct,
// then decompile with Vineflower. Unobfuscated versions (26.1+) skip the
// remap. Source trees are reference-only and never committed.
// Usage: node mc-pipeline/02-decompile.mjs <versionId> [more ...]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  WORK,
  download,
  ensureDir,
  ensureJdk,
  fetchJson,
  manifest,
  versionJson,
} from "./lib/common.mjs";

const TOOLS = join(WORK, "tools");

async function githubLatestJar(repo, match) {
  // Reuse a previously downloaded jar before touching the GitHub API, and
  // retry the API call: transient socket closes killed a five-version run.
  const cached = existsSync(TOOLS)
    ? readdirSync(TOOLS).find((f) => match.test(f))
    : null;
  if (cached) return join(TOOLS, cached);
  let rel;
  for (let attempt = 1; ; attempt++) {
    try {
      rel = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  const asset = rel.assets.find((a) => match.test(a.name));
  if (!asset) throw new Error(`no asset matching ${match} in ${repo}`);
  const dest = join(TOOLS, asset.name);
  await download(asset.browser_download_url, dest);
  return dest;
}

/** The server jar is a bundler since 1.18: the real jar is nested inside. */
function innerServerJar(id, java) {
  const dir = join(WORK, id);
  const jar = join(dir, "server.jar");
  const listing = execFileSync(
    java.replace(/java\.exe$/, "jar.exe"),
    ["tf", jar],
    { maxBuffer: 64 * 1024 * 1024 },
  ).toString();
  const inner = listing
    .split(/\r?\n/)
    .find((l) => /^META-INF\/versions\/.+\/server-.+\.jar$/.test(l));
  if (!inner) return jar; // pre-bundler era: the jar IS the server
  const out = join(dir, "server-inner.jar");
  if (!existsSync(out)) {
    execFileSync(
      java.replace(/java\.exe$/, "jar.exe"),
      ["xf", jar, inner],
      { cwd: dir },
    );
    const extracted = join(dir, ...inner.split("/"));
    execFileSync("cmd", ["/c", "copy", "/y", extracted, out], { stdio: "ignore" });
  }
  return out;
}

const ids = process.argv.slice(2);
if (!ids.length) throw new Error("usage: node mc-pipeline/02-decompile.mjs <id...>");
ensureDir(TOOLS);
const m = await manifest();
const vineflower = await githubLatestJar(
  "Vineflower/vineflower",
  /^vineflower-[\d.]+\.jar$/,
);

for (const id of ids) {
  const v = await versionJson(m, id);
  const java = await ensureJdk(Math.max(v.javaVersion?.majorVersion ?? 8, 17));
  const dir = join(WORK, id);
  const srcOut = join(dir, "src");
  if (existsSync(srcOut) && readdirSync(srcOut).length) {
    console.log(`[${id}] src already present, skipping`);
    continue;
  }
  let jarToDecompile = innerServerJar(id, java);
  if (v.downloads.server_mappings) {
    const remapped = join(dir, "server-remapped.jar");
    if (!existsSync(remapped)) {
      const reconstruct = await githubLatestJar(
        "LXGaming/Reconstruct",
        /^reconstruct-cli-[\d.]+\.jar$/,
      );
      console.log(`[${id}] remapping to Mojang names...`);
      execFileSync(
        java,
        [
          "-jar", reconstruct,
          "--jar", jarToDecompile,
          "--mapping", join(dir, "mappings", "server.txt"),
          "--output", remapped,
          "--agree",
          "--exclude", "com.google.,com.mojang.authlib,io.netty.,it.unimi.,org.apache.,joptsimple.",
        ],
        // cwd matters: Reconstruct writes a logs/ dir into its working dir.
        { stdio: "inherit", cwd: dir },
      );
    }
    jarToDecompile = remapped;
  } else {
    console.log(`[${id}] unobfuscated, decompiling directly`);
  }
  console.log(`[${id}] decompiling with Vineflower (this takes a while)...`);
  ensureDir(srcOut);
  execFileSync(
    java,
    ["-jar", vineflower, "--silent", jarToDecompile, srcOut],
    { stdio: "inherit" },
  );
  console.log(`[${id}] source at ${srcOut}`);
}
