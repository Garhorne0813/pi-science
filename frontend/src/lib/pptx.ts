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
