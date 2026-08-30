/**
 * Cross-tool input carry: the file or text a visitor just gave one tool stays
 * available to the next tool they open, so "resize this image, then strip its
 * EXIF" never means picking the same file twice.
 *
 * The store is IN MEMORY ONLY. It survives Astro view transitions (the JS
 * module instance lives across client-side navigations) and nothing else:
 * a reload or a new tab starts empty. That is deliberate. PROJECT.md lets
 * localStorage hold preferences, never content, and a visitor's file is
 * content. Nothing here touches storage, the DOM, or the network, so the
 * module is importable from anywhere and the tests stay plain.
 *
 * FileDrop calls setCarriedInput when it receives files and shows a
 * "Use <name> from <tool>" chip when the carried input matches its accept
 * filter. ToolShell does the same for text input.
 */

export interface CarriedInput {
  kind: "file" | "text";
  /** Present when kind is "file". Only the first file is carried. */
  file?: File;
  /** Present when kind is "text". */
  text?: string;
  /** Slug of the tool the input came from. */
  fromSlug: string;
  /** Display name of that tool. */
  fromName: string;
  /** Date.now() at the time it was set. */
  at: number;
}

type Listener = (value: CarriedInput | null) => void;

let current: CarriedInput | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const cb of listeners) cb(current);
}

/** Replace the carried input. Same-tool re-sets are fine; they just refresh it. */
export function setCarriedInput(input: CarriedInput): void {
  current = input;
  notify();
}

export function getCarriedInput(): CarriedInput | null {
  return current;
}

export function clearCarriedInput(): void {
  if (current === null) return;
  current = null;
  notify();
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeCarriedInput(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Does the carried input hold a file that an `accept` attribute would admit?
 * `accept` uses the HTML input syntax ("image/*", ".gpx,.kml", "audio/*,.wav").
 * Empty or missing accept admits any file. Pure, so it is unit tested.
 */
export function carriedFileMatches(input: CarriedInput | null, accept?: string): boolean {
  if (!input || input.kind !== "file" || !input.file) return false;
  const rules = (accept ?? "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (rules.length === 0) return true;
  const name = input.file.name.toLowerCase();
  const type = (input.file.type || "").toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

/**
 * Should a tool offer the carried input at all? Not when it came from this
 * same tool (the visitor is already looking at it) and not once it is stale.
 */
export function shouldOfferCarried(
  input: CarriedInput | null,
  currentSlug: string,
  now = Date.now(),
  maxAgeMs = 30 * 60 * 1000,
): boolean {
  if (!input) return false;
  if (input.fromSlug === currentSlug) return false;
  return now - input.at <= maxAgeMs;
}
