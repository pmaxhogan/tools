---
name: tool-page-copy
description: Write or refresh the SEO page copy for one or more tools - what/how/why sections, FAQ, meta description, keywords - following the DESIGN.md copy rules. Use when asked to "polish the copy", "/tool-page-copy <slug>", or "improve SEO text".
---

# /tool-page-copy [url-slug | all]

Rewrites the user-facing copy in `src/tools/<slug>/meta.ts` to landing-page
quality. The copy is rendered on the page (collapsed sections + FAQ) and drives
search snippets, so it must be real prose, not filler.

## Binding rules

Read `DESIGN.md` "Copy rules" first. The non-negotiables:

1. NO em dashes or en dashes anywhere. Commas, colons, parentheses, or new
   sentences instead. Hyphenated compounds are fine.
2. The privacy claim is exactly "your files and inputs never leave your device".
   Never "zero network requests", never overstated.
3. Plain "MIT licensed". No bundle-size boasts.
4. Confident, concrete, no exclamation marks, no marketing superlatives.

## What good copy looks like, per field

- `description` (one sentence): the tool's job plus its sharpest differentiator.
  This becomes the meta description seed and the card text; front-load keywords.
- `copy.what` (2-4 sentences): capabilities in concrete terms. Name the formats,
  algorithms, or standards involved (RFC numbers, ISO 8601, IANA zones) because
  those are search terms.
- `copy.how` (2-4 sentences): actual steps a first-time user takes, mentioning
  paste/drop input, the options that matter, the copy buttons, and that state
  lives in the URL for sharing.
- `copy.why` (2-4 sentences): the honest case against the incumbent site:
  ads, cookie walls, upload-to-server, caps, signup walls. State what this one
  does instead. Never invent claims about competitors.
- `copy.faq` (exactly 3): questions real searchers type, answered specifically.
  At least one privacy question ("is my input uploaded?") for any tool that
  touches sensitive data (tokens, passwords, files).
- `keywords`: 5-8 phrases users actually search, lowercase.

## Procedure

1. Read the tool's current meta.ts and its index.ts (know what it really does;
   never write copy the logic can't back up).
2. Rewrite the fields above. Keep TypeScript syntax valid.
3. Grep the result for em/en dashes and exclamation marks; fix any.
4. `npm run build` to confirm the page still renders, and eyeball the built
   HTML snippet for the FAQ JSON-LD.
