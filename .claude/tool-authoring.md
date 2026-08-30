# Tool authoring spec — src/tools/<slug>/

The contract for implementing one tool's **pure logic layer**. The UI is a separate
surface and is NOT part of this task unless explicitly stated.

## Files to create (exactly these, nothing else)

```
src/tools/<url-slug>/index.ts       # the logic: run() + helpers
src/tools/<url-slug>/index.test.ts  # vitest suite
src/tools/<url-slug>/meta.ts        # ToolMeta object (metadata + page copy)
```

Do NOT edit `src/tools/registry.ts` (the orchestrator wires it — parallel agents
would conflict). Do NOT run `npm install` (deps are preinstalled; if you believe
one is missing, note it in your final report instead). Do NOT create Vue/Astro
files.

## Reference implementations — read these first

- `src/tools/types.ts` — the `ToolMeta`, `ToolLogic`, `OptionSpec`, `ToolError` types.
- `src/tools/epoch-converter/` — text-input tool, `Record<string,string>` output.
- `src/tools/uuid/` — no-input generator, string output, options incl. number + boolean.

## Rules for index.ts (from PROJECT.md §3, rule 27)

1. **Pure.** No DOM, no `window`/`document`/`navigator`/`localStorage`, no `fetch`,
   no Vue/Astro imports. Tests run in Node — `globalThis.crypto` is fine.
2. **Deterministic where the domain allows.** Randomness takes an optional
   `seed` option: when a non-empty seed is provided, use a small deterministic PRNG
   (e.g. xorshift128 seeded from a string hash) so tests can assert exact output;
   otherwise use `crypto.getRandomValues`.
3. Export `run(input, opts)` (may be async) and `export default { run } satisfies ToolLogic<...>`.
4. **Output type must be `string` or `Record<string, string>`** — the generic UI
   shell renders both (mono block vs labeled copyable rows). If the tool truly
   needs a richer UI (canvas, live events, tables), still return the best
   text/record representation and flag "needs custom panel" in your report.
5. Throw `ToolError(code, message, fix?)` for bad input — message says what's
   wrong, `fix` says how to fix it. Never throw raw strings; never return error
   text as output.
6. Handle the empty string / missing input gracefully: either a sensible default
   (like epoch-converter using "now") or a clear `ToolError('empty-input', ...)`.

## Rules for index.test.ts

- `import { describe, expect, it } from 'vitest'` — style-match the reference tests.
- Minimum: happy path + two edge cases + every `ToolError` branch you wrote.
- Tests must be deterministic (use the seed option for random tools; never
  depend on wall-clock time without injecting it).
- Verify with: `npx vitest run src/tools/<url-slug>` — must be green before you finish.

## Rules for meta.ts

Export `export const meta: ToolMeta = {...}` matching `src/tools/types.ts`:

- `slug`: the URL slug you were given (keyword-shaped, rule 22).
- `matrixSlug`: the tool-matrix.csv slug you were given (omit if identical).
- `name`, `description`: from the matrix row, polished. Description is one
  sentence, no trailing period inconsistency (end with a period).
- `category`, `keywords` (5-8 search phrases real users type).
- `input`/`output` TypeSpecs; `options: OptionSpec[]` for every user-tunable
  behavior — the generic panel renders these. Sensible defaults; selects for
  enums, boolean for toggles, number with min/max.

### The dropdown contract (every `kind: "select"`)

Every select renders through the shared searchable-select component, so authoring
one has a fixed contract:

- **Use `options`, not `choices`.** `choices` is the legacy `{value,label}[]` and
  is kept only so unmigrated tools still compile. New selects use
  `options: SelectOption[]` where each option is `{ value, label, synonyms }`.
