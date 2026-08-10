// Bring up a real headless dedicated server for a version, with RCON on, a
// superflat void-ish world, and no structures, then hand back an Rcon client.
// The eula=true write below is the Mojang EULA acceptance for local harness
// use; disclosed in docs/minecraft-tools-plan.md.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORK, ensureDir, ensureJdk, versionJson } from "./common.mjs";
import { Rcon } from "./rcon.mjs";

const RCON_PASS = "mc-pipeline";

function serverProperties(id, rconPort, gamePort) {
  // level-type syntax changed: pre-1.18 wants "flat", 1.18+ "minecraft:flat"
  // (escaped colon in .properties). Old versions ignore unknown keys, so the
  // rest is shared. Colons in .properties values must be escaped.
  const [maj, min] = id.startsWith("1.")
    ? id.split(".").map(Number).slice(0, 2)
    : [99, 0];
  const modern = maj > 1 || min >= 18;
  return [
    `level-type=${modern ? "minecraft\\:flat" : "flat"}`,
    "generate-structures=false",
    // spawn-monsters must stay true: false removes SUMMONED hostile mobs the
    // way peaceful does. Natural spawning is disabled per run via
    // "gamerule doMobSpawning false" instead.
    "spawn-monsters=true",
    "online-mode=false",
    "enable-rcon=true",
    `rcon.port=${rconPort}`,
    `rcon.password=${RCON_PASS}`,
    `server-port=${gamePort}`,
    "view-distance=4",
    "simulation-distance=4",
    "spawn-protection=0",
    "max-players=1",
    "enable-command-block=true",
    "sync-chunk-writes=false",
    // The watchdog kills the server when one tick runs long. Harness runs do
    // exactly that on purpose (tick sprint, high random tick speed) and get
    // starved when several versions run side by side, so it is turned off:
    // a server that shoots itself mid-measurement loses the whole run.
    "max-tick-time=-1",
    "level-name=world",
    "motd=mc-pipeline harness",
  ].join("\n");
}

/**
 * Start the server for a version (first run generates the world), wait for
 * RCON to accept, and return { rcon, stop }. stop() shuts the server down
 * cleanly via the "stop" command and waits for process exit.
 */
export async function startServer(id, { timeoutMs = 180000, slot = 0 } = {}) {
  const rconPort = 25575 + slot * 2;
  const gamePort = 25599 + slot * 2;
  const m = JSON.parse(
    (await import("node:fs")).readFileSync(
      join(WORK, "version_manifest_v2.json"),
      "utf8",
    ),
  );
  const v = await versionJson(m, id);
  const java = await ensureJdk(v.javaVersion?.majorVersion ?? 8);
  const dir = ensureDir(join(WORK, id, "server"));
  writeFileSync(join(dir, "eula.txt"), "eula=true\n");
  writeFileSync(
    join(dir, "server.properties"),
    serverProperties(id, rconPort, gamePort) + "\n",
  );
  const jar = join(WORK, id, "server.jar");
  if (!existsSync(jar)) throw new Error(`${jar} missing; run 01-download.mjs ${id}`);

  const proc = spawn(java, ["-Xmx2G", "-Xms512M", "-jar", jar, "nogui"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));

  const deadline = Date.now() + timeoutMs;
  let rcon;
  while (!rcon) {
    if (proc.exitCode !== null)
      throw new Error(`server ${id} exited early:\n${log.slice(-4000)}`);
    if (Date.now() > deadline)
      throw new Error(`server ${id} rcon timeout:\n${log.slice(-4000)}`);
    if (/RCON running/i.test(log) || /Thread RCON Listener started/i.test(log)) {
      try {
        rcon = await Rcon.connect("127.0.0.1", rconPort, RCON_PASS, 5000);
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const stop = async () => {
    try {
      await rcon.cmd("stop");
    } catch {
      proc.kill();
    }
    rcon.close();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 30000);
      proc.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };
  return { rcon, stop, logTail: () => log.slice(-4000) };
}
