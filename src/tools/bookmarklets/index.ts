import { ToolError, type ToolLogic } from "../types";

export interface BookmarkletOpts {
  /** 'encode' | 'decode' | 'shelf' */
  mode: string;
  [key: string]: unknown;
}

const MAX_URL_LENGTH = 65000;
const JS_PREFIX = "javascript:";

// ---------------------------------------------------------------------------
// Comment stripping and whitespace collapsing.
//
// This is not a JS parser. It is a single-pass scanner that:
//   - copies string literals (single, double, backtick) verbatim, so a // or
//     /* inside a string is never mistaken for a comment start;
//   - copies what looks like a regex literal verbatim too, using a
//     conservative heuristic (the character immediately before the leading
//     "/", ignoring whitespace, must be a value-context punctuation mark, a
//     keyword like return/typeof/new, or the start of the source) so a
//     division "a / b" is never misread as the start of a regex;
//   - strips // line comments and /* */ block comments everywhere else;
//   - collapses every other run of whitespace, including strippped-comment
//     gaps, to a single space, which always keeps identifier characters
//     separated.
//
// Known limitation: because newlines collapse to spaces, source that relies
// on automatic semicolon insertion across a line break (a bare "return"
// followed by a value on the next line, or two statements with no
// semicolon where the second starts with "(" or "[") can change meaning.
// Keep semicolons in the source you paste here.
// ---------------------------------------------------------------------------

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "throw",
  "void",
  "do",
  "else",
  "yield",
  "case",
  "await",
  "default",
]);

const REGEX_PRECEDING_PUNCT = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "^",
  "~",
]);

/** The last meaningful token already emitted: a word, or one punctuation char. */
function lastToken(out: string): string {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j]!)) j--;
  if (j < 0) return "";
  const ch = out[j]!;
  if (isIdentChar(ch)) {
    let k = j;
    while (k >= 0 && isIdentChar(out[k]!)) k--;
    return out.slice(k + 1, j + 1);
  }
  return ch;
}

/** Conservative check: does a "/" at this point plausibly start a regex literal? */
function isRegexStart(out: string): boolean {
  const tok = lastToken(out);
  if (tok === "") return true;
  if (REGEX_PRECEDING_KEYWORDS.has(tok)) return true;
  if (tok.length === 1 && REGEX_PRECEDING_PUNCT.has(tok)) return true;
  return false;
}

/**
 * Strips comments (respecting strings and regex-literal boundaries) and
 * collapses whitespace outside of them to a single space. See the module
 * doc comment above for what this does and does not guarantee.
 */
export function minify(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let pendingSpace = false;

  while (i < n) {
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1] : "";

    // String literals: copied verbatim, including any // or /* inside.
    if (c === "'" || c === '"' || c === "`") {
      if (pendingSpace) {
        out += " ";
        pendingSpace = false;
      }
      const quote = c;
      let j = i + 1;
      let buf = c;
      while (j < n) {
        const cj = src[j]!;
        buf += cj;
        if (cj === "\\") {
          j++;
          if (j < n) {
            buf += src[j];
            j++;
          }
          continue;
        }
        if (cj === quote) {
          j++;
          break;
        }
        j++;
      }
      out += buf;
      i = j;
      continue;
    }

    // Line comment.
    if (c === "/" && c2 === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      pendingSpace = true;
      continue;
    }

    // Block comment.
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      pendingSpace = true;
      continue;
    }

    // Possible regex literal: copied verbatim so an unescaped // or /*
    // inside its body is never mistaken for a comment.
    if (c === "/" && isRegexStart(out)) {
      if (pendingSpace) {
        out += " ";
        pendingSpace = false;
      }
      let j = i + 1;
      let buf = c;
      let inClass = false;
      while (j < n) {
        const cj = src[j]!;
        buf += cj;
        if (cj === "\\") {
          j++;
          if (j < n) {
            buf += src[j];
            j++;
          }
          continue;
        }
        if (cj === "[") {
          inClass = true;
          j++;
          continue;
        }
        if (cj === "]") {
          inClass = false;
          j++;
          continue;
        }
        if (cj === "/" && !inClass) {
          j++;
          break;
        }
        if (cj === "\n") break; // unterminated on this line: bail out, treat as literal so far
        j++;
      }
      while (j < n && /[a-z]/i.test(src[j]!)) {
        buf += src[j];
        j++;
      }
      out += buf;
      i = j;
      continue;
    }

    if (/\s/.test(c)) {
      pendingSpace = true;
      i++;
      continue;
    }

    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += c;
    i++;
  }

  return out.trim();
}

// ---------------------------------------------------------------------------
// Encode / decode / shelf.
// ---------------------------------------------------------------------------

