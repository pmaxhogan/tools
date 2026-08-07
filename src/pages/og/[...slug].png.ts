import type { APIRoute } from 'astro';
import { renderOgPng } from '@/lib/og';
import { tools } from '@/tools/registry';

const SITE_DESCRIPTION =
  'Fast, private developer tools that run entirely in your browser. No ads, no accounts, no limits.';

export function getStaticPaths() {
  return [
    ...tools.map((t) => ({ params: { slug: t.slug } })),
    { params: { slug: 'site' } },
  ];
}

export const GET: APIRoute = async ({ params }) => {
  const { slug } = params;

  if (slug === 'site') {
    const png = await renderOgPng({
      title: 'tools.maxhogan.dev',
      description: SITE_DESCRIPTION,
    });
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  }

  const tool = tools.find((t) => t.slug === slug);
  if (!tool) {
    return new Response('Not found', { status: 404 });
  }

  const png = await renderOgPng({
    title: tool.name,
    description: tool.description,
    category: tool.category,
  });
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
};
