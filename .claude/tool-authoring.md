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
`gpt-tokenizer`, `file-type` (main entry is portable), `exifr`. Import them
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
