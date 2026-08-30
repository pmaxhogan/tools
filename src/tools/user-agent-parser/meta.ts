import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "user-agent-parser",
  icon: "MonitorSmartphone",
  matrixSlug: "ua",
  name: "User-Agent Parser",
  description:
    "Decode a raw User-Agent string into browser name and version, rendering engine, operating system, and device type.",
  category: "Network",
  keywords: [
    "user agent parser",
    "ua parser",
    "user agent string",
    "what is my user agent",
    "browser detection",
    "device detection",
    "parse user agent",
  ],
  searchTerms: [
    "ua string decoder",
    "browser sniffer",
    "device detection tool",
    "what browser am i using",
    "bot detection from user agent",
    "client hints parser",
    "os detection from ua",
    "identify browser from header",
    "server log user agent lookup",
    "safari version detector",
    "chrome version from ua",
    "mobile vs desktop user agent",
  ],
  input: "text/plain",
  output: "application/json",
  examples: [
    {
      label: "Safari on macOS",
      input:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    },
  ],
  http: { method: "POST", contentType: "application/json" },
  copy: {
    what: 'Decodes a raw User-Agent string into its parts: browser name and version, rendering engine, operating system, device vendor/model/type, CPU architecture when present, and whether the string belongs to a known bot or crawler. Handles desktop, mobile, and bot UAs, including unrecognized ones (returned as "Unknown" rather than an error).',
    how: 'Paste a User-Agent string, from a server log, a bug report, or your own browser (search "what is my user agent" to find it), and get back a labeled breakdown of every field ua-parser-js can identify. Each row has its own copy button.',
    why: "UA-lookup sites are typically ad-heavy and log what you paste. This one runs the parse entirely in your browser, works offline after first load, and never sends the string anywhere.",
    faq: [
      {
        q: 'Why are some rows missing or say "Unknown"?',
        a: 'Not every User-Agent string carries every field: bots in particular often omit device and CPU details entirely. Fields the parser can\'t detect are shown as "Unknown" rather than guessed.',
      },
      {
        q: "How does it detect bots?",
        a: "It checks the string against ua-parser-js's bot-detection list (covering known crawlers, AI bots, and CLI tools like curl/wget) plus a fallback check for common bot-like substrings.",
      },
      {
        q: "Can I check my own browser's User-Agent?",
        a: 'Search "what is my user agent" to find the exact string your browser sends, then paste it in here for the full breakdown.',
      },
    ],
  },
};
