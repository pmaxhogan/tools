/**
 * Connection awareness for the auto-download policy.
 *
 * Tool-specific one-time downloads (ffmpeg, Pyodide, tesseract, the AI models)
 * start automatically on first visit to their tool, EXCEPT when the browser
 * reports a metered or Save-Data connection. There we hold back and let the
 * user start the download with one tap, so a page visit never silently burns
 * hundreds of megabytes of mobile data.
 *
 * This lives in src/lib (not a tool logic module) because it reads
 * navigator.connection, which the pure tool layer may not touch.
 */

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
  type?: string;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

function connection(): NetworkInformationLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

/** True when the connection looks metered or the user asked to save data. */
export function isMetered(): boolean {
  const c = connection();
  if (!c) return false;
  if (c.saveData) return true;
  if (c.type === "cellular") return true;
  const slow =
    c.effectiveType === "slow-2g" || c.effectiveType === "2g" || c.effectiveType === "3g";
  return Boolean(slow);
}

/**
 * Whether a tool-specific download should kick off automatically on first
 * visit. False on metered / Save-Data, where the panel shows a one-tap start
 * with the download size instead.
 */
export function shouldAutoDownload(): boolean {
  return !isMetered();
}

/** Subscribe to connection changes; returns an unsubscribe function. */
export function onConnectionChange(listener: () => void): () => void {
  const c = connection();
  if (!c?.addEventListener) return () => {};
  c.addEventListener("change", listener);
  return () => c.removeEventListener?.("change", listener);
}
