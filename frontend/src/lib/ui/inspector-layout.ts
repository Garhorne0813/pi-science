export const INSPECTOR_LAYOUT_CHANGE_EVENT = "pi-science:inspector-layout-change";

/** Notify imperative preview renderers after an inspector layout control is
 * toggled. Consumers schedule their own work so React can commit first. */
export function notifyInspectorLayoutChange(): void {
  window.dispatchEvent(new Event(INSPECTOR_LAYOUT_CHANGE_EVENT));
}
