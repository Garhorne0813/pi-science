import { expect, it } from "vitest";
import { isSettingsRoute, primarySection } from "./primary-section";
it.each([["/", "projects"], ["/workspace/proj", "conversations"], ["/workspace/proj/session/s1", "conversations"], ["/workspace/proj/knowledge", "knowledge"], ["/workspace/proj/research", "research"], ["/workspace/proj/runs", "runs"], ["/workspace/proj/files", null], ["/workspace/proj/files/preview", null], ["/workspace/proj/settings", null], ["/settings", null], ["/workspace/other", null]])("classifies %s as %s", (path, expected) => { expect(primarySection(path!, "proj")).toBe(expected); });
it("does not claim workspace pages without a cwd", () => { expect(primarySection("/workspace/proj", null)).toBe(null); });
it.each([["/settings", true], ["/workspace/proj/settings", true], ["/workspace/proj/research", false], ["/workspace/proj/settings/more", false]])("classifies settings path %s as %s", (path, expected) => { expect(isSettingsRoute(path as string)).toBe(expected); });
