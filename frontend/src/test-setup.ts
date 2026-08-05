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
