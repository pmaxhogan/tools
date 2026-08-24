import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "reverse-proxy-config-generator",
  matrixSlug: "proxy-config",
  icon: "Server",
  name: "Reverse Proxy Config Generator",
  description:
    "Generate nginx and Caddy reverse proxy configs with TLS, websockets, and security headers.",
  category: "Homelab",
  keywords: [
    "nginx reverse proxy config generator",
    "caddy reverse proxy",
    "nginx proxy_pass example",
    "reverse proxy websocket",
    "nginx ssl config",
  ],
  searchTerms: [
    "nginx server block generator",
    "caddyfile generator",
    "nginx letsencrypt config",
    "proxy_pass generator",
    "nginx websocket upgrade header",
    "caddy automatic https",
    "reverse proxy generator",
    "nginx security headers",
  ],
  input: "text/plain",
  output: "text/plain",
  inputOptional: {
    label: "Quick entry",
    hint: 'Optional. Type one line like "app.example.com -> http://127.0.0.1:3000" to set the domain and the upstream together, overriding those two options above. Every other option still applies.',
  },
  http: { method: "GET", contentType: "text/plain" },
  options: [
    {
      kind: "select",
      id: "server",
      label: "Server",
      default: "nginx",
      options: [
        { value: "nginx", label: "nginx", synonyms: ["nginx.conf", "server block"] },
        { value: "caddy", label: "Caddy", synonyms: ["caddyfile", "caddy server"] },
        { value: "both", label: "Both", synonyms: ["nginx and caddy", "both configs"] },
      ],
    },
    {
      kind: "text",
      id: "domain",
      label: "Domain",
      default: "app.example.com",
      placeholder: "app.example.com",
    },
    {
      kind: "text",
      id: "upstream",
      label: "Upstream",
      default: "http://127.0.0.1:3000",
      placeholder: "http://127.0.0.1:3000",
    },
    { kind: "boolean", id: "tls", label: "TLS (HTTPS)", default: true },
    { kind: "boolean", id: "websockets", label: "WebSocket support", default: true },
    { kind: "boolean", id: "securityHeaders", label: "Security headers", default: true },
    { kind: "boolean", id: "realIp", label: "Forward real client IP", default: true },
    { kind: "boolean", id: "gzip", label: "Gzip compression", default: true },
    {
      kind: "number",
      id: "maxBodyMb",
      label: "Max upload size (MB)",
      default: 50,
      min: 1,
      max: 10000,
    },
    {
      kind: "number",
      id: "timeoutSec",
      label: "Proxy timeout (seconds)",
      default: 60,
      min: 1,
      max: 3600,
    },
    {
      kind: "select",
      id: "cache",
      label: "Static asset caching",
      default: "none",
      options: [
        { value: "none", label: "None", synonyms: ["no caching", "disabled"] },
        {
          value: "static-assets",
          label: "Cache static assets",
          synonyms: ["css js images", "long lived cache", "expires 30d"],
        },
      ],
    },
    { kind: "boolean", id: "wwwRedirect", label: "Redirect www to apex domain", default: false },
  ],
  copy: {
    what: "Builds a complete nginx server block or Caddyfile site block for proxying a domain to a local or internal upstream, with TLS termination, websocket upgrade headers, common security headers (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy), real client IP forwarding, gzip, upload size limits, proxy timeouts, static asset caching, and an optional www to apex redirect. It can generate nginx, Caddy, or both at once.",
    how: "Type a line like app.example.com -> http://127.0.0.1:3000, or fill in the domain and upstream fields directly, then toggle the options for TLS, websockets, headers, caching, and redirects. Copy the nginx block into /etc/nginx/sites-available or the Caddyfile block into /etc/caddy/Caddyfile, then reload the server.",
    why: "Most nginx and Caddy examples online are partial snippets missing websocket headers, security headers, or a working TLS redirect, so you end up stitching several tabs together. This generates a complete, working config for either server in one pass, entirely in your browser: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does nginx need the Upgrade header for websockets?",
        a: 'nginx proxies HTTP/1.1 connections by default without forwarding the Connection and Upgrade headers, so a websocket handshake fails silently behind a plain proxy_pass. Setting proxy_http_version 1.1 plus proxy_set_header Upgrade $http_upgrade and Connection "upgrade" tells nginx to pass the handshake through instead of terminating it as a normal HTTP request.',
      },
      {
        q: "Where do the TLS certificates come from?",
        a: "The nginx output points at the standard certbot path, /etc/letsencrypt/live/<domain>/fullchain.pem and privkey.pem, which Certbot creates when you run certbot certonly or certbot --nginx for that domain. Caddy skips this entirely: it requests and renews certificates from Let's Encrypt automatically the first time it serves the site, so the Caddy block needs no certificate paths at all.",
      },
      {
        q: "How do I test the config before reloading?",
        a: "For nginx, run nginx -t (or sudo nginx -t), which parses every config file and reports the first syntax error with a line number, then reload with systemctl reload nginx once it passes. For Caddy, run caddy validate --config /etc/caddy/Caddyfile, or just caddy reload, which validates the new config before it swaps in and leaves the old one running if validation fails.",
      },
    ],
  },
};
