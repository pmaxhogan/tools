# DESIGN.md — the visual language of tools.maxhogan.dev

Chosen by shootout (variant 2, "Soft Depth"). This document is binding for every
page, component, and tool panel. `src/styles/global.css` is the token source of
truth; this file explains the system and the rules that are not expressible as
CSS variables.

## Design language

Warm-neutral surfaces (paper, not paper-white; warm charcoal, not blue-black),
generous 10-14px radii, layered elevation, airy vertical rhythm, and a confident
violet brand that carries across the whole site. Friendly but professional:
Raycast, Arc, modern macOS app.

**Bolder brand (supersedes the earlier "violet only for primary/focus/active"
rule).** Violet is now a broader brand presence, not a single reserved accent.
It appears as soft gradient washes behind heroes and tool-page bands, as a
gradient fill on the primary button and on active toggles, as the logo mark, and
as tasteful hairline accents on hover. Two guardrails keep this tasteful: the
warm neutrals still own the vast majority of every screen (violet is the accent,
never the field), and every wash stays low-opacity so foreground text keeps AA
contrast in both themes. Saturated violet fills carry text only at the token
anchors that are known to pass AA (light: `#5B4BD6` on white; dark: `#8A79F5`
with the dark foreground).

**Core rule: elevation is expressed differently per theme.**

- Light: shadow does the lifting. Borders are hairline, nearly invisible.
- Dark: shadows are useless on a dark field, so elevation is surface-lightness
  steps (bg to surface to surface-2) reinforced by a border lighter than the
  surface it sits on. Deep ambient shadow only on the highest layer (popovers).

## Color

Defined in `global.css` on `:root` (light) and `.dark`. Key mappings to the
shadcn variable set:

| Token                     | Light                | Dark                    | Used for                       |
| ------------------------- | -------------------- | ----------------------- | ------------------------------ |
| `--background`            | `#F6F4F1` warm paper | `#141311` warm charcoal | page field                     |
| `--card`                  | `#FFFFFF`            | `#1D1B18`               | raised cards, panes            |
| `--popover`               | `#FFFFFF`            | `#252220`               | menus, palette (highest layer) |
| `--secondary` / `--muted` | `#F0EDE8`            | `#252220`               | inset wells, secondary fills   |
| `--accent`                | `#F3F0EB`            | `#2B2825`               | hover fills for ghost controls |
| `--primary`               | `#5B4BD6` violet     | `#8A79F5` lifted violet | primary actions, links, active |
| `--border`                | `#E7E2DA`            | `#302C27`               | hairlines                      |
| `--input`                 | `#D8D1C6`            | `#403A33`               | input rest-state border        |
| `--ring`                  | `#5B4BD6`            | `#8A79F5`               | focus ring                     |
| `--positive`              | `#2F7D5B`            | `#63C79B`               | copied / success states        |

Never pure `#fff` as a page background; white is reserved for raised surfaces
so cards read as lifted. Violet is the brand color and the only saturated hue in
the palette (the chart tokens aside); it now carries broader than before, per the
bolder-brand direction above, but the warm neutrals still own the field.

### Brand tokens (added for the bolder-brand direction)

Defined on `:root` and `.dark` in `global.css`, safe for any panel or island to
consume:

| Token                                  | Purpose                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `--primary-hover` / `--primary-active` | solid-violet hover and pressed steps                                                    |
| `--brand-2`                            | the second, lighter violet stop for gradients                                           |
| `--brand-accent`                       | a brighter violet reserved for glows                                                    |
| `--grad-brand`                         | the standard two-stop violet gradient (buttons, active toggles, slider fill, logo mark) |
| `--grad-brand-strong`                  | a slightly deeper variant for hover on gradient surfaces                                |
| `--grad-brand-soft`                    | a low-saturation violet gradient for soft fills                                         |
| `--brand-glow`                         | radial glow for hero backgrounds (`bg-[image:var(--brand-glow)]`)                       |
| `--brand-band`                         | vertical wash for tool-page header bands                                                |
| `--brand-hairline`                     | translucent violet for hover borders, rings, and slider outline                         |

