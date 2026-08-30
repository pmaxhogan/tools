# src/tools/_generated

Generated data modules. The chemistry ones are built by
`scripts/prepare-chem-data.mjs`; other scripts write their own files here.
Hand edits are lost on the next build.

These are committed, dated snapshots, not throwaway build output. Workers
Builds caps a build near twenty minutes and a cold refetch is longer than
that, so a deploy imports what is in git and this script is the refresh path.
Only `.cache/`, the raw fetches, stays out of git.

## Rebuild

```
node scripts/prepare-chem-data.mjs               # build, using the on-disk cache
node scripts/prepare-chem-data.mjs --refresh     # ignore the cache and refetch
node scripts/prepare-chem-data.mjs --offline     # cache only, fail on a miss
node scripts/prepare-chem-data.mjs --no-broad    # narrow tier only
node scripts/prepare-chem-data.mjs --budget=90   # stop starting work after 90 minutes
```

A warm build takes a couple of minutes, almost all of it re-reading the cached
GHS pages. A cold build takes roughly 45 to 75 minutes: the broad tier reads
about 23,000 Wikipedia articles and every page of PubChem's bulk GHS
annotations. Everything lands in `src/tools/_generated/.cache/chem/` so the
next build refetches nothing, and `--budget` bounds a run that has to stop
early: it ships what finished and records the shortfall in the meta.

## Files

| File | Size | Contents |
| ---- | ---- | -------- |
| `chem-data.ts` | 1,652,015 bytes | CHEMICALS and CHEM_DATA_META |
| `elements.ts` | 49,988 bytes | ELEMENTS, the 118 elements |
| `ghs-statements.ts` | 17,983 bytes | H_STATEMENTS, P_STATEMENTS and PICTOGRAMS |
| `chem-index.ts` | 9,333 bytes | types and helpers for the lazily fetched broad dataset, no bulk data |

## The broad tier: public/data/chem/

`chem-data.ts` is the narrow tier, 3,050 compounds that carry an NFPA
rating or a GHS classification. It is imported directly, so it ships inside the
tool's JavaScript and has to stay small.

The broad tier is 25,248 compounds: every English Wikipedia article with a
Chembox, a Drugbox or an Infobox drug. It is too large to bundle, so it ships as
129 JSON files the browser fetches on demand, and
`chem-index.ts` holds only the types and helpers for reading them.

```ts
import {
  CHEM_INDEX_URL, chemShardUrl, chemRecordFrom, chemHasNfpa, chemHasGhs,
  chemIsDrug, chemCid, CHEM_BROAD_META,
  type ChemIndexRow, type ChemRecord, type ChemShard,
} from "@/tools/_generated/chem-index";

const index: ChemIndexRow[] = await (await fetch(CHEM_INDEX_URL)).json();
const row = index.find((r) => r[1] === "Acetone");
const shard: ChemShard = await (await fetch(chemShardUrl(row[0]))).json();
const record: ChemRecord | undefined = chemRecordFrom(shard, row[0]);
```

| File | Size | Gzipped | Contents |
| ---- | ---- | ------- | -------- |
| `public/data/chem/index.json` | 2,486,283 bytes | 972,052 bytes | one `[id, name, formula, cas, molarMass, flags, syn?]` row per compound |
| `public/data/chem/<0..127>.json` | 12,230,281 bytes total | 3,422,997 bytes total | full records, keyed by id, sharded by `id % 128` |

- The index is enough to run a search box. Fetch one shard only once someone
  picks a compound; it is a 128th of the corpus.
- `id` is the PubChem CID when the `CHEM_FLAG_CID` bit is set. A compound
  this build could not resolve to a CID keeps a synthetic id at or above
  900,000,000, which is well past PubChem's range, so the
  modulo sharding still works and no id ever collides with a real CID.
- `syn`, the index's 7th column, is up to 4 alternative names per
  compound (PubChem's title, a short IUPAC name, then the best of the compound's own
  synonyms), present only when the row has one worth showing. It is what lets a query
  like "table salt" or "sulfuric acid" reach a compound whose Wikipedia article title
  reads differently, without a shard fetch. index.json carries its own tighter budget,
  2.5 MB raw and 1.0 MB gzipped, separate from the whole tier's
  budget above; this build shipped 2 per row, cut down from the full amount to fit.
- `ghs.h` here is codes only. `H_STATEMENTS` in `ghs-statements.ts` has
  the canonical wording, and repeating it per compound cost more than the whole
  index does.
- Nothing under `/data/` is precached by the service worker
  (`scripts/generate-sw.mjs` skips that prefix), so both fetches are ordinary
  network requests served from the browser's HTTP cache on a repeat visit.
- `CHEM_BROAD_META.ghsSweepComplete` is the resume signal. When it is true,
  every page of PubChem's bulk GHS annotations was read and
  `counts.withoutGhs` is simply how many compounds PubChem has never
  classified, which is most of them. When it is false, `--budget` cut the
  sweep short and a rerun with a warmer cache will classify more.


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
