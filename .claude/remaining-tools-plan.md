# Remaining tool-matrix rows: standing plan (updated 2026-08-19)

Goal set by Max on 2026-08-19: all major planned tool batches complete, pushed
and verified, except rows that need human clarification or are unsuitable for
unattended build+verify. Same playbook every batch (see CLAUDE.md,
.claude/tool-authoring.md, the /tool-batch skill): logic agents in parallel ->
orchestrator wires registry/worker/icons/PanelHost -> full gate -> push main ->
claude-in-chrome QA subagent on the live site -> fix -> update this file.

## Excluded (built earlier under other slugs, or intentionally not built)

popout, palette, api, share-target, qr-decode (qr-code-scanner), pipelines,
usb-midi (midi-inspector covers MIDI; USB half folded into hid-report-explorer),
minecraft-fall (merged into damage), all minecraft-* rows (built).

## Batch 3: SHIPPED 2026-08-19 (commits 7771bc5 + 86029ed + QA fixes), 142 pages live

Browser QA of batch 3 pending/in progress at time of writing; see memory.

### Batch 3 table (historical)

| row | matrix slug | proposed URL slug | model | panel? | notes |
|-----|-------------|-------------------|-------|--------|-------|
| 83 | color | color-picker | opus | yes | picker/palettes/contrast/hex-rgb-hsl-oklch; logic = culori-free hand math (oklch conversions must be exact; test against known values) |
| 85 | image-diff | image-diff | opus | yes | pixel + SSIM; logic pure on Uint8ClampedArray, panel does canvas |
| 87 | bcrypt | bcrypt-generator | opus | maybe | bcryptjs + argon2 wasm? check hash-wasm availability; needs deps decision: use `hash-wasm` (argon2+bcrypt, small) if installable |
| 95 | sun | sunrise-sunset-calculator | opus | no | NOAA solar equations, golden hour, shadow angle; input "lat,lon" + optional date; deterministic tests |
| 96 | echo | echo | sonnet | no | Worker endpoint reflecting request + IP; page shows curl instructions + a "call it" button |
| 97 | uf2 | uf2-inspector | sonnet | no | UF2 block parser, family IDs table |
| 98 | proxy-config | reverse-proxy-config-generator | sonnet | no | nginx + Caddy from options; http endpoint |
| 99 | wasm-support | wasm-feature-detector | sonnet | yes | logic = table of tiny feature-probe wasm binaries as bytes; panel runs WebAssembly.validate |
| 105 | av-test | webcam-mic-test | sonnet | yes | getUserMedia preview + level meter; logic = level/peak math |
| 106 | photo-calc | photography-calculator | opus | no | DoF, hyperfocal, exposure EV, ND, FoV; deterministic |
| 107 | tone | tone-generator | sonnet | yes | WebAudio; logic = wave/sweep param validation + note-to-freq |
| 110 | anchor | css-anchor-positioning-builder | opus | yes | generates CSS anchor-position rules; live preview panel |
| 112 | headers | http-header-inspector | sonnet | maybe | Worker echoes request headers; page fetches /api/http-header-inspector and renders |
| 114 | resistor | resistor-color-code-calculator | sonnet | no | 4/5/6 band decode/encode |
| 115 | chart | chart-maker | opus | yes | CSV -> SVG chart (own renderer, no deps) + PNG via canvas in panel; dataviz skill for palette |
| 120 | media-keys | media-key-tester | sonnet | yes | Media Session handlers; logic = event log formatter |

## Batch 4: SHIPPED 2026-08-19 (fbee0b8 logic, 89599fb panels), 158 pages live

annotate, parquet, heatmap, tracks (gpx-viewer, no basemap), barcode, coords,
bed-mesh, ruler, rollover, monitor, doc-convert, tuner, stego, wire-gauge,
dither, nfc. Browser QA launched right after deploy.

## Batch 5 (FINAL buildable batch): LOGIC DONE, committed cf28885 LOCALLY (not pushed)

State at checkpoint (2026-08-19, usage limit hit): all 19 logic layers green
(8124 tests, lint 0, typecheck 0, 175 tools registered, 4 worker endpoints).
Icons added. NOT pushed: batch 5 needs its bespoke panels first because the
document/qr/audio/font copy promises panel features.

