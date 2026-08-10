# Minecraft tools: plan and locked decisions

Written 2026-08-10 from a completed ultraquest interview. This is the spec of
record for the Minecraft category. Decisions under "Locked decisions" were
answered explicitly by Max and must not be re-asked.

## The quest

Add a new "Minecraft" category to tools.maxhogan.dev with calculators that are
extremely accurate to real game behavior, verified against actual Minecraft
code per version. A local pipeline downloads game versions, deobfuscates the
ones that need it, extracts authoritative data, and generates golden test
vectors by running real game code. Tool pages state how their numbers were
verified. The differentiator: search results for Minecraft calculators are
dominated by thin AI-generated SEO farms with no version awareness and no
source of truth.

## Locked decisions (do not re-ask)

- Category name: `Minecraft`. Slug prefix: `minecraft-` (SEO keyword shaped).
- First wave (this effort): pipeline plus four tools:
  1. `minecraft-loot-table-calculator`: loot probability engine (exact
     expected drops, driven by real per-version loot JSON)
  2. `minecraft-damage-calculator`: unified damage tool (armor, toughness,
     Protection EPF, Resistance, fall damage, mace damage)
  3. `minecraft-anvil-calculator`: anvil lifetime planner (prior-work
     penalty growth, repair strategy, Too Expensive horizon, rename costs)
  4. `minecraft-xp-calculator`: XP economy (level curve, Mending repair vs
     level cost, kill-to-level planning)
- Full backlog (all added to tool-matrix.csv): the four above plus projectile
  trajectory, elytra + firework flight, hunger/saturation simulator, villager
  discount calculator, mob spawning simulator, breeding/crop growth timers,
  redstone tick/timing converter, and (merged into damage) fall + mace.
- Versions v1: pinned per mechanic from where behavior changed, union across
  tools: 1.16.5, 1.18.2, 1.20.6, 1.21.1, 1.21.11, plus the current latest
  release resolved dynamically from the manifest (26.2 at time of writing).
  Each tool's picker shows only versions where its numbers differ. v2 later:
  every release since 1.14.4, plus notable majors starting at 1.8.
- Pipeline lives in `mc-pipeline/` at repo top level. Scripts committed;
  jars, JDKs, servers, decompiled source all gitignored under
  `mc-pipeline/work/`. Never wired into `npm run build`; the Cloudflare build
  must never need Java.
- Data strategy: pipeline emits committed per-tool `data.ts` modules, each
  under the 2 MB service worker precache limit.
- Verification: golden vectors for all formula tools where feasible,
  committed under `mc-pipeline/vectors/`. Hand-derived from decompiled
  source where invocation is impractical. Every tool page carries a
  verification note plus a changelog of version boundaries where the
  mechanic changed.
- Each page carries the disclaimer line: "Not an official Minecraft product.
  Not approved by or associated with Mojang or Microsoft."
- QA: browser QA every tool after deploy (claude-in-chrome pattern).
- Build style: parallel subagents implement tools; only the orchestrator
  touches registry.ts, PanelHost.vue, tool-icons.ts, package.json.
- Deploy: incremental pushes to main (auto-deploy via Cloudflare Worker).
- Disk: keep all pipeline artifacts. Ping Max if free space drops under
  2 GB. Windows disk cleanup including recycle bin is pre-authorized.
- Pre-granted: Mojang jar/mapping downloads, mcmeta fetches, running
  Java/Gradle, downloading Vineflower and portable JDKs, Docker if easier.
- The eula=true acceptance for the local harness server is disclosed here
  and was covered by the pre-grants (the harness cannot run without it).

## Ground truth established 2026-08-10

- `version_manifest_v2.json` latest release: 26.2 (year-based versioning is
  real; snapshot line is 26.3). The pipeline resolves latest dynamically and
  never hardcodes a version.
- 26.1 and later have no `client_mappings`/`server_mappings` entries: they
  ship unobfuscated. 1.14.4 through 1.21.11 have official Mojang mappings.
  Remap-or-not is decided per version by the presence of the manifest field,
  never by parsing version numbers.
- Manifest `javaVersion.majorVersion` per version: 1.16.5 needs 8, 1.18.2
  and 1.20.x need 17, 1.21.x needs 21, 26.x needs 25. The machine has Java
  21; the pipeline downloads portable Temurin JDKs per required major into
  `mc-pipeline/work/jdk/` and launches each server on its declared major.

## Pipeline architecture (mc-pipeline/)

Node .mjs scripts using node builtins only (repo convention), plus Java
tools it downloads itself:

1. `01-download.mjs`: fetch manifest, download server jar (and client jar
   where needed), mappings when present, portable JDK per required major.
2. `02-decompile.mjs`: for mapped versions, extract the real server jar from
   the bundler, remap to Mojang names (CLI remapper, e.g. ART), decompile
   with Vineflower. For unobfuscated versions, decompile directly. Output:
   readable source trees under `work/<version>/src/` for reference only.
   Decompiled source and mappings are never committed or redistributed;
   TypeScript reimplements logic and never transcribes Java.
3. `03-extract-data.mjs`: pull per-version data (loot tables, enchantments,
   damage type tags, food components, registries) from misode/mcmeta tags,
   falling back to the vanilla data generator run locally. Emit trimmed
   committed `data.ts` modules per tool.
