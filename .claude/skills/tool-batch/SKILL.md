---
name: tool-batch
description: Implement several tools from tool-matrix.csv in parallel with subagents, choosing models by tool complexity, then wire, review, and verify the batch. Use when asked to "build the next N tools", "/tool-batch <slugs...>", or "implement phase N".
---

# /tool-batch <slug slug slug ...> | next <N>

Fans out one subagent per tool for the pure logic layer, then wires and verifies
the batch centrally. This is how 20 tools get built in an afternoon without
merge conflicts.

## Orchestration rules (learned from the Phase 1 build)

1. **Prep before launch (orchestrator, once):**
   - Any new npm dependencies the batch needs are installed BEFORE launching
     agents. Parallel agents must never touch package.json.
   - `.claude/tool-authoring.md` is up to date; it is the binding spec every
     agent reads first.
2. **One agent per tool, all launched in parallel, in the background.** Each
   agent writes ONLY `src/tools/<url-slug>/` (index.ts, index.test.ts, meta.ts,
   plus a sanctioned data file when the prompt allows it). Agents never edit
   `registry.ts` - the orchestrator wires it after, serially, conflict-free.
3. **Model tiering, by matrix Effort grade and domain trickiness:**
   - `haiku`: mechanical chores only (renames, file moves), never whole tools
   - `sonnet`: Effort A or A+ tools with well-known semantics (case, lines,
     escape, hash, url, ua, placeholder, snowflake, discord-time...)
   - `opus`: tools with tricky domain rules, heavy library integration, or
     data curation (cron, unicode, figlet, fake-data, qr, json/jwt)
   - orchestrating model: contract/registry surface, review, and anything
     cross-cutting
4. **Prompts must state per tool:** URL slug (keyword-shaped, orchestrator
   picks it), matrixSlug, name, category, the matrix description, concrete
   design notes (options, output shape, error branches, which preinstalled dep
   to use), the exact test expectations, and whether http: belongs in meta.
   Vague prompts produce incompatible tools.
   - **Dropdowns:** instruct every agent that each `kind: "select"` option must
     carry `synonyms` (hidden search aliases, treat as required) and that any
     select large enough to benefit must be organised into hierarchical `groups`
     (categories with their own synonyms), per the model in `src/tools/types.ts`.
     The shared searchable-select shows a search field automatically past 6
     options. Use `options`/`groups`, never new `choices`. No em or en dashes in
     labels or synonyms. `src/tools/escape-unescape/meta.ts` is the reference.
5. **After each agent lands (or all at once):** wire registry.ts (meta import +
   lazy loader, alphabetized), then run the full gate:
   - `npx vitest run` (whole suite - catches cross-tool surprises)
   - `npm run build` (catches type and import errors in the astro graph)
   - `npx eslint src/tools` (purity rules)
   - spot-review each tool's meta copy against DESIGN.md copy rules
     (especially: no em/en dashes in prose) and the honesty rules (never claim
     "zero network requests")
6. **Custom-panel flags** from agent reports become follow-up items; the batch
   is not blocked on them - the generic shell renders string and
   Record<string,string> output meanwhile.

## Verification gate for the whole batch

Green suite + green build + registry entries for every tool + each new page
renders in the built dist/. Then run `/tool-done all` for the full audit.
