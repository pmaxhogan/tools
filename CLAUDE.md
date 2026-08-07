# CLAUDE.md — working on tools.maxhogan.dev

Read `PROJECT.md` first: it is the source of truth for rules, scope, and build
order. `DESIGN.md` governs all visual and copy decisions. `tool-matrix.csv` is
the plan for all 168 tools.

## The three binding documents

| Doc | Governs |
|---|---|
| `PROJECT.md` | rules (server policy, data handling, SEO, architecture rule 27), phases, definition of done |
| `DESIGN.md` | tokens, spacing, focus/motion, and the copy rules (NO em/en dashes in prose, exact privacy claim wording) |
| `.claude/tool-authoring.md` | the contract for a tool's logic layer (files, purity, tests, meta shape) |

## Architecture

- `src/tools/<url-slug>/` — pure logic (`index.ts`), tests, `meta.ts`. Never
  imports Vue, never touches DOM/fetch/localStorage (eslint enforces this).
- `src/tools/registry.ts` — hand-maintained: eager meta imports + lazy logic
  loaders keyed by URL slug. Only the orchestrator edits it in parallel work.
- `src/pages/[slug].astro` — one dynamic route renders every tool page from the
  registry. `src/layouts/ToolPage.astro` carries SEO metadata, JSON-LD, copy.
- `src/components/tool/ToolShell.vue` — the generic island: paste/drop/picker
  input, schema-driven options, output with copy buttons, URL-fragment state.
  Tools flagged "needs custom panel" get a bespoke island later; string and
  Record<string,string> outputs render generically.
- `worker/index.ts` — Cloudflare Worker: serves static assets plus the
  stateless `/api/<slug>` endpoints for tools whose meta declares `http`.
- URL slugs are keyword-shaped for SEO (`qr-code-generator`); `matrixSlug`
  maps back to `tool-matrix.csv` when they differ.

## Commands

- `npm test` / `npx vitest run src/tools/<slug>` — logic tests
- `npm run build` — astro build + `scripts/generate-sw.mjs` (service worker)
- `npm run lint` — includes purity rules for `src/tools`
- Deploy: push to main; the git-connected Cloudflare Worker "tools" builds and
  deploys automatically (`wrangler.jsonc` is the config).
- **Lockfile rule:** Workers Builds runs npm 10.9.2, which requires `@emnapi/*`
  entries that npm 11 omits. After changing dependencies, regenerate the lock
  with `npx -y npm@10.9.2 install --package-lock-only` or CI's `npm ci` fails
  with a lockfile-sync error. Drop this once the build image ships npm 11.

## Project skills

- `/new-tool <slug>` — implement one tool end to end from the matrix
- `/tool-batch <slugs...>` — parallel subagent fan-out for many tools, with the
  model-tiering policy (sonnet for simple, opus for tricky, orchestrator wires
  registry and reviews)
- `/tool-done [slug|all]` — audit against the definition of done
- `/tool-page-copy [slug|all]` — SEO copy rewrite under the DESIGN.md rules

## Hard rules most likely to be violated by accident

1. No em dashes or en dashes in any user-facing prose (DESIGN.md).
2. Never add a runtime third-party request (fonts, CDNs, analytics beacons).
3. Tool logic never goes inside a component (rule 27).
4. Shareable state goes in the URL fragment, never the query string;
   localStorage holds preferences only, never content.
5. Parallel tool agents never edit `registry.ts` or `package.json`.
6. The privacy claim is exactly "your files and inputs never leave your
   device"; never claim "zero network requests".
