import { toast } from "./toast";

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
