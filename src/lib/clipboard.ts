import { toast } from "./toast";

/**
 * The single clipboard-read path for the whole site, the mirror of `copyText`.
 *
 * For a "Paste" button: a control that fills the input from the clipboard
 * without the visitor having to focus the box first. Reading is far more
 * restricted than writing, so failure is the common case rather than the odd
 * one. Firefox has no `readText` for page scripts at all, Safari only allows
 * it behind its own paste confirmation, and every browser refuses when the
 * permission is denied or the document is not focused.
 *
 * That is why the failure toast names the keyboard instead of asking the
 * visitor to try again: Ctrl+V always works, and it is the only advice that
 * helps on a browser that will never grant the permission.
 *
 * Touches `navigator`, so only components may import it. Tool logic stays pure.
 *
 * @returns the clipboard text, or null when the browser blocked or does not
 * support reading. Never throws, so a panel can simply keep its current input
 * when null comes back.
 */
export async function readText(): Promise<string | null> {
  try {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.readText !== "function") {
      throw new Error("The clipboard API is unavailable.");
    }
    return await navigator.clipboard.readText();
  } catch {
    toast({
      title: "Paste failed",
      description:
        "Your browser blocked reading the clipboard. Click the input and press Ctrl+V (Cmd+V on a Mac) instead.",
      variant: "error",
    });
    return null;
  }
}

/**
 * The single clipboard-write path for the whole site.
 *
 * Every "copy" affordance goes through here so the success and failure copy is
 * identical everywhere, exactly like `download.ts` owns saving a file (CLAUDE.md
 * rule 7). Most copy affordances are the shared `CopyButton`, which calls this;
 * this function exists for the sites where the copy target is not a button at
 * all (a swatch cell, a table cell, a character in a grid), where wrapping a
 * Button would restyle the control.
 *
 * Touches `navigator`, so only components may import it. Tool logic stays pure.
 *
 * @returns true when the text reached the clipboard, so a caller can still run
 * its own inline "Copied" flourish. Never throws: a blocked clipboard is a
 * normal browser outcome, not an exception the panel has to handle.
 */
export async function copyText(text: string, label = "Copied"): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      throw new Error("The clipboard API is unavailable.");
    }
    await navigator.clipboard.writeText(text);
    toast({ title: label, variant: "success" });
    return true;
  } catch {
    toast({
      title: "Copy failed",
      description: "Your browser blocked clipboard access. Select the text and copy it by hand.",
      variant: "error",
    });
    return false;
  }
}
