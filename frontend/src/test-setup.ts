/** Vitest global setup — registers @testing-library/jest-dom matchers
 *  (toBeInTheDocument, toHaveValue, …) on vitest's expect. */
import "@testing-library/jest-dom/vitest";

// Some components read matchMedia at render time (e.g. the desktop sidebar
// breakpoint). jsdom does not implement it, so provide a minimal stub that
// answers the lg breakpoint queries used by the app shell.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("min-width") || query.includes("1024"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Radix primitives (e.g. Popover) measure their content with ResizeObserver;
// jsdom does not implement it.
if (typeof window !== "undefined" && typeof window.ResizeObserver !== "function") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
}

// Node 26 exposes localStorage as an experimental global that is undefined
// under jsdom (it requires --localstorage-file). Components and stores read
// localStorage at render time, so provide an in-memory fallback when the
// browser implementation is missing.
function memoryStorage(): Storage {
  let data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => {
      data = new Map();
    },
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
}

if (typeof window !== "undefined" && typeof window.localStorage === "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
}
if (typeof window !== "undefined" && typeof window.sessionStorage === "undefined") {
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: memoryStorage(),
  });
}
