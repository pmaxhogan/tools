---
name: tool-done
description: Audit one tool (or all tools) against the PROJECT.md section 5 definition-of-done checklist and report pass/fail per item. Use when asked "is <tool> done", "/tool-done <slug>", "audit the tools", or before shipping a batch.
---

# /tool-done [url-slug | all]

Audits tools against the definition of done (PROJECT.md section 5) and reports a
pass/fail table per tool. Fix-forward: when a failure is mechanical (missing copy
button wiring, missing meta field, dash in prose), fix it in the same run and
mark it fixed.

## The checklist, with how to verify each item

For each tool (all registry entries when run with `all`):

1. **run() pure, typed, tested** - `src/tools/<slug>/index.test.ts` exists, covers
   happy path + at least two edge cases + every ToolError branch;
   `npx vitest run src/tools/<slug>` green. run() has concrete types, no DOM or
   fetch or Vue imports (eslint's restricted-globals rule for src/tools enforces
   this; run `npx eslint src/tools/<slug>`).
2. **Input by paste, drop, picker** - tools with text input get all three via the
   generic shell automatically; verify custom panels implement them too.
3. **Copy/download on output** - every output value reachable by a copy control.
4. **Fragment state round-trip** - options and (small) input restore from the URL
   hash on load; verify by loading `/<slug>#i=...&opt=...` in the dev server.
5. **Keyboard operable, visible focus** - tab through the page; every control
   reachable, focus ring visible (the global :focus-visible rule covers styled
   components; check custom panels didn't suppress it).
6. **Capability-gated honestly** - if meta.requires is set, the page states the
   requirement instead of breaking.
7. **Page copy complete** - meta.copy.what/how/why are real sentences; faq has 3
   entries; DESIGN.md copy rules hold (NO em/en dashes in any user-facing string;
   grep the meta for them).
8. **Metadata complete** - title, description, canonical, OG image, JSON-LD render
   in the built HTML (check dist/<slug>/index.html after `npm run build`).
9. **No third-party requests** - the page must not reference any external origin;
   grep the built HTML and its JS chunks for `https://` origins that are not
   tools.maxhogan.dev.
10. **Heavy deps lazy** - the tool's chunk loads only on its page; shell bundle
    unchanged (compare dist/_astro chunk names/sizes before and after adding).
11. **Offline after first load** - service worker precache includes the page and
    its chunks (verify the generated precache manifest lists them).

## Output format

One table: rows = tools, columns = the 11 items, cells = pass / FIXED / FAIL with
a one-line reason for any FAIL. End with the list of follow-ups that could not be
fixed mechanically.
