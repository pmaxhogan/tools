import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'favicon-generator',
  matrixSlug: 'favicon',
  name: 'Favicon Generator',
  description: 'Build favicon.ico, a web manifest and the right link tags from one source image.',
  category: 'Images',
  keywords: [
    'favicon generator',
    'favicon.ico from png',
    'web manifest generator',
    'apple touch icon',
    'favicon link tags',
    'png to ico',
    'site.webmanifest',
  ],
  searchTerms: [
    'favicon maker',
    'ico converter',
    'app icon generator',
    'website icon generator',
    'touch icon generator',
    'manifest.json generator',
    'pwa icon generator',
    'logo to favicon',
    'generate favicon sizes',
  ],
  input: 'image/*',
  output: 'application/json',
  options: [
    {
      kind: 'text',
      id: 'appName',
      label: 'App name',
      default: 'My App',
      placeholder: 'My App',
    },
    {
      kind: 'text',
      id: 'themeColor',
      label: 'Theme color',
      default: '#5B4BD6',
      placeholder: '#5B4BD6',
    },
    {
      kind: 'text',
      id: 'bgColor',
      label: 'Background color',
      default: '#ffffff',
      placeholder: '#ffffff',
    },
  ],
  copy: {
    what: 'Turns one source image into the full icon set a site actually needs: a favicon.ico packed from real 16, 32 and 48 pixel renders, a 180 pixel apple-touch-icon, 192 and 512 pixel manifest PNGs, a site.webmanifest, and the head snippet that wires them together. It warns you when the source is small or not square and can center-crop to square for you.',
    how: 'Drop any image onto the input or pick one with the file button. Set the app name, theme color, and background color, which feed the manifest and the theme-color meta tag. Download each file, or use Download all, then paste the link tags into your head.',
    why: 'Most favicon sites ask you to upload your logo, then watermark the result, paywall the larger sizes, or email you a zip. This one packs the ICO in the page you are already looking at, hands you the exact tags to paste, and your files and inputs never leave your device.',
    faq: [
      {
        q: 'What favicon sizes do I actually need in 2026?',
        a: 'Far fewer than the old 20 file checklists claimed. A favicon.ico at the site root, a 192 and a 512 pixel PNG referenced from the web manifest, and a 180 pixel apple-touch-icon cover every current browser and mobile home screen.',
      },
      {
        q: 'Can an .ico file contain PNG data?',
        a: 'Yes. The ICO container has allowed PNG compressed entries since Windows Vista, and every modern browser reads them. That is what this tool writes, which is why the output stays small instead of ballooning into an uncompressed bitmap.',
      },
      {
        q: 'Is my logo uploaded anywhere?',
        a: 'No. The PNG is parsed and the ICO is assembled in your browser, so your files and inputs never leave your device.',
      },
    ],
  },
};
