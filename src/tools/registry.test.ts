import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loaders, tools } from "./registry";

/**
 * Drift guard for the hand-maintained slug lists.
 *
 * A tool's slug has to appear, by hand, in four places that no compiler relates
 * to each other: the registry's meta list and loader map, the PanelHost panel
 * map, the worker's endpoint table, and the curated icon map. Every way of
 * getting that wrong fails silently in production. A missing PanelHost entry
 * quietly serves the generic shell instead of the tool's real UI; a meta that
 * declares `http` but never reaches the worker 404s on curl; an icon name with
 * a typo renders the fallback wrench forever.
 *
 * The cross-file lists are read as source text rather than imported. Two of the
 * files pull in Vue components, which do not import under the node test
 * environment, and the loader map cannot be introspected at runtime because
 * Vite rewrites its dynamic imports. Text is what all four have in common, and
 * the only thing being asserted is which slugs are listed.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(root + path, "utf8");

/** The body of an object literal, from its opening line to the closing `};`. */
function objectBody(source: string, opening: string): string {
  const start = source.indexOf(opening);
  if (start === -1) throw new Error(`could not find "${opening}" to scan for slugs`);
  const body = source.slice(start + opening.length);
  const end = body.indexOf("\n};");
  if (end === -1) throw new Error(`"${opening}" has no closing brace`);
  return body.slice(0, end);
}

/** Keys of an object literal: quoted, bare, or ES6 shorthand. */
function objectKeys(source: string, opening: string): string[] {
  const matches = objectBody(source, opening).matchAll(
    /^ {2}(?:"([^"]+)"|([A-Za-z][\w$]*))\s*[:,]/gm,
  );
  return [...matches].map((m) => m[1] ?? m[2]!);
}

/** slug -> tool directory, read from the registry's loader map. */
function loaderDirs(): Map<string, string> {
  const body = objectBody(
    read("src/tools/registry.ts"),
    "export const loaders: Record<string, () => Promise<unknown>> = {",
  );
  const matches = body.matchAll(
    /(?:"([^"]+)"|([A-Za-z][\w$]*)):\s*\(\)\s*=>\s*import\("\.\/([^/"]+)\/index"\)/g,
  );
  return new Map([...matches].map((m) => [m[1] ?? m[2]!, m[3]!]));
}

/** Tool directories on disk that ship runnable logic. */
function toolDirs(): string[] {
  return readdirSync(root + "src/tools", { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        readFileSync(`${root}src/tools/${name}/index.ts`);
        return true;
      } catch {
        return false;
      }
    });
}

const slugs = new Set(tools.map((t) => t.slug));
const dirs = loaderDirs();

describe("registry", () => {
  it("gives every tool a unique slug", () => {
    expect(slugs.size).toBe(tools.length);
  });

  it("pairs every meta with a logic loader", () => {
    expect([...slugs].filter((s) => !(s in loaders))).toEqual([]);
  });

  it("pairs every logic loader with a meta", () => {
    expect(Object.keys(loaders).filter((s) => !slugs.has(s))).toEqual([]);
  });

  it("parses a loader directory for every registered slug", () => {
    expect(Object.keys(loaders).filter((s) => !dirs.has(s))).toEqual([]);
  });

  it("registers every tool directory that ships an index.ts", () => {
    const loaded = new Set(dirs.values());
    expect(toolDirs().filter((dir) => !loaded.has(dir))).toEqual([]);
  });
});

describe("worker endpoints", () => {
  const wired = new Set(
    [...read("worker/index.ts").matchAll(/from "\.\.\/src\/tools\/([^/"]+)\/meta"/g)].map(
      (m) => m[1]!,
    ),
  );

  it("exposes every tool whose meta declares http", () => {
    const missing = tools
      .filter((t) => t.http)
      .filter((t) => !wired.has(dirs.get(t.slug) ?? t.slug));
    expect(missing.map((t) => t.slug)).toEqual([]);
  });

  it("exposes nothing whose meta omits http", () => {
    const byDir = new Map(tools.map((t) => [dirs.get(t.slug) ?? t.slug, t]));
    const stray = [...wired].filter((dir) => byDir.has(dir) && !byDir.get(dir)!.http);
    expect(stray).toEqual([]);
  });
});

describe("panels", () => {
  it("keys every bespoke panel to a real slug", () => {
    const panels = objectKeys(
      read("src/components/tool/PanelHost.vue"),
      "const panels: Record<string, Component> = {",
    );
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.filter((slug) => !slugs.has(slug))).toEqual([]);
  });
});

describe("icons", () => {
  it("resolves every meta icon name in the curated map", () => {
    const icons = new Set(
      objectKeys(read("src/lib/tool-icons.ts"), "const ICONS: Record<string, Component> = {"),
    );
    expect(icons.size).toBeGreaterThan(0);
    const unknown = tools.filter((t) => t.icon && !icons.has(t.icon));
    expect(unknown.map((t) => `${t.slug} -> ${t.icon}`)).toEqual([]);
  });
});
