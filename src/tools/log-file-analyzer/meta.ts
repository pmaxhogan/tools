import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "log-file-analyzer",
  icon: "ScrollText",
  name: "Log File Analyzer",
  description:
    "Summarize an access or application log: traffic, status codes, top paths, slow requests and errors, without uploading it anywhere.",
  category: "Homelab",
  keywords: [
    "log file analyzer",
    "nginx log analyzer",
    "apache access log parser",
    "json log viewer",
    "log file statistics",
    "top requests by status code",
    "find errors in log file",
    "web server log report",
  ],
  searchTerms: [
    "access log",
    "combined log format",
    "clf parser",
    "logfmt",
    "goaccess alternative",
    "server log stats",
    "404 report",
    "5xx errors",
    "slow request finder",
    "top ip addresses in log",
    "user agent breakdown",
    "syslog reader",
    "ndjson logs",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "view",
      label: "Sections",
      default: "all",
      options: [
        {
          value: "all",
          label: "Everything",
          synonyms: ["all", "full report", "complete", "show everything"],
        },
        {
          value: "traffic",
          label: "Traffic only",
          synonyms: ["paths", "top urls", "visitors", "addresses", "bandwidth", "user agents"],
        },
        {
          value: "errors",
          label: "Errors only",
          synonyms: ["failures", "4xx", "5xx", "exceptions", "stack traces", "status codes"],
        },
        {
          value: "timing",
          label: "Timing only",
          synonyms: ["slow requests", "latency", "duration", "response time", "performance"],
        },
      ],
    },
    {
      kind: "number",
      id: "top",
      label: "Entries per top list",
      default: 10,
      min: 1,
      max: 50,
      step: 1,
    },
    { kind: "boolean", id: "maskIps", label: "Mask the host part of every address", default: true },
    {
      kind: "boolean",
      id: "stripQuery",
      label: "Group paths ignoring the query string",
      default: true,
    },
  ],
  examples: [
    {
      label: "nginx access log",
      input: [
        '203.0.113.14 - - [30/Aug/2026:06:00:00 +0000] "GET / HTTP/1.1" 200 5120 "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0" 0.031',
        '203.0.113.14 - - [30/Aug/2026:06:00:12 +0000] "GET /assets/app.js HTTP/1.1" 200 184320 "https://example.com/" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0" 0.008',
        '198.51.100.23 - - [30/Aug/2026:06:05:41 +0000] "GET /wp-login.php HTTP/1.1" 404 310 "-" "curl/8.7.1" 0.004',
        '198.51.100.23 - - [30/Aug/2026:06:31:02 +0000] "POST /api/v1/report HTTP/1.1" 500 512 "-" "curl/8.7.1" 4.250',
        '192.0.2.7 - - [30/Aug/2026:07:12:09 +0000] "GET /pricing HTTP/1.1" 200 9210 "https://example.com/" "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1" 0.062',
      ].join("\n"),
    },
    { label: "Longer sample log", file: "sample.log" },
  ],
  copy: {
    what: "Reads a log file and reports what is actually in it: which format it is, how many lines parsed, the time span the log covers, the split of responses across 2xx, 3xx, 4xx and 5xx, the busiest paths, addresses and user agents, total bytes served, the slowest requests, and a sample of the error lines. It recognizes the Apache and nginx combined and common access log formats, JSON lines with the usual field names, and any plain log whose lines start with an ISO 8601 or syslog timestamp. Files up to 50 MB are read in one pass.",
    how: "Paste log lines into the input, or drop a .log or .txt file onto it. The format is detected from the first lines and named in the result along with how much of the sample it matched. Use the options to resize the top lists, keep query strings separate from their path, show addresses in full instead of masked, or narrow the report to just traffic, errors, or timing.",
    why: "Log analyzers on the web want the file on their server, which means handing over every address and request path your users generated. This one runs the parser in your browser, so your files and inputs never leave your device, and it needs no install, no config file, and no account. GoAccess and awk pipelines are still the right answer for a log you own on a machine you control; this is for the log someone just sent you.",
    faq: [
      {
        q: "Which log formats does it understand?",
        a: "The Apache and nginx combined and common access log formats (including a trailing $request_time or rt= field), JSON lines with one object per line, and generic lines that begin with an ISO 8601 or syslog timestamp. For JSON it looks up fields by the usual names, so timestamp, time or @timestamp for the time, status or status_code for the response, path, url or request for the target, and duration_ms, latency or request_time for the time taken.",
      },
      {
        q: "Why are the IP addresses shown with an x at the end?",
        a: "The last octet of an IPv4 address (or the last group of an IPv6 address) is masked by default, because that is the part that identifies a specific machine while the rest is what makes a top list useful. Turn off the masking option to see them in full. Either way the log stays in your browser.",
      },
      {
        q: "What happens to lines it cannot parse?",
        a: "They are counted in the skipped total rather than dropped silently, and they are still scanned for the words ERROR, FATAL, CRITICAL, PANIC and EXCEPTION, so a stack trace sitting in the middle of an access log still shows up in the error samples.",
      },
    ],
  },
};
