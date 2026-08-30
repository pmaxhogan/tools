import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "semver-range-tester",
  name: "Semver Range Tester",
  description: "Check whether a version satisfies a semver range, with plain English rules.",
  category: "Dev",
  keywords: [
    "semver range tester",
    "does this version satisfy this range",
    "npm version range checker",
    "caret vs tilde semver",
    "semver satisfies",
    "package.json version range",
    "semver comparator",
  ],
  searchTerms: [
    "npm version range",
    "caret vs tilde",
    "package.json version",
    "does this version match",
    "node-semver",
    "version constraint checker",
    "dependency range",
    "semver prerelease rule",
    "x range",
    "hyphen range",
    "version sorter",
    "semver compare",
  ],
  icon: "Layers",
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "text",
      id: "range",
      label: "Semver range",
      default: "",
      placeholder: "^1.2.3 || >=2 <3",
    },
    {
      kind: "boolean",
      id: "includePrerelease",
      label: "Include prereleases",
      default: false,
    },
  ],
  examples: [
    {
      label: "Caret range with a prerelease",
      input: "1.2.2\n1.2.3\n1.9.9\n2.0.0-rc.1\n2.0.0",
      opts: { range: "^1.2.3", includePrerelease: "false" },
    },
  ],
  copy: {
    what: "Tests a list of versions against one semver range and shows exactly which ones pass. It desugars the range into its real comparators first, so ^1.2.3 becomes >=1.2.3 <2.0.0-0 and 1.2.3 - 2.3 becomes >=1.2.3 <2.4.0-0, then restates the result as a sentence you can read out loud. Carets, tildes, x-ranges, hyphen ranges, whitespace AND sets, and pipe separated OR sets are all supported, along with npm's prerelease rule. It also sorts every version you paste into true semver order and reports the highest and lowest ones that satisfy the range.",
    how: 'Paste your versions into the input box, one per line, then type the range into the Semver range field, for example "^1.2.3" or ">=1.2.7 <1.3.0". Read the Parsed range row to see what the range really means, then the Satisfies and Does not satisfy rows for the verdict on each version. Turn on Include prereleases if you want versions like 1.2.4-alpha judged on their numbers alone. The range and the toggle travel in the link, so you can share a case with a coworker exactly as you set it up.',
    why: "Working this out usually means opening a Node REPL, installing the semver package, and calling satisfies() by hand, or trusting a half remembered rule about what the caret does on a 0.x version. This page implements the same npm range grammar and shows its work, including the desugared comparators most tools hide. There are no ads, no sign in, and no request limits, and everything runs in this tab, so your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does 1.2.4-alpha not satisfy >=1.2.3?",
        a: "Because npm treats prereleases as opt in. A version carrying a prerelease only satisfies a comparator set when at least one comparator in that same set also carries a prerelease and pins the same major, minor, and patch numbers. So 1.2.4-alpha fails >=1.2.3 even though it compares as greater, and it still fails >=1.2.3 <1.2.5-0 because that prerelease bound sits on 1.2.5 rather than 1.2.4. It passes >=1.2.4-alpha or >=1.2.4-0, where the prerelease bound names the same three numbers. The idea is that installing a package should never hand you an unreleased build you did not ask for. Flip on Include prereleases to compare on numbers alone.",
      },
      {
        q: "What is the difference between caret and tilde?",
        a: "A caret allows anything that does not change the leftmost non zero field, so ^1.2.3 covers up to but not including 2.0.0. A tilde allows patch level changes when a minor is given, so ~1.2.3 covers up to but not including 1.3.0. The 0.x rules are where they diverge and where people get surprised: ^0.2.3 behaves like a tilde and stops before 0.3.0, and ^0.0.3 is pinned so tightly that only 0.0.3 itself matches. Paste a few 0.x versions in and watch the Parsed range row change as you edit.",
      },
      {
        q: "Which range forms does this understand?",
        a: 'All of the common npm ones: comparators such as >=1.2.7, <1.3.0, and a bare 1.2.3; carets and tildes including partial forms like ^1.2 and ~1; x-ranges written as 1.x, 1.2.X, 1.*, or a lone * for any version; hyphen ranges such as "1.2.3 - 2.3.4" with partial bounds on either side; whitespace between comparators meaning AND; and || between comparator sets meaning OR. Versions may carry a leading v, a -prerelease, and a +build, and build metadata is ignored for precedence exactly as the spec says.',
      },
    ],
  },
};
