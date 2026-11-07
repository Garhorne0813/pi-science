import { useEffect, useEffectEvent, useRef } from "react";

export function useSettingsAutosave(pending: string | null, save: () => Promise<unknown>, delay = 200) {
  const commit = useEffectEvent(save);
  const queued = useRef(false);

  useEffect(() => {
    queued.current = pending !== null;
    if (pending === null) return;
    const timer = window.setTimeout(() => {
      queued.current = false;
      void commit();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [pending, delay]);

  // Closing Settings while a valid edit is queued still commits that edit.
  useEffect(() => () => {
    if (!queued.current) return;
    queued.current = false;
    void commit();
  }, []);
}
