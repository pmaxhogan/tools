# tools.maxhogan.dev

Fast, private developer tools that run entirely in your browser. No ads, no
accounts, no limits. Your files and inputs never leave your device.

Live at [tools.maxhogan.dev](https://tools.maxhogan.dev).

## The pledge

- No ads, no upsells, no email capture, no "sign up to download", no watermarks.
- No artificial limits: no file-size caps, no uses-per-day, no formats behind a tier.
- Client-side by default. A server is involved only where the browser genuinely
  cannot do the job, and any server code is stateless: pure request to response.
- Shareable state lives in the URL fragment, which is never sent to a server.
- No third-party requests at runtime. Fonts and libraries are self-hosted.
- MIT licensed, so all of the above is enforceable by fork.

## Architecture in one paragraph

Every tool is a pure, typed transform function (`src/tools/<slug>/index.ts`)
kept separate from its UI. The Astro site prerenders one static page per tool;
a small Vue island hydrates the interactive part and lazy-loads the tool's
logic chunk on that page only. The same functions power the curl API
(`/api/<slug>`, a Cloudflare Worker) because the logic never touches the DOM.

## curl API

Cheap, pure tools are exposed as stateless endpoints:

```
curl https://tools.maxhogan.dev/api            # list of endpoints
curl "https://tools.maxhogan.dev/api/epoch-converter?input=1754521200&tz=UTC"
```

Nothing is logged, nothing is stored.

## Development

```
npm install
npm run dev        # dev server
npm test           # vitest suite for all tool logic
npm run build      # static build + service worker generation
npm run lint       # eslint, including purity rules for src/tools
```

Adding a tool: see `.claude/tool-authoring.md` for the logic contract and
`PROJECT.md` for the project rules. Each tool ships with tests, page copy,
metadata, and offline support before it counts as done.

## License

MIT
