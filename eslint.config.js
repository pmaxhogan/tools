import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue', 'src/lib/**', 'src/components/**'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['scripts/**', 'worker/**', '*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.serviceworker },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    files: ['src/tools/**/*.ts'],
    ignores: ['src/tools/**/*.test.ts'],
    rules: {
      // Rule 27: tool logic is pure — no DOM, no globals, no framework.
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage', 'fetch'],
      'no-restricted-imports': ['error', { patterns: ['vue', '@/components/*', 'astro:*'] }],
    },
  },
  {
    // Source and worker only. The rest are generated or vendored bundles
    // (build output, wrangler temp, and the self-hosted engine chunks the
    // prepare-*.mjs scripts stage under public/), never hand-authored, so
    // linting them is noise. They are gitignored; CI never sees them.
    ignores: [
      'dist/',
      'dist-worker-check/',
      '.astro/',
      '.wrangler/',
      'node_modules/',
      'src/components/ui/',
      'public/ffmpeg/',
      'public/models/',
      'public/pyodide/',
      'public/tesseract/',
    ],
  }
);
