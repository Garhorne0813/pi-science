/** Clipboard access that works where the app is actually used.
 *
 *  `navigator.clipboard` only exists in a secure context, but a workspace is
 *  commonly opened over plain HTTP on a LAN address, where the promise is
 *  simply absent — the file explorer's copy actions then did nothing at all and
 *  said nothing about it. Fall back to the selection-based copy and report
 *  success, so the caller can tell the user when the platform refused. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission or policy refusal: try the legacy path before giving up.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