Usage in Tailwind is via arbitrary values, e.g. `bg-[image:var(--grad-brand)]`,
`ring-[color:var(--brand-hairline)]`; none are mapped as `--color-*` utilities.

## Typography

Geist (text) and Geist Mono (values), self-hosted, variable weight.

| Role    | Size/leading                | Weight | Notes                      |
| ------- | --------------------------- | ------ | -------------------------- |
| display | 36/1.12, -0.022em           | 600    | tool title on its page     |
| h2      | 22/1.27, -0.014em           | 600    | section headings           |
| h3      | 17/1.35                     | 600    | card titles, FAQ questions |
| body    | 15/1.6                      | 400    | default UI and prose       |
| small   | 13.5/1.5                    | 400    | descriptions, meta         |
| micro   | 12/1.35, +0.04em, uppercase | 600    | eyebrow/category labels    |
| mono    | 14/1.5                      | 450    | values, timestamps, code   |

Prose measure capped at 68ch. Anything numeric that updates live gets
`font-variant-numeric: tabular-nums`.

## Spacing, radii, borders, shadows

- 4px base scale. Card padding 20-24, pane padding 24-28, grid gutter 16,
  section gap 48-64, control height 40 (md) / 34 (sm). Page max-width 1140px.
- Radii: 8 chips/kbd, 10 buttons/inputs (`--radius`), 14 cards, 18 panes.
  Nested radius = parent radius minus padding. Never nest equal radii.
- Borders 1px only, never 2px. Borders carry structure, not emphasis;
  emphasis comes from surface and shadow. Inset wells use an inner hairline
  (inset box-shadow) instead of a border so they read as carved, not stacked.
- Shadows: warm-tinted two-layer in light (`--sh-sm/md/lg` in global.css);
  in dark the contact layer disappears and raised surfaces get a 1px top
  highlight instead.

## Focus and motion

- `:focus-visible` only. One rule everywhere: `outline: 2px solid var(--ring);
outline-offset: 2px` plus a soft `--accent-soft` halo. Composite controls
  move the ring to the wrapper via `:focus-within`.
- Motion: 120ms ease-out for color, 160ms `cubic-bezier(.2,.7,.3,1)` for
  transform/shadow. Card hover lift is translateY(-2px) plus one shadow step.
  Nothing exceeds 200ms. Everything honors `prefers-reduced-motion`.
- Page navigation uses Astro view transitions (`ClientRouter` in
  `BaseLayout.astro`). The root cross-fade is pinned to 160ms (the browser
  default 0.25s overshoots the budget); Astro's own stylesheet zeroes the
  view-transition pseudo-elements under `prefers-reduced-motion`.

## Theming

System preference is the default; the header toggle overrides it in either
direction and persists to `localStorage("theme")` (preferences only, rule 7).
Implementation: `.dark` class on `<html>`, set before paint in BaseLayout.

## Copy rules (binding for ALL user-facing text)

1. **Never use em dashes or en dashes in prose.** Restructure with commas,
   colons, parentheses, or separate sentences. Hyphens in compound words are
   fine. This applies to page copy, meta descriptions, FAQ answers, option
   labels, error messages, and README-facing text.
2. No bundle-size or "no JavaScript frameworks" boasts in site copy.
3. License mention is plain "MIT licensed", not "MIT licensed, read the source".
4. The privacy claim is exactly "your files and inputs never leave your
   device". Never claim "zero network requests" (rule 12).
5. Tone: confident, concrete, no exclamation marks, no marketing superlatives.

## Component rules

- Use the shadcn-vue components in `src/components/ui/`; restyle via tokens,
  not per-component overrides.
- Tool working areas: input and output are inset wells on a raised pane.
  Every output value is mono with a copy affordance.
- Tool cards on the homepage: icon tile with `--accent-soft` fill, name,
  one-line description, hover lift.
- Empty, error, and loading states are designed, never blank: errors show the
  message plus the fix hint; empty inputs show a helpful placeholder.
- Keyboard hints render as `<kbd>` chips (8px radius, `--secondary` fill).
