import { useEffect, useRef } from "react";
export function useScrollMemory(_key: string) {
  return useRef<HTMLDivElement>(null);
}
