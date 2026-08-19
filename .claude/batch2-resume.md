# Batch 2 resume state (written 2026-08-18, pre-reboot)

Quest: build the next 16 unbuilt tool-matrix rows (continuation of the ultraquest
"do the next planned tools"). All process decisions carry over from the batch 1
interview: strict matrix order, sonnet/opus tiering, orchestrator wires
registry/worker/PanelHost, deploy by pushing to main, then browser QA of every
tool live via gstack /browse, no em or en dashes, rule 27 purity.

## DONE (committed locally as 9c8e324, NOT yet pushed)

- 16 logic layers, all tests green (suite total 6240), lint 0, typecheck 0,
  build green (126 pages): color-blindness-simulator, exif-time-shifter,
  passkey-tester, bookmarklets, dns-lookup, subnet-calculator, timezone-planner,
  protobuf-decoder, mcp-inspector, certificate-decoder, browser-privacy-check,
  webrtc-tester, docker-compose-converter, promql-formatter,
  speculation-rules-generator, ohms-law-calculator.
- registry.ts wired (124 tools). tool-icons.ts: 11 icons added.
- worker/index.ts: 5 new expose() endpoints (subnet-calculator GET,
  ohms-law-calculator GET, certificate-decoder POST, docker-compose-converter
  POST, promql-formatter POST) + new worker/mcp-relay.ts (restricted MCP CORS
  relay at /api/mcp-relay: method allowlist, https-only, origin-pinned CORS,
  foreign-Origin 403; security review addressed).
- Deps added (lockfile regenerated with npm@10.9.2): cbor-x, @msgpack/msgpack,
  @peculiar/x509 (+reflect-metadata; must be FIRST import), documented in
  .claude/tool-authoring.md.
- 2 of 8 bespoke panels finished and committed but NOT yet registered in
  PanelHost.vue: DnsLookupPanel.vue, ExifShiftPanel.vue.

## IN FLIGHT AT REBOOT (agents killed; files may exist PARTIAL and UNCOMMITTED)

Untracked, unverified, possibly half-written panel files. DELETE any of these
that exist and rebuild (or finish by hand after review) before trusting them:
- src/components/tool/panels/ColorBlindnessPanel.vue (palette tab + canvas image sim tab, uses logic exports parseColor/simulateRgb/MATRICES/CVD_KINDS, download via @/lib/download)
- src/components/tool/panels/PasskeyPanel.vue (register/authenticate/decode tabs, navigator.credentials, error mapping, feeds serialized credential JSON to run())
- src/components/tool/panels/McpInspectorPanel.vue (interactive client: direct fetch + /api/mcp-relay fallback, initialize->initialized->tools/list, schema-driven call form, raw log, fragment state url+mode)
- src/components/tool/panels/BookmarkletsPanel.vue (shelf of draggable javascript: links via SHELF export + make-your-own + decode tabs; Vue blocks javascript: hrefs, set via setAttribute in onMounted)
- src/components/tool/panels/PrivacyCheckPanel.vue (collector for every PROBES id, button-triggered, feeds JSON to run(), grouped rows + raw JSON block)
- src/components/tool/panels/WebrtcTesterPanel.vue (live ICE gathering per STUN_SERVERS + no-STUN baseline + paste tab, feeds [{candidate,url}] JSON to run())

The full prompts for these 6 panels are in the session transcript; the sketches
above are enough to re-prompt fresh agents (model: opus for colorblind/passkey/
mcp, sonnet for bookmarklets/privacy/webrtc).

## REMAINING STEPS AFTER PANELS LAND

1. Register all 8 panels in src/components/tool/PanelHost.vue (alphabetical,
   defineAsyncComponent pattern).
2. Full gate: npx vitest run; npm run lint; npm run typecheck; npm run build.
   registry.test.ts validates PanelHost keys.
3. Push to main (pre-authorized) -> Cloudflare auto-deploys.
4. Browser QA every one of the 16 live at tools.maxhogan.dev via claude-in-chrome
   (per memory: QA uses claude-in-chrome, not gstack browse, for the periodic
   visual QA; either works for smoke). Deep-dive: mcp-inspector (direct +
   relay against a real public MCP server), exif-time-shifter (shift a real
   photo, re-download, verify), passkey-tester (ceremony starts; OS dialog
   cannot be completed by automation - verify error paths + decode),
   dns-lookup, webrtc-tester, browser-privacy-check, colorblind image sim,
   bookmarklets drag targets.
5. Curl-verify the 5 new /api endpoints + /api/mcp-relay guards (bad origin
   403, method allowlist 400, blocked host 400).
6. Update memory tools-project-state.md with batch 2 summary; delete this file.

## Judgment calls already made (do not re-litigate)

- Slug choices: protobuf-decoder (row binary-decode), webrtc-tester
  (webrtc-debug), promql-formatter (logql), docker-compose-converter
  (docker-convert), bookmarklets, others literal.
- mcp-relay never forwards Authorization; auth servers are client-direct only.
- protobuf wire-type-2 heuristic: strict-printable string wins over nested
  message parse (agent-documented, test-locked).
- exif: GPS tags untouched by design; JPEG+TIFF only.
