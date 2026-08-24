# UX pass + chemistry/Wikidata tools + overhauls: locked spec and progress (2026-08-23)

Source: a completed ultraquest interview with Max on 2026-08-23. Every item
under "Locked decisions" was answered explicitly. DO NOT re-ask any of them.
Progress checkboxes at the bottom are the live tracker; update them as waves
land. Memory file tools-project-state.md gets a summary at the end of each wave.

## The quest

A large UX/platform pass on tools.maxhogan.dev plus new tools and overhauls:

1. Wave 0: finish batch 5 (19 tools committed locally in cf28885, 17 bespoke
   panels missing), push, QA.
2. Wave 1: design mockup artifact (Fable fork) for every new UX surface +
   tool overhaul + new tool, published with NATIVE Claude artifact comments
   (NOT the unbroker widget). Max comments; loop on fixes until he says
   "lgtm". In parallel, Opus/Sonnet agents build everything not blocked on
   design (data + logic layers, primitives, and a first draft of the visual
   shell components, reworked after comments).
3. Wave 2: shell UX (categories, picker, sidebar, examples, segmented,
   quick-entry, KeyValueGrid, US English lint), deploy, QA.
4. Wave 3: tool overhauls (RAIDZ v2, metronome toggle, resistor picker) +
   facelifts (distance-bearing, sunrise-sunset, photography, wire-gauge,
   coordinate-converter), deploy, QA.
5. Wave 4: new tools (Chemistry x5, Wikidata x4, backlog: document-scanner,
   handwriting-pad, image-upscaler, gpx basemap, PDF sign), deploy, QA.
6. Final: memory + plan update, final report, push notification.

Done-when: each wave deployed to prod (push main, CI green, Workers Builds
deploy) and browser-QA'd by a claude-in-chrome subagent on the live site with
findings fixed.

## Locked decisions (do not re-ask)

### Process
- Batch 5 finishes FIRST as wave 0.
- Ordering: parallel design mockup + shell UX, then overhauls, then new tools.
- Deploy path: push to main per wave. CI gates the auto-deploy.
- Subagents run in git worktrees where files overlap; in place when disjoint.
- Design feedback: ONE artifact, one direction per item, covering all items.
  Native artifact comments (Artifact tool publish + watch + reply/resolve).
  Loop until Max says lgtm. Push notification when the mockup is ready.
- Unblocked while waiting for lgtm: data + logic layers, primitives with no
  visual debate, AND first drafts of the visual shell components.
- Testing: unit tests for all logic (vitest) + claude-in-chrome browser QA per
  wave on the live site.
- Model policy (hard rule): Fable (orchestrator/fork) does the mockup, review,
  registry/PanelHost/worker wiring, gates, anything hard to reverse. Opus
  subagents: panels, shell components, tricky logic. Sonnet: simple logic,
  sweeps, copy.
