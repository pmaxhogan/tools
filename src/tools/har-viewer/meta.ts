import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "har-viewer",
  icon: "Network",
  matrixSlug: "har",
  name: "HAR Viewer",
  description: "Waterfall view, search and privacy-aware export for browser network captures.",
  category: "Data",
  keywords: [
    "har file viewer",
    "open har file online",
    "har waterfall",
    "analyze network capture",
    "sanitize har file",
    "har file analyzer",
    "read har file",
  ],
  searchTerms: [
    "http archive viewer",
    "network tab export viewer",
    "chrome devtools export viewer",
    "redact har file",
    "find slow requests",
    "network waterfall chart",
    "remove cookies from har",
    "inspect network capture",
    "devtools network export",
    "network request viewer",
    "api call inspector",
  ],
  input: "application/json",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary and waterfall",
          synonyms: ["overview", "at a glance"],
        },
        {
          value: "waterfall",
          label: "Full waterfall",
          synonyms: ["timeline view", "request timeline", "full timeline"],
        },
        {
          value: "slowest",
          label: "Slowest requests",
          synonyms: ["slow requests", "highest latency", "longest duration"],
        },
        {
          value: "largest",
          label: "Largest responses",
          synonyms: ["biggest responses", "largest payload", "biggest transfer size"],
        },
        {
          value: "domains",
          label: "Domains",
          synonyms: ["hosts", "by domain", "domain breakdown"],
        },
      ],
    },
    {
      kind: "text",
      id: "filter",
      label: "URL contains",
      default: "",
      placeholder: "e.g. /api/ or analytics",
    },
    {
      kind: "select",
      id: "status",
      label: "Status",
      default: "all",
      options: [
        { value: "all", label: "All", synonyms: ["every status", "no filter"] },
        {
          value: "2xx",
          label: "2xx success",
          synonyms: ["success", "ok responses", "200 status"],
        },
        {
          value: "3xx",
          label: "3xx redirect",
          synonyms: ["redirects", "300 status", "redirected"],
        },
        {
          value: "4xx",
          label: "4xx client error",
          synonyms: ["client errors", "400 status", "not found", "bad request"],
        },
        {
          value: "5xx",
          label: "5xx server error",
          synonyms: ["server errors", "500 status", "internal server error"],
        },
      ],
    },
    {
      kind: "number",
      id: "minMs",
      label: "Minimum duration (ms)",
      default: 0,
      min: 0,
      max: 600000,
      step: 50,
    },
  ],
  copy: {
    what: "Opens a .har network capture from Chrome, Firefox, Safari or Charles and turns it into something readable: a summary of requests, transfer size and time span, a waterfall of every request laid out on the capture timeline with dns, connect, wait and receive phases, and leaderboards for the slowest requests, the largest responses and the busiest domains. Search by URL, filter by status class or MIME type, and hide anything faster than a threshold you set. It also scans the capture for cookies, Authorization headers, request bodies and credential shaped query parameters, and can hand back a sanitized copy with all of them redacted.",
    how: 'Drop the .har file onto the page or paste its contents. Use the search box, the status filter and the minimum duration to narrow the table, click a column heading to sort by start, duration or size, and click any row to see its request and response headers. Sensitive headers show as redacted until you press the eye button next to one. If you need to attach the capture to a bug report, press "Download sanitized copy" first and send that file instead.',
    why: "The other HAR viewers ask you to upload a file that contains your session cookies and bearer tokens to their server, which is a wild thing to ask for a read only preview. This one parses the file in the tab you already have open, shows you exactly how many credentials are sitting inside it, and can hand you a redacted copy that is safe to attach to a ticket.",
    faq: [
      {
        q: "What is in a HAR file that makes it sensitive?",
        a: "A capture records complete requests and responses. That means your Cookie and Set-Cookie headers, Authorization bearer tokens, API keys in query strings, form posts including passwords, and, if the capture was saved with response bodies, the content of every page and API reply. Anyone holding the file can usually replay your session.",
      },
      {
        q: "How does the sanitizer decide what to remove?",
        a: "It empties the cookie arrays on both the request and the response, redacts the Cookie, Set-Cookie, Authorization and Proxy-Authorization headers by name regardless of casing, replaces request bodies with a note of their size, redacts query parameters whose name contains token, key, auth, session, password, code or signature in both the parsed list and the URL itself, and drops captured response bodies. Everything else in the file, including timings, cache blocks and vendor extensions, is preserved so the sanitized copy still opens in any HAR tool.",
      },
      {
        q: "Is my capture uploaded anywhere?",
        a: "No. The file is read and rendered in the browser, and the sanitized download is built in the same tab: your files and inputs never leave your device. This tool deliberately has no API endpoint, because sending a HAR file over the wire is exactly the risk it exists to remove.",
      },
    ],
  },
};
