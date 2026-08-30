/**
 * The toast store: a tiny observable stack of transient messages.
 *
 * Pure by design. It touches no DOM, no timers, and no browser globals, so it
 * unit tests in the node environment and can be imported from anywhere. The
 * Toaster component owns rendering and the auto-dismiss clock; the store only
 * knows what is currently queued.
 *
 * **How a panel island toasts into the layout island.** Astro hydrates each
 * island as its own Vue app, but they all run in one JavaScript realm. Vite
 * emits `src/lib/toast.ts` as a single shared chunk with a single URL, and the
 * browser's module registry hands every importer the same evaluated instance,
 * so the `stack` and `listeners` below are one object no matter how many
 * islands are on the page. A CopyButton inside a lazily hydrated panel calls
 * `toast()` and the `<Toaster>` mounted once in BaseLayout re-renders. No
 * events, no globals, no provide/inject across island boundaries.
 *
 * Timing note: each toast carries `createdAt` and `durationMs` so a renderer
 * that mounts late (or remounts after a view transition) can work out how much
 * of the dismissal window is left rather than restarting it.
 */

export type ToastVariant = "default" | "success" | "error";

export interface ToastOptions {
  /** Short headline, sentence case. No em or en dashes (DESIGN.md). */
  title: string;
  /** Optional second line: detail, or the fix hint for an error. */
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds on screen. Defaults to DEFAULT_TOAST_MS. */
  durationMs?: number;
}

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  durationMs: number;
  /** Epoch milliseconds, so a late renderer can compute the remaining time. */
  createdAt: number;
}

export type ToastListener = (toasts: readonly Toast[]) => void;

/** Default time on screen. Long enough to read "Copied", short enough to ignore. */
export const DEFAULT_TOAST_MS = 2500;

/**
 * At most three at once. A burst (copying five swatches in a row) should not
 * build a column that covers the tool; the oldest falls off the bottom.
 */
export const MAX_TOASTS = 3;

let stack: readonly Toast[] = [];
const listeners = new Set<ToastListener>();
let counter = 0;

function emit(): void {
  for (const listener of listeners) listener(stack);
}

/** Queue a toast and return its id, which `dismissToast` accepts. */
export function toast(options: ToastOptions): string {
  counter += 1;
  const entry: Toast = {
    id: `toast-${counter}`,
    title: options.title,
    variant: options.variant ?? "default",
    durationMs:
      typeof options.durationMs === "number" && options.durationMs > 0
        ? options.durationMs
        : DEFAULT_TOAST_MS,
    createdAt: Date.now(),
  };
  if (options.description) entry.description = options.description;

  const next = [...stack, entry];
  // Oldest first, so dropping the overflow means dropping from the front.
  stack = next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
  emit();
  return entry.id;
}

/** Remove one toast. Unknown ids are a no-op, so a double dismiss is safe. */
export function dismissToast(id: string): void {
  const next = stack.filter((t) => t.id !== id);
  if (next.length === stack.length) return;
  stack = next;
  emit();
}

/** Remove everything. Mainly for tests and for teardown. */
export function clearToasts(): void {
  if (stack.length === 0) return;
  stack = [];
  emit();
}

/** The current stack, oldest first. */
export function getToasts(): readonly Toast[] {
  return stack;
}

/**
 * Subscribe to the stack. The callback fires immediately with the current
 * value so a renderer that mounts mid-flight still shows what is queued.
 * Returns the unsubscribe function.
 */
export function subscribeToasts(callback: ToastListener): () => void {
  listeners.add(callback);
  callback(stack);
  return () => {
    listeners.delete(callback);
  };
}
