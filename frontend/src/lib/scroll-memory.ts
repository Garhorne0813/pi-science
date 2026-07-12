import { useEffect, useRef } from "react";
export function useScrollMemory(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { /* noop in web version */ }, [key]);
  return ref;
}
