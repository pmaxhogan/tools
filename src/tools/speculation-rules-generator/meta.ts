import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "speculation-rules-generator",
  matrixSlug: "speculation",
  icon: "Zap",
  name: "Speculation Rules Builder",
  description: "Build and validate prerender and prefetch rule sets for the Speculation Rules API.",
  category: "Dev",
  keywords: [
    "speculation rules generator",
    "prerender rules",
    "prefetch rules",
    "speculation rules api",
    "chrome prerender",
  ],
  searchTerms: [
    "speculationrules script tag",
    "document rules speculation",
    "url pattern prerender",
    "eagerness prefetch",
    "instant navigation chrome",
    "speculation rules validator",
    "prerender json builder",
    "href_matches",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "generate",
      options: [
        {
          value: "generate",
          label: "Generate rules",
          synonyms: ["build", "create", "author rules", "make rules"],
        },
        {
          value: "validate",
          label: "Validate rules",
          synonyms: ["check", "lint", "verify rules", "audit rules"],
        },
      ],
    },
    {
      kind: "select",
      id: "action",
      label: "Action (generate mode)",
      default: "prefetch",
      options: [
        {
          value: "prefetch",
          label: "Prefetch",
          synonyms: ["prefetch response", "background fetch", "speculative fetch"],
        },
        {
          value: "prerender",
          label: "Prerender",
          synonyms: ["prerender page", "speculative prerender", "full page prerender"],
        },
      ],
    },
    {
      kind: "select",
      id: "eagerness",
      label: "Eagerness (generate mode)",
      default: "moderate",
      options: [
        {
          value: "conservative",
          label: "Conservative: only on strong intent (e.g. pointerdown)",
          synonyms: ["safe", "low risk", "least eager", "hover confirmed"],
        },
        {
          value: "moderate",
          label: "Moderate: default browser heuristic timing",
          synonyms: ["default", "balanced", "medium", "recommended"],
        },
        {
          value: "eager",
          label: "Eager: triggers sooner, more bandwidth used",
          synonyms: ["aggressive", "early", "high eagerness"],
        },
        {
          value: "immediate",
          label: "Immediate: triggers as soon as the rule matches",
          synonyms: ["instant", "as soon as possible", "no delay", "highest eagerness"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "documentRules",
      label: "Use document (pattern) rules for URL patterns",
      default: true,
    },
    {
      kind: "boolean",
      id: "scriptTag",
      label: 'Wrap output in <script type="speculationrules">',
      default: true,
    },
  ],
  copy: {
    what: "Builds and validates Speculation Rules API JSON, the rule set browsers use to prefetch or prerender pages before a user clicks a link. In generate mode, paste one URL or URL pattern per line (use * or :param for a pattern, or prefix a line with not to exclude it) and get back document rules or a plain URL list, with an eagerness and action of your choice. In validate mode, paste an existing rule set (with or without the surrounding script tag) and get a verdict, a list of specific problems, and a plain-English description of what the rules actually do.",
    how: "Pick Generate or Validate at the top. For Generate, list your URLs or patterns, choose prefetch or prerender, pick an eagerness, and copy the resulting script tag straight into your page's head. For Validate, paste your JSON or full script tag and read the verdict: each finding names the exact key and what is wrong with it.",
    why: "Writing this JSON by hand means guessing at the where-clause grammar and eagerness values with no feedback until a real browser silently ignores a malformed rule. This tool builds the structure for you and, on the validate side, catches unknown keys, invalid eagerness values, and requirements used on the wrong rule type before you ship them. Your files and inputs never leave your device.",
    faq: [
      {
        q: "Which browsers actually support the Speculation Rules API?",
        a: "Chromium-based browsers (Chrome and Edge) support it today; prefetch shipped first and prerender followed. Firefox and Safari do not implement it, so treat it as a progressive enhancement: unsupported browsers simply ignore the script tag.",
      },
      {
        q: "What does the eagerness setting actually change?",
        a: "Eagerness controls how much user intent the browser waits for before firing the speculative request. Conservative waits for a strong signal like a pointer press, moderate uses the browser's own heuristic (typically a hover held briefly), eager fires on a lighter hover, and immediate fires the instant the rule matches, at the cost of more wasted bandwidth on links never followed.",
      },
      {
        q: "How do I check whether a rule actually fired?",
        a: "In Chrome, open chrome://process-internals and check the Preloading tab for the URL's status (its history shows exactly why a candidate was or was not used). Alternatively, open DevTools, go to the Application tab, and look under Speculative loads for each rule's match status and failure reason.",
      },
    ],
  },
};
