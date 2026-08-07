/**
 * Build-time Open Graph image renderer (PROJECT.md og pipeline).
 *
 * Renders a 1200x630 PNG card via satori (object syntax, no JSX/React
 * runtime) then encodes it with sharp. Fonts are read from disk with
 * node:fs, which only runs during `astro build` (static endpoint), never
 * ships to the client. Font buffers are cached at module scope so repeated
 * calls across the many static paths in [...slug].png.ts do not re-read
 * disk for every tool.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import satori from "satori";
import sharp from "sharp";

/** Minimal satori element shape (object syntax, not JSX). */
interface SatoriNode {
  type: string;
  props: {
    style?: Record<string, string | number>;
    children?: SatoriNode | SatoriNode[] | string;
  };
}

// Resolved from the project root (process.cwd() during `astro build`) rather
// than import.meta.url: Vite relocates this module into dist/.prerender/
// chunks when bundling the static endpoint, which would break a
// import.meta.url-relative path to node_modules.
const GEIST_SANS_DIR = join(process.cwd(), "node_modules", "geist", "dist", "fonts", "geist-sans");
const GEIST_MONO_DIR = join(process.cwd(), "node_modules", "geist", "dist", "fonts", "geist-mono");

const COLORS = {
  bg: "#F6F4F1",
  card: "#FFFFFF",
  text: "#1B1917",
  textSecondary: "#57514A",
  accent: "#5B4BD6",
  border: "#E7E2DA",
} as const;

interface FontBuffers {
  regular: Buffer;
  semibold: Buffer;
  mono: Buffer;
}

let fontCache: FontBuffers | null = null;

function loadFonts(): FontBuffers {
  if (!fontCache) {
    fontCache = {
      regular: readFileSync(join(GEIST_SANS_DIR, "Geist-Regular.ttf")),
      semibold: readFileSync(join(GEIST_SANS_DIR, "Geist-SemiBold.ttf")),
      mono: readFileSync(join(GEIST_MONO_DIR, "GeistMono-Regular.ttf")),
    };
  }
  return fontCache;
}

export interface RenderOgOptions {
  title: string;
  description: string;
  category?: string;
}

/** Renders one 1200x630 OG card and returns the encoded PNG bytes. */
export async function renderOgPng(opts: RenderOgOptions): Promise<Buffer> {
  const { title, description, category } = opts;
  const fonts = loadFonts();

  const headerChildren: SatoriNode[] = [];

  if (category) {
    headerChildren.push({
      type: "div",
      props: {
        style: {
          display: "flex",
          fontFamily: "Geist",
          fontWeight: 600,
          fontSize: 22,
          color: COLORS.accent,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 20,
        },
        children: category,
      },
    });
  }

  headerChildren.push(
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          fontFamily: "Geist",
          fontWeight: 600,
          fontSize: 76,
          lineHeight: 1.08,
          letterSpacing: "-0.02em",
          color: COLORS.text,
          marginBottom: 28,
        },
        children: title,
      },
    },
    {
      type: "div",
      props: {
        style: {
          display: "flex",
          fontFamily: "Geist",
          fontWeight: 400,
          fontSize: 32,
          lineHeight: 1.45,
          color: COLORS.textSecondary,
          maxHeight: 140,
          overflow: "hidden",
        },
        children: description,
      },
    },
  );

  const card: SatoriNode = {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        backgroundColor: COLORS.card,
        borderRadius: 24,
        border: `1px solid ${COLORS.border}`,
        boxShadow: "0 24px 64px rgba(27, 25, 23, 0.12)",
        padding: 64,
      },
      children: [
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "column" },
            children: headerChildren,
          },
        },
        {
          type: "div",
          props: {
            style: { display: "flex", flexDirection: "row", alignItems: "center" },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    backgroundColor: COLORS.accent,
                    marginRight: 12,
                  },
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    fontFamily: "Geist Mono",
                    fontWeight: 400,
                    fontSize: 24,
                    color: COLORS.textSecondary,
                  },
                  children: "tools.maxhogan.dev",
                },
              },
            ],
          },
        },
      ],
    },
  };

  const root: SatoriNode = {
    type: "div",
    props: {
      style: {
        display: "flex",
        width: 1200,
        height: 630,
        backgroundColor: COLORS.bg,
        padding: 40,
        fontFamily: "Geist",
      },
      children: card,
    },
  };

  const svg = await satori(root as unknown as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Geist", data: fonts.regular, weight: 400, style: "normal" },
      { name: "Geist", data: fonts.semibold, weight: 600, style: "normal" },
      { name: "Geist Mono", data: fonts.mono, weight: 400, style: "normal" },
    ],
  });

  return sharp(Buffer.from(svg)).png().toBuffer();
}
