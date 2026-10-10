import { useEffect, useState } from "react";

function startOfDay(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Calendar groups refresh once per local day, including after a suspended tab resumes. */
export function useLocalDay() {
  const [day, setDay] = useState(() => startOfDay(new Date()));
  useEffect(() => {
    let timer: number;
    const refresh = () => {
      window.clearTimeout(timer);
      const now = new Date();
      setDay(startOfDay(now));
      // Use the next calendar midnight rather than 24 hours (DST can change day length).
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(refresh, midnight.getTime() - now.getTime());
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  return day;
}
