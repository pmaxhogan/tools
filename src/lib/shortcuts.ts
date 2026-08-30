/**
 * Keyboard shortcuts shared by every tool surface.
 *
 * `TOOL_SHORTCUTS` is the single source of truth for both the shortcut sheet
 * (what to show) and `matchShortcut` (what to do), so the two can never drift.
 * `matchShortcut` is pure and DOM-free, taking a minimal event-like shape
 * instead of a real `KeyboardEvent` so it is trivial to unit test.
 * `installToolShortcuts` is the one DOM-touching piece: a `document` keydown
 * listener that calls `matchShortcut` and dispatches to handlers, returning an
 * uninstall function. `ToolShell.vue` calls it today; `PanelHost.vue` calling
 * it for bespoke panels is a follow-up (see the wave report).
 *
 * The rules, decided here so they live in one place:
 *
 *  - `?` (show the shortcut sheet) is ignored while the event target is an
 *    input, textarea, select, or contenteditable element, anywhere on the
 *    page, so typing a literal "?" never pops the dialog.
 *  - `Ctrl`/`Cmd`+`Enter` (run) and `Ctrl`/`Cmd`+`Shift`+`C` (copy output) are
 *    NOT blocked by typing: they are modified combos that never insert a
 *    character, and running or copying while the cursor is still in the input
 *    is the whole point of having them.
 *  - `Esc` (clear input) is the one exception to the first rule: it fires
 *    only when focus is inside the tool island (`context.insideToolIsland`)
 *    and no dialog is open (`context.dialogOpen`), regardless of whether the
 *    focused element counts as "typing". Outside the tool island, or with a
 *    dialog open, `Esc` does nothing here and falls through to whatever else
 *    is listening (closing the shortcut sheet itself, for example).
 *  - `Ctrl`/`Cmd`+`K` (open the command palette) is listed for documentation
 *    only. `CommandPalette.vue` already owns a global listener for it; this
 *    module never matches it, so there is exactly one place that opens the
 *    palette.
 */

export type ShortcutAction = "show-help" | "run" | "copy-output" | "clear-input" | "open-palette";

export interface ShortcutSpec {
  action: ShortcutAction;
  /** What the sheet calls this shortcut. */
  label: string;
  /** `KeyboardEvent.key` this shortcut fires on, compared case-insensitively. */
  key: string;
  /** Nicer label for `key` in the sheet, when the raw key value reads oddly. */
  displayKey?: string;
  /** Requires Ctrl on Windows/Linux, Cmd on macOS. */
  ctrlOrCmd?: boolean;
  shift?: boolean;
  /** Documented in the sheet but never matched here; something else owns it. */
  documentedOnly?: boolean;
}

/** The keymap. Order here is the order the sheet renders them in. */
export const TOOL_SHORTCUTS: readonly ShortcutSpec[] = [
  { action: "show-help", label: "Show keyboard shortcuts", key: "?" },
  { action: "run", label: "Run the tool", key: "Enter", displayKey: "Enter", ctrlOrCmd: true },
  {
    action: "copy-output",
    label: "Copy output",
    key: "c",
    displayKey: "C",
    ctrlOrCmd: true,
    shift: true,
  },
  { action: "clear-input", label: "Clear input", key: "Escape", displayKey: "Esc" },
  {
    action: "open-palette",
    label: "Open search",
    key: "k",
    displayKey: "K",
    ctrlOrCmd: true,
    documentedOnly: true,
  },
];

/**
 * Tools whose subject IS the keyboard. On these the key you press is the
 * reading, so opening a modal sheet on "?" (which then traps focus until it is
 * dismissed) would break the tool at the exact moment it is being used. They
 * get no shortcut sheet, and their page does not advertise one. PanelHost
 * skips installing the listener for these slugs; ToolPage.astro skips the
 * "press ? for shortcuts" line for the same set, from this one list.
 */
export const KEYBOARD_FIRST_TOOLS: ReadonlySet<string> = new Set([
  "keycode",
  "key-rollover-tester",
  "media-key-tester",
  "reaction-time-test",
  "click-speed-test",
  "typing-speed-test",
]);

/** The minimal event shape `matchShortcut` needs, satisfied by a real KeyboardEvent. */
export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** The event target's tag name, any case. Empty string when there is no target. */
  targetTag: string;
  targetContentEditable: boolean;
}

/** What `matchShortcut` needs to know beyond the key combo itself. */
export interface MatchShortcutContext {
  /** True when the event target sits inside the tool's own input/output island. */
  insideToolIsland: boolean;
  /** True when a dialog (the shortcut sheet, or any other) is currently open. */
  dialogOpen: boolean;
}

