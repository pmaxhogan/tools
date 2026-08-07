import TurndownService from 'turndown';
// @ts-expect-error: @joplin/turndown-plugin-gfm ships no type declarations.
import { gfm } from '@joplin/turndown-plugin-gfm';
import { ToolError, type ToolLogic } from '../types';

export interface ToMarkdownOpts {
  /** Bullet character for unordered lists: '-', '*', or '+'. */
  bullet?: string;
  /** Keep links as [text](href). When false, only the link text survives. */
  keepLinks?: boolean;
  /** Keep images as ![alt](src). When false, images are dropped. */
  keepImages?: boolean;
  [key: string]: unknown;
}

/** Attributes worth keeping. Everything else (class, style, id, dir, lang, mso-*) goes. */
const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan']);
/** Checkbox state has to survive or task lists cannot convert. */
const KEEP_ON_INPUT = new Set(['type', 'checked']);

type Rewrite = { open: string; close: string } | null;

/**
 * Rewrite (or unwrap) balanced pairs of one tag.
 *
 * `decide` sees each opening tag and returns the replacement text for the tag
 * and for its matching close, or null to leave the pair alone. Depth counting
 * matters here: Google Docs and Word nest spans several levels deep, so a
 * "replace the next closing tag" shortcut would pair the wrong ends together.
 */
function rewriteBalanced(html: string, tag: string, decide: (openTag: string) => Rewrite): string {
  const re = new RegExp(`<\\s*(/?)${tag}(\\s[^>]*)?(/?)>`, 'gi');
  const edits: { start: number; end: number; text: string }[] = [];
  const stack: { start: number; end: number; rewrite: Rewrite }[] = [];
  let tail = '';
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const isClose = m[1] === '/';
    const selfClosing = m[3] === '/';
    if (isClose) {
      const open = stack.pop();
      if (!open || !open.rewrite) continue;
      edits.push({ start: open.start, end: open.end, text: open.rewrite.open });
      edits.push({ start: m.index, end: m.index + m[0].length, text: open.rewrite.close });
    } else if (!selfClosing) {
      stack.push({ start: m.index, end: m.index + m[0].length, rewrite: decide(m[0]) });
    }
  }

  // Unclosed openers still get rewritten; their closer is appended at the end.
  for (const open of stack) {
    if (!open.rewrite) continue;
    edits.push({ start: open.start, end: open.end, text: open.rewrite.open });
    tail = open.rewrite.close + tail;
  }

  if (edits.length === 0) return html;
  edits.sort((a, b) => a.start - b.start);

  let out = '';
  let pos = 0;
  for (const edit of edits) {
    out += html.slice(pos, edit.start) + edit.text;
    pos = edit.end;
  }
  return out + html.slice(pos) + tail;
}

/** The style attribute value of a tag, prefixed with ';' so property tests can anchor. */
function styleOf(openTag: string): string {
  const m = /\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(openTag);
  if (!m || !m[1]) return ';';
  return ';' + m[1].replace(/^["']|["']$/g, '');
}

// The leading [;\s] keeps mso-bidi-font-weight:bold from reading as font-weight:bold.
const BOLD = /[;\s]font-weight\s*:\s*(?:bold|bolder|[6-9]00)/i;
const NOT_BOLD = /[;\s]font-weight\s*:\s*(?:normal|400)/i;
const ITALIC = /[;\s]font-style\s*:\s*italic/i;

function keepQuoted(value: string): string {
  return /^["']/.test(value) ? value : `"${value}"`;
}

/** Drop every attribute outside the allowlist, quoted or not (Word emits both). */
function stripAttributes(html: string): string {
  const tagRe =
    /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>`]+))?)*)\s*(\/?)>/g;
  const attrRe = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>`]+))?/g;

  return html.replace(tagRe, (_full, name: string, attrs: string, slash: string) => {
    const kept: string[] = [];
    const isInput = name.toLowerCase() === 'input';
    if (attrs) {
      attrRe.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(attrs)) !== null) {
        const key = a[1]!.toLowerCase();
        if (!KEEP_ATTRS.has(key) && !(isInput && KEEP_ON_INPUT.has(key))) continue;
        kept.push(a[2] === undefined ? key : `${key}=${keepQuoted(a[2])}`);
      }
    }
    const rendered = kept.length > 0 ? ' ' + kept.join(' ') : '';
    return `<${name}${rendered}${slash ? ' /' : ''}>`;
  });
}