- **Every option carries `synonyms`.** These are extra search aliases, never
  rendered, that the search field filters on alongside the visible label (for
  example `synonyms: ["hex", "base16"]` on a "Hexadecimal" option). Write the
  words a user would actually type, including abbreviations and alternate names.
  Synonyms are currently typed optional so the codebase stays green during the
  migration; treat them as required. An empty `synonyms: []` is only acceptable
  when no real alias exists.
- **Group large selects into hierarchical categories.** When a select has enough
  options to benefit (roughly eight or more, or whenever the options fall into
  obvious families), use `groups: SelectGroup[]` instead of a flat `options`
  list. A group is `{ label, synonyms, options?, groups? }` and nests
  recursively. Categories carry their own synonyms, and the search matches on
  category label and synonyms too: matching a category surfaces every option
  beneath it. See `src/tools/escape-unescape/meta.ts` for a grouped example and
  its flat `direction` select for the small-select example.
- **The search field is automatic.** The component shows a search input once the
  flat leaf-option count (from `flattenSelectOptions`, counted once per spec) is
  greater than 6. You never wire the search field yourself; just supply good
  synonyms and, for large lists, good groups.
- **No em or en dashes** in option labels, group labels, or synonyms (DESIGN.md).
- `http`: include `{ method: 'GET', contentType: 'text/plain' | 'application/json' }`
  ONLY for cheap pure text transforms/generators. Omit for anything heavy.