const TYPING_TAGS = new Set(["input", "textarea", "select"]);

/** True when the event target is a form control or contenteditable element. */
export function isTypingTarget(
  event: Pick<ShortcutEventLike, "targetTag" | "targetContentEditable">,
): boolean {
  return TYPING_TAGS.has(event.targetTag.toLowerCase()) || event.targetContentEditable;
}

function keyMatches(spec: ShortcutSpec, event: ShortcutEventLike): boolean {
  if (event.key.toLowerCase() !== spec.key.toLowerCase()) return false;
  if ((event.ctrlKey || event.metaKey) !== (spec.ctrlOrCmd === true)) return false;
  // Shift is a requirement, not an exact match: a spec that asks for it (like
  // copy-output's Ctrl/Cmd+Shift+C) needs it held, but a spec that does not
  // ask for it tolerates Shift being held anyway. This matters for "?" itself,
  // whose `key` value already reflects the shift a physical keyboard needs to
  // produce it (Shift+/ on most layouts): requiring shiftKey === false here
  // would make the show-help shortcut unreachable on a real keyboard even
  // though `key` correctly reads "?".
  if (spec.shift === true && !event.shiftKey) return false;
  return true;
}

/**
 * Which `ShortcutAction`, if any, `event` triggers under `context`. Pure: no
 * DOM access, so it runs the same in a unit test and in the real listener.
 * See the module doc comment for the typing/Esc/palette rules this enforces.
 */
export function matchShortcut(
  event: ShortcutEventLike,
  context: MatchShortcutContext,
): ShortcutAction | null {
  const spec = TOOL_SHORTCUTS.find((s) => !s.documentedOnly && keyMatches(s, event));
  if (!spec) return null;

  if (spec.action === "show-help") return isTypingTarget(event) ? null : spec.action;

  if (spec.action === "clear-input") {
    if (context.dialogOpen || !context.insideToolIsland) return null;
    return spec.action;
  }

  return spec.action;
}

/** Callbacks `installToolShortcuts` dispatches to. Every one is optional. */
export interface ShortcutHandlers {
  onShowHelp?: () => void;
  onRun?: () => void;
  onCopyOutput?: () => void;
  onClearInput?: () => void;
  /**
   * Defaults to always true: every action but clear-input ignores this
   * anyway. Takes the real `KeyboardEvent` (not the reduced
   * `ShortcutEventLike`) so a caller can do an actual DOM containment check
   * against its root element, e.g. `root.value?.contains(e.target as Node)`.
   */
  isInsideToolIsland?: (event: KeyboardEvent) => boolean;
  /** Defaults to always false (no dialog open). */
  isDialogOpen?: () => boolean;
}

function toEventLike(e: KeyboardEvent): ShortcutEventLike {
  const target = e.target as HTMLElement | null;
  return {
    key: e.key,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    targetTag: target?.tagName?.toLowerCase() ?? "",
    targetContentEditable: target?.isContentEditable ?? false,
  };
}

/**
 * Installs a `document` keydown listener that runs every keydown through
 * `matchShortcut` and calls the matching handler, `preventDefault`-ing the
 * event when a shortcut fires so, for example, `?` never types into a field
 * behind a mis-focused element. Returns an uninstall function.
 *
 * DOM-touching by design (this is the wiring layer, not the pure logic), so
 * it is safe to call from any mounted tool surface. `ToolShell.vue` calls it
 * for the generic panel; a bespoke panel can call it the same way from
 * `PanelHost.vue` (not wired yet, left for the orchestrator).
 */
export function installToolShortcuts(handlers: ShortcutHandlers): () => void {
  function onKeydown(e: KeyboardEvent): void {
    const eventLike = toEventLike(e);
    const action = matchShortcut(eventLike, {
      insideToolIsland: handlers.isInsideToolIsland?.(e) ?? true,
      dialogOpen: handlers.isDialogOpen?.() ?? false,
    });
    if (!action) return;

    switch (action) {
      case "show-help":
        if (!handlers.onShowHelp) return;
        e.preventDefault();
        handlers.onShowHelp();
        return;
      case "run":
        if (!handlers.onRun) return;
        e.preventDefault();
        handlers.onRun();
        return;
      case "copy-output":
        if (!handlers.onCopyOutput) return;
        e.preventDefault();
        handlers.onCopyOutput();
        return;
      case "clear-input":
        if (!handlers.onClearInput) return;
        e.preventDefault();
        handlers.onClearInput();
        return;
      case "open-palette":
        // documentedOnly: matchShortcut never returns this, kept for exhaustiveness.
        return;
    }
  }

  document.addEventListener("keydown", onKeydown);
  return () => document.removeEventListener("keydown", onKeydown);
}
