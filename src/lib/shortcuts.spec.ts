import { describe, expect, it, vi } from "vitest";
import { installToolShortcuts } from "./shortcuts";

function fireKeydown(init: KeyboardEventInit, target: EventTarget = document): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("installToolShortcuts", () => {
  it("calls onRun for Ctrl+Enter and preventDefault()s the event", () => {
    const onRun = vi.fn();
    const uninstall = installToolShortcuts({ onRun });
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true });
    document.dispatchEvent(event);
    expect(onRun).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    uninstall();
  });

  it("calls onShowHelp for a real ? keypress (Shift+/ on most layouts)", () => {
    const onShowHelp = vi.fn();
    const uninstall = installToolShortcuts({ onShowHelp });
    // A physical keyboard sends shiftKey: true for "?" on most layouts; the
    // spec has no shift requirement, so this must still match (see the
    // "shift is a requirement, not an exact match" comment in keyMatches).
    fireKeydown({ key: "?", shiftKey: true });
    expect(onShowHelp).toHaveBeenCalledOnce();
    uninstall();
  });

  it("does not call onShowHelp while the target is typing", () => {
    const onShowHelp = vi.fn();
    const uninstall = installToolShortcuts({ onShowHelp });
    const input = document.createElement("input");
    document.body.append(input);
    fireKeydown({ key: "?", shiftKey: true }, input);
    expect(onShowHelp).not.toHaveBeenCalled();
    input.remove();
    uninstall();
  });

  it("passes the real KeyboardEvent to isInsideToolIsland and gates clear-input on it", () => {
    const onClearInput = vi.fn();
    const isInsideToolIsland = vi.fn((e: KeyboardEvent) => e.target === document.body);
    const uninstall = installToolShortcuts({ onClearInput, isInsideToolIsland });

    fireKeydown({ key: "Escape" }, document.body);
    expect(isInsideToolIsland).toHaveBeenCalled();
    expect(isInsideToolIsland.mock.calls[0][0]).toBeInstanceOf(KeyboardEvent);
    expect(onClearInput).toHaveBeenCalledOnce();

    uninstall();
  });

  it("blocks clear-input when isDialogOpen reports true", () => {
    const onClearInput = vi.fn();
    const uninstall = installToolShortcuts({ onClearInput, isDialogOpen: () => true });
    fireKeydown({ key: "Escape" });
    expect(onClearInput).not.toHaveBeenCalled();
    uninstall();
  });

  it("stops listening after uninstall", () => {
    const onRun = vi.fn();
    const uninstall = installToolShortcuts({ onRun });
    uninstall();
    fireKeydown({ key: "Enter", ctrlKey: true });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("does nothing, and does not preventDefault, when no handler is registered for the action", () => {
    const uninstall = installToolShortcuts({});
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    uninstall();
  });
});
