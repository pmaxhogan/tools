# tools.maxhogan.dev — project brief

A suite of developer and power-user web tools, built to replace sites that have been
ruined by ads, upsells, signup walls, and artificial limits. Everything runs in the
browser unless it genuinely cannot.

This document is the source of truth for an agent working on this repo. `tool-matrix.csv`
holds all 168 planned tools with grades; `tool-matrix.html` is the same data, sortable.

---

## 1. Non-negotiable rules

These are settled decisions, not suggestions. If a task appears to require breaking one,
stop and raise it rather than working around it.

### Server policy
1. Client-side by default. A server is permitted only when the job is *impossible* in the browser.
2. Any server code is stateless: pure request to response. No user content in KV, R2, or D1.
3. No accounts, no auth, no user-generated persistence.
4. **Exception (named, narrow):** a Worker or Durable Object may broker WebRTC signaling for
   the `drop` tool. In-memory only, never written to disk; rooms expire in minutes; SDP and
   ICE candidates only, never file bytes; no payload logging. STUN only — **no TURN relay**,
   because relayed bytes would pass through our infrastructure and break rule 5.

### Data handling
5. Files never leave the device.
6. Shareable state goes in the URL **fragment**, never the query string. Fragments are not
   sent to the server, so a shared link cannot leak content into request logs.
7. `localStorage` holds preferences only. Never content.
8. No third-party requests at runtime. Self-host fonts and libraries. The privacy claim dies
   the moment a Google Fonts request fires.

### The pledge
9. No ads, no upsells, no email capture, no "sign up to download", no watermarks.
10. No artificial limits — file size, uses per day, or formats behind a tier.
11. MIT licensed, so the pledge is enforceable by fork.
12. Wording matters: the claim is **"your files and inputs never leave your device,"**
    not "zero network requests." Do not overstate it.

### Engineering
13. Every tool is independently deletable. Shared components must not couple tools to each other.
14. Heavy payloads (ffmpeg, ONNX, sql.js, LibreOffice) lazy-load only on the page that needs
    them and never touch the shell bundle.
15. Progressive enhancement. Capability-detect and state plainly "this needs Chrome / desktop /
    WebGPU" rather than breaking silently.
16. Keyboard-first. Offline-capable PWA. Respect `prefers-color-scheme` and `prefers-reduced-motion`.
17. Every tool accepts paste, drag-drop, and file-picker input where the type allows. Every
    output has a copy button.

### Scope discipline
18. Done means: beats the site it replaces at the core job. Nothing more.
19. Explicit non-goals — no accounts, no sync, no collaboration, no chatbot, no pro tier.
20. If a tool needs a backend to be good, descope it or drop it. No half-tools.

### SEO (the site is public and wants traffic)
21. Pre-rendered static HTML per tool. No client-rendered SPA shell, no hash routing.
22. Flat, keyword-shaped URLs: `/qr-code-generator`, `/epoch-converter`.
23. Real but thin and collapsed copy on every page — what it does, how to use it, why it beats the alternative,
    a short FAQ. Thin pages do not rank.
24. Per-page metadata: title, description, OG image, canonical, `SoftwareApplication` JSON-LD, sitemap.
25. [Removed]
26. Tools graded low on **Reach** (Chrome-only, desktop-only, hardware-gated) make poor landing
    pages. Build them, but lead publicly with high-Reach tools.

### The architecture rule
27. **Every tool is a pure transform function with declared input and output types, kept
    separate from its UI.** The function is the tool; the page is one surface on it. This is
    what makes the three surfaces — web UI, pipeline node, curl endpoint — free rather than
    triplicate work. Do not write a tool whose logic lives inside a component.

---

## 2. Settled decisions

| Decision | Choice |
|---|---|
| Domain | `tools.maxhogan.dev`, its own Cloudflare Pages project |
| License | MIT |
| Audience | Public, SEO-optimised |
| Analytics | Cookieless. Use zone-level HTTP analytics (no client JS) or proxy the beacon through our own domain — never load `static.cloudflareinsights.com` directly, per rule 8 |
| Framework | **Deferred.** Must prerender per route, support per-page metadata, keep the shell tiny, and use partial hydration so 168 tools don't compile into one bundle. Astro or SvelteKit both qualify. |

---

## 3. The tool contract

Every tool exports a definition matching roughly this shape. Types drive both the pipeline
graph (which tools may connect) and the curl API (which tools are exposable).

```ts
export interface Tool<In, Out> {
  slug: string;                    // URL segment, matches tool-matrix.csv
  name: string;
  description: string;
  category: string;

  input:  TypeSpec;                // e.g. 'text/plain', 'image/*', 'application/json', 'File'
  output: TypeSpec;

  /** Pure. No DOM, no network, no globals. This is the tool. */
  run(input: In, opts: Opts): Promise<Out> | Out;

  /** Optional: exposed as a stateless curl endpoint. Only for cheap, pure, side-effect-free runs. */
  http?: { method: 'GET' | 'POST'; contentType: string };

  /** Optional: gates the UI with an honest message instead of breaking. */
  requires?: Capability[];         // 'webgpu' | 'serial' | 'hid' | 'fs-access' | 'desktop' | ...
}
```

