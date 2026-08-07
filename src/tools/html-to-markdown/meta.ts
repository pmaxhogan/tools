import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'html-to-markdown',
  icon: 'FileCode',
  matrixSlug: 'to-markdown',
  name: 'HTML to Markdown',
  description: 'Turn HTML and rich text pasted from Google Docs or Word into tidy Markdown.',
  category: 'Text',
  keywords: [
    'html to markdown',
    'google docs to markdown',
    'word to markdown',
    'convert rich text to markdown',
    'paste to markdown',
    'rich text to markdown converter',
    'html markdown converter',
  ],
  searchTerms: [
    'turndown online',
    'rich text to md',
    'clean up pasted html',
    'docx to markdown',
    'gfm converter',
    'markdown cleaner',
    'strip word formatting',
    'notion to markdown',
    'convert to gfm',
  ],
  input: 'text/html',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'bullet',
      label: 'Bullet marker',
      default: '-',
      choices: [
        { value: '-', label: 'Hyphen (-)' },
        { value: '*', label: 'Asterisk (*)' },
        { value: '+', label: 'Plus (+)' },
      ],
    },
    { kind: 'boolean', id: 'keepLinks', label: 'Keep links', default: true },
    { kind: 'boolean', id: 'keepImages', label: 'Keep images', default: true },
  ],
  copy: {
    what: 'Converts HTML and rich text from Google Docs, Word, Outlook, or any web page into clean Markdown. Headings, lists, blockquotes, code blocks, links, and images all come across, and tables, strikethrough, and task lists convert to GitHub Flavored Markdown. Before the conversion runs, a cleanup pass removes the junk those editors leave behind: the Google Docs wrapper tag, Word conditional comments and o:p tags, mso styles, class and id attributes, and runs of non-breaking spaces used as layout.',
    how: 'Paste the HTML source into the input box, or drop an .html file onto the page. Pasting formatted text works too, and plain text passes straight through untouched; a future update will capture rich clipboard content automatically, so for now the HTML source or the file drop gives the most complete result. Pick a bullet marker, decide whether to keep links and images, then copy the Markdown out.',
    why: 'Most HTML to Markdown converters are ad-heavy sites that upload your document to a server before converting it. This one runs entirely in your browser, so your files and inputs never leave your device, and it actually cleans up Google Docs and Word markup instead of passing it through as inline HTML. No sign-up, no file size limit, no upsell.',
    faq: [
      {
        q: 'Does it handle tables?',
        a: 'Yes. HTML tables become GitHub Flavored Markdown pipe tables, with the first row as the header. Strikethrough and checkbox task lists convert too. Merged cells have no Markdown equivalent, so tables using colspan or rowspan come out flattened.',
      },
      {
        q: 'Why does my Google Docs bold survive here when other converters lose it?',
        a: 'Google Docs does not use strong tags. It marks bold with a styled span (font-weight: 700) and wraps the whole selection in a b tag that is set to font-weight: normal. The cleaner rewrites those spans into real strong and em tags and unwraps that outer b tag, so bold and italic survive and your document does not come out entirely bold.',
      },
      {
        q: 'Is my document uploaded anywhere?',
        a: 'No. The conversion runs entirely in your browser, so your files and inputs never leave your device. The page also works offline after the first load.',
      },
    ],
  },
};
