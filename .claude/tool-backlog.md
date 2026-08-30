# Tool backlog: ideas beyond the original matrix

The original `tool-matrix.csv` (168 planned tools) is fully built. On
2026-08-30 Max chose a set of new tool ideas beyond the matrix in an
interview, held during the 12 hour polish run described in
`.claude/polish-run-plan.md`. Rows for every idea below were also appended to
`tool-matrix.csv` so they sort, score and build the same way as the original
168.

This file is the tracker: one line per idea, grouped by the category it was
filed under. A tool starts unchecked. The orchestrator ticks the checkbox and
adds the shipped slug in parentheses after `name` once a tool is built,
reviewed and deployed; nothing here should be marked done ahead of that.

"Generic shell ok" means `ToolShell.vue`'s schema-driven options panel and
string/Record output rendering are enough, no bespoke Vue island needed.
"Needs panel" means the tool needs a custom island (canvas, drag interaction,
live preview, animation, tree view, or similar) beyond what the generic shell
renders.

Physics tools are visualization first by design: an animated trajectory, an
interactive ray diagram, animated Doppler wavefronts, an animated orbit plot.
No plain form-and-number calculators in that category; if a physics idea
can't carry a visualization, it doesn't belong here.

Three tools shipped after the original matrix with no CSV row of their own
(`bingo-card-generator`, `display-info`, `electromagnetic-spectrum`) got rows
added to `tool-matrix.csv` in this same pass, but they are not tracked here
since they are already built; see the CSV directly for their grades.

## Status summary

Counts as of 2026-08-30, one row per category, matched by slug (checking each
idea's slug against the shipped tool's URL slug, directory name and its
meta.ts `matrixSlug` where the two differ).

| Category | Shipped | In progress | Not started | Total |
| --- | --- | --- | --- | --- |
| Dev | 14 | 0 | 11 | 25 |
| Text | 7 | 0 | 4 | 11 |
| Crypto | 6 | 0 | 0 | 6 |
| Files | 2 | 0 | 1 | 3 |
| Data | 1 | 0 | 1 | 2 |
| Audio | 1 | 0 | 4 | 5 |
| Images | 5 | 0 | 0 | 5 |
| Docs | 0 | 0 | 2 | 2 |
| QR | 0 | 0 | 1 | 1 |
| Time | 0 | 0 | 1 | 1 |
| Hardware | 5 | 0 | 0 | 5 |
| RF | 8 | 0 | 0 | 8 |
| Chemistry | 10 | 0 | 0 | 10 |
| Astronomy | 3 | 1 | 1 | 5 |
| Physics | 0 | 0 | 4 | 4 |
| Weather & Earth | 3 | 0 | 1 | 4 |
| Minecraft | 0 | 4 | 2 | 6 |
| Testers | 0 | 2 | 1 | 3 |
| Generators | 0 | 1 | 2 | 3 |
| Network | 0 | 0 | 2 | 2 |
| Homelab | 0 | 0 | 1 | 1 |
| Media | 0 | 0 | 2 | 2 |
| Finance | 0 | 0 | 2 | 2 |
| Math | 0 | 0 | 4 | 4 |
| Biology | 0 | 0 | 3 | 3 |
| **Total** | **65** | **8** | **50** | **123** |

## Dev

- [x] **Regex Tester** (`regex-tester`) (shipped 2026-08-30): Live match highlighting, capture
  groups and a plain English explanation of any regular expression. No
  dependency beyond native `RegExp`. Needs panel (highlighted match view over
  the input text).
- [x] **JSONPath Query** (`jsonpath-query`) (shipped 2026-08-30): Run a JSONPath expression against
  pasted JSON and see every match highlighted in the tree. Dependency: a small
  JSONPath engine (e.g. jsonpath-plus). Needs panel (tree view with match
  highlighting).
- [x] **XPath and CSS Selector Tester** (`xpath-css-selector-tester`) (shipped 2026-08-30): Test
  XPath or CSS selectors against pasted HTML and see every match highlighted
  in context. Dependency: native `DOMParser`, `document.evaluate` and
  `querySelectorAll`. Needs panel (highlighted HTML preview).
