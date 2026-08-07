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
    files: ['scripts/**', 'worker/**'],
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
    ignores: ['dist/', '.astro/', 'node_modules/', 'src/components/ui/'],
  }
);
