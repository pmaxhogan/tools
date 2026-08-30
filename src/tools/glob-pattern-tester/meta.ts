import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "glob-pattern-tester",
  name: "Glob Pattern Tester",
  description: "Check file paths against a glob pattern and see which ones match.",
  category: "Dev",
  keywords: [
    "glob pattern tester",
    "test glob pattern",
    "glob matcher online",
    "gitignore pattern tester",
    "file path wildcard match",
    "glob to regex",
    "globstar tester",
  ],
  searchTerms: [
    "minimatch",
    "fnmatch",
    "globstar",
    "double star glob",
    "wildcard path match",
    "does my glob match",
    "npmignore tester",
    "eslint ignore pattern",
    "tsconfig include exclude",
    "shell wildcard tester",
    "brace expansion",
    "path pattern check",
  ],
  icon: "FileSearch",
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "text",
      id: "pattern",
      label: "Glob pattern",
      default: "",
      placeholder: "src/**/*.{ts,tsx}",
    },
    { kind: "boolean", id: "dot", label: "Match dotfiles", default: false },
    { kind: "boolean", id: "caseSensitive", label: "Case sensitive", default: true },
    {
      kind: "boolean",
      id: "matchBase",
      label: "Match file name when the pattern has no slash",
      default: false,
    },
  ],
  examples: [
    {
      label: "TypeScript sources under src",
      input: [
        "src/index.ts",
        "src/lib/format.ts",
        "src/components/App.tsx",
        "src/lib/format.test.ts",
        "src/.hidden/secret.ts",
        "scripts/build.mjs",
        "README.md",
      ].join("\n"),
      opts: {
        pattern: "src/**/*.{ts,tsx}",
        dot: "false",
        caseSensitive: "true",
        matchBase: "false",
      },
    },
  ],
  copy: {
    what: "Tests a glob pattern against a list of file paths and splits them into matched and unmatched, with a count for each side. It handles the full syntax you use in a build config or an ignore file: stars, globstars, question marks, character classes with ranges and negation, brace groups including nested ones, backslash escapes, and a leading exclamation mark for an exclusion. It also prints the regular expression the pattern compiled to, which is usually the fastest way to see why a path fell on the wrong side. Options cover dotfiles, case sensitivity, and whether a slash free pattern is compared against the file name or the whole path.",
    how: "Paste your paths into the input box, one per line, then type the pattern into the Glob pattern field, for example src/**/*.{ts,tsx}. Read the Matched and Not matched rows, and open the Regex row when a verdict surprises you. Turn on Match dotfiles to let wildcards see names that start with a dot, and turn off Case sensitive to compare loosely. A pattern that starts with an exclamation mark flips into an exclusion, so !**/*.test.ts matches every path except the test files.",
    why: "Most glob questions get answered by editing a config, rerunning a build, and reading the file list that comes out, which is a slow loop for a one character mistake. This runs the whole match locally and shows the compiled regex, so you can see the difference between a star and a globstar instead of guessing. There are no ads, no sign in, and no upload step, and your files and inputs never leave your device.",
    faq: [
      {
        q: "Does a star match across folders, and what about a globstar?",
        a: "A single star matches any run of characters inside one path segment and never crosses a slash, so src/*.ts matches src/a.ts but not src/lib/a.ts. A double star is a globstar only when it is a whole segment, and it stands for zero or more segments, so a/**/b matches a/b as well as a/x/b and a/x/y/b. A trailing globstar matches everything below the prefix but not the prefix itself, so src/** matches src/a.ts and src/lib/a.ts but not src on its own. Dotfiles are hidden by default: a leading dot in a segment is invisible to stars, globstars, question marks, and character classes unless the pattern spells the dot out, as in .* or .config/*, or you turn on Match dotfiles.",
      },
      {
        q: "Can I test gitignore or npmignore rules here?",
        a: "Mostly, yes. A pattern that starts with an exclamation mark is an exclusion, so !*.log puts every log file in the unmatched column and everything else in the matched one, which is how an ignore rule reads. Ignore files also treat a slash free rule such as *.log as a file name rule at any depth, so turn on Match file name when the pattern has no slash to reproduce that. Directory only rules that end in a slash, and the way git anchors a rule to the folder holding the ignore file, are not modeled here.",
      },
      {
        q: "What syntax does it support beyond the wildcards?",
        a: "Character classes with [abc], ranges with [a-z], and negation with [!abc] or [^abc], where a closing bracket in first position is a literal and no class can ever match a slash. Brace groups expand, including nested ones such as {a,{b,c}}, while a brace pair with no comma stays literal the way a shell treats it. A backslash escapes the next character, so \\* is a literal star. Errors call out the real problem: an unclosed class, an unclosed brace group, a lone trailing backslash, or a pattern that would expand into too many variants.",
      },
    ],
  },
};
