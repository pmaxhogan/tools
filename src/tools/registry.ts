/**
 * Hand-maintained tool registry.
 *
 * Imports each tool's cheap `meta.ts` eagerly (grid, palette, sitemap, SEO)
 * and maps slugs to a lazy import of the logic module (rule 14: heavy code
 * loads only on the page that needs it).
 *
 * Adding a tool: create src/tools/<slug>/{meta.ts,index.ts,index.test.ts},
 * then register meta + loader here. tool-matrix.csv stays the planning doc.
 */
import type { ToolMeta } from './types';
import { meta as epochConverter } from './epoch-converter/meta';
import { meta as uuid } from './uuid/meta';

export const tools: ToolMeta[] = [epochConverter, uuid];

/** Lazy loaders for tool logic, keyed by URL slug. */
export const loaders: Record<string, () => Promise<unknown>> = {
  'epoch-converter': () => import('./epoch-converter/index').then((m) => m.default),
  'uuid-generator': () => import('./uuid/index').then((m) => m.default),
};

export function getTool(slug: string): ToolMeta | undefined {
  return tools.find((t) => t.slug === slug);
}

export const categories = (): string[] => [...new Set(tools.map((t) => t.category))];