- Pre-grants: git push main after each green gate; add npm deps + regen the
  lockfile with `npx -y npm@10.9.2 install --package-lock-only`; build-time
  network fetches in scripts (PubChem, Wikipedia, Wikidata, HF/GitHub weights)
  with sha256 pins for weights; delete/rewrite existing panels and
  registry/worker wiring; rename the three "Colour" tool names; spawn
  claude-in-chrome QA subagents on the live site; git worktrees; edit memory
  files and .claude/*-plan.md; publish + watch the design artifact.
- Stuck policy: pick the reversible option, document in this file + the final
  report, continue. Hard-stop only for destructive or unauthorized actions.
- Comms: PushNotification at mockup ready, each wave deployed, final report.

### Shell UX
- Examples: new `ToolMeta.examples?: { label: string; input?: string; opts?:
  Record<string,string>; file?: string }[]`. Text/JSON/CSV tools PRE-FILL
  example 1 when the URL fragment is empty, with a dismissable "Example input"
  chip (one click clears). File/image/audio tools get a "Try a sample" button
  loading a tiny bundled sample from public/samples/. Examples never override
  a shared link's fragment. Apply to (almost) every tool that takes input.
- Segmented control: shared `src/components/ui/segmented/` lifted from
  GpuInspectorPanel.vue:206-225. OptionControl auto-promotes any select with
  <= 4 leaf options (131 of 219 specs). Metas may override either way:
  `ui: "segmented" | "select"` on the OptionSpec. The 7 hand-rolled copies
  (GpuInspector, KeyboardHeatmap, Midi, MinecraftHunger, MinecraftRedstone,
  MinecraftXp, QrReader) switch to the shared component. Labels wrap on
  narrow screens.
- Optional-shorthand tools (raidz-calculator, reverse-proxy-config-generator,
  systemd-unit-builder, print-cost-calculator paste): KEEP the text box but
  collapsed under a "Quick entry" toggle with clearer copy explaining what the
  box does (new `inputOptional?: { label: string; hint: string }` on ToolMeta).
  minecraft-anvil-calculator and minecraft-redstone-timing-calculator never
  read input: set `input: "none"`.
- Multi-column output: OutputView renders Record outputs as a responsive grid
  (1 col < sm, 2 at lg, 3 at xl) when values are short; long values span the
  full row. New shared `KeyValueGrid.vue`; the hand-rolled <dl> panels migrate
  (TotpPanel, ParquetViewerPanel, QrReaderPanel, ElectromagneticSpectrumPanel,
  WasmFeaturePanel, McpInspectorPanel, FirmwareFlasherPanel,
  DiscordCompressorPanel, MinecraftSpawningPanel and the other Minecraft
  grids where it fits).
- Categories: `src/tools/categories.ts` canonical registry: slug, label,
  icon (lucide name via tool-icons.ts), description (1-2 sentences, SEO, copy
  rules), order. KEEP ALL 23 categories exactly; ADD "Chemistry". registry
  test enforces every meta.category is in the list and no category slug
  collides with a tool slug. Sidebar, HomeGrid, CommandPalette, breadcrumbs
  read order + icons from it (no more alphabetical sorts).
- Category pages: `/category/<slug>` (src/pages/category/[slug].astro):
  filtered homepage with LARGER cards (2 cols at lg), intro paragraph, OG
  image (add slugs to src/pages/og/[...slug].png.ts), CollectionPage +
  ItemList JSON-LD, related-categories footer chips, and a category-scoped
  search box (reuse HomeGrid search). Sitemap is automatic.
- Category links + icons everywhere: breadcrumb category segment becomes a
  link with icon (ToolPage.astro:55-61); sidebar category headers link with
  icons; homepage section headings link with icons; palette shows categories
  as results with icons.
- Quick picker: desktop `max-w-3xl`, ~75vh, TWO-PANE (results left with icon
  + name + category badge; right pane previews the highlighted tool: icon,
  description, category, keyboard hint). All matches shown (virtualized if
  needed). Mobile keeps the single-column sheet. BaseLayout.astro:8-15 must
  project `icon` into paletteTools.
- Top bar: search-field-shaped button "Search tools" + Ctrl K kbd at md+,
  magnifier icon below md; opens the palette through a tiny shared store
  (src/lib/palette-store.ts) so the Astro header can reach the island.
- Ranking (src/lib/search.ts): word-prefix boost (token at the start of a
  word in the name outranks mid-word), acronym/initials match, category rows
  as results when a token matches a category, curated synonym expansion map
  (sound->audio, picture/photo->image, zip->archive, ...) plus a searchTerms
  audit across all metas, typo tolerance (Damerau-Levenshtein <= 1 for tokens
  >= 4 chars, ranked below exact, only when exact hits are few), recently-used
  boost (localStorage preference of last ~10 slugs; empty query shows Recent
  first). Tests must include: "em" -> Electromagnetic Spectrum first, "sound"
  -> audio tools, "colour" still matches.
- Sidebar: resizable at xl+ via a drag handle (6px edge, visible on
  hover/focus), range 14-28rem, keyboard arrows adjust 1rem, double-click
  resets, width persisted in localStorage (preference) and applied pre-paint
  via `--sidebar-w` in BaseLayout applyHtmlState. Search box sticky under the
  sidebar header; typing a category name collapses the list to that category
  (header first with icon + link, then its tools, then other name matches).
  Scroll position: the `<aside id="site-sidebar">` scrollTop persists across
  view-transition swaps (move transition:persist or save/restore around
  astro:before-swap/after-swap); if the active link is off-screen, scroll the
  minimum amount to reveal it (scrollIntoView block "nearest").
- US English: one-time sweep of user-facing prose and comments
  (colour, neighbour, metre, normalis-, grey in prose, cancelled/cancelling,
  analyse in prose, centre, labelled, recognis-, travelled, licence,
  summaris-, organis-, behaviour, serialis-, optimis-, modelled, visualis-,
  aluminium, defence) PLUS `scripts/check-spelling.mjs` wired into `npm run
  lint` with an allowlist (analyser/AnalyserNode/createAnalyser,
  echoCancellation, aria-labelledby, CSS Color 4 grey names in color-picker,
  greyhound wordlist, GAM command names like license_skus, programmer).
  British spellings STAY in `synonyms`/`searchTerms` (search index). Rename
  the three tool names: "Colour Suite" -> "Color Suite", "Colour Blindness
  Simulator" -> "Color Blindness Simulator", "Resistor Colour Code
  Calculator" -> "Resistor Color Code Calculator". DESIGN.md gains the rule:
  US English only.

### Overhauls
- RAIDZ v2 (bespoke panel + logic): hierarchical diagram pool > vdevs >
  drives; click-to-toggle failed drives; states green (online), red
  (offline/failed), yellow (degraded), red with black stripe (data loss),
  propagating drive -> vdev -> pool; per-vdev "N failures left"; failure set
  in the fragment. Capacity pie: 100% = sum of all drives; slices usable,
  parity, ZFS slop/metadata overhead (toggle), OS/filesystem reserve (toggle
  + percent). Reuse chart-maker's pie (export slicePath/renderPie). MTBF or
  AFR + resilver time -> Markov MTTDL per vdev and pool + annual data-loss
  probability, with a helper table of realistic values (consumer, NAS,
  enterprise, SSD; cite Backblaze/vendor sheets); UREs ignored with a note.
  ALSO in scope: hot spares (reduce MTTR), mixed vdevs (different widths and
  levels per vdev), dRAID (distributed spare math). Keep the shorthand as
  quick entry.
- Metronome (tuner-metronome): a simple TOGGLE "Accent first beat only"
  (tick-tock-tock-tock). Seam: TunerMetronomePanel.vue isAccentBeat (~:562);
  panel-local spec precedent at ~:121-146. Visual beat indicator reflects it.
- Resistor color code: bespoke panel with an SVG resistor, 4/5/6 bands via
  segmented control; click a band -> swatch popover of the legal colors for
  that position; live value/tolerance/E-series; typed input stays as a
  secondary "Type it" path; encode mode paints bands from a typed value. Needs
  a color -> hex table (none exists). COLOR_INFO key stays "grey" internally
  (tests assert it); display label "Gray".
- Facelifts (bespoke panels): distance-bearing-calculator (two coordinate
  fields + "use my location", unit segmented, compass rose), sunrise-sunset
  (location + use my location, date picker, timezone select, day-arc graphic
  with golden/blue hour bands), photography-calculator (mode segmented +
  proper fields per mode + DoF bar graphic), wire-gauge-calculator (mode
  segmented + numeric fields + AWG table), coordinate-converter (format
  auto-detect chips + copy-all grid).

### New tools
- Category "Chemistry" (new; flask icon). Dataset is a BUILD-TIME FETCH like
  the AI models (scripts/prepare-chem-data.mjs, run from `npm run build`,
  cached + reproducible, output gitignored under src/tools/_generated/ or
  public/): PubChem bulk NFPA annotations (pug_view annotations heading "NFPA
  Hazard Classification", 851 rows, HSDB + OSHA) UNION Wikipedia chembox NFPA
  params (~2,600 articles, CC BY-SA, attribute), each row tagged with source;
  PubChem GHS classification; PubChem periodic table JSON
  (rest/pug/periodictable/JSON). Rows carry name, synonyms, CAS, formula,
  PubChem CID, Wikipedia title/link, molar mass and properties where known.
  - nfpa-704-fire-diamond: per-quadrant 0-4 or Any (segmented), specials
    W / OX / SA three-state (require/exclude/any); results sorted by name
    with count; "nearby ratings" when exact matches are few; reverse search
    box (name/synonym/CAS/formula) fills the quadrants; downloadable SVG/PNG
    of the diamond (optional chemical-name caption); PERMANENT non-dismissible
    disclaimer above results + footer line (reference only, verify against
    the SDS and NFPA 704 / the AHJ, never a basis for workplace safety
    decisions); links to Wikipedia + PubChem.
  - chemical-lookup: hub; name/CAS/formula search -> molar mass, formula,
    density, melting/boiling/flash point, NFPA diamond, GHS pictograms + H/P
    statements, links.
  - ghs-pictogram-lookup: pick pictograms / H-codes -> matching chemicals;
    renders/downloads the UN pictograms (public domain SVGs, self-hosted).
  - molar-mass-calculator: formula parser (parentheses, hydrates like
    CuSO4.5H2O, charges), molar mass + percent composition from IUPAC atomic
    weights; generic shell OK with a pre-filled example.
  - periodic-table: interactive table, property trends color-mapped,
    per-element detail with links.
- Wikidata-backed (baked build-time snapshots via SPARQL in
  scripts/prepare-wikidata.mjs, cached, CC0): country-code-lookup (ISO 3166
  alpha-2/3/numeric, calling code, currency, TLD, time zones, driving side,
  plug types, capital, flag emoji), airport-code-lookup (IATA/ICAO -> name,
  city, coordinates, elevation, time zone; pick two for great-circle
  distance reusing distance-bearing math), language-code-lookup (ISO
  639-1/2/3 + ISO 15924, native names, direction, speakers),
  wikidata-cities-database (cities with population > 100k + countries table
  baked into a SQLite file built at build time; the page is the
  sqlite-viewer panel preloaded with that file and curated queries).
- Backlog: document-scanner (camera or image -> corner detection with manual
  handles, perspective warp, contrast boost, multi-page PDF via pdf-lib; no
  OpenCV), handwriting-pad (pressure-aware ink canvas, smoothing, SVG/PNG
  export, NO recognition, honest copy), image-upscaler (Real-ESRGAN:
  RealESRGAN_x4plus fp16 ~33 MB chunked like ffmpeg + realesr-general-x4v3
  ~5 MB as the default; onnxruntime-web WebGPU EP with WASM fallback; tiled
  inference; metered-connection rules from src/lib/connection.ts), gpx-viewer
  basemap (OpenStreetMap tiles behind an explicit "Load map tiles" button,
  off by default, privacyNote), PDF toolbox "Sign" (drawn/typed/uploaded
  visual signature placed and flattened with pdf-lib; shares the ink canvas
  component with handwriting-pad; labeled as visual, not cryptographic).
- Slugs: nfpa-704-fire-diamond, chemical-lookup, ghs-pictogram-lookup,
  molar-mass-calculator, periodic-table, country-code-lookup,
  airport-code-lookup, language-code-lookup, wikidata-cities-database,
  document-scanner, handwriting-pad, image-upscaler.

## Design lgtm (2026-08-23, from artifact comments; LOCKED)

Max approved the mockup ("rest lgtm") with four deltas, all to carry into the
real components:
1. Segmented controls hug their content (w-fit, start-aligned), never stretch
   to the options-grid column. Applied to src/components/ui/segmented.
2. Resistor panel drawing = dog-bone axial body (bulged end caps, lead wires
   both ends, bands following the body curve), not an oval.
3. GHS pictogram picker shows the drawn diamond SYMBOLS (official UN artwork,
   self-hosted, public domain) with small labels, never word chips.
4. Periodic table gets a Layout toggle: Standard (f-block below) / Wide
   (lanthanides + actinides spliced inline, 32 columns).

## Research anchors (2026-08-23)

- Category model: ToolMeta.category free string (src/tools/types.ts:133);
  registry.ts:573 categories() unused; sorts in SidebarNav.vue:26-28,
  CommandPalette.vue:26-29, HomeGrid.vue:25. registry.test.ts is the
  drift-guard pattern (:88 slug uniqueness, :148-155 icons).
- Sidebar: Sidebar.astro:32 aside is the scroll container; :56 SidebarNav
  transition:persist; width 17rem at :112-119, drawer 18rem at :68-83.
  BaseLayout.astro:80-98 applyHtmlState (localStorage "sidebar"), :114-170
  delegated toggles, :172 CommandPalette client:idle. SidebarNav.vue:82-88
  revealActive, :106-118 search box (not sticky), :141 aria-current.
- Palette: CommandPalette.vue:51-56 Ctrl+K only; :103 dialog classes; :125
  list max-h; rows :137-157 no icon. HomeGrid.vue:39 decorative kbd.
- Search: src/lib/search.ts tiers (name exact 1000 / prefix 500 / substr
  250 / alias exact 200 / alias substr 120 / category 80 / description 40;
  per-token 40/25/15/8), tests src/lib/search.test.ts.
- Routing: src/pages/[slug].astro:7-9; og/[...slug].png.ts:8-10; og.ts:63-87
  takes category; sitemap automatic (astro.config.mjs:20).
- Shell: ToolShell.vue:33 hasInput, :66-70 placeholder, :91-102 debounce,
  :104/:110 watches, :116-117 readFragment, :182 input card, :240 Generate
  button; fragment.ts MAX_FRAGMENT_INPUT 2000. OptionControl.vue:26-32 select
  -> SearchableSelect; select-options.ts SEARCH_THRESHOLD 6. OutputView.vue:
  41-61 Record stack, :63-66 pre; ToolShell.vue:30 HORIZONTAL_SCROLL_TOOLS.
- Overhauls: raidz-calculator/index.ts:18 overhead ratio, :73 parseShorthand,
  :88 run; chart-maker/index.ts:1039 slicePath, :1057 renderPie (unexported).
  tuner-metronome/index.ts:534-552 TimeSignature + accentBeats, :591
  clickSchedule, :750 renderClickSamples; TunerMetronomePanel.vue ~:121-146
  local spec, ~:562 isAccentBeat, ~:641 gain tiers.
  resistor-color-code-calculator/index.ts:25-90 tables, :160 eSeriesRows,
  :286 parseValue; meta.ts:32-58 mode/bands.
- Spelling: ~1000 hits; tool names at color-picker/meta.ts:7,
  color-blindness-simulator/meta.ts:7, resistor-color-code-calculator/meta.ts:7.

## Wave 4 build notes (from the data agents; do not lose)

- Wikidata snapshots DONE: scripts/prepare-wikidata.mjs (+ scripts/lib/
  wikidata-sparql.mjs, wikidata-emit.mjs), outputs wikidata-countries.ts (255),
  wikidata-airports.ts (9,073; LON/PAR are city items, NYC absent, AAL is the
  air base), wikidata-languages.ts (8,265 + 274 scripts; scripts[] may be
  empty = "not recorded"; Language.iso2 is ISO 639-2 NOT country alpha-2),
  public/data/wikidata-cities.sqlite (7,622 cities + countries + meta table
  of caveats; admin1 = immediate P131 parent; timezone NULL for multi-zone
  countries; 267 duplicate name+country pairs incl metro areas). WIKIDATA_META
  per module. Warm rebuild 1.2 s offline; cache 70 MB gitignored.
- CI ORDERING (must do in wave 4): the generated .ts are gitignored, so the
  moment a tool imports src/tools/_generated/*, CI typecheck fails on a clean
  checkout. Add `node scripts/prepare-wikidata.mjs && node
  scripts/prepare-chem-data.mjs` to .github/workflows/ci.yml BEFORE typecheck
  (network run, ~6 min cold), and to the Workers Build via npm run build.
- prettierignore now covers src/tools/_generated/, public/data/, public/wawoff2/.
- SPARQL lessons: use language "en,mul" for labels; P6687 is the IANA zone
  (P1442 is image of grave); UTC offset labels use U+2212; filter !isBLANK on
  P238; dissolved states filtered via P576.

## Progress

- [x] Wave 0: all 17 batch-5 panel files written by agents (15/17 reported
      green as of 14:35; QrTransfer + Multitouch agents still finalizing).
      Remaining: PanelHost wiring, authoritative typecheck+build, push, curl
      4 endpoints, QA
- [x] Wave 0 SHIPPED: commit 27d3e06 pushed, CI green, deployed, 4 endpoints
      curl-verified. Browser QA: 18/19 usable, findings fixed in d6318e8
      (wawoff2 worker codec fix for the font-subsetter blocker: the package
      only exports under Node, now self-hosted glue in per-direction workers
      via scripts/prepare-wawoff2.mjs + public/wawoff2/worker.js +
      src/lib/woff2.ts + setWoff2Codec seam; mouse-tester bounce threshold
      25ms; gcode textarea forwards drops; qr-file-transfer honest privacy
      note). d6318e8 deployed, /wawoff2/ assets live. WOFF2 path needs a
      browser re-check in the wave-2 QA. British spellings in batch-5 copy
      fixed by the upcoming sweep.
- [x] Wave 1 lgtm: Max approved 2026-08-23 with 4 deltas (see Design lgtm
      section); all 4 mockup fixes republished, threads resolved
- [x] Wave 1: mockup artifact published + watched:
      https://claude.ai/code/artifact/507c75f4-071d-430e-b2fd-59eec027553f
      (Max push-notified 14:36). Unblocked agents running: search ranking,
      segmented, key-value grid, ToolShell examples/quick-entry, sidebar,
      chem dataset, wikidata snapshots, raidz v2 logic, spelling script.
      Done: categories.ts + /category pages + registry guard (built 201
      pages incl 24 category pages + OG + sitemap)
- [ ] Wave 1: Max said lgtm
- [x] Wave 2+3 PUSHED together as 264401e (380 files): all shell UX, all
      overhauls, 5 of 6 facelift panels (WireGaugePanel relaunched on Sonnet
      after the 5h-cap kill), US English sweep done + check-spelling wired
      into npm run lint (repo clean; keys/aliases restored with markers:
      chart-maker doughnut allowlist, kilometre/metre input synonyms in
      distance-bearing + photography, search.test literals). 8357 tests,
      typecheck 0, build 201 pages. CI watch running.
      NOTE the 5h usage cap killed 7 agents mid-flight ~17:00; all their
      panels were complete on disk; examples validated repo-wide (70/70).
      Max asked for REDUCED parallelism + lower-tier agents from now on
      (max 2-3 concurrent, Sonnet-first, Opus only for tricky panels).
- [ ] Wave 2+3 QA on live site (incl font-subsetter WOFF2 recheck, category
      pages, palette, sidebar resize, RAIDZ sim, resistor picker)
- [x] Wave 4 part 1 SHIPPED (1a89ce0): 5 Chemistry + 4 Wikidata tools, wired,
      CI green, live, molar-mass API verified. Dataset snapshots + GHS art
      committed (DEVIATION from build-time fetch: Workers Builds ~20 min cap
      vs ~19 min cold fetch; prepare scripts remain the refresh path). CI
      needs NO prepare step now (snapshots are tracked).
- [x] Wave 4 part 2 SHIPPED (9017ef9): document-scanner, handwriting-pad +
      InkCanvas, pdf-toolbox Sign op, image-upscaler (x4v3 4.9MB default +
      x4plus 66MB chunked, pinned BSD-3, onnxruntime-web now direct dep),
      wikidata-cities panel, gpx-viewer OSM basemap (click-only; PROJECT.md
      rule 8 gained the second named exception). 8752 tests, 214 pages.
- [ ] Wave 4 browser QA + fixes
- [ ] Memory + final report
