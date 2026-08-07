/**
 * Document Picture-in-Picture: float a tool panel in a small always-on-top
 * window. Chromium only (Chrome and Edge 116+); everything here degrades to a
 * no-op elsewhere, and `isPopoutSupported()` lets the UI hide itself entirely.
 *
 * DATA ATTRIBUTE CONTRACT
 * -----------------------
 * The element that travels into the pop out window is the one carrying
 * `data-popout-root`. PanelHost puts that attribute on the wrapper around the
 * tool panel, and there is exactly one per page:
 *
 *   <div data-popout-root> ...the tool panel... </div>
 *
 * Nothing else on the page may use that attribute. The placeholder card this
 * module leaves behind is marked `data-popout-placeholder` so it is easy to
 * find in tests and never confused with the root.
 *
 * WHY MOVE INSTEAD OF CLONE
 * -------------------------
 * The root element is moved (`appendChild` adopts it into the other document),
 * so every node identity is preserved: Vue's virtual DOM patches keep landing
 * on the same elements, and listeners, intervals and component state all
 * survive. Cloning would silently fork the UI from its state.
 *
 * URL FRAGMENT STATE
 * ------------------
 * Tool state still writes to the opener's `location.hash`, which is what we
 * want: the shareable URL lives on the real page, not on `about:blank`.
 */

/** Only one pop out window can exist at a time, so module state is enough. */
let active: PopoutHandle | null = null;

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 560;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 360;

export interface PopoutOptions {
  /** Requested window width in CSS pixels. Clamped to a usable minimum. */
  width?: number;
  /** Requested window height in CSS pixels. Clamped to a usable minimum. */
  height?: number;
  /**
   * Called once the panel is back in the page, whether the user closed the
   * pop out window, pressed "Bring it back", or code called `close()`.
   * Reactive-friendly: safe to flip a ref from here.
   */
  onClosed?: () => void;
}

export interface PopoutHandle {
  /** Restore the panel and close the pop out window. Safe to call twice. */
  close(): void;
  /** The pop out window itself, for callers that need to size or focus it. */
  readonly window: Window;
}

/** The slice of the Document PiP API we use. Not in lib.dom yet. */
interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

function pipApi(): DocumentPictureInPictureApi | null {
  if (typeof window === 'undefined') return null;
  const host = window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi };
  return host.documentPictureInPicture ?? null;
}

/** True when this browser ships Document Picture-in-Picture. SSR safe. */
export function isPopoutSupported(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

/** True while a panel from this page is floating. */
export function isPoppedOut(): boolean {
  return active !== null;
}

/** Resolves the data attribute contract above. SSR safe. */
export function findPopoutRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>('[data-popout-root]');
}

/**
 * Flattens a stylesheet to CSS text. `@import` rules are expanded inline
 * because an `@import` that lands after other rules is ignored by the parser.
 */
function serializeSheet(sheet: CSSStyleSheet): string {
  const out: string[] = [];
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule instanceof CSSImportRule && rule.styleSheet) {
      try {
        out.push(serializeSheet(rule.styleSheet));
        continue;
      } catch {
        // Unreadable nested sheet: fall through and keep the @import text.
      }
    }
    out.push(rule.cssText);
  }
  return out.join('\n');
}

/**
 * Rebuilds the page's CSS inside the pop out document.
 *
 * Fonts: `global.css` declares self-hosted `@font-face` with root absolute
 * URLs (`/fonts/...`), and serialized `cssText` keeps URLs exactly as
 * authored. The pop out document's own URL is `about:blank`, which resolves
 * nothing, so a `<base href>` goes in first. `document.baseURI` is used rather
 * than `location.origin` so this still works if the site ever moves under a
 * subpath. The base element must precede the styles, since a `<base>` only
 * affects URLs that come after it.
 */
function copyStyles(pip: Window): void {
  const head = pip.document.head;

  const base = pip.document.createElement('base');
  base.href = document.baseURI;
  head.append(base);

  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.disabled) continue;
    try {
      // Serializing avoids a flash of unstyled content: the rules are there
      // before the first paint instead of one network round trip later.
      const style = pip.document.createElement('style');
      if (sheet.media.mediaText) style.media = sheet.media.mediaText;
      style.textContent = serializeSheet(sheet);
      head.append(style);
    } catch {
      // An opaque sheet cannot be read. There are none on this site (rule 8
      // forbids third party requests), but a browser extension can inject
      // one, so fall back to linking it. `link.href` is already absolute.
      const owner = sheet.ownerNode;
      if (owner instanceof HTMLLinkElement && owner.href) {
        const link = pip.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = owner.href;
        if (owner.media) link.media = owner.media;
        head.append(link);
      }
    }
  }
}

/**
 * Mirrors the theme onto the pop out document: the `.dark` class lives on
 * `<html>`, so copying the class list is what carries dark mode across. The
 * background is also painted directly from the token so there is no white
 * flash before the copied stylesheet's `body` rule applies.
 */
