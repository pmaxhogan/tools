// @ts-check

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import vue from "@astrojs/vue";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  site: "https://tools.maxhogan.dev",
  // Category pages that were merged or renamed. Keep in sync with
  // RETIRED_CATEGORY_SLUGS in src/tools/categories.ts.
  redirects: {
    "/category/crypto": "/category/security",
    "/category/generators": "/category/games",
    "/category/mobile": "/category/hardware",
    "/category/science": "/category/rf",
    "/category/physics": "/category/astronomy",
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  },
  integrations: [vue(), sitemap()],
});