/** Non-breaking spaces used as layout collapse; single ones become ordinary spaces. */
function normalizeNbsp(text: string): string {
  return text
    .replace(/&nbsp;|&#160;|&#xa0;/gi, '\u00A0')
    .replace(/\u00A0{3,}/g, ' ')
    .replace(/\u00A0/g, ' ');
}

/**
 * Strip the editor junk that survives conversion otherwise: Google Docs wrapper
 * tags and styled spans, Word conditional comments and o:p tags, and every
 * class, style, id, and mso- attribute in between.
 */
export function cleanHtml(raw: string): string {
  let html = raw;

  // Comments, including Word's downlevel-hidden conditionals.
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Downlevel-revealed conditionals are markup, not comments.
  html = html.replace(/<!\[(?:end)?if[^\]]*\]>/gi, '');
  // Doctype and processing instructions.
  html = html.replace(/<![^>]*>/g, '').replace(/<\?[\s\S]*?\?>/g, '');

  // Elements whose contents are never prose.
  html = html.replace(/<(style|script|xml|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(/<\/?(style|script|xml|title)\b[^>]*>/gi, '');
  html = html.replace(/<(meta|link|base)\b[^>]*>/gi, '');

  // Google Docs wraps the whole paste in a <b> that is not bold. Keep contents.
  html = rewriteBalanced(html, 'b', (tag) =>
    /docs-internal-guid/i.test(tag) || NOT_BOLD.test(styleOf(tag)) ? { open: '', close: '' } : null,
  );

  // Google Docs (and Word) express bold and italic with styled spans.
  html = rewriteBalanced(html, 'span', (tag) => {
    const style = styleOf(tag);
    const bold = BOLD.test(style);
    const italic = ITALIC.test(style);
    if (bold && italic) return { open: '<strong><em>', close: '</em></strong>' };
    if (bold) return { open: '<strong>', close: '</strong>' };
    if (italic) return { open: '<em>', close: '</em>' };
    return null;
  });

  // Word smart-tag wrappers keep their contents; o:p paragraph markers do too.
  html = rewriteBalanced(html, 'w:sdt', () => ({ open: '', close: '' }));
  html = html.replace(/<\/?o:p[^>]*>/gi, '');

  html = stripAttributes(html);
  html = normalizeNbsp(html);

  return html;
}

/** Trailing whitespace, runaway blank lines, and one final newline. */
function tidy(text: string): string {
  const body = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body ? body + '\n' : '';
}

/**
 * Undo Markdown escaping of underscores inside a word (`snake\_case`). Safe:
 * CommonMark never opens emphasis on an intraword underscore, so the escape was
 * never doing any work. Underscores at a word boundary keep their backslash.
 */
function unescapeIntrawordUnderscores(md: string): string {
  return md.replace(/(\w)\\_(?=\w)/g, '$1_');
}

function looksLikeHtml(text: string): boolean {
  return /<[a-zA-Z!/]/.test(text);
}

function buildService(opts: ToMarkdownOpts): TurndownService {
  const bullet = opts.bullet === '*' || opts.bullet === '+' ? opts.bullet : '-';
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: bullet as '-' | '*' | '+',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
    hr: '---',
    linkStyle: 'inlined',
  });
  service.use(gfm);

  if (opts.keepImages === false) {
    service.addRule('dropImages', { filter: 'img', replacement: () => '' });
  }
  if (opts.keepLinks === false) {
    service.addRule('unlinkAnchors', { filter: 'a', replacement: (content: string) => content });
  }

  // Turndown's built in listItem rule pads the marker out to a fixed column
  // ("-   " for bullets, "1.  " for ordered items) so nested content lines up.
  // That reads as a stray run of spaces, so this replaces it with a single
  // space after the marker. Continuation lines still indent to the width of
  // the new, shorter prefix, so nesting stays valid.
  service.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const parent = node.parentNode as HTMLElement | null;
      let prefix = `${options.bulletListMarker ?? '-'} `;
      if (parent && parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }
      const isParagraph = /\n$/.test(content);
      let body = content.replace(/^\n+/, '').replace(/\n+$/, '') + (isParagraph ? '\n' : '');
      body = body.replace(/\n/gm, '\n' + ' '.repeat(prefix.length));
      return prefix + body + (node.nextSibling ? '\n' : '');
    },
  });

  return service;
}

export function run(input: string, opts: ToMarkdownOpts): string {
  const raw = input ?? '';
  if (!raw.trim())
    throw new ToolError(
      'empty-input',
      'Nothing to convert.',
      'Paste rich text or HTML source into the input, or drop an .html file onto the page.',
    );

  // People paste plain text here all the time. That is not an error, so pass it
  // through with only whitespace normalized.
  if (!looksLikeHtml(raw)) return tidy(normalizeNbsp(raw));

  const markdown = buildService(opts).turndown(cleanHtml(raw));
  return tidy(unescapeIntrawordUnderscores(markdown));
}

export default { run } satisfies ToolLogic<string, string, ToMarkdownOpts>;
