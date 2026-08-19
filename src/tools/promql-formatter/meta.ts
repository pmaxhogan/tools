import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "promql-formatter",
  matrixSlug: "logql",
  icon: "ScrollText",
  name: "LogQL & PromQL Formatter",
  description: "Format and explain Loki and Prometheus queries in plain English.",
  category: "Homelab",
  keywords: [
    "promql formatter",
    "logql formatter",
    "prometheus query formatter",
    "loki query explainer",
    "promql pretty print",
    "explain promql query",
    "grafana query formatter",
  ],
  searchTerms: [
    "prettify promql",
    "beautify logql",
    "what does this prometheus query do",
    "loki pipeline stages",
    "promql indent",
    "rate vs irate",
    "unwrap logql",
    "prometheus alert rule formatter",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "lang",
      label: "Query language",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Detect automatically",
          synonyms: ["auto", "guess", "detect", "either"],
        },
        {
          value: "promql",
          label: "PromQL (Prometheus)",
          synonyms: ["prometheus", "prom", "metrics", "alertmanager", "thanos", "mimir"],
        },
        {
          value: "logql",
          label: "LogQL (Loki)",
          synonyms: ["loki", "logs", "grafana loki", "log query"],
        },
      ],
    },
    {
      kind: "select",
      id: "mode",
      label: "Output",
      default: "format",
      options: [
        {
          value: "format",
          label: "Formatted query",
          synonyms: ["format", "pretty print", "prettify", "beautify", "indent"],
        },
        {
          value: "explain",
          label: "Plain English explanation",
          synonyms: ["explain", "describe", "what does this do", "breakdown"],
        },
        {
          value: "both",
          label: "Formatted query and explanation",
          synonyms: ["both", "everything", "all"],
        },
      ],
    },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Pretty prints PromQL and LogQL queries and, if you want, walks through what each part actually does. It indents nested function calls and aggregations two spaces per level, breaks long label matcher blocks onto one matcher per line, puts every Loki pipeline stage on its own line, and normalizes the spacing around operators, offsets, and @ modifiers. Explain mode produces a numbered list: which series or log streams get selected, what each filter and parse stage does, what the range window and subquery mean, and what the functions and aggregations compute. It reads both languages and can tell them apart on its own.",
    how: "Paste a query and pick an output: formatted, explained, or both. Leave the language on detect automatically unless a query is ambiguous, then choose PromQL or LogQL by hand. Copy the result with the button next to it, and share the page URL to hand someone the exact query you were looking at.",
    why: "Grafana can prettify a query only once it is already typed into the right datasource panel, and the online formatters that do this in a browser tab tend to be wrapped in ads or ask you to sign in first. This one runs entirely in your browser, so a production query with real hostnames and customer identifiers in its label matchers never leaves your device. It also explains the query rather than only reindenting it, and it will not reject a query it cannot fully parse: it normalizes what it can and says so.",
    faq: [
      {
        q: "Does it validate my query?",
        a: "Only loosely. It flags unbalanced parentheses and braces with the position of the offending bracket, but it is a formatter, not a Prometheus or Loki parser, so it will happily reformat a query that the real engine would reject. Anything it cannot fully read is whitespace normalized and reported as not explained.",
      },
      {
        q: "Is the formatting stable if I run it twice?",
        a: "Yes. Formatting an already formatted query returns exactly the same text, so you can paste it into a dashboard or an alert rule file and reformat later without churn in your diffs.",
      },
      {
        q: "How does it tell PromQL and LogQL apart?",
        a: 'It tokenizes first, then looks for LogQL line filters and pipeline stages outside of string literals, so a regex alternation like job=~"api|web" is not mistaken for a pipe. A query that starts with a stream selector is also treated as LogQL. Override it with the language dropdown when a query sits on the fence.',
      },
    ],
  },
};
