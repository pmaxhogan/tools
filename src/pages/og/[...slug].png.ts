import type { APIRoute } from "astro";
import { renderOgPng } from "@/lib/og";
import { CATEGORIES, categoryBySlug } from "@/tools/categories";
import { tools } from "@/tools/registry";

const SITE_DESCRIPTION =
  "Fast, private developer tools that run entirely in your browser. No ads, no accounts, no limits.";

/** Prefix of the category cards. The route is a rest param, so it can hold a slash. */
const CATEGORY_PREFIX = "category/";

export function getStaticPaths() {
  return [
    ...tools.map((t) => ({ params: { slug: t.slug } })),
    ...CATEGORIES.map((c) => ({ params: { slug: `${CATEGORY_PREFIX}${c.slug}` } })),
    { params: { slug: "site" } },
  ];
}

export const GET: APIRoute = async ({ params }) => {
  const { slug } = params;

  // Checked before the tool lookup: a category slug is never a tool slug
  // (registry.test enforces that), but "category/x" would 404 down there.
  if (slug?.startsWith(CATEGORY_PREFIX)) {
    const category = categoryBySlug(slug.slice(CATEGORY_PREFIX.length));
    if (!category) {
      return new Response("Not found", { status: 404 });
    }
    const png = await renderOgPng({
      title: `${category.label} tools`,
      description: category.description,
      category: "Category",
    });
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
  }

  if (slug === "site") {
    const png = await renderOgPng({
      title: "tools.maxhogan.dev",
      description: SITE_DESCRIPTION,
    });
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
  }

  const tool = tools.find((t) => t.slug === slug);
  if (!tool) {
    return new Response("Not found", { status: 404 });
  }

  const png = await renderOgPng({
    title: tool.name,
    description: tool.description,
    category: tool.category,
  });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
