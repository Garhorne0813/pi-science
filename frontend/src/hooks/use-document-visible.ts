import { useSyncExternalStore } from "react";
function subscribe(onChange: () => void) { document.addEventListener("visibilitychange", onChange); return () => document.removeEventListener("visibilitychange", onChange); }
function snapshot() { return document.visibilityState === "visible"; }
export function useDocumentVisible(): boolean { return useSyncExternalStore(subscribe, snapshot, () => true); }