- [x] **Glob Pattern Tester** (`glob-pattern-tester`) (shipped 2026-08-30): Check a list of paths
  against a glob pattern and see which ones match. Dependency: a small glob
  matcher (e.g. picomatch). Generic shell ok.
- [x] **Semver Range Tester** (`semver-range-tester`) (shipped 2026-08-30): Check whether a version
  satisfies a semver range, with the rule spelled out in plain English.
  Dependency: the `semver` package. Generic shell ok.
- [x] **Unified Diff and Patch Applier** (`unified-diff-patch-applier`) (shipped 2026-08-30): Apply
  a unified diff patch to pasted text and preview the result before download.
  Dependency: a diff/patch library (e.g. `diff`). Needs panel (before/after
  preview with hunk status).
- [x] **Cubic Bezier Easing Editor** (`cubic-bezier-easing-editor`) (shipped 2026-08-30): Drag
  control points on a curve and copy the matching CSS or JS easing function.
  No dependency beyond canvas/SVG. Needs panel (draggable curve editor).
- [x] **CSS Gradient Generator** (`css-gradient-generator`) (shipped 2026-08-30): Build linear,
  radial and conic gradients visually with draggable color stops and copy the
  CSS. No dependency. Needs panel (color stop editor with live preview).
- [x] **Fluid Clamp Calculator** (`fluid-clamp-calculator`) (shipped 2026-08-30): Turn a min and
  max size across a viewport range into a responsive CSS `clamp()`
  expression. No dependency. Generic shell ok.
- [x] **Box Shadow Generator** (`box-shadow-generator`) (shipped 2026-08-30): Stack multiple shadow
  layers visually and copy the CSS `box-shadow` value. No dependency. Needs
  panel (layer list with live preview).
- [x] **CSS Keyframes Builder** (`css-keyframes-builder`) (shipped 2026-08-30): Build `@keyframes`
  animations on a visual timeline and preview them live. No dependency. Needs
  panel (timeline editor with preview).
- [x] **Clip Path Generator** (`clip-path-generator`) (shipped 2026-08-30): Drag shape handles over
  an image and copy the matching CSS `clip-path`. No dependency. Needs panel
  (draggable shape editor over an image).
- [x] **Color Contrast Checker** (`color-contrast-checker`) (shipped 2026-08-30): Check a
  foreground and background color pair against WCAG contrast ratios, with a
  pass/fail readout for AA and AAA. No dependency (WCAG formula is a few
  lines of math). Generic shell ok.
- [x] **Log File Analyzer** (`log-file-analyzer`) (shipped 2026-08-30): Filter, search and get
  stats across a large log file without a server. No required dependency
  (custom line parsing), a virtualized list helps for very large files. Needs
  panel (filterable, virtualized log table).
- [ ] **Meta Tags and OG Preview** (`meta-tags-og-preview`): Edit meta tags
  and preview how the page card renders on Twitter, Facebook, LinkedIn and
  Slack. No dependency. Needs panel (mocked social card previews per
  platform).
- [ ] **Robots.txt Tester** (`robots-txt-tester`): Test a URL against
  robots.txt rules, or build a robots.txt from scratch. No dependency (rule
  matching is hand-rolled). Generic shell ok.
- [ ] **Markdown Preview** (`markdown-preview`): Live rendered preview of
  Markdown as you type, with export to HTML. Dependency: a Markdown renderer
  (e.g. `marked`). Needs panel (split editor/preview view).
- [ ] **HTML Live Preview** (`html-live-preview`): Sandboxed live preview of
  HTML, CSS and JS as you edit, no server round trip. No dependency (sandboxed
  `iframe`). Needs panel (editor plus live sandboxed preview).
- [ ] **Sitemap Inspector** (`sitemap-inspector`): Parse an XML sitemap,
  validate every URL and show coverage stats. No dependency (native
  `DOMParser`). Needs panel (URL table with status per entry).
- [ ] **Code Formatter** (`code-formatter`): Format JavaScript, CSS, HTML and
  more with Prettier, entirely locally. Dependency: `prettier/standalone`
  plus per-language plugins, lazy loaded. Needs panel (code editor in, code
  editor out).
