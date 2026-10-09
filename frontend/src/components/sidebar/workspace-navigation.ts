import { useLocation, useNavigate } from "react-router-dom";
import { create } from "zustand";
import { useUiStore } from "../../lib/ui";

type SidebarTab = "sessions" | "files";

// Transient workspace state shared by the expanded sidebar and collapsed rail.
// A different cwd starts with an empty Conversations view; nothing is persisted.
export const useWorkspaceSidebar = create<{
  cwd: string | null;
  tab: SidebarTab;
  query: string;
  setTab: (cwd: string, tab: SidebarTab) => void;
  setQuery: (cwd: string, query: string) => void;
  showConversations: (cwd: string) => void;
}>((set) => ({
  cwd: null, tab: "sessions", query: "",
  setTab: (cwd, tab) => set(state => ({ cwd, tab, query: state.cwd === cwd ? state.query : "" })),
  setQuery: (cwd, query) => set(state => ({ cwd, query, tab: state.cwd === cwd ? state.tab : "sessions" })),
  showConversations: cwd => set({ cwd, tab: "sessions", query: "" }),
}));

export function closeSidebarOnNarrow() {
  if (window.innerWidth < 768) useUiStore.getState().setSidebarCollapsed(true);
}

// Both sidebar forms share the lazy-create landing contract.
export function useNewWorkspaceConversation(cwd: string | null) {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    if (!cwd) return;
    useWorkspaceSidebar.getState().showConversations(cwd);
    const root = `/workspace/${encodeURIComponent(cwd)}`;
    if (location.pathname === root) {
      useUiStore.getState().setSuppressAutoSessionNav(false);
    } else {
      useUiStore.getState().setSuppressAutoSessionNav(true);
      navigate(root, { state: { suppressAutoSessionNavFor: cwd } });
    }
    closeSidebarOnNarrow();
  };
}
