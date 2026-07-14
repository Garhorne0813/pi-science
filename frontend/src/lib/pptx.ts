/**
 * Normalize a PPTX before passing it to pptx-preview.
 *
 * The preview library accepts the original OOXML ArrayBuffer directly. This
 * hook is intentionally async so we can add compatibility rewrites later for
 * providers that emit paragraph-level default run properties, without making
 * the viewer or call sites change.
 */
export async function normalizePptxForPreview(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  return bytes;
}

// Kept for compatibility with older callers.
export async function renderPptx(bytes: ArrayBuffer): Promise<HTMLElement> {
  const root = document.createElement("div");
  const normalized = await normalizePptxForPreview(bytes);
  const { init } = await import("pptx-preview");
  const previewer = init(root, { width: 960, mode: "list" });
  await previewer.preview(normalized);
  return root;
}