- [ ] **Minifier** (`minifier`): Minify JavaScript, CSS and HTML and see the
  size saved. Dependency: `terser`, `csso` and `html-minifier-terser`, lazy
  loaded. Generic shell ok.
- [ ] **GraphQL Formatter** (`graphql-formatter`): Pretty print and validate
  GraphQL queries and schemas. Dependency: `graphql`'s parse/print. Generic
  shell ok.
- [ ] **Dotenv to JSON** (`dotenv-to-json`): Convert between `.env` files and
  JSON in either direction. No dependency. Generic shell ok.
- [ ] **.gitignore Generator** (`gitignore-generator`): Combine language and
  tool templates into one `.gitignore` file. Dependency: a bundled snapshot of
  the github/gitignore templates, committed, no runtime fetch. Needs panel
  (multi-select template picker with combined preview).
- [ ] **HTTP Status Codes** (`http-status-codes`): Searchable reference for
  every HTTP status code and what it means. No dependency (static dataset).
  Generic shell ok.

## Text

- [x] **Fancy Text Generator** (`fancy-text-generator`) (shipped 2026-08-30): Turn plain text into
  unicode bold, italic, script and other styled variants for social bios. No
  dependency (unicode character mapping tables). Generic shell ok.
- [x] **Morse Code Translator** (`morse-code-translator`) (shipped 2026-08-30): Translate text to
  and from Morse code, with audible playback of the tones. Dependency: Web
  Audio API (native) for tone playback. Needs panel (playback controls and
  timing display).
- [x] **NATO Phonetic Alphabet** (`nato-phonetic-alphabet`) (shipped 2026-08-30): Spell out any
  text using the NATO phonetic alphabet, with audio playback of each word.
  Dependency: SpeechSynthesis API (native) or bundled short audio clips. Needs
  panel (per-word playback controls).
- [x] **Number to Words** (`number-to-words`) (shipped 2026-08-30): Spell out a number in English
  words, including currency and ordinal forms. No dependency. Generic shell
  ok.
- [x] **Roman Numeral Converter** (`roman-numeral-converter`) (shipped 2026-08-30): Convert between
  Arabic numbers and Roman numerals in either direction. No dependency.
  Generic shell ok.
- [x] **Cipher Tool** (`cipher-tool`) (shipped 2026-08-30): Encode and decode text with Caesar,
  ROT13 and Vigenere ciphers. No dependency. Generic shell ok.
- [x] **Lorem Ipsum Generator** (`lorem-ipsum-generator`) (shipped 2026-08-30): Generate
  placeholder paragraphs, sentences or word counts of lorem ipsum text. No
  dependency. Generic shell ok.
- [ ] **Readability Score** (`readability-score`): Flesch-Kincaid and other
  readability scores for pasted text. No dependency. Generic shell ok.
- [ ] **Word Frequency Counter** (`word-frequency-counter`): Count and rank
  word and phrase frequency across pasted text. No dependency. Generic shell
  ok (sortable table output).
- [ ] **Text Cleaner** (`text-cleaner`): Normalize whitespace, smart quotes
  and line endings in pasted text via toggles. No dependency. Generic shell
  ok.
- [ ] **Find and Replace (Regex)** (`find-and-replace-regex`): Find and
  replace across pasted text with regex support and a live match preview. No
  dependency (native `RegExp`). Needs panel (live highlighted preview).

## Crypto

- [x] **SSH Key Generator** (`ssh-key-generator`) (shipped 2026-08-30): Generate an ed25519
  OpenSSH key pair locally, with fingerprint and PEM/OpenSSH export.
  Dependency: WebCrypto Ed25519 (native in modern browsers) plus an OpenSSH
  wire-format encoder. Needs panel (key pair display with per-part copy).
- [x] **Text Encrypter** (`text-encrypter`) (shipped 2026-08-30): Encrypt and decrypt text with a
  passphrase using AES-GCM, entirely locally. Dependency: WebCrypto (native).
  Generic shell ok.