/** Minify, optionally wrap in an IIFE, percent-encode, and enforce the length cap. */
function wrapAndEncode(bodySrc: string, alreadyWrapped: boolean): string {
  const minified = minify(bodySrc);
  const wrapped = alreadyWrapped ? minified : `(()=>{${minified}})()`;
  const encoded = JS_PREFIX + encodeURIComponent(wrapped);
  if (encoded.length > MAX_URL_LENGTH) {
    throw new ToolError(
      "too-long",
      `The bookmarklet URL is ${encoded.length} characters, past the ~${MAX_URL_LENGTH} limit most bookmark managers accept.`,
      "Shorten the source, or split it into more than one bookmarklet.",
    );
  }
  return encoded;
}

function encode(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed)
    throw new ToolError("empty-input", "Enter JavaScript source to turn into a bookmarklet.");

  const startsWithJs = /^javascript:/i.test(trimmed);
  const rawBody = startsWithJs ? trimmed.slice(JS_PREFIX.length) : trimmed;
  let body = rawBody;
  if (startsWithJs) {
    try {
      body = decodeURIComponent(rawBody);
    } catch {
      body = rawBody; // not percent-encoded, or malformed: use as typed
    }
  }
  return wrapAndEncode(body, startsWithJs);
}

function decode(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new ToolError("empty-input", "Paste a javascript: bookmarklet URL to decode.");
  if (!/^javascript:/i.test(trimmed))
    throw new ToolError(
      "not-bookmarklet",
      `"${trimmed.slice(0, 40)}" does not start with javascript:.`,
      "Paste the full bookmarklet URL, starting with javascript:.",
    );
  const body = trimmed.slice(JS_PREFIX.length);
  try {
    return decodeURIComponent(body);
  } catch {
    return body; // malformed percent-encoding: return the raw body rather than erroring
  }
}

export interface ShelfEntry {
  name: string;
  description: string;
  source: string;
}

/**
 * Ready-made bookmarklets. Each is self-contained (no shared globals across
 * runs beyond the DOM), injects nothing remote, and cleans itself up: an
 * overlay it creates is removed by pressing Esc or by running the same
 * bookmarklet a second time. Exported so a future custom panel can render
 * these as draggable links without re-deriving them from `run`.
 */
