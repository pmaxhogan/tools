/**
 * The storage layer for the preference lists: recently used tools and pinned
 * favorites. Rule 7 lets `localStorage` hold preferences and nothing else, and
 * a list of tool slugs is a preference, so this module owns exactly that shape,
 * `string[]` under a named key, and nothing wider.
 *
 * It exists because three surfaces (the homepage grid, the sidebar nav, and the
 * star button on a tool page) read and write the same two keys, and a star
 * clicked in one of them has to light up in the others without a reload. The
 * browser's own `storage` event only fires in OTHER tabs, so a same-tab change
 * needs a second channel: every write here also dispatches a `prefs-change`
 * CustomEvent on `window` carrying the key that changed. `onPrefsChange`
 * subscribes to both, so a caller gets same-tab and cross-tab updates from one
 * subscription and one teardown function.
 *
 * Every read and write is wrapped: storage can be disabled (private modes,
 * blocked cookies), full, or holding something an older version wrote. None of
 * those may take a page down, so a failed read is an empty list and a failed
 * write is a no-op that still notifies in-memory listeners.
 */

/** Event name dispatched on `window` after a same-tab preference write. */
export const PREFS_CHANGE_EVENT = "prefs-change";

/** `detail` shape of a {@link PREFS_CHANGE_EVENT} event. */
export interface PrefsChangeDetail {
  /** The localStorage key that was written. */
  key: string;
}

/** True when there is a window with a usable localStorage to talk to. */
function hasStorage(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

/**
 * The slug list stored under `key`, or an empty list when storage is
 * unavailable or holds anything but an array of strings.
 */
export function readList(key: string): string[] {
  if (!hasStorage()) return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Store `list` under `key` and tell this tab about it. The notification fires
 * even when the write itself failed, so the surfaces in this tab still agree
 * with each other when storage is blocked.
 */
export function writeList(key: string, list: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Blocked or full storage: the preference is lost on reload, which is not
    // worth breaking the page over. Listeners still get the in-memory update.
  }
  notifyPrefsChange(key);
}

/** Dispatch the same-tab change event for `key` without writing anything. */
export function notifyPrefsChange(key: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PrefsChangeDetail>(PREFS_CHANGE_EVENT, { detail: { key } }));
}

/**
 * Call `handler` whenever the list under `key` changes, in this tab or another
 * one. Returns the teardown function, which is safe to call more than once.
 */
export function onPrefsChange(key: string, handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<Partial<PrefsChangeDetail>>).detail;
    if (detail?.key === key) handler();
  };
  // A `storage` event with a null key means the whole store was cleared.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === key) handler();
  };

  window.addEventListener(PREFS_CHANGE_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREFS_CHANGE_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