- [x] **JWT Generator** (`jwt-generator`) (shipped 2026-08-30): Build and sign a JWT with HS256 or
  RS256 from a header and payload you edit. Dependency: WebCrypto (native) for
  signing. Needs panel (header/payload editors plus signed token output,
  companion to the existing `jwt-vulnerability-check`).
- [x] **Self-Signed Certificate Generator** (`self-signed-certificate-generator`) (shipped 2026-08-30):
  Generate a self-signed X.509 certificate and key pair for local
  development. Dependency: `@peculiar/x509` plus WebCrypto. Needs panel
  (certificate field form plus PEM output and download).
- [x] **HMAC Generator** (`hmac-generator`) (shipped 2026-08-30): Compute and verify HMAC digests
  for a message and secret key, companion to the existing `hash-generator`.
  Dependency: WebCrypto (native). Generic shell ok.
- [x] **Password Strength Checker** (`password-strength-checker`) (shipped 2026-08-30): Score a
  password's real entropy and estimated crack time, with plain English
  reasons. Dependency: `zxcvbn` or `zxcvbn-ts`. Needs panel (live strength
  meter).

## Files

- [x] **Archive Viewer** (`archive-viewer`) (shipped 2026-08-30): Browse and extract zip and tar
  archives without unpacking them to disk. Dependency: `fflate`. Needs panel
  (file tree with extract).
- [x] **Torrent File Inspector** (`torrent-file-inspector`) (shipped 2026-08-30): Decode a
  `.torrent` file's trackers, file list and info hash. Dependency: a small
  bencode parser (hand-rolled or a tiny lib). Needs panel (tracker/file list
  view).
- [ ] **Directory Tree Generator** (`directory-tree-generator`): Turn a
  dropped folder or a pasted file list into an ASCII directory tree. No
  dependency. Needs panel (folder drop plus tree render).

## Data

- [x] **XLSX Viewer** (`xlsx-viewer`) (shipped 2026-08-30): Open, sort and filter Excel
  spreadsheets without uploading them anywhere. Dependency: SheetJS (`xlsx`),
  lazy loaded. Needs panel (spreadsheet grid with sheet tabs).
- [ ] **Word Cloud Generator** (`word-cloud-generator`): Turn pasted text into
  a weighted word cloud image, sized by frequency. Dependency: a word-cloud
  layout algorithm (e.g. `d3-cloud`) or a hand-rolled spiral placement. Needs
  panel (canvas layout render).

## Audio

- [x] **MP3 Tag Editor** (`mp3-tag-editor`) (shipped 2026-08-30): Read and edit ID3 tags and cover
  art on MP3 files in the browser. Dependency: an ID3 read/write library.
  Needs panel (tag form plus cover art preview).
- [ ] **Voice Recorder** (`voice-recorder`): Record from the microphone with a
  live waveform, then trim and export. Dependency: `MediaRecorder` API
  (native). Needs panel (waveform plus recording controls).
- [ ] **Text to Speech** (`text-to-speech`): Read text aloud with the
  browser's built-in voices, and export it as an audio file. Dependency:
  SpeechSynthesis API (native), plus `MediaRecorder` to capture output audio.
  Needs panel (voice picker and playback controls).
- [ ] **Sound Level Meter** (`sound-level-meter`): Live decibel readout from
  the microphone, with a running peak and average. Dependency: Web Audio API
  `AnalyserNode` (native). Needs panel (live meter visualization).
- [ ] **Audio Joiner** (`audio-joiner`): Concatenate multiple audio files into
  one, with crossfade options. Dependency: Web Audio API (native) or
  ffmpeg.wasm concat. Needs panel (file list reorder plus crossfade preview).

## Images

- [x] **EXIF Viewer and Stripper** (`exif-viewer-and-stripper`) (shipped 2026-08-30): See every
  EXIF field in a photo and export a clean copy with it removed. Dependency:
  `exifr` for parsing, canvas re-encode to strip. Needs panel (image preview
  plus EXIF table).