- `copy`: REAL page copy (rule 23 — thin pages don't rank, fake copy is worse):
  - `what`: 2-4 sentences, concrete, mentions the actual capabilities.
  - `how`: 2-4 sentences of actual usage steps.
  - `why`: honest comparison against the incumbent sites (ads, upsells, limits,
    privacy) — never overstate; the claim is "your inputs never leave your
    device", not "zero network requests".
  - `faq`: exactly 3 Q&As real searchers would ask, answered specifically.

## Heavy dependencies (rule 14)

Preinstalled and allowed: `qrcode`, `figlet`, `@faker-js/faker`, `ua-parser-js`,
`cronstrue`, `croner`, `svgo` (import from `svgo/browser`), `papaparse`, `yaml`,
`smol-toml`, `diff`, `sql-formatter`, `@cfworker/json-schema`, `turndown`,
`gpt-tokenizer`, `file-type` (main entry is portable), `exifr`, `mathjs`,
`@noble/hashes` (subpaths carry the `.js` suffix: `@noble/hashes/hmac.js`,
`@noble/hashes/sha2.js`, `@noble/hashes/legacy.js`), `urlpattern-polyfill`
(side-effect import installs the global only where absent), `@js-temporal/polyfill`,
`cbor-x` (import { decode } from "cbor-x"), `@msgpack/msgpack`, `@peculiar/x509`
(requires `import "reflect-metadata";` as the FIRST import of any module that
imports it, in tests too), `hash-wasm` (bcrypt, argon2id, and fast hashes; async, wasm inline).
`hyparquet` (parquet reader, pure JS, async), `mammoth` (DOCX to HTML; `import mammoth from "mammoth"`, use `convertToHtml({ arrayBuffer })`), `marked` (Markdown to HTML; `import { marked } from "marked"`).
`opentype.js` (font parse/subset/write: `import opentype from "opentype.js"`), `wawoff2` (woff2 compress/decompress, wasm, async: `import { compress, decompress } from "wawoff2"`), `jsqr` (QR decode from RGBA).
Import them
normally — the registry lazy-loads your whole module per page, so the dependency
never touches the shell bundle. Everything else: standard library only.

## Binary input tools

Tools whose `meta.input` is `'File'`, `'image/*'`, or `'application/octet-stream'`
receive `Uint8Array | string` as their `run()` input: `Uint8Array` when the user
drops or picks a file, `string` when they typed or pasted text (UTF-8 encode it
yourself if the logic needs bytes). Never assume a filename exists. The generic
shell handles the file reading; the logic layer stays pure bytes-in, text-out.
Output stays `string` or `Record<string, string>`; if the natural output is a
binary file (an image, an ico), return the best text representation (base64 data
URL in a labeled record row is acceptable) and flag "needs custom panel".

## Definition of done for this task

- [ ] `npx vitest run src/tools/<slug>` green
- [ ] All three files present, contract-conformant
- [ ] No edits outside `src/tools/<slug>/`
- [ ] Final report: one line status, output shape chosen, whether a custom
      panel is needed, any missing dep or follow-up

## Shared components (bespoke panels)

This section is the exception to "the UI is not part of this task": it governs
`src/components/tool/panels/*.vue`, not the pure logic layer.

**Rule: a panel MUST use these four components. Never hand roll a drop zone, an
error banner, a progress bar, or an empty state.** They were extracted because
120 panels had drifted into 43 drop zones, 95 error blocks, and 35 progress bars
that disagreed on radius, tone, focus, and wording. A new variant is a
regression, not a preference. If one of them cannot express what your panel
needs, extend the component (and its spec) rather than forking the markup.

All four live in `src/components/tool/` and are imported by path, e.g.
`import FileDrop from "@/components/tool/FileDrop.vue"`. Each ships a
`<Name>.spec.ts` next to it that runs in the `components` vitest project
(`npx vitest run --project components`).

### FileDrop.vue

The single input surface for files: drop, click, keyboard, clipboard paste, and
the cross tool carry chip.

| Prop        | Type      | Default                                 | Notes                                                    |
| ----------- | --------- | --------------------------------------- | -------------------------------------------------------- |
| `accept`    | `string`  | none                                    | HTML accept syntax; also filters the carry chip          |
| `multiple`  | `boolean` | `false`                                 | otherwise only the first file is emitted                 |
| `label`     | `string`  | `"Drop a file here or click to choose"` | headline inside the zone                                 |
| `hint`      | `string`  | none                                    | second line, e.g. "PNG, JPEG or WebP up to 50 MB"        |
| `disabled`  | `boolean` | `false`                                 | removes it from the tab order and ignores every input    |
| `paste`     | `boolean` | `true`                                  | listens for document paste events carrying files         |
| `compact`   | `boolean` | `false`                                 | single line variant for a "replace this file" affordance |
| `directory` | `boolean` | `false`                                 | webkitdirectory; implies `multiple`                      |

- Emits: `files` with a `File[]`, from drop, picker, paste, and the carry chip.
- Slots: default (replaces the whole inner body), `actions` (extra buttons such
  as "Load sample" or "Use camera", rendered inside the zone). Providing the
  default slot replaces the built in body including the `actions` outlet, so a
  custom body brings its own buttons.
- The zone is a focusable `role="button"` with Enter and Space activation and
  the standard focus ring. Clicks that start on a slotted button belong to that
  button, so `actions` content works normally.
- Carry: on every emission it stores the first file in `src/lib/carry-input.ts`
  under the `toolSlug` and `toolName` that PanelHost provides, and it offers a
  matching file from another tool as a "Use <name> from <tool>" chip with a
  dismiss x. The store is in memory only, so nothing is persisted.

### ErrorBanner.vue

| Prop          | Type                             | Default   | Notes                         |
| ------------- | -------------------------------- | --------- | ----------------------------- |
| `message`     | `string` (required)              |           | what went wrong, one sentence |
| `title`       | `string`                         | none      | headline above the message    |
| `hint`        | `string`                         | none      | how to fix it                 |
| `variant`     | `"error" \| "warning" \| "info"` | `"error"` | tone                          |
| `dismissible` | `boolean`                        | `false`   | renders the dismiss x         |

- Emits: `dismiss`.
- Slot: default, appended below the message (a retry button, a details block).
- `role="alert"` for error, `role="status"` for warning and info, `aria-live`
  polite throughout.
- A `ToolError` maps straight onto it: `:message="error.message"`
  `:hint="error.fix"`.

### ProgressBar.vue

| Prop     | Type           | Default | Notes                                     |
| -------- | -------------- | ------- | ----------------------------------------- |
| `value`  | `number`       | none    | 0 to 100, clamped; omit for indeterminate |
| `label`  | `string`       | none    | caption on the left, also the aria-label  |
| `detail` | `string`       | none    | caption on the right, e.g. "3 of 12"      |
| `size`   | `"sm" \| "md"` | `"md"`  | 6px or 8px track                          |

- No emits, no slots.
- `role="progressbar"` with `aria-valuemin`, `aria-valuemax`, and
  `aria-valuenow` (omitted while indeterminate). Brand gradient fill.
- The indeterminate stripe is authored to look deliberate when frozen, because
  global.css disables every animation under `prefers-reduced-motion`.

### EmptyState.vue

| Prop    | Type                | Default | Notes                                   |
| ------- | ------------------- | ------- | --------------------------------------- |
| `title` | `string` (required) |         | one short line saying what is missing   |
| `hint`  | `string`            | none    | how to fill it                          |
| `icon`  | `string`            | none    | lucide export name, e.g. `"FileSearch"` |

- No emits. Slot: `actions`, for a chip such as "Load example".
- `icon` resolves through `src/lib/tool-icons.ts`, which is a curated map: a
  name it does not carry silently falls back to the wrench, so add the icon
  there first if it is missing.

## Copying to the clipboard

Never call `navigator.clipboard.writeText` from a panel. Every copy affordance
goes through one of two shared pieces so the success and failure toasts read
the same everywhere.

### `<CopyButton>` (the default)

| Prop         | Type                              | Default    |
| ------------ | --------------------------------- | ---------- |
| `text`       | `string`                          | none       |
| `getText`    | `() => string \| Promise<string>` | none       |
| `label`      | `string`                          | icon only  |
| `variant`    | Button variant                    | `"ghost"`  |
| `size`       | Button size                       | `"sm"`     |
| `disabled`   | `boolean`                         | `false`    |
| `icon`       | a lucide component                | `Copy`     |
| `toastTitle` | `string`                          | `"Copied"` |

Emits `copied` and `failed`. Supply `text` for a value already in state:

    <CopyButton :text="jsonText" label="Copy JSON" />

Supply `getText` when the value has to be produced at click time (serializing
a canvas, flushing the debounced URL fragment before reading the address bar).
`getText` may be async and takes precedence over `text`. If it throws, the user
gets an error toast and the button emits `failed`; nothing is written.

### `copyText()` for copy affordances that are not buttons

A swatch, a table cell, or a grid cell cannot become a `<CopyButton>` without
restyling it. Those call the shared helper directly:

    import { copyText } from "@/lib/clipboard";

It never throws, returns `true` when the write landed (so the panel can still
run its own inline "Copied" flourish), and raises the same toasts CopyButton
does. Like `download.ts` it touches the DOM, so only components may import it.

### Toasts

`toast({ title, description?, variant?, durationMs? })` from `@/lib/toast`
queues a message; the single `<Toaster>` in BaseLayout renders it. The store is
one shared module instance across every island, so a panel can toast into the
layout. Stack is capped at 3, default 2500 ms, pauses on hover. Titles and
descriptions are user-facing prose: no em or en dashes, and an error gets a fix
hint, not just a failure.

## Favorites, recents, share

`PanelHost` renders `<FavoriteButton :slug>`, `<ShareLinkButton />` and
`<PopoutButton />` above every tool and records the slug in the recent list on
mount. Panels never do any of this themselves. Both lists are slug lists in
localStorage (`favorite-tools`, `recent-tools`), which rule 7 allows because a
list of slugs is a preference; content never goes there. `src/lib/prefs.ts`
owns the read/write/subscribe helpers and fires `prefs-change` so the home
grid, sidebar, and buttons stay in sync in the same tab.
