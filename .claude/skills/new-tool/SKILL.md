---
name: new-tool
description: Scaffold and implement one tool from tool-matrix.csv end to end - pure logic, tests, metadata, registry wiring, and page verification. Use when asked to "add a tool", "implement <slug>", "/new-tool <slug>", or "build the next tool from the matrix".
---

# /new-tool <matrix-slug-or-name>

Implements one tool from `tool-matrix.csv` completely: logic, tests, meta, registry
entry, and build verification. The result is a live page at `/<url-slug>`.

## Steps

1. **Find the matrix row.** Look up the slug or name in `tool-matrix.csv`. If the
   argument is ambiguous, pick the closest matching row and say which one you chose.
2. **Read the binding docs, in order:**
   - `.claude/tool-authoring.md` (the logic-layer contract; follow it exactly)
   - `DESIGN.md` (copy rules apply to ALL user-facing strings, especially:
     never use em or en dashes in prose)
   - `src/tools/types.ts`, plus `src/tools/epoch-converter/` and
     `src/tools/uuid/` as reference implementations
3. **Choose the URL slug.** Keyword-shaped for SEO (rule 22): what a searcher
   would type, like `qr-code-generator`, not an internal name. Keep the matrix
   slug in `matrixSlug` when it differs.
4. **Implement** `src/tools/<url-slug>/{index.ts,index.test.ts,meta.ts}` per the
   authoring spec. Type `run` with concrete parameter and return types (do not
   annotate it as `ToolLogic[...]['run']`, which widens the return to a union
   and breaks strict type-checking in tests); keep
   `export default { run } satisfies ToolLogic<...>`.
5. **Wire the registry** (`src/tools/registry.ts`): import the meta into the
   `tools` array and add the lazy loader keyed by URL slug. Keep both lists
   alphabetized by slug.
6. **Decide the UI surface.** The generic `ToolShell` covers text-in/text-out and
   options-driven tools. If the tool needs a custom panel (live events, canvas,
   image preview, editable tables), create `src/components/tool/panels/<PascalName>Panel.vue`
   following an existing panel as reference, and register it in the panel map used
   by `src/pages/[slug].astro`.
7. **Verify:** `npx vitest run src/tools/<url-slug>` green, `npm run build` green,
   then load `/<url-slug>` with the dev server and confirm: input paste works,
   output renders, copy button works, options round-trip through the URL fragment.
8. **Definition of done** is PROJECT.md section 5. Run down the checklist before
   declaring the tool finished; fix anything that fails.

## Model guidance (when this runs as a subagent batch)

See `/tool-batch` for the tiering policy. When implementing inline, just implement.
