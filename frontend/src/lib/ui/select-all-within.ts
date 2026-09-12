/** Whether a keyboard event is the platform select-all shortcut. */
export function isSelectAllShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && event.key.toLowerCase() === "a";
}

/** Replace the document selection with exactly the contents of `element`. */
export function selectAllWithin(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
