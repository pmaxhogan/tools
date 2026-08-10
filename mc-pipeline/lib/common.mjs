// Shared helpers for the Minecraft pipeline: manifest access, downloads with
// sha1 verification, portable JDK provisioning, and archive extraction.
// Node builtins only. Everything heavy lands under mc-pipeline/work/ which is
// gitignored (jars, mappings, JDKs, decompiled source stay local-only).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const WORK = join(ROOT, "work");
export const VECTORS = join(ROOT, "vectors");

const MANIFEST_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/** Versions pinned for v1, latest release appended dynamically at run time. */
export const PINNED = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11"];

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function fetchJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/** Fetch the version manifest (cached per run under work/). */
export async function manifest() {
  ensureDir(WORK);
  const cache = join(WORK, "version_manifest_v2.json");
  const data = await fetchJson(MANIFEST_URL);
  writeFileSync(cache, JSON.stringify(data));
  return data;
}

/** The pinned set plus whatever the manifest says is the latest release. */
export async function pinnedVersions() {
  const m = await manifest();
  const ids = [...PINNED];
  if (!ids.includes(m.latest.release)) ids.push(m.latest.release);
  return { manifest: m, ids };
}

/** Per-version JSON, cached under work/<id>/version.json. */
export async function versionJson(m, id) {
  const dir = ensureDir(join(WORK, id));
  const cache = join(dir, "version.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const entry = m.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`version ${id} not in manifest`);
  const data = await fetchJson(entry.url);
  writeFileSync(cache, JSON.stringify(data));
  return data;
}

export function sha1(buf) {
  return createHash("sha1").update(buf).digest("hex");
}

/** Download url to dest, verifying sha1 when given. No-op if verified file exists. */
export async function download(url, dest, expectedSha1) {
  if (existsSync(dest)) {
    if (!expectedSha1) return dest;
    if (sha1(readFileSync(dest)) === expectedSha1) return dest;
  }
  ensureDir(dirname(dest));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedSha1 && sha1(buf) !== expectedSha1)
    throw new Error(`sha1 mismatch for ${url}`);
  writeFileSync(dest, buf);
  return dest;
}

/** Extract a zip (or tar.gz) using Windows bsdtar, into destDir. */
export function extract(archive, destDir) {
  ensureDir(destDir);
  // Full path to System32 bsdtar: a GNU tar earlier in PATH treats C:\ as a
  // remote host ("Cannot connect to C") and fails on Windows paths.
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", archive, "-C", destDir], { stdio: "inherit" });
}

/**
 * Ensure a portable Temurin JDK for the given major version exists under
 * work/jdk/<major>/ and return the path to its java.exe. The machine's own
 * Java is never assumed to match what a game version needs.
 */
export async function ensureJdk(major) {
  const base = join(WORK, "jdk", String(major));
  const marker = join(base, ".ready");
  if (!existsSync(marker)) {
    console.log(`[jdk] fetching Temurin ${major}...`);
    const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`;
    const zip = join(WORK, "jdk", `temurin-${major}.zip`);
    await download(url, zip);
    extract(zip, base);
    writeFileSync(marker, "ok");
  }
  // The zip contains a single top-level jdk-* directory.
  const { readdirSync } = await import("node:fs");
  const inner = readdirSync(base).find((d) => d.startsWith("jdk"));
  if (!inner) throw new Error(`no jdk dir inside ${base}`);
  return join(base, inner, "bin", "java.exe");
}

/** Free disk space guard: warn loudly when C: drops under 2 GB. */
export function checkDisk() {
  try {
    const out = execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-PSDrive C).Free",
    ]).toString();
    const free = Number(out.trim());
    if (free && free < 2 * 1024 ** 3) {
      console.error(
        `[disk] WARNING: only ${(free / 1024 ** 3).toFixed(1)} GB free on C:`,
      );
      return false;
    }
  } catch {
    // best effort only
  }
  return true;
}
