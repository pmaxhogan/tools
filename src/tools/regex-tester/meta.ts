import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "regex-tester",
  name: "Regex Tester",
  description:
    "Test a regular expression with live match highlighting, capture groups, a replace preview, and a plain English explanation of the pattern.",
  category: "Dev",
  keywords: [
    "regex tester",
    "regular expression tester",
    "regex online",
    "test regex pattern",
    "regex capture groups",
    "regex explainer",
    "javascript regex tester",
    "regex replace preview",
  ],
  searchTerms: [
    "regexp",
    "regex101",
    "regexr",
    "pattern matcher",
    "match highlighting",
    "named capture group",
    "lookahead lookbehind",
    "regex cheat sheet",
    "explain this regex",
    "find and replace regex",
    "regex debugger",
    "does my regex match",
  ],
  icon: "WholeWord",
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "text",
      id: "pattern",
      label: "Pattern",
      default: "",
      placeholder: "(?<user>\\w+)@(\\w+\\.\\w+)",
    },
    {
      kind: "text",
      id: "flags",
      label: "Flags",
      default: "g",
      placeholder: "gim",
    },
    {
      kind: "text",
      id: "replacement",
      label: "Replacement (optional)",
      default: "",
      placeholder: "$<user> at $2",
    },
  ],
  examples: [
    {
      label: "Pull names out of email addresses",
      input:
        "Contact ann@example.com or bob.jones@mail.example.org.\nBilling goes to accounts@example.com.",
      opts: {
        pattern: "(?<user>[\\w.]+)@(?<host>[\\w.]+\\.\\w+)",
        flags: "g",
        replacement: "$<user> at $<host>",
      },
    },
  ],
  copy: {
    what: "Runs a JavaScript regular expression against your test text and shows every match highlighted in place, so you can see what the pattern grabbed instead of guessing. Each match is listed with its offsets and its capture groups, named groups included. A replacement box previews what String.replace would produce, using the real $1, $<name>, $&, $` and $' rules. Alongside all of that, the pattern is broken down into a plain English list: which piece is an anchor, which is a character class, which is a group, and what every quantifier repeats.",
    how: "Type the pattern into the Pattern box and toggle the flags you want, then paste or type the text you are testing underneath. Matches highlight as you type and the match list fills in below, with a badge on each capture group. Add a replacement template to see the rewritten text, and open the cheat sheet at the bottom when you need to remember a token. The pattern, flags, replacement, and test text all live in the URL fragment, so a link shares the whole setup.",
    why: "The popular regex sites bury the tester under ads, ask you to sign in to save anything, or ship your pattern and your sample text to a server to be evaluated. This one runs the browser's own regex engine in your tab, so what you see is exactly what your JavaScript will do, and your files and inputs never leave your device. It is also honest about its limits: the test text is capped at 100 KB and the match list stops at 5,000 matches, so a slow pattern cannot lock up the page.",
    faq: [
      {
        q: "Which regex flavor is this?",
        a: "JavaScript, specifically the ECMAScript RegExp your browser ships. That means named groups with (?<name>...), lookbehind with (?<=...), Unicode property escapes with \\p{...} under the u or v flag, and the d, g, i, m, s, u, v and y flags. Patterns written for PCRE, Python or Go mostly carry over, but a few things do not, such as possessive quantifiers, atomic groups, recursion, and inline modifiers like (?i).",
      },
      {
        q: "Why does my pattern only find one match?",
        a: "Without the g flag a regular expression stops at the first match, and String.replace rewrites only that one. Turn on g to scan the whole text. The y flag is different: it anchors each attempt to the position where the last match ended, so a gap in the text stops the scan.",
      },
      {
        q: "Can a bad pattern freeze the page?",
        a: "A pattern with nested quantifiers, the classic (a+)+b shape, can take exponential time on the right input, and no browser regex engine can be interrupted once it starts. Two guards keep that survivable rather than fatal: the test text is capped at 100 KB and the match list stops at 5,000 matches. That reduces the blast radius, it does not eliminate it, so if the tab does stall on a nested quantifier, reload and simplify the pattern.",
      },
    ],
  },
};