export const SHELF: ShelfEntry[] = [
  {
    name: "Outline everything",
    description: "Draws a 1px outline around every element on the page. Run again to remove it.",
    source: `
      // Toggle a global outline style. Second run removes it.
      var id = '__bm_outline__';
      var existing = document.getElementById(id);
      if (existing) {
        existing.remove();
      } else {
        var style = document.createElement('style');
        style.id = id;
        style.textContent = '*{outline:1px solid rgba(255,0,60,.6) !important;}';
        document.head.appendChild(style);
      }
    `,
  },
  {
    name: "Kill sticky headers",
    description: "Removes every fixed or sticky-positioned element and restores page scrolling.",
    source: `
      // One-shot fix: no overlay is left behind, so nothing to toggle.
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var cs = getComputedStyle(all[i]);
        if (cs.position === 'fixed' || cs.position === 'sticky') {
          all[i].parentNode && all[i].remove();
        }
      }
      document.documentElement.style.overflow = 'auto';
      document.body.style.overflow = 'auto';
      document.documentElement.style.position = 'static';
      document.body.style.position = 'static';
    `,
  },
  {
    name: "Reveal passwords",
    description: "Turns every password field into plain text. Run again to hide them again.",
    source: `
      // Per-field toggle: a revealed field is marked so a second run re-hides it.
      var inputs = document.querySelectorAll('input[type="password"],input[data-bm-was-password]');
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (inp.type === 'password') {
          inp.type = 'text';
          inp.setAttribute('data-bm-was-password', '1');
        } else if (inp.hasAttribute('data-bm-was-password')) {
          inp.type = 'password';
          inp.removeAttribute('data-bm-was-password');
        }
      }
    `,
  },
  {
    name: "Make page editable",
    description: "Toggles the browser's designMode so you can click and edit any text on the page.",
    source: `
      document.designMode = document.designMode === 'on' ? 'off' : 'on';
    `,
  },
  {
    name: "Pixel ruler",
    description:
      "Shows a crosshair with live x/y coordinates as you move the mouse. Click to drop a marker, press Esc or run again to remove it.",
    source: `
      var id = '__bm_ruler__';
      var existing = document.getElementById(id);
      if (existing) { existing._cleanup(); }
      else {
        var el = document.createElement('div');
        el.id = id;
        var hLine = document.createElement('div');
        hLine.style.cssText = 'position:fixed;left:0;right:0;height:1px;background:rgba(255,0,60,.6);pointer-events:none;z-index:2147483647;';
        var vLine = document.createElement('div');
        vLine.style.cssText = 'position:fixed;top:0;bottom:0;width:1px;background:rgba(255,0,60,.6);pointer-events:none;z-index:2147483647;';
        var label = document.createElement('div');
        label.style.cssText = 'position:fixed;background:#111;color:#fff;padding:2px 6px;border-radius:3px;pointer-events:none;font:12px monospace;z-index:2147483647;';
        document.body.appendChild(hLine);
        document.body.appendChild(vLine);
        document.body.appendChild(label);
        document.body.appendChild(el);
        var markers = [];
        function onMove(e) {
          hLine.style.top = e.clientY + 'px';
          vLine.style.left = e.clientX + 'px';
          label.style.left = (e.clientX + 12) + 'px';
          label.style.top = (e.clientY + 12) + 'px';
          label.textContent = e.clientX + ', ' + e.clientY;
        }
        function onClick(e) {
          e.preventDefault();
          e.stopPropagation();
          var m = document.createElement('div');
          m.style.cssText = 'position:fixed;width:8px;height:8px;margin:-4px;border-radius:50%;background:#ff003c;pointer-events:none;z-index:2147483647;left:' + e.clientX + 'px;top:' + e.clientY + 'px;';
          document.body.appendChild(m);
          markers.push(m);
        }
        function onKey(e) { if (e.key === 'Escape') el._cleanup(); }
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        el._cleanup = function () {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKey, true);
          hLine.remove(); vLine.remove(); label.remove();
          for (var i = 0; i < markers.length; i++) markers[i].remove();
          el.remove();
        };
      }
    `,
  },
  {
    name: "Color picker",
    description:
      "Click any element to see its computed background and text color in a floating chip. Press Esc or run again to remove it.",
    source: `
      var id = '__bm_picker__';
      var existing = document.getElementById(id);
      if (existing) { existing._cleanup(); }
      else {
        var chip = document.createElement('div');
        chip.id = id;
        chip.style.cssText = 'position:fixed;left:12px;bottom:12px;background:#111;color:#fff;padding:8px 12px;border-radius:6px;font:12px monospace;z-index:2147483647;pointer-events:none;';
        chip.textContent = 'Click any element...';
        document.body.appendChild(chip);
        function onClick(e) {
          e.preventDefault();
          e.stopPropagation();
          var cs = getComputedStyle(e.target);
          chip.textContent = 'bg: ' + cs.backgroundColor + ' | color: ' + cs.color;
        }
        function onKey(e) { if (e.key === 'Escape') chip._cleanup(); }
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        chip._cleanup = function () {
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKey, true);
          chip.remove();
        };
      }
    `,
  },
  {
    name: "List every link",
    description:
      "Lists every href on the page in an overlay you can select and copy from. Press Esc, click Close, or run again to remove it.",
    source: `
      var id = '__bm_links__';
      var existing = document.getElementById(id);
      if (existing) { existing._cleanup(); }
      else {
        var anchors = document.querySelectorAll('a[href]');
        var lines = [];
        for (var i = 0; i < anchors.length; i++) {
          var href = anchors[i].getAttribute('href');
          if (href) lines.push(href);
        }
        var overlay = document.createElement('div');
        overlay.id = id;
        overlay.style.cssText = 'position:fixed;inset:24px;background:#111;color:#0f0;overflow:auto;z-index:2147483647;padding:16px;border-radius:8px;';
        var closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close (Esc)';
        closeBtn.style.cssText = 'position:sticky;top:0;margin-bottom:8px;background:#333;color:#fff;border:0;padding:6px 10px;border-radius:4px;cursor:pointer;';
        var pre = document.createElement('pre');
        pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font:12px monospace;margin:0;';
        pre.textContent = lines.length ? lines.join('\\n') : 'No links found.';
        overlay.appendChild(closeBtn);
        overlay.appendChild(pre);
        document.body.appendChild(overlay);
        function onKey(e) { if (e.key === 'Escape') overlay._cleanup(); }
        function onClose() { overlay._cleanup(); }
        document.addEventListener('keydown', onKey, true);
        closeBtn.addEventListener('click', onClose);
        overlay._cleanup = function () {
          document.removeEventListener('keydown', onKey, true);
          overlay.remove();
        };
      }
    `,
  },
  {
    name: "List every image",
    description:
      "Lists every image on the page with its natural pixel size in an overlay. Press Esc, click Close, or run again to remove it.",
    source: `
      var id = '__bm_images__';
      var existing = document.getElementById(id);
      if (existing) { existing._cleanup(); }
      else {
        var imgs = document.querySelectorAll('img');
        var lines = [];
        for (var i = 0; i < imgs.length; i++) {
          var im = imgs[i];
          lines.push(im.naturalWidth + 'x' + im.naturalHeight + '  ' + (im.currentSrc || im.src));
        }
        var overlay = document.createElement('div');
        overlay.id = id;
        overlay.style.cssText = 'position:fixed;inset:24px;background:#111;color:#0f0;overflow:auto;z-index:2147483647;padding:16px;border-radius:8px;';
        var closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close (Esc)';
        closeBtn.style.cssText = 'position:sticky;top:0;margin-bottom:8px;background:#333;color:#fff;border:0;padding:6px 10px;border-radius:4px;cursor:pointer;';
        var pre = document.createElement('pre');
        pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font:12px monospace;margin:0;';
        pre.textContent = lines.length ? lines.join('\\n') : 'No images found.';
        overlay.appendChild(closeBtn);
        overlay.appendChild(pre);
        document.body.appendChild(overlay);
        function onKey(e) { if (e.key === 'Escape') overlay._cleanup(); }
        function onClose() { overlay._cleanup(); }
        document.addEventListener('keydown', onKey, true);
        closeBtn.addEventListener('click', onClose);
        overlay._cleanup = function () {
          document.removeEventListener('keydown', onKey, true);
          overlay.remove();
        };
      }
    `,
  },
  {
    name: "Accessibility audit",
    description:
      "Counts images missing alt text, inputs missing labels, and heading order jumps, then shows the totals in an overlay. Press Esc, click Close, or run again to remove it.",
    source: `
      var id = '__bm_audit__';
      var existing = document.getElementById(id);
      if (existing) { existing._cleanup(); }
      else {
        var imgs = document.querySelectorAll('img');
        var missingAlt = 0;
        for (var i = 0; i < imgs.length; i++) { if (!imgs[i].hasAttribute('alt')) missingAlt++; }

        var fields = document.querySelectorAll('input,select,textarea');
        var missingLabel = 0;
        for (var j = 0; j < fields.length; j++) {
          var f = fields[j];
          var hasLabel = false;
          if (f.id && document.querySelector('label[for="' + f.id + '"]')) hasLabel = true;
          if (f.closest('label')) hasLabel = true;
          if (f.getAttribute('aria-label') || f.getAttribute('aria-labelledby')) hasLabel = true;
          if (!hasLabel) missingLabel++;
        }

        var headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
        var jumps = 0;
        var lastLevel = 0;
        for (var k = 0; k < headings.length; k++) {
          var level = Number(headings[k].tagName.charAt(1));
          if (lastLevel && level - lastLevel > 1) jumps++;
          lastLevel = level;
        }

        var overlay = document.createElement('div');
        overlay.id = id;
        overlay.style.cssText = 'position:fixed;right:24px;bottom:24px;background:#111;color:#fff;z-index:2147483647;padding:16px;border-radius:8px;font:13px monospace;max-width:320px;';
        var title = document.createElement('div');
        title.textContent = 'Accessibility audit';
        title.style.cssText = 'font-weight:bold;margin-bottom:8px;';
        var body = document.createElement('div');
        body.style.cssText = 'white-space:pre-wrap;';
        body.textContent = 'Images missing alt: ' + missingAlt + '\\nInputs missing labels: ' + missingLabel + '\\nHeading order jumps: ' + jumps;
        var closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close (Esc)';
        closeBtn.style.cssText = 'display:block;margin-top:8px;background:#333;color:#fff;border:0;padding:6px 10px;border-radius:4px;cursor:pointer;';
        overlay.appendChild(title);
        overlay.appendChild(body);
        overlay.appendChild(closeBtn);
        document.body.appendChild(overlay);
        function onKey(e) { if (e.key === 'Escape') overlay._cleanup(); }
        function onClose() { overlay._cleanup(); }
        document.addEventListener('keydown', onKey, true);
        closeBtn.addEventListener('click', onClose);
        overlay._cleanup = function () {
          document.removeEventListener('keydown', onKey, true);
          overlay.remove();
        };
      }
    `,
  },
];

function shelf(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of SHELF) {
    out[entry.name] = wrapAndEncode(entry.source, false);
  }
  return out;
}

export function run(input: string, opts: BookmarkletOpts): string | Record<string, string> {
  const mode = opts.mode || "encode";
  if (mode === "decode") return decode(input);
  if (mode === "shelf") return shelf();
  if (mode === "encode") return encode(input);
  throw new ToolError("bad-mode", `Unknown mode "${mode}".`, 'Use "encode", "decode", or "shelf".');
}

export default { run } satisfies ToolLogic<string, string | Record<string, string>, BookmarkletOpts>;