- [x] **Image Color Palette Extractor** (`image-color-palette-extractor`) (shipped 2026-08-30):
  Pull the dominant colors out of an image as hex, rgb and named swatches.
  Dependency: canvas pixel sampling, optionally a quantization lib. Needs
  panel (image preview with swatch list).
- [x] **Image to Data URL** (`image-to-data-url`) (shipped 2026-08-30): Convert an image to a
  base64 data URL, or decode a data URL back to a file. No dependency. Needs
  panel (image preview alongside the encoded text).
- [x] **Image Watermark** (`image-watermark`) (shipped 2026-08-30): Overlay a text or logo
  watermark on one image or a whole batch, with position and tiling controls.
  No dependency (canvas API). Needs panel (live positioning preview).
- [x] **Meme Generator** (`meme-generator`) (shipped 2026-08-30): Add classic caption text to any
  image and export it, no account needed. No dependency (canvas API). Needs
  panel (drag-to-position text over the image).

## Docs

- [ ] **Invoice Generator** (`invoice-generator`): Build a line-item invoice
  with tax and a logo, and export it as a PDF. Dependency: `pdf-lib`. Needs
  panel (line-item editor plus PDF preview).
- [ ] **Font Viewer** (`font-viewer`): Load a local font file and preview it
  as a specimen sheet and glyph table. Dependency: native `FontFace` API,
  plus `opentype.js` for glyph enumeration. Needs panel (specimen and glyph
  grid).

## QR

- [ ] **vCard Generator** (`vcard-generator`): Build a vCard contact file with
  a scannable QR code to add it instantly. Dependency: the existing QR
  generation library already used by `qr-code-generator`. Needs panel (form
  plus QR preview).

## Time

- [ ] **ICS Event Generator** (`ics-event-generator`): Build a single
  calendar event and download it, or generate add-to-calendar links.
  Companion to the existing `ics-inspector`. No dependency (hand-rolled ICS
  serializer). Generic shell ok.

## Hardware

- [x] **LED Resistor Calculator** (`led-resistor-calculator`) (shipped 2026-08-30): Work out the
  current-limiting resistor for an LED from supply and forward voltage. No
  dependency. Generic shell ok.
- [x] **Voltage Divider Calculator** (`voltage-divider`) (shipped 2026-08-30): Work out output
  voltage or either resistor value for a two-resistor divider. No dependency.
  Generic shell ok.
- [x] **555 Timer Calculator** (`555-timer-calculator`) (shipped 2026-08-30): Astable and
  monostable frequency, duty cycle and component values. No dependency.
  Generic shell ok.
- [x] **Capacitor Code Decoder** (`capacitor-code-decoder`) (shipped 2026-08-30): Decode 3-digit
  and letter capacitor codes into capacitance and tolerance. No dependency.
  Generic shell ok.
- [x] **PCB Trace Width Calculator** (`pcb-trace-width`) (shipped 2026-08-30): IPC-2221 trace width
  for a target current, copper weight and temperature rise. No dependency.
  Generic shell ok.

## RF

- [x] **Antenna Length Calculator** (`antenna-length-calculator`) (shipped 2026-08-30):
  Quarter-wave and dipole antenna lengths for any frequency. No dependency.
  Generic shell ok.
- [x] **Path Loss and Link Budget** (`path-loss-link-budget`) (shipped 2026-08-30): Free space
  path loss and a full link budget from transmit power to receiver
  sensitivity. No dependency. Generic shell ok.
- [x] **Fresnel Zone Calculator** (`fresnel-zone`) (shipped 2026-08-30): Fresnel zone radius and
  clearance for a wireless link, with a visual clearance profile. No
  dependency. Needs panel (clearance profile diagram).
- [x] **VSWR and Return Loss Converter** (`vswr-return-loss`) (shipped 2026-08-30): Convert between
  VSWR, return loss and reflection coefficient. No dependency. Generic shell
  ok.
- [x] **dBm, Watts and Volts Converter** (`dbm-watts-volts-converter`) (shipped 2026-08-30):
  Convert RF power between dBm, watts and volts across common impedances. No
  dependency. Generic shell ok.