Rules for `run`:
- Pure and deterministic where the domain allows. Randomness takes a seed parameter.
- No DOM access, no `window`, no fetch. If it needs those, it belongs in the UI layer.
- Streams or `File`/`Blob` for anything large. Never load a whole video into a string.
- Throws typed errors with actionable messages — see rule 17 in spirit: errors say what
  went wrong and how to fix it.

---

## 4. Build order

`tool-matrix.csv` is sorted by balanced priority. But priority is not build order —
infrastructure comes first, and cheap tools before expensive ones so the shell gets
exercised early.

### Phase 0 — Foundation (no tools)
Shell, routing, per-page metadata, sitemap, PWA manifest and service worker, deploy pipeline,
the `Tool` contract, and the shared component set (dropzone, copy button, code pane, options
panel). Ship it with two trivial tools to prove the pipeline end to end.

### Phase 1 — Pure text and generators
Cheapest tier. Exercises the contract, the curl API, and the pipeline types with no heavy deps.

`epoch-converter` · `cron` · `case` · `lines` · `escape` · `base-convert` · `uuid` ·
`password` · `hash` · `keycode` · `json-tools` · `qr-generator` · `discord-time` ·
`snowflake` · `iso-week` · `duration` · `random` · `unicode` · `ua` · `url` ·
`placeholder` · `fake-data` · `figlet`

Ship the **command palette** and the **curl API** at the end of this phase — both need a
critical mass of tools to be worth anything, and both score near the top of the matrix.

### Phase 2 — Files, no heavy wasm
`image-tools` · `favicon` · `svg-optimize` · `file-id` · `csv` · `data-convert` · `diff` ·
`sql-format` · `json-schema` · `json-to-types` · `compress` · `clipboard` · `invisibles` ·
`mojibake` · `to-markdown` · `count`

Add **pop-out windows** (Document PiP) here — highest-scoring item in the whole matrix,
cheap, and it applies retroactively to everything already built.

### Phase 3 — Media core
Build the shared ffmpeg.wasm worker once, then the family:
`discord-compressor` · `av-converter` · `video-to-gif` · `audio-trim` · `gif-tools` ·
`frame-extract` · `frame-trim` · `subtitles` · `spectrogram`

### Phase 4 — High-value heavy and novel
`decode` · `dmarc` · `email-headers` · `redact` · `oauth-scopes` · `pdf` · `sqlite` ·
`transcribe` · `remove-bg` · `ocr` · `har` · `smart` · `wireguard`

### Phase 5 — personal and low-Reach
FS Access tools (`rename`, `dupes`, `folder-diff`, `batch`), hardware tools (`serial`, `hid`,
`flash`, `ble`), and the niche ones (`oryx-diff`, `factorio`, `gam`, `jinja`). All useful,
none suitable as public landing pages. Build when wanted, not on a schedule.

### Phase 6 — Pipelines
The composable pipeline builder. Highest moat score, highest cost (D+ effort). Deliberately
last: the contract from rule 27 must already be proven across ~60 tools before the builder is
worth writing, and building it early risks stalling the project.


---

## 5. Definition of done, per tool

A tool ships when all of these are true:

- [ ] `run()` is pure, typed, and unit-tested with at least the happy path and two edge cases
- [ ] Input accepted by paste, drop, and file picker (where the type allows)
- [ ] Output has a working copy or download action
- [ ] State round-trips through the URL fragment
- [ ] Keyboard-operable start to finish; visible focus rings
- [ ] Capability-gated with an honest message if it needs Chrome, desktop, or specific hardware
- [ ] Page copy written: what it does, how to use it, why it beats the incumbent, short FAQ
- [ ] Metadata complete: title, description, canonical, OG image, JSON-LD
- [ ] No third-party network requests at runtime — verify in the network panel
- [ ] Heavy deps lazy-loaded, shell bundle unchanged
- [ ] Works offline after first load

---

## 6. Things to not do

- Do not put tool logic inside a component. Rule 27 exists because retrofitting it across
  168 tools would be brutal.
- Do not add a backend to make a tool nicer. Descope instead.
- Do not add analytics beacons, error reporting SDKs, or CDN-hosted libraries. Self-host.
- Do not use `localStorage` for user content, or the query string for shareable state.
  - Caveot: *do* use localStorage for user settings (theme, bookmarks, control+k tool search)
- Do not add a TURN server to make `drop` work through symmetric NAT. Fail honestly instead.
- Do not build the pipeline UI early.
- Do not ship all 168 pages at once.
- Do not claim "nothing leaves your device" on a page that makes any network request.

---

## 7. Files

| File | Purpose |
|---|---|
| `tool-matrix.csv` | All 168 tools: slug, description, category, four grades, balanced priority |
| `tool-matrix.html` | Same data, sortable and filterable, with four ranking presets |
| `PROJECT.md` | This document |

Grading key: **A+ is always best.** Effort A+ means cheapest to build, assuming shared cores
already exist. Utility A+ means most useful times largest audience. Alternatives A+ means
nothing decent exists today. Reach A+ means it runs everywhere including mobile.
