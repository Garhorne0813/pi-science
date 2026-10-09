import { afterEach, expect, it, vi } from "vitest";
import { useUiStore } from "./store";
const initial = { contextPanelCollapsed: useUiStore.getState().contextPanelCollapsed, sidebarWidth: useUiStore.getState().sidebarWidth };
afterEach(() => { useUiStore.setState(initial); localStorage.removeItem("pi-science.sidebar.collapsed"); localStorage.removeItem("pi-science.sidebar.width"); });
it("defaults the context panel width to 299", () => { expect(initial.sidebarWidth).toBe(299); });
it("restores an existing user preference from the unchanged storage keys", async () => { localStorage.setItem("pi-science.sidebar.collapsed", "true"); localStorage.setItem("pi-science.sidebar.width", "340"); vi.resetModules(); const { useUiStore: restored } = await import("./store"); expect(restored.getState().contextPanelCollapsed).toBe(true); expect(restored.getState().sidebarWidth).toBe(340); });
it("persists context panel preferences under the existing keys", () => { useUiStore.getState().setContextPanelCollapsed(true); useUiStore.getState().setSidebarWidth(320); expect(localStorage.getItem("pi-science.sidebar.collapsed")).toBe("true"); expect(localStorage.getItem("pi-science.sidebar.width")).toBe("320"); expect(useUiStore.getState().contextPanelCollapsed).toBe(true); expect(useUiStore.getState().sidebarWidth).toBe(320); });