- [x] **Coax Cable Loss Calculator** (`coax-cable-loss`) (shipped 2026-08-30): Signal loss over a
  coax run by cable type, length and frequency. Dependency: a bundled
  attenuation table per common cable type. Generic shell ok.
- [x] **Wavelength and Frequency Converter** (`wavelength-frequency-converter`) (shipped 2026-08-30):
  Convert between frequency and wavelength for any part of the spectrum. No
  dependency. Generic shell ok.
- [x] **LC Resonance Calculator** (`lc-resonance`) (shipped 2026-08-30): Resonant frequency of an
  LC circuit from inductance and capacitance. No dependency. Generic shell
  ok.

Note: band plans, channel tables, regulatory rules and the RF exposure
calculator shipped inside the Electromagnetic Spectrum tool
(`electromagnetic-spectrum`) rather than as separate tools tracked in this
list.

## Chemistry

- [x] **Chemical Equation Balancer** (`chemical-equation-balancer`) (shipped 2026-08-30): Balance
  any chemical equation automatically and show the working. No dependency
  (matrix-based balancing algorithm). Generic shell ok.
- [x] **Stoichiometry Calculator** (`stoichiometry-calculator`) (shipped 2026-08-30): Mole ratios,
  limiting reactant and theoretical yield from a balanced equation and given
  reactant amounts. No dependency. Generic shell ok.
- [x] **Half-Life and Decay Calculator** (`half-life-decay`) (shipped 2026-08-30): Remaining
  quantity over time for any half-life, with a decay curve. No dependency.
  Needs panel (decay curve chart).
- [x] **Dilution Calculator** (`dilution-calculator`) (shipped 2026-08-30): Solve C1V1 equals C2V2
  for any missing concentration or volume. No dependency. Generic shell ok.
- [x] **Molarity and Solution Prep** (`molarity-solution-prep`) (shipped 2026-08-30): Work out
  moles, volume or concentration, with a step-by-step prep recipe. No
  dependency. Generic shell ok.
- [x] **pH and pOH Calculator** (`ph-poh-calculator`) (shipped 2026-08-30): Convert between pH,
  pOH, H+ and OH- concentration, including weak acid Ka. No dependency.
  Generic shell ok.
- [x] **Buffer Calculator** (`buffer-calculator`) (shipped 2026-08-30): Henderson-Hasselbalch
  buffer pH and capacity from acid and conjugate base amounts. No dependency.
  Generic shell ok.
- [x] **Electron Configuration Viewer** (`electron-configuration`) (shipped 2026-08-30): Aufbau
  order electron configuration and orbital diagram for any element, reusing
  the existing periodic table dataset. No dependency. Needs panel (orbital
  diagram render).
- [x] **Isotope Abundance Lookup** (`isotope-abundance-lookup`) (shipped 2026-08-30): Natural
  isotopes, abundance and atomic mass contribution for any element.
  Dependency: a bundled isotope abundance dataset (NIST/IUPAC values,
  committed). Generic shell ok.
- [x] **Empirical Formula Calculator** (`empirical-formula-calculator`) (shipped 2026-08-30): Turn
  mass percent composition into an empirical and molecular formula. No
  dependency. Generic shell ok.

## Astronomy

- [x] **Moon Phase Calculator** (`moon-phase-calculator`) (in progress 2026-08-30): Today's moon phase
  and illumination, animated across any date range. No dependency (hand-rolled
  lunar phase algorithm). Needs panel (animated moon visual).
- [ ] **Planet Positions and Rise/Set** (`planet-positions-rise-set`): Rise,
  set and sky position for the naked-eye planets from any location.
  Dependency: a bundled simplified orbital-elements dataset (committed, no
  runtime fetch). Needs panel (sky position display).
- [x] **Orbital Mechanics Calculator** (`orbital-mechanics-calculator`) (shipped 2026-08-30):
  Hohmann transfer, escape velocity and orbital period, with a transfer orbit
  diagram. No dependency. Needs panel (transfer orbit diagram).
- [x] **Julian Date Converter** (`julian-date-converter`) (shipped 2026-08-30): Convert between
  calendar dates and Julian and modified Julian dates. No dependency. Generic
  shell ok.
