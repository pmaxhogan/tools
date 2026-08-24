import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "echo",
  matrixSlug: "echo",
  icon: "Radio",
  name: "Echo Endpoint",
  description: "A curl-able endpoint that reflects your request, headers, and IP back at you.",
  category: "Platform",
  keywords: [
    "echo endpoint",
    "httpbin alternative",
    "request inspector",
    "what is my ip",
    "webhook tester",
  ],
  searchTerms: [
    "httpbin",
    "requestbin",
    "curl test endpoint",
    "webhook debugging",
    "check my headers",
    "what headers am i sending",
    "reflect request",
    "test post request",
    "my ip address curl",
    "request bin",
    "curl echo endpoint",
  ],
  input: "application/json",
  output: "application/json",
  privacyNote:
    "Calling the echo endpoint sends that one request to this site's Worker so it can be reflected back to you. Nothing about it is stored or logged; it exists only in the response you get.",
  options: [
    {
      kind: "select",
      id: "format",
      label: "Format",
      default: "json",
      options: [
        { value: "json", label: "JSON", synonyms: ["pretty json", "raw json"] },
        { value: "text", label: "Plain text", synonyms: ["plain", "txt", "lines"] },
        { value: "table", label: "Table", synonyms: ["rows", "record", "key value"] },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Reflects everything about the request that reached it: method, path, query string, headers, IP address, and Cloudflare's geo and network metadata. Useful for debugging what a proxy or CDN is rewriting, checking your outbound IP, or seeing exactly what headers a script sends.",
    how: "Call /api/echo with curl, or use the on-page button to fire a request from your own browser. Sensitive headers like Authorization and Cookie are shown as a redacted placeholder rather than their real value. Switch the format between JSON, plain text, and a table depending on what you are piping the output into.",
    why: "Same idea as httpbin.org, but self-hosted here, with no rate limit and no third party seeing your headers pass through their infrastructure first. The redaction rules mean you can point real requests at it, including ones carrying an API key, without that key ending up echoed back into your terminal.",
    faq: [
      {
        q: "What is my IP and where does it come from?",
        a: "The IP, country, city, and ASN come from Cloudflare's request metadata for the connection that reached this Worker, the same data every Cloudflare-fronted site sees for every visitor.",
      },
      {
        q: "Is my request stored anywhere?",
        a: "No. The request is reflected back in the response and never logged or written to storage by this site's code.",
      },
      {
        q: "How do I test webhooks with it?",
        a: 'POST a body to /api/echo, exactly like a webhook sender would, for example curl -X POST -d \'{"event":"test"}\' https://tools.maxhogan.dev/api/echo. The response shows the body, its byte length, and every header the sender included.',
      },
    ],
  },
};
