import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "urlpattern-tester",
  matrixSlug: "urlpattern",
  name: "URLPattern Tester",
  description: "Test route patterns against URLs and inspect every matched group.",
  category: "Dev",
  keywords: [
    "urlpattern tester",
    "url pattern matcher",
    "route pattern test",
    "named route groups",
    "url matching",
    "urlpattern api",
  ],
  searchTerms: [
    "url pattern",
    "route matcher",
    "path matching",
    "does this route match",
    "wildcard url match",
    "service worker route test",
    "router debug",
    "express route pattern test",
    "path-to-regexp tester",
    "named group url match",
  ],
  icon: "Route",
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "text",
      id: "pattern",
      label: "URLPattern",
      default: "",
      placeholder: "/users/:id",
    },
    {
      kind: "text",
      id: "baseURL",
      label: "Base URL (optional)",
      default: "",
      placeholder: "https://example.com",
    },
  ],
  examples: [
    {
      label: "Product route match",
      input: "https://shop.example.com/products/electronics/42",
      opts: { pattern: "/products/:category/:id", baseURL: "https://shop.example.com" },
    },
  ],
  copy: {
    what: "Checks a URLPattern against one URL or a whole list of them and shows exactly what matched. For a single URL you get a detailed breakdown: every component's captured groups, listed as pathname.groups.id, hostname.groups.sub, and so on. For several URLs you get one row each, with a match or no match verdict and the captured groups inline, plus a count of how many matched. It also echoes back how the browser parsed your pattern into protocol, hostname, pathname, search, and hash so you can see where a stray slash or colon landed.",
    how: 'Type the pattern into the URLPattern field, for example "/users/:id" or "https://:sub.example.com/*". Relative patterns need a base, so fill in the Base URL field with something like https://example.com. Paste the URLs to test into the input box, one per line, then read the results. Relative URLs such as /users/42 work too when a base URL is set, and the URL updates as you go so you can share a pattern and its test cases in one link.',
    why: "Working out why a route does not match usually means editing router config, restarting a dev server, and reloading a page for every guess. This runs the real URLPattern implementation your browser ships, so what you see here is what your router, service worker, or Cloudflare Worker will do. There are no ads, no sign in, and no request limits, and the matching runs in this tab, so your files and inputs never leave your device.",
    faq: [
      {
        q: "What is URLPattern?",
        a: "URLPattern is a built in browser API for matching URLs against a pattern, the same idea as an Express or React Router path but standardized. It matches each URL component separately (protocol, hostname, port, pathname, search, hash) and returns the captured groups. This page uses the native implementation when your browser has one and a polyfill when it does not, so results match the API either way.",
      },
      {
        q: "Named groups and wildcards?",
        a: 'A named group is a colon followed by a name, so "/users/:id" captures 42 from /users/42 as the group id. A star is a wildcard that captures whatever it spans and reports it under a numbered group, so "/files/*" captures docs/report.pdf as pathname.groups.0. Groups also work in the hostname, as in "https://:sub.example.com/*", and you can make a segment optional with a question mark.',
      },
      {
        q: "Which frameworks use this?",
        a: "Chrome, Deno, and recent Node builds expose URLPattern natively, and it backs routing in Workbox service worker routes, Cloudflare Workers routers such as itty-router, Deno and Fresh, and several newer client side routers. Even when your framework uses its own matcher, the syntax is close enough that testing here catches most pattern mistakes before you touch the config.",
      },
    ],
  },
};
