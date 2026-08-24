/**
 * Saving a generated file to disk.
 *
 * Every tool that produces a file needs the same six-line anchor dance, so it
 * had been rewritten in 23 panels, each with its own answer to when (or
 * whether) to revoke the object URL. Browsers still offer no direct "save this
 * blob" call, so the anchor is unavoidable; having it in one place is not.
 *
 * Component-side only: this touches the DOM, so tool logic must not import it.
 */

/**
 * Click a synthetic link to save `url` as `filename`.
 *
 * The caller owns `url` and its lifetime. Use this for URLs that outlive the
 * download (an object URL held in component state, or a data URL); use
 * `downloadBlob` when the URL exists only to be saved.
 */
export function downloadUrl(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Firefox only honors a click on a link that is in the document.
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Save a blob as `filename`, minting and releasing the object URL.
 *
 * The revoke is deferred: revoking synchronously after `click()` races the
 * browser's read of the URL, and the download fails silently in Safari. A
 * generous delay costs one unreachable blob for a second and is the difference
 * between a file saving and not.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Save UTF-8 text as `filename`, e.g. downloadText(json, "report.json"). */
export function downloadText(text: string, filename: string, type = "text/plain"): void {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}
