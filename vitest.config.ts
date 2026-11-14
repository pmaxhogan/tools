import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

// `test.projects` entries do not inherit root-level `resolve`/`plugins`, so
// the `@` alias is hoisted to a const and repeated in both projects, and the
// Vue plugin is scoped to the one project that mounts components.
const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

// `npm run test:changed` (vitest --changed) picks tests by walking the import
// graph from each changed file. These are the inputs that graph cannot see,
// because a test reads them off disk instead of importing them: fixtures, the
// source files the registry and sidebar drift guards scan as text, and the
// files that decide how every module resolves. A change to any of them runs
// the whole suite. A test that starts reading a new file from disk belongs
// here too.
//
// The patterns are anchored to the repo root on purpose. Vitest's defaults
// start with a `**`, which never crosses a dot directory, so under
// `.claude/worktrees/<name>/` they match nothing and an edit to package.json
// would run zero tests. That is also why the defaults are restated here
// instead of spread in.
const root = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\$()*+?[\]^{|}!]/g, "\\$&");
const forceRerunTriggers = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  "public/samples/**",
  "mc-pipeline/**",
  "worker/index.ts",
  "src/components/tool/PanelHost.vue",
  "src/lib/tool-icons.ts",
  "src/layouts/BaseLayout.astro",
].map((pattern) => root + pattern);

export default defineConfig({
  test: {
    forceRerunTriggers,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        plugins: [vue()],
        resolve: { alias },
        test: {
          name: "components",
          environment: "happy-dom",
          include: ["src/**/*.spec.ts"],
        },
      },
    ],
  },
});
