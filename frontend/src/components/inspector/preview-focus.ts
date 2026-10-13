/** Include browsing contexts in the modal's native keyboard sequence. */
export function previewFocusables(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, iframe:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.tabIndex >= 0 && !element.closest("[hidden], [inert]") && !element.matches(":disabled") && element.checkVisibility?.({ visibilityProperty: true }) !== false);
}

/** Native inert keeps background controls out of iframe/PDF Tab navigation,
 * whose key events may be owned by the browser rather than the parent page. */
export function inertPreviewBackground(panel: HTMLElement) {
  const changed = new Map<HTMLElement, boolean>();
  let branch: HTMLElement = panel;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch || sibling.getAttribute("aria-hidden") === "true") continue;
      changed.set(sibling, sibling.hasAttribute("inert"));
      sibling.setAttribute("inert", "");
    }
    if (parent === document.body) break;
    branch = parent;
  }
  return () => {
    for (const [element, wasInert] of changed) if (!wasInert) element.removeAttribute("inert");
  };
}

export function focusPreviewElement(element: HTMLElement, reverse = false) {
  element.focus();
  if (element.tagName !== "IFRAME") return;
  try {
    const frameDocument = (element as HTMLIFrameElement).contentDocument;
    if (!frameDocument) return;
    const controls = previewFocusables(frameDocument);
    (reverse ? controls.at(-1) : controls[0])?.focus();
  } catch { /* Browser-owned and cross-origin frames keep their own focus. */ }
}
