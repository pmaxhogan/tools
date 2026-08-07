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

export const tools: ToolMeta[] = [];

/** Lazy loaders for tool logic, keyed by URL slug. */
export const loaders: Record<string, () => Promise<unknown>> = {};

export function getTool(slug: string): ToolMeta | undefined {
  return tools.find((t) => t.slug === slug);
}

export const categories = (): string[] => [...new Set(tools.map((t) => t.category))];
