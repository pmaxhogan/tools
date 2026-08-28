import js from "@eslint/js";
import tseslint from "typescript-eslint";
import astro from "eslint-plugin-astro";
import vue from "eslint-plugin-vue";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  ...vue.configs["flat/recommended"],
  {
    // Agent worktrees under .claude/ carry their own tsconfig, which would
    // otherwise make typescript-eslint see two candidate project roots.
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["**/*.vue", "src/lib/**", "src/components/**"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["scripts/**", "worker/**", "mc-pipeline/**", "*.config.{js,mjs,ts}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.serviceworker },
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    // A leading underscore marks a parameter as deliberately unused. Tool `run`
    // functions must accept (input, opts) to satisfy the ToolLogic contract even
    // when a tool reads neither, so this is the normal case, not an exception.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/tools/**/*.ts"],
    ignores: ["src/tools/**/*.test.ts"],
    rules: {
      // Rule 27: tool logic is pure — no DOM, no globals, no framework.
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "navigator",
        "localStorage",
        "sessionStorage",
        "fetch",
        "indexedDB",
        "caches",
        "XMLHttpRequest",
        "WebSocket",
        "EventSource",
        "importScripts",
        // The bare-global bans above would be trivially sidestepped by reaching
        // through globalThis/self, so ban the object itself. Tool logic has no
        // legitimate use for it: the pure globals it does rely on (crypto, btoa)
        // are available unprefixed in every runtime the tools target, so an
        // allowlist of permitted properties would only be a maintenance burden.
        {
          name: "globalThis",
          message:
            "Rule 27: tool logic stays pure. Reaching through globalThis does not make a DOM, storage, or network global allowed. Pure globals (crypto, btoa) work unprefixed in browsers, Workers, and Node.",
        },
        {
          name: "self",
          message:
            "Rule 27: tool logic stays pure. Reaching through self does not make a DOM, storage, or network global allowed. Pure globals (crypto, btoa) work unprefixed in browsers, Workers, and Node.",
        },
      ],
      "no-restricted-imports": ["error", { patterns: ["vue", "@/components/*", "astro:*"] }],
    },
  },
  {
    // Source and worker only. The rest are generated or vendored bundles
    // (build output, wrangler temp, and the self-hosted engine chunks the
    // prepare-*.mjs scripts stage under public/), never hand-authored, so
    // linting them is noise. They are gitignored; CI never sees them.
    ignores: [
      "dist/",
      "dist-worker-check/",
      ".astro/",
      ".wrangler/",
      "node_modules/",
      // Agent worktrees: sibling checkouts, linted in their own sessions.
      ".claude/worktrees/",
      // Python training pipeline: its venv vendors JS (torch model_dump).
      "training/",
      "src/components/ui/",
      "public/ffmpeg/",
      "public/models/",
      "public/pyodide/",
      "public/tesseract/",
      "public/wawoff2/",
      "public/data/",
      "src/tools/_generated/",
      "mc-pipeline/extracted/",
      "mc-pipeline/vectors/",
      "mc-pipeline/work/",
    ],
  },
  // Last: turn off every stylistic rule that Prettier owns, so eslint and
  // Prettier never fight over formatting (quotes, attribute wrapping, indent).
  eslintConfigPrettier,
);