- [x] **Magnitude Calculator** (`magnitude-calculator`) (shipped 2026-08-30): Convert between
  apparent and absolute magnitude using the distance modulus. No dependency.
  Generic shell ok.

## Physics

Visualization first by design: every tool below is an animated or interactive
diagram, never a plain form-and-number calculator.

- [ ] **Projectile Motion Simulator** (`projectile-motion-simulator`):
  Animated trajectory from launch angle, speed, gravity and drag, with range
  and max height called out live. No dependency (canvas physics
  integration). Needs panel (animated canvas simulation).
- [ ] **Optics Ray Diagram** (`optics-ray-diagram`): Interactive ray diagram
  for thin lenses and mirrors, built on Snell's law, with draggable object
  and focal points. No dependency. Needs panel (interactive SVG/canvas ray
  diagram).
- [ ] **Doppler Effect Visualizer** (`doppler-effect-visualizer`): Animated
  wavefronts from a moving sound source, with an optional pitch-shifted audio
  demo. Dependency: Web Audio API (native) for the audio demo. Needs panel
  (animated wavefront canvas).
- [ ] **Orbital Plot Visualizer** (`orbital-plot-visualizer`): Animated
  two-body orbit from eccentricity and semi-major axis, obeying Kepler's
  laws. No dependency. Needs panel (animated orbit canvas/SVG).

## Weather & Earth

- [x] **Wind Chill, Heat Index and Dew Point** (`wind-chill-heat-index-calculator`) (shipped 2026-08-30):
  NWS formulas for wind chill, heat index and dew point in one calculator. No
  dependency. Generic shell ok.
- [x] **Pressure Altitude Calculator** (`pressure-altitude-calculator`) (shipped 2026-08-30):
  Pressure and density altitude from field elevation, altimeter setting and
  temperature, for pilots. No dependency. Generic shell ok.
- [x] **Earthquake Magnitude and Energy** (`earthquake-magnitude-energy-calculator`) (shipped 2026-08-30):
  Convert between earthquake magnitude scales and the energy they release. No
  dependency. Generic shell ok.
- [ ] **Tide and Moon Illumination Calculator** (`tide-moon-illumination-calculator`):
  Approximate tide timing and a lunar illumination table for any date range.
  Note: real tide prediction needs harmonic station constants that are not
  practical to bundle for every coastline; scope this as a simplified
  lunar-only approximation plus the illumination table, and say so plainly in
  the tool's copy. No required dependency. Needs panel (table plus chart over
  a date range).

## Minecraft

- [x] **Minecraft Nether Portal Calculator** (`minecraft-nether-portal-calculator`) (in progress 2026-08-30):
  Overworld and Nether portal linking coordinates using the 1:8 ratio. No
  dependency. Generic shell ok.
- [x] **Minecraft Pixel Circle Generator** (`minecraft-pixel-circle-generator`) (in progress 2026-08-30):
  Exportable block-grid circles and arcs for builds, at any radius. No
  dependency. Needs panel (grid canvas render plus export).
- [ ] **Minecraft MOTD Color Code Generator** (`minecraft-motd-color-code-generator`):
  Build a formatted server MOTD with a live color and formatting code
  preview. No dependency. Needs panel (live formatted preview plus color code
  palette).
- [ ] **Minecraft NBT Viewer** (`minecraft-nbt-viewer`): Browse and edit NBT
  data from a world save or item, as a tree. Dependency: an NBT binary
  parser. Needs panel (tree view with edit).
- [x] **Minecraft Beacon Calculator** (`minecraft-beacon-calculator`) (in progress 2026-08-30): Pyramid
  layer requirements and effect range for any beacon size. No dependency.
  Generic shell ok.
- [x] **Minecraft Tick Time Converter** (`minecraft-tick-time-converter`) (in progress 2026-08-30):
  Convert between game ticks, redstone ticks and real time, companion to the
  existing redstone timing calculator. No dependency. Generic shell ok.

## Testers

