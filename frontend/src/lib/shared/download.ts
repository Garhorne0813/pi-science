/** Hand a Blob to the browser as a download with an explicit filename.
 *
 *  The object URL is revoked on a later macrotask: the browser starts reading
 *  the blob inside `click()`, and releasing the URL in the same task can cut a
 *  large transfer short. */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // Firefox only follows the click for anchors attached to the document.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function saveTextWithFeedback(text: string, filename: string): Promise<void> {
  saveBlobAsFile(new Blob([text], { type: "text/plain" }), filename);
}
