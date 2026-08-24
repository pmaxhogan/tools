# src/tools/_generated

Generated data modules. The chemistry ones are built by
`scripts/prepare-chem-data.mjs`; other scripts write their own files here.
Everything in this directory is a build artifact: the directory ignores
itself, nothing in it is committed, and hand edits are lost on the next build.

## Rebuild

```
node scripts/prepare-chem-data.mjs             # build, using the on-disk cache
node scripts/prepare-chem-data.mjs --refresh   # ignore the cache and refetch
node scripts/prepare-chem-data.mjs --offline   # cache only, fail on a miss
```

A warm build takes a few seconds. A cold build takes roughly 10 to 15 minutes,
almost all of it the per compound GHS sweep, and leaves its responses in
`src/tools/_generated/.cache/chem/` so the next build refetches nothing.

## Files

| File | Size | Contents |
| ---- | ---- | -------- |
| `chem-data.ts` | 1,651,890 bytes | CHEMICALS and CHEM_DATA_META |
| `elements.ts` | 49,864 bytes | ELEMENTS, the 118 elements |
| `ghs-statements.ts` | 17,858 bytes | H_STATEMENTS, P_STATEMENTS and PICTOGRAMS |

## Shapes

```ts
import { CHEMICALS, CHEM_DATA_META, type Chemical } from "@/tools/_generated/chem-data";
import { ELEMENTS, type Element } from "@/tools/_generated/elements";
import { H_STATEMENTS, P_STATEMENTS, PICTOGRAMS } from "@/tools/_generated/ghs-statements";
```

- `Chemical` carries `id`, `name`, `synonyms`, and the optional `cas`,
  `formula`, `molarMass`, `cid`, `wikipedia`, `nfpa`, `nfpaAlt`,
  `ghs` and `props`. Ids are `cid:180`, `wp:Acetone`, `hsdb:30` or
  `osha:235`, and are stable across builds.
- `nfpa` is present only when health, fire and instability all parse to 0 to 4.
  `nfpaAlt` holds Wikipedia's rating when it disagrees with PubChem's.
- `ghs.h` entries are worded by the notifying body. `H_STATEMENTS` holds the
  canonical UN wording for the same code, so the two can differ.
- `Element` omits a numeric field rather than zeroing it. `period` and
  `group` are derived from the atomic number; `group` is absent for the
  f block.
- `CHEM_DATA_META` carries `builtAt`, `counts` and `sources`, including
  the attribution each source requires.
- Hazard statements, pictogram sets and precautionary sets are pooled and
  shared between rows, so two chemicals can hold the same array instance.
  Treat every value here as read only and copy before sorting or mutating.
- A compound often carries several GHS classifications, one per notifying
  body. One is chosen, in the order listed under `ghsSourcePriority` in
  `CHEM_DATA_META`, so a row is one coherent classification rather than the
  union of every jurisdiction.

## Attribution

- PubChem NFPA Hazard Classification annotations (HSDB and OSHA): Public domain (US National Library of Medicine)
- PubChem GHS Classification: Public domain (US National Library of Medicine)
- PubChem GHS reference (hazard statements, precautionary statements, pictograms): Public domain (US National Library of Medicine)
- PubChem periodic table: Public domain (US National Library of Medicine)
- English Wikipedia Chembox parameters: CC BY-SA 4.0

Wikipedia content is CC BY-SA 4.0. Any surface that shows a Wikipedia derived
value has to credit the article, which is what the `wikipedia` field is for.

## Reference only

Nothing here is a basis for a workplace safety decision. Verify against the
safety data sheet, NFPA 704 itself, and the authority having jurisdiction.