- [ ] **Typing Speed Test** (`typing-speed-test`): Words per minute and
  accuracy against generated or custom passages. No dependency. Needs panel
  (live typed-text highlighting plus timer).
- [x] **Reaction Time Test** (`reaction-time-test`) (in progress 2026-08-30): Measure visual reaction
  time across repeated trials, with a distribution chart. No dependency.
  Needs panel (stimulus display, timing capture, distribution chart).
- [x] **Click Speed Test** (`click-speed-test`) (in progress 2026-08-30): Clicks per second over a
  fixed window, with a running best score. No dependency. Needs panel (click
  target plus live counter).

## Generators

- [x] **Sudoku Generator and Solver** (`sudoku-generator-solver`) (in progress 2026-08-30): Generate
  puzzles with a unique solution at any difficulty, or solve one you paste
  in. No dependency (hand-rolled generator/solver). Needs panel (interactive
  grid).
- [ ] **Maze Generator** (`maze-generator`): Generate printable mazes at any
  size, with an optional solution overlay. No dependency. Needs panel
  (canvas maze render plus print export).
- [ ] **Word Search Generator** (`word-search-generator`): Build a printable
  word search from your own word list, at any grid size. No dependency. Needs
  panel (grid render plus print export).

## Network

- [ ] **Well-Known Ports** (`well-known-ports`): Searchable reference for
  well-known and registered TCP and UDP ports. No dependency (static
  dataset). Generic shell ok.
- [ ] **MAC Address OUI Lookup** (`mac-address-oui-lookup`): Look up the
  vendor behind a MAC address prefix, or generate a random MAC. Dependency: a
  bundled OUI vendor dataset (IEEE public registry snapshot, committed).
  Generic shell ok.

## Homelab

- [ ] **Chmod Calculator** (`chmod-calculator`): Convert Unix file permissions
  between checkboxes, octal and symbolic form. No dependency. Generic shell
  ok.

## Media

- [ ] **Audio Extractor** (`audio-extractor`): Pull the audio track out of a
  video file in the format you choose. Dependency: ffmpeg.wasm (already
  bundled for the Media category). Needs panel (`MediaShell` with an ffmpeg
  arg builder).
- [ ] **Video Speed and Reverse** (`video-speed-reverse`): Change video
  playback speed or reverse it, re-encoded locally. Dependency: ffmpeg.wasm.
  Needs panel (`MediaShell` with an ffmpeg arg builder).

## Finance

- [ ] **Compound Interest Calculator** (`compound-interest-calculator`):
  Growth of a balance over time with compounding, contributions and a chart.
  No dependency. Needs panel (growth chart).
- [ ] **Loan Amortization Calculator** (`loan-amortization-calculator`): Full
  payment schedule and interest paid over a loan's life, with a chart. No
  dependency. Needs panel (schedule table plus chart).

## Math

- [ ] **Statistics Calculator** (`statistics-calculator`): Mean, median,
  mode, standard deviation and linear regression from pasted data. No
  dependency. Generic shell ok.
- [ ] **Function Grapher** (`function-grapher`): Plot and compare multiple
  functions with pan, zoom and trace. Dependency: an expression parser (e.g.
  `mathjs`) plus canvas/SVG plotting. Needs panel (interactive plot).
- [ ] **Prime Factorization Calculator** (`prime-factorization-calculator`):
  Break any number into its prime factors, with GCD and LCM. No dependency.
  Generic shell ok.
- [ ] **Percentage Calculator** (`percentage-calculator`): Every common
  percentage question in one calculator, change included. No dependency.
  Generic shell ok.

## Biology

- [ ] **Punnett Square Calculator** (`punnett-square-calculator`): Monohybrid
  and dihybrid cross grids from parent genotypes. No dependency. Needs panel
  (cross grid render).
- [ ] **DNA/RNA Translator** (`dna-rna-translator`): Transcribe and translate
  a sequence using the codon table, with reverse complement. No dependency
  (bundled codon table). Generic shell ok.
- [ ] **Population Growth Calculator** (`population-growth-calculator`):
  Exponential and logistic population growth over time, with a chart. No
  dependency. Needs panel (growth curve chart).