4. `04-harness.mjs`: golden vector generation, two modes:
   - RCON e2e mode: bring up a real dedicated server per version (flat
     world, no structures, RCON on, eula accepted), drive it with a
     hand-rolled ~50 line RCON client. Loot: `loot insert` into a chest
     with a `mine` context and an enchanted tool, read exact contents via
     `/data get block`, reset chest, N samples; vectors are statistical
     (samples, mean, tolerance). Damage: `/damage` (1.19.4+) on re-summoned
     mobs with explicit base armor 0 attribute and equipment; use a damage
     type that does not bypass armor (mob_attack, checked against the
     version's damage-type tags). Space or re-summon around the 10 tick
     hurt-resistance window. Per-era command templates (NBT pre 1.20.5,
     components after, component shape shifted again in 1.21.5).
   - Source-derived mode: for player-bound mechanics commands cannot reach
     headlessly (anvil costs, XP curve, mace bonus, pre-1.19.4 damage),
     values are hand-derived from reading the decompiled source and written
     into vector JSON with `method: "source-derived"` plus the class/method
     they came from.
   Vitest asserts the TS logic matches: exact equality for exact vectors,
   inside tolerance for statistical ones. The loot engine additionally gets
   exact structural tests parsed from the loot JSON itself.

Prove the entire chain on 1.21.11 first (mappings present, /damage exists,
modern components), then scale to the other versions as configuration.

## Landscape research summary (2026-08-10)

Saturated, do not build: seed/structure maps (chunkbase), command generators
(mcstacker, gamergeeks), datapack generators (misode), banner/firework/potion
generators, enchant ordering (iamcal and clones), beacon and portal
calculators, circle generators.

Gaps worth owning (in priority order from research): loot probability engine
(strongest, pipeline is the moat), unified damage calculator (successor to
maxhogan.dev/web-apps/armorcalc), anvil lifetime planner, hunger/saturation
simulator, mob spawning simulator, villager discount calculator (1.20.2
nerf makes per-version handling the gap), projectile trajectory, elytra
flight, XP economy, breeding/growth timers, redstone timing, fall damage.
Honorable mentions for later: raid wave composition, potion effect stacking,
light-level spawn-proof checker, fishing odds (falls out of the loot engine).

Legal posture: official mappings license permits use for development;
mappings and decompiled source stay local and are never redistributed.
Extracted game data JSON is standard to ship (misode, Fabric do so
publicly). Game code is reimplemented, never copied.

## Status

- [x] Interview complete, decisions locked
- [x] Manifest ground truth verified
- [x] Pipeline: download + JDK provisioning
- [x] Pipeline: decompile (remap + Vineflower)
- [x] Pipeline: data extraction to data.ts
- [x] Pipeline: harness vectors (1.21.11 proof first, then all six)
- [x] Four tools implemented, tested against vectors
- [x] Registry, icons, panels wired; matrix rows added
- [x] Deployed; browser QA passed per tool
- [x] Design pass: loot split workbench with tiles and searchable table
      picker, anvil two-pane workbench with merge tree, damage matchup card
      with mob attackers and custom kits, XP Option D panel with Mending
      sustainability and weighted source mixtures
- [x] Enchant applicability gating across all panels (no impossible
      enchant/tool combos are ever shown)

## Wave 2: the remaining matrix rows (2026-08-10)

All seven remaining tools shipped: hunger, villager trades, mob spawning,
projectile, elytra, crop growth, redstone timing. The eighth row
(`minecraft-fall`) stays merged into the damage calculator for search
coverage. Eleven Minecraft tools are now live.

`mc-pipeline/07-harness-sim.mjs` adds four measured families on top of the
original three, six versions each:

    node mc-pipeline/07-harness-sim.mjs <id> [--slot=N] [projectile|villager|growth|redstone ...]

What the second harness can and cannot reach, established by runtime probes:

- Projectile: exact per-tick positions and motions via `tick freeze` plus
  `tick step`, full double precision. Available from 1.20.6 on; 1.16.5 and
  1.18.2 have no tick commands, so those are source-derived and cross-checked
  against the measured modern constants.
- Villager: a summoned villager generates its `Offers` immediately and they
  are readable over RCON, so trade tables are measured rather than
  transcribed. Trades are drawn randomly per villager, so each profession and
  level is sampled 200 times. 26.2 is the exception: it only writes `Offers`
  once they exist and only generates them on a job-site restock, so those
  samples stand each villager next to its job block until it restocks.
- Growth: measurable only on 1.21.11 and 26.2. Before 1.21.11 the random tick
  loop sits inside the natural-spawning branch of
  `ServerChunkCache.tickChunks`, gated on `anyPlayerCloseEnoughForSpawning`,
  so a headless server with no player never random ticks anything. 1.21.11
  moved it to `forEachBlockTickingChunk`. This is the same mechanism that
  makes natural mob spawning unmeasurable headlessly on every version, which
  is why the spawning tool is source-derived plus extracted biome data and
  says so on the page.
- Redstone: exact tick counts by stepping, on the versions with tick commands.

Two traps worth remembering. `tick step` and `tick sprint` return before the
ticks actually run, so reads must poll `tick query` or they silently return
stale values. And gamerules were renamed to namespaced ids in the newest
versions: `randomTickSpeed` is now `minecraft:random_tick_speed`, so the
harness probes both rather than parsing version numbers.

Vector file schema, one shape for every family:

- Always: `version`, `generated`, `serverJarSha1`, `method`
  (`rcon-e2e` or `source-derived`), `measured` (boolean), `note`.
- `source-derived` files carry `sourceConstants`, where every leaf constant is
  `{ value, class, note }` so each number names the class it came from.
- `rcon-e2e` files carry the per-family measured payload (`cases`,
  `professions`, and so on).

Source constants are extracted by collecting every match and requiring them to
agree rather than taking the first: a first-match regex over a Java file is
only correct by luck, and it produced two wrong vectors before it was fixed
(a hopper cooldown that read the `setCooldown(0)` reset instead of the real 8,
and a trident water drag that took the `AbstractArrow` base value instead of
the `ThrownTrident` override).
