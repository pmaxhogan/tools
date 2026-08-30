import { describe, expect, it } from "vitest";
import { isTypingTarget, matchShortcut, TOOL_SHORTCUTS, type ShortcutEventLike } from "./shortcuts";

function event(overrides: Partial<ShortcutEventLike>): ShortcutEventLike {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    targetTag: "body",
    targetContentEditable: false,
    ...overrides,
  };
}

const notTyping = { insideToolIsland: true, dialogOpen: false };

describe("isTypingTarget", () => {
  it("is true for input, textarea, and select", () => {
    expect(isTypingTarget({ targetTag: "input", targetContentEditable: false })).toBe(true);
    expect(isTypingTarget({ targetTag: "TEXTAREA", targetContentEditable: false })).toBe(true);
    expect(isTypingTarget({ targetTag: "select", targetContentEditable: false })).toBe(true);
  });

  it("is true for contenteditable elements regardless of tag", () => {
    expect(isTypingTarget({ targetTag: "div", targetContentEditable: true })).toBe(true);
  });

  it("is false for a plain element", () => {
    expect(isTypingTarget({ targetTag: "button", targetContentEditable: false })).toBe(false);
    expect(isTypingTarget({ targetTag: "body", targetContentEditable: false })).toBe(false);
  });
});

describe("matchShortcut: show-help (?)", () => {
  // On a real keyboard "?" is Shift+/ on most layouts, so the event arrives
  // with shiftKey: true even though the spec never asks for shift. Every
  // case here fires with shiftKey true to match what a browser actually
  // sends; the last case checks an unshifted layout still works too.
  it("fires on a bare ? outside a text field", () => {
    expect(matchShortcut(event({ key: "?", shiftKey: true, targetTag: "body" }), notTyping)).toBe(
      "show-help",
    );
  });

  it("is ignored while typing in an input", () => {
    expect(
      matchShortcut(event({ key: "?", shiftKey: true, targetTag: "input" }), notTyping),
    ).toBeNull();
  });

  it("is ignored while typing in a textarea", () => {
    expect(
      matchShortcut(event({ key: "?", shiftKey: true, targetTag: "textarea" }), notTyping),
    ).toBeNull();
  });

  it("is ignored in a contenteditable element", () => {
    expect(
      matchShortcut(
        event({ key: "?", shiftKey: true, targetTag: "div", targetContentEditable: true }),
        notTyping,
      ),
    ).toBeNull();
  });

  it("also fires without shiftKey, for a layout where ? is unshifted", () => {
    expect(matchShortcut(event({ key: "?", shiftKey: false }), notTyping)).toBe("show-help");
  });
});

describe("matchShortcut: run (Ctrl/Cmd+Enter)", () => {
  it("fires with ctrlKey", () => {
    expect(matchShortcut(event({ key: "Enter", ctrlKey: true }), notTyping)).toBe("run");
  });

  it("fires with metaKey (Cmd on macOS)", () => {
    expect(matchShortcut(event({ key: "Enter", metaKey: true }), notTyping)).toBe("run");
  });

  it("fires while the target is the tool's own textarea", () => {
    expect(
      matchShortcut(event({ key: "Enter", ctrlKey: true, targetTag: "textarea" }), notTyping),
    ).toBe("run");
  });

  it("does not fire on a bare Enter", () => {
    expect(matchShortcut(event({ key: "Enter" }), notTyping)).toBeNull();
  });

  it("still fires with an incidental shiftKey held (shift is a requirement, not an exact match)", () => {
    expect(matchShortcut(event({ key: "Enter", ctrlKey: true, shiftKey: true }), notTyping)).toBe(
      "run",
    );
  });
});

describe("matchShortcut: copy-output (Ctrl/Cmd+Shift+C)", () => {
  it("fires with ctrlKey and shiftKey", () => {
    expect(matchShortcut(event({ key: "c", ctrlKey: true, shiftKey: true }), notTyping)).toBe(
      "copy-output",
    );
  });

  it("fires while typing (a modified combo never inserts a character)", () => {
    expect(
      matchShortcut(
        event({ key: "c", ctrlKey: true, shiftKey: true, targetTag: "textarea" }),
        notTyping,
      ),
    ).toBe("copy-output");
  });

  it("does not fire without shift", () => {
    expect(matchShortcut(event({ key: "c", ctrlKey: true }), notTyping)).toBeNull();
  });

  it("does not fire on a bare c", () => {
    expect(matchShortcut(event({ key: "c" }), notTyping)).toBeNull();
  });
});

describe("matchShortcut: clear-input (Esc)", () => {
  it("fires inside the tool island with no dialog open", () => {
    expect(
      matchShortcut(event({ key: "Escape" }), { insideToolIsland: true, dialogOpen: false }),
    ).toBe("clear-input");
  });

  it("fires even when the target is the tool's own textarea (the documented exception)", () => {
    expect(
      matchShortcut(event({ key: "Escape", targetTag: "textarea" }), {
        insideToolIsland: true,
        dialogOpen: false,
      }),
    ).toBe("clear-input");
  });

  it("does not fire outside the tool island", () => {
    expect(
      matchShortcut(event({ key: "Escape" }), { insideToolIsland: false, dialogOpen: false }),
    ).toBeNull();
  });

  it("does not fire while a dialog is open", () => {
    expect(
      matchShortcut(event({ key: "Escape" }), { insideToolIsland: true, dialogOpen: true }),
    ).toBeNull();
  });
});

describe("matchShortcut: open-palette (Ctrl/Cmd+K) is documentation only", () => {
  it("is never matched, even with the right combo", () => {
    expect(matchShortcut(event({ key: "k", ctrlKey: true }), notTyping)).toBeNull();
  });

  it("still appears in TOOL_SHORTCUTS for the sheet to render", () => {
    expect(TOOL_SHORTCUTS.some((s) => s.action === "open-palette")).toBe(true);
  });
});

describe("matchShortcut: unrelated keys", () => {
  it("returns null for a key with no shortcut", () => {
    expect(matchShortcut(event({ key: "a" }), notTyping)).toBeNull();
  });
});
