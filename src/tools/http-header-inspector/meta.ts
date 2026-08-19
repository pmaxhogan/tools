import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "http-header-inspector",
  matrixSlug: "headers",
  icon: "FileSearch",
  name: "HTTP Header Inspector",
  description: "See exactly what headers your browser is sending.",
  category: "Network",
  keywords: [
    "what headers is my browser sending",
    "http request headers",
    "view my request headers",
    "user agent header",
    "accept-language header",
    "sec-ch-ua",
  ],
  searchTerms: [
    "request header viewer",
    "client hints checker",
    "fetch metadata headers",
    "check my headers",
    "curl reproduce my headers",
    "browser fingerprint headers",
    "what is my ip header",
    "sec-fetch headers explained",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "explained",
      options: [
        {
          value: "explained",
          label: "Explained",
          synonyms: ["annotated", "with descriptions", "default", "labeled"],
        },
        {
          value: "raw",
          label: "Raw values",
          synonyms: ["values only", "plain", "no explanations", "unexplained"],
        },
        {
          value: "curl",
          label: "As curl command",
          synonyms: ["curl", "reproduce with curl", "curl -h", "shell command"],
        },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  privacyNote:
    "Your headers are shown to you by this site's own worker and are not stored or logged by its code.",
  copy: {
    what: 'Shows the HTTP request headers a browser is sending, with a labeled explanation for each one: User-Agent, Accept-Language, the Sec-CH-UA client hints, the Sec-Fetch-* metadata headers, caching and proxy headers, and more. Works on your own live headers, fetched with one click from this site\'s own API, or on any header text or JSON object you paste in, including a captured curl -v transcript. A raw values view and a ready-to-run curl command are also available.',
    how: 'Click "Show my headers" to fetch and analyze exactly what your browser just sent to this site, or paste header lines or a JSON object of headers into the input yourself. Switch the view between an explained breakdown, raw values only, or a curl command that reproduces the same request. The Cookie and Authorization values are always redacted to a length in the explained and curl views.',
    why: "Most \"what headers am I sending\" pages just read navigator.userAgent from JavaScript, which is not what a server actually receives once client hints, Fetch Metadata, and any proxy in front of it add or strip headers along the way. This tool reads the request headers this site's own worker actually received, explains what each one reveals and how identifying it is, and never stores or logs them.",
    faq: [
      {
        q: "Why doesn't this match navigator.userAgent?",
        a: "navigator.userAgent is only what JavaScript can read from inside the page. The real HTTP request also carries headers JavaScript cannot see directly, such as Sec-Fetch-Site, Accept-Language, and whatever a proxy in front of the server injects, like a Cloudflare CF-Connecting-IP header. Show my headers fetches the exact header set this site's own worker received for that request.",
      },
      {
        q: "Are my Cookie or Authorization headers exposed anywhere?",
        a: "No. The explained and curl views always redact the Cookie and Authorization values, showing only their length, so a copied report or command never carries a live session token or credential. The raw view shows the true values, since it exists to show exactly what your browser sent, and none of it is sent anywhere else.",
      },
      {
        q: "What are the Sec-CH-UA and Sec-Fetch headers?",
        a: "Sec-CH-UA and its siblings are Client Hints, a structured, opt-in replacement for parsing browser and OS details out of the User-Agent string. Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest, and Sec-Fetch-User are Fetch Metadata headers that tell the server the relationship and purpose of a request, mainly used for defensive checks like blocking a cross-site image load from acting like a navigation.",
      },
    ],
  },
};
