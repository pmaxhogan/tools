// Download every pinned Minecraft version's server jar, official mappings
// when the version publishes them (1.14.4 through 1.21.11; 26.1+ ships
// unobfuscated so the field is simply absent), and the portable Temurin JDK
// each version declares via javaVersion.majorVersion. Re-runs are no-ops for
// verified files. Usage: node mc-pipeline/01-download.mjs [versionId ...]
import { join } from "node:path";
import {
  WORK,
  checkDisk,
  download,
  ensureJdk,
  pinnedVersions,
  versionJson,
} from "./lib/common.mjs";

const only = process.argv.slice(2);
const { manifest: m, ids } = await pinnedVersions();
const targets = only.length ? only : ids;

for (const id of targets) {
  if (!checkDisk()) {
    console.error("[disk] stopping downloads; free space is under 2 GB");
    process.exit(1);
  }
  const v = await versionJson(m, id);
  const dir = join(WORK, id);
  const d = v.downloads;
  console.log(`[${id}] server jar (${(d.server.size / 1048576).toFixed(1)} MB)`);
  await download(d.server.url, join(dir, "server.jar"), d.server.sha1);
  if (d.server_mappings) {
    console.log(`[${id}] official server mappings`);
    await download(
      d.server_mappings.url,
      join(dir, "mappings", "server.txt"),
      d.server_mappings.sha1,
    );
  } else {
    console.log(`[${id}] no mappings published (unobfuscated version)`);
  }
  const major = v.javaVersion?.majorVersion ?? 8;
  const java = await ensureJdk(major);
  console.log(`[${id}] java ${major} ready at ${java}`);
}
console.log(`done: ${targets.join(", ")}`);