REMAINING FOR BATCH 5 (in order):
1. Build 17 panels (one agent each, same prompt style as batches 2-4; prompts
   must say: read DESIGN.md, the tool's index.ts + meta.ts, a reference panel;
   create EXACTLY ONE file src/components/tool/panels/<Name>Panel.vue; SSR-safe;
   click-to-start for mic/camera/audio; no em/en dashes; verify typecheck+eslint):
   HexViewerPanel (virtualized hex grid, template editor, go-to-offset, search,
     entropy sparkline), MarkdownTablePanel (grid editing, paste, column drag,
     align buttons, live markdown), BeautifierPanel (image drop/paste, canvas
     composite via renderFrameSvg + data-screenshot-slot, export 1x/2x),
     GamepadPanel (getGamepads rAF poll, drift test 3 s, circularity, vibration),
     CountdownPanel (big digits, presets, laps, target date, chime, title,
     fragment state via encodeTimerState), MouseTesterPanel (coalesced events,
     Hz graph, pointer-lock DPI, click grid, scroll log, acceleration),
     BpmKeyPanel (file drop -> decodeAudioData -> analyzeTrack with progress,
     tap tempo, camelot neighbours), LightMeterPanel (rear camera, 5 Hz frame
     sampling, lux readout, CCT swatch, calibration, try track exposure
     settings), QrTransferPanel (sender canvas animation pinning plan.version,
     receiver camera + jsQR -> Receiver.ingest, download), AudioDataPanel (play
     morse/DTMF/FSK, WAV download, mic decode live for all three), AsciiArtPanel
     (image drop, live pre preview, columns slider, copy/download, PNG render),
     MultitouchPanel (pointer capture surface, circles per pointer, coverage
     grid, pressure bar, fullscreen), PomodoroPanel (phase clock, start/pause/
     skip, chime, title, fragment state via encodeState for the pop-out),
     GcodePanel (file drop, layer slider + play, canvas/SVG renderer, stats,
     travel toggle, color by), SpritePackerPanel (multi-image drop, atlas
     preview, PNG + JSON/CSS/XML + zip via fflate), FontSubsetterPanel (font
     drop, FontFace preview before/after, presets, size bar, download; MUST
     browser-smoke-test wawoff2 loading under Vite), ElementRecorderPanel
     (region overlay, element pick, CropTarget when available else canvas
     crop, MediaRecorder, patchWebmDuration, download).
   Generic shell is fine for: distance-bearing-calculator, print-cost-calculator.
2. Wire PanelHost.vue (alphabetical defineAsyncComponent entries), run the gate
   (vitest, lint, typecheck, build), commit, push main, watch CI + deploy.
3. Curl-check the 4 new endpoints (audio-data-codec, distance-bearing-
   calculator, markdown-table-editor, print-cost-calculator).
4. claude-in-chrome QA subagent over all 19 live pages (same brief style as
   batches 2-4), fix findings, push.
5. Batch 4 QA report (agent a829711f0cdbb302f) may still be pending: read its
   result when it arrives and fix any blockers/bugs it reports.
6. Update memory tools-project-state.md; then the only remaining matrix rows are
   the "Needs Max" three (scan, upscale, handwriting): ask him.

## (historical) Batch 5 list

hex-viewer, markdown-table-editor, screenshot-beautifier, gamepad-tester,
distance-bearing-calculator, countdown-timer, mouse-tester, bpm-key-detector,
light-meter, print-cost-calculator, qr-file-transfer, audio-data-codec,
image-to-ascii, multitouch-tester, pomodoro-timer, gcode-viewer,
sprite-sheet-packer, font-subsetter (opentype.js + wawoff2), element-recorder.
After batch 5 only the "Needs Max" rows remain (scan, upscale, handwriting).

## (historical) Batch 4+ candidates in order

121 annotate (panel-heavy, canvas), 122 parquet (needs a parquet reader dep:
hyparquet is small and pure JS; ok), 123 heatmap, 125 subset (font subsetting:
needs a dep like subset-font/harfbuzzjs wasm; check size cap 2MB precache rule),
126 tracks (GPX/KML/GeoJSON parse pure; map render needs a tile source = third
party runtime request; DO NOT fetch tiles by default; render track on plain SVG
canvas with no basemap, or ask), 130 barcode (bwip-js dep or hand-roll code128/
EAN), 132 coords (UTM/MGRS math), 133 bed-mesh (3D plot: SVG isometric or
canvas), 134 ruler, 135 rollover, 137 doc-convert (DOCX->PDF: heavy; docx
parsing via mammoth (js) + pdf-lib exists? check), 138 tuner, 139 stego,
140 wire-gauge, 142 dither, 144 nfc (Web NFC, Android only, gate), 145 hex,
146 md-table, 147 beautify, 149 handwriting (needs an ink-to-text model:
handwriting recognition local model = large download; likely PARK), 151
gamepad, 152 geo-calc, 154 timer, 155 mouse, 156 bpm, 157 light-meter,
158 print-cost, 159 qr-transfer, 160 audio-data, 162 ascii-art, 165 touch,
166 pomodoro, 167 gcode, 168 sprite-packer, 108 scan (document scanner:
opencv-ish deskew; heavy, maybe PARK), 109 element-recorder, 119 upscale
(Real-ESRGAN WebGPU: model weights download, size and licensing question:
PARK for Max), 136 monitor (Monitor Test Suite: fullscreen test patterns; fine).

## Needs Max (do not build unattended)

- 119 upscale: which ESRGAN weights, license, hosting under the 25 MiB Worker
  asset cap (needs chunking like ffmpeg) - ask.
- 149 handwriting: no small local ink-recognition model exists; ask whether a
  stylus pad without recognition is acceptable.
- 126 tracks: basemap tiles are a third-party runtime request (hard rule 2);
  build without a basemap unless Max approves a tile provider.
- 108 scan: heavy CV pipeline; confirm scope (perspective crop only vs full
  auto-detect) before spending effort.

## Cross-batch conventions already decided

- New deps: install BEFORE agents, smoke-test under vitest, regen lockfile with
  npx -y npm@10.9.2 install --package-lock-only, add to tool-authoring.md.
- Any networked panel is click-to-fire, never on mount, with a privacyNote.
- Bespoke panels only where the generic shell cannot render.
- No em/en dashes; exact privacy claim wording; rule 27 purity.
