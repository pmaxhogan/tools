# 12-hour polish + expansion run: locked spec and live tracker (2026-08-30)

Source: a completed ultraquest interview with Max on 2026-08-30. Every item
under "Locked decisions" was answered explicitly. DO NOT re-ask any of them.
If this session dies (usage cap, reboot), a fresh session resumes from the
Progress section at the bottom. Standing (durable) answers were also written
to ~/unbroker/.claude/ultraquest-standing-answers.md.

## The quest

Ship as many polished tools as possible in ~12 unattended hours on
tools.maxhogan.dev: force-multiplier refactors first (shared components +
full migration), then platform features, then polish of existing tools and
new tools beyond the exhausted matrix. Time split: 50% refactors, 20% new
tools, 30% polish. Quality over quantity: write down every idea, build what
can be done well.

Done-when per wave: main pushed, CI green, Workers Builds deployed, live QA by
a browser subagent with blockers fixed, PushNotification sent.

## Locked decisions (do not re-ask)

### Process
- Concurrency: 5-8 concurrent agents, tiered. Sonnet (cheap): sweeps, data,
  simple logic, copy, backlog. Opus: panels, tricky logic, migrations, per-diff
  review. Fable forks ONLY for the EM overhaul, shell components, reviews.
- Cap policy: checkpoint every wave; on a cap hit stop spawning, push what is
  green, wait and resume until the 12h window ends.
- Ordering: wave 1 infra + shared components + stores; wave 2 bulk migration
  by file partition; wave 3 platform features + facelifts + EM/chem
  overhauls; wave 4+ new tools by category batch interleaved with polish;
  perf pass last.
- Deploy: push main after every green wave. Agents gate on vitest + eslint +
  vue-tsc for their files; orchestrator runs the authoritative `npm run build`
  then pushes and watches CI. Red CI: ALWAYS fix forward, never revert.
- Verification: live-site QA subagent (claude-in-chrome or gstack /browse,
  either) per wave; curl any new /api endpoints.
- Review: Opus reviewer per implementation-agent diff; orchestrator reads
  shell/registry/PanelHost/wiring diffs.
