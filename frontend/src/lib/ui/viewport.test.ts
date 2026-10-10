import { afterEach, expect, it, vi } from "vitest";
import { MOBILE_MAX_WIDTH, NARROW_MEDIA_QUERY, isNarrowViewport } from "./viewport";
afterEach(() => vi.unstubAllGlobals());
it("pins the mobile threshold and media query", () => { expect(MOBILE_MAX_WIDTH).toBe(767); expect(NARROW_MEDIA_QUERY).toBe("(max-width: 767px)"); });
it.each([[767, true], [768, false]])("classifies width %i as narrow=%s", (width, expected) => { vi.stubGlobal("innerWidth", width); expect(isNarrowViewport()).toBe(expected); });
