import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "./categories";
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

/**
 * Tool directories whose logic has landed but which are deliberately not on the
 * site yet. The workflow builds a tool's pure layer first and wires the
 * registry, PanelHost, and icons in a later pass, so an unwired directory is a
 * tool in progress rather than a mistake.
 *
 * Adding a name here has to be deliberate, and shipping the tool means deleting
 * it again: the test below fails if an entry is registered after all, so this
 * list cannot rot into a permanent exemption.
 */
const UNWIRED = new Set<string>([]);

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
    const unwired = toolDirs().filter((dir) => !loaded.has(dir) && !UNWIRED.has(dir));
    expect(unwired).toEqual([]);
  });

  it("does not list a tool as unwired once it is registered", () => {
    const loaded = new Set(dirs.values());
    expect([...UNWIRED].filter((dir) => loaded.has(dir))).toEqual([]);
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

/**
 * `ToolMeta.category` is a free string, so nothing but this guard relates it to
 * the canonical list in categories.ts. A typo there is invisible: the tool just
 * grows its own one-off section on the homepage and never appears under the
 * category it belongs to, and its category page link 404s.
 *
 * The slug collision check matters because tool pages live at `/<slug>` and
 * category pages at `/category/<slug>`. They do not collide as URLs today, but
 * the two namespaces are written by hand from the same vocabulary, and a shared
 * name makes every link, breadcrumb and search result ambiguous to read.
 */
describe("categories", () => {
  const labels = new Set(CATEGORIES.map((c) => c.label));

  it("declares a known category on every tool", () => {
    const unknown = tools.filter((t) => !labels.has(t.category));
    expect(unknown.map((t) => `${t.slug} -> ${t.category}`)).toEqual([]);
  });

  it("never reuses a tool slug as a category slug", () => {
    const clashing = CATEGORIES.filter((c) => slugs.has(c.slug));
    expect(clashing.map((c) => c.slug)).toEqual([]);
  });

  it("gives every category a unique, kebab-case slug", () => {
    const seen = CATEGORIES.map((c) => c.slug);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((slug) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))).toEqual([]);
  });

  it("keeps em and en dashes out of the category copy", () => {
    // Escapes, not literals: the copy rule bans these characters from prose, so
    // the guard should not be the one file that smuggles them back in.
    const offenders = CATEGORIES.filter((c) => /[\u2013\u2014]/.test(c.description));
    expect(offenders.map((c) => c.slug)).toEqual([]);
  });
});