- Pre-grants: git push main; worktrees/branches; edit .claude/*.md, memory,
  tool-matrix.csv, PROJECT/DESIGN/CLAUDE.md on rule changes; npm deps +
  npm 10.9.2 lockfile regen; build-time fetches (PubChem, Wikidata, GitHub
  raw) with committed snapshots; rewrite any panel/shell/PanelHost/registry/
  worker/CI/vitest/eslint; live QA subagents; PushNotifications.
- The other live session (tools-60) is idle: ignore, but check git status
  before each wave.
- Comms: PushNotification per deployed wave + final. Final report as an
  artifact with NATIVE comments (NO unbroker widget, ever) plus chat. Also a
  component-gallery artifact of the new shared components for async comments.
- Stuck policy: pick the reversible option, document here + in the report.

### Refactors (wave 1 + 2)
- Extract: FileDrop, ErrorBanner, ProgressBar, Toast (+ useToast), migrate the
  12 raw-clipboard sites to CopyButton, Canvas/Image preview, ResultTable,
  EmptyState. Migrate ALL panels (120) plus ToolShell/MediaShell/FsShell.
- Infra: vitest happy-dom project + @vue/test-utils for component tests, CI
  runs `npm run build`, repo-wide meta lint (em/en dashes in prose; "zero/no
  network requests" phrasing), hygiene (matrixSlug on 5 dirs, stale plan
  marked historical, 3 post-matrix tools added to the CSV).

### Platform features (wave 3)
- Favorites/pinning (localStorage preference, recent-tools.ts pattern),
  pinned + recent rows on home and sidebar, "new" badges (last 30 days),
  per-category counts, random tool button.
- Related tools (3-6) on every tool page, static for SEO.
- Copy link + share button next to PopoutButton (Web Share on mobile, toast).
- Cross-tool input carry: IN-MEMORY session store surviving view transitions
  only; a "Use <file> from <tool>" chip in the next tool's drop zone. Nothing
  persisted.
- Keyboard shortcuts on tool pages: ? sheet, Ctrl+Enter run, Ctrl+Shift+C
  copy output, Esc clear; documented in FAQ.
- Onboarding + empty states: shared EmptyState with hint + example chip;
  first-visit tooltip for the command palette.

### Polish (wave 3+)
- Known gaps: examples for the ~11 generic tools lacking them, reshape
  jwt-vulnerability-check + protobuf-decoder output, webrtc privacy sentence,
  longer meta descriptions for the shortest ~40.
- Facelift the 23 Phase-1 tools against DESIGN.md (Segmented, KeyValueGrid,
  examples, bolder brand).
- Performance pass (last): PanelHost client:load CLS, heaviest panels'
  first-load JS, loading skeletons, lighthouse top 20.
- Chemistry: expand snapshot to ~10-20k compounds (committed, <= ~5 MB gz,
  lazy index), better UX (search, filters, detail).
- EM spectrum: moves to a new RF category; curated US allocation dataset
  hand-built from FCC/NTIA + ITU region summary as a checked-in TS module
  with sources (no runtime fetch); zoomable log-scale allocation viewer with
  stacked lanes, search + lookups, rules/licensing panel, educational layer.
  Band plans, rules, channel tables (WiFi/Zigbee/LoRa), FCC exposure live
  INSIDE the EM tool (not separate tools).

### New tools (wave 4+), quality over quantity; unbuilt ideas -> CSV + backlog
- New categories: RF, Astronomy, Physics, Weather & Earth. No Biology.
- Dev text: regex-tester, jsonpath-query, xpath-css-selector-tester,
  glob-pattern-tester, semver-range-tester, unified-diff-patch-applier.
- CSS: cubic-bezier-easing-editor, css-gradient-generator,
  fluid-clamp-calculator, box-shadow-generator, css-keyframes-builder,
  clip-path-generator.
- Text fun: fancy-text-generator, morse-code-translator (audio),
  nato-phonetic-alphabet, number-to-words, roman-numeral-converter,
  cipher-tool (caesar/rot13/vigenere), lorem-ipsum-generator.
- Crypto: ssh-key-generator (ed25519 OpenSSH), text-encrypter (AES-GCM),
  jwt-generator (HS256/RS256), self-signed-certificate-generator
  (@peculiar/x509), hmac-generator, password-strength-checker.
- Files/data: archive-viewer (fflate), xlsx-viewer (SheetJS lazy),
  mp3-tag-editor (ID3), torrent-file-inspector, log-file-analyzer.
- Image: exif-viewer-and-stripper, image-color-palette-extractor,
  image-to-data-url, image-watermark, meme-generator, color-contrast-checker.
- Documents: invoice-generator (pdf-lib), vcard-generator (+QR),
  ics-event-generator, word-cloud-generator, font-viewer.
- Electronics/science: led-resistor-calculator, voltage-divider,
  555-timer-calculator, capacitor-code-decoder, pcb-trace-width.
- RF: antenna-length-calculator, path-loss-link-budget, fresnel-zone,
  vswr-return-loss, dbm-watts-volts converter, coax-cable-loss,
  wavelength-frequency converter, lc-resonance.
- Chemistry: chemical-equation-balancer, stoichiometry-calculator,
  half-life-decay, dilution-calculator, molarity-solution-prep,
  ph-poh-calculator, buffer-calculator, electron-configuration,
  isotope-abundance-lookup, empirical-formula-calculator.
- Astronomy: moon-phase-calculator (visual), planet-positions-rise-set,
  orbital-mechanics (Hohmann/escape velocity), julian-date-converter,
  magnitude-calculator.
- Physics (VISUALIZATION-FIRST ONLY): projectile-motion (animated
  trajectory), optics-ray-diagram (thin lens + snell), doppler (animated
  waves), orbital plot; no plain form-and-number calculators.
- Weather & Earth: wind-chill-heat-index-dew-point, pressure-altitude,
  earthquake-magnitude-energy, tide/lunar illumination table.
- Minecraft: nether-portal-calculator, pixel-circle-generator,
  motd-color-code-generator, nbt-viewer, beacon-calculator,
  tick-time-converter.
- Tests/games: typing-speed-test, reaction-time-test, click-speed-test,
  sudoku-generator-solver, maze-generator, word-search-generator.
- NOT picked (backlog only): Web/SEO bundle, code-formatting bundle, text
  analysis bundle, Unix bundle, audio/video bundle, calculators (finance/
  math) bundle, Biology.
- Deps: small pure-JS deps freely; big ones lazy behind a click.

## Wave plan and file ownership

Wave 1 (parallel, disjoint files):
- W1-A Sonnet: vitest happy-dom project (src/**/*.spec.ts), CI build step,
  meta lint test + fix 4 hits, hygiene (matrixSlug, plan doc note).
- W1-B Opus: FileDrop, ErrorBanner, ProgressBar, EmptyState (+ specs, docs).
- W1-C Opus: Toast/useToast + Toaster island, CopyButton toast, ShareLinkButton,
  carry-input store (src/lib/carry-input.ts) + CarryChip.
- W1-D Opus: favorites lib + FavoriteButton + HomeGrid/SidebarNav pinned +
  recent rows + new badges + counts + random button + added-dates module.
- W1-E Sonnet: related-tools lib + ToolPage.astro section; shortcuts lib +
  ShortcutSheet.
- W1-F Sonnet: content gaps (examples x11, descriptions x40, webrtc note,
  jwt/protobuf output reshape).
- W1-G Sonnet: .claude/tool-backlog.md + tool-matrix.csv rows for every idea.
- Orchestrator: deps install, PanelHost/ToolShell wiring of Toaster,
  ShareLinkButton, FavoriteButton, shortcuts; build; push; QA.

## Progress

- [ ] Wave 1 built
- [ ] Wave 1 pushed + CI green + QA
- [ ] Wave 2 migration (6 partitions + shells)
- [ ] Wave 2 pushed + QA
- [ ] Wave 3 features/facelifts/EM/chem
- [ ] Wave 3 pushed + QA
- [ ] Wave 4+ new tools by category
- [ ] Perf pass
- [ ] Final: memory, report artifact, gallery artifact, notification