function applyTheme(pip: Window): void {
  const source = document.documentElement;
  const target = pip.document.documentElement;
  target.className = source.className;
  target.lang = source.lang || 'en';

  const tokens = getComputedStyle(source);
  const background = tokens.getPropertyValue('--background').trim();
  const foreground = tokens.getPropertyValue('--foreground').trim();
  const dark = source.classList.contains('dark');

  target.style.colorScheme = dark ? 'dark' : 'light';
  pip.document.body.style.background = background || (dark ? '#141311' : '#f6f4f1');
  pip.document.body.style.color = foreground || (dark ? '#f4f1ec' : '#1b1917');
  pip.document.body.style.margin = '0';
  pip.document.body.style.padding = '12px';
}

/**
 * The card left in the vacated spot. Built with inline styles reading the
 * design tokens rather than Tailwind utilities: this markup lives in a `.ts`
 * file, so relying on the utility scanner to emit classes for it would couple
 * the placeholder's appearance to scanner behavior.
 */
function buildPlaceholder(onReturn: () => void): HTMLElement {
  const card = document.createElement('div');
  card.setAttribute('data-popout-placeholder', '');
  card.style.cssText = [
    'display:flex',
    'flex-wrap:wrap',
    'align-items:center',
    'justify-content:space-between',
    'gap:12px',
    'padding:20px',
    'border:1px solid var(--border)',
    'border-radius:14px',
    'background:var(--card)',
    'color:var(--foreground)',
    'box-shadow:var(--sh-sm)',
    'font-size:14px',
  ].join(';');

  const text = document.createElement('div');
  const title = document.createElement('p');
  title.textContent = 'This tool is floating in its own window.';
  title.style.cssText = 'margin:0;font-weight:500';
  const hint = document.createElement('p');
  hint.textContent = 'Close that window, or bring it back here.';
  hint.style.cssText = 'margin:2px 0 0;color:var(--muted-foreground);font-size:13.5px';
  text.append(title, hint);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Bring it back';
  button.style.cssText = [
    'height:32px',
    'padding:0 12px',
    'border:1px solid var(--border)',
    'border-radius:10px',
    'background:var(--background)',
    'color:var(--foreground)',
    'font:inherit',
    'font-size:13.5px',
    'font-weight:500',
    'cursor:pointer',
  ].join(';');
  button.addEventListener('click', onReturn);

  card.append(text, button);
  return card;
}

/**
 * Moves `root` into a floating window. Returns null when the browser has no
 * Document PiP support, when the user gesture requirement is not met, or when
 * a pop out window is already open.
 */
export async function popOut(root: HTMLElement, opts: PopoutOptions = {}): Promise<PopoutHandle | null> {
  const api = pipApi();
  if (!api) {
    console.warn('[popout] Document Picture-in-Picture is not available in this browser.');
    return null;
  }
  // Already floating: hand back the live handle instead of opening a second
  // window, which the API would either reject or silently replace.
  if (active) return active;
  if (api.window) {
    console.warn('[popout] Another Picture-in-Picture window is already open.');
    return null;
  }

  let pip: Window;
  try {
    pip = await api.requestWindow({
      width: Math.max(MIN_WIDTH, Math.round(opts.width ?? DEFAULT_WIDTH)),
      height: Math.max(MIN_HEIGHT, Math.round(opts.height ?? DEFAULT_HEIGHT)),
    });
  } catch (err) {
    // Rejects without a user gesture, when the feature is policy blocked, or
    // when the user declines. Nothing moved yet, so there is nothing to undo.
    console.warn('[popout] Could not open the pop out window.', err);
    return null;
  }

  pip.document.title = document.title;
  copyStyles(pip);
  applyTheme(pip);

  // The placeholder doubles as the restore anchor: it sits exactly where the
  // root was, so putting the root back is a single replaceChild.
  const placeholder = buildPlaceholder(() => handle.close());
  root.parentNode?.insertBefore(placeholder, root);
  pip.document.body.append(root);

  // Keep the floating window in sync when the header theme toggle flips the
  // `.dark` class on the opener, otherwise it strands the old theme.
  const themeWatcher = new MutationObserver(() => applyTheme(pip));
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  let restored = false;

  /** The single restore path. Idempotent: every trigger routes through here. */
  function restore(): void {
    if (restored) return;
    restored = true;
    themeWatcher.disconnect();
    pip.removeEventListener('pagehide', restore);
    window.removeEventListener('pagehide', closeOnly);
    // If the placeholder is gone the host component was torn down, so there is
    // nowhere sensible to put the panel back. Dropping it is better than
    // appending an orphan panel to the end of the page.
    if (placeholder.isConnected) placeholder.replaceWith(root);
    active = null;
    opts.onClosed?.();
  }

  /** Opener is going away: close the floating window, do not move nodes. */
  function closeOnly(): void {
    try {
      pip.close();
    } catch {
      // Window already gone.
    }
  }

  // User closed the floating window with its own close button.
  pip.addEventListener('pagehide', restore);
  window.addEventListener('pagehide', closeOnly);

  const handle: PopoutHandle = {
    window: pip,
    close() {
      // Restore first so the panel is home even if `pagehide` never fires.
      restore();
      closeOnly();
    },
  };

  active = handle;
  return handle;
}
