import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

// `test.projects` entries do not inherit root-level `resolve`/`plugins`, so
// the `@` alias is hoisted to a const and repeated in both projects, and the
// Vue plugin is scoped to the one project that mounts components.
const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  test: {
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
