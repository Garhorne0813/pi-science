import { useLocation, useNavigate } from "react-router-dom";
import { useUiStore } from "../../lib/ui";

export function closeSidebarOnNarrow() {
  if (window.innerWidth < 768) useUiStore.getState().setSidebarCollapsed(true);
}

// Both sidebar forms share the lazy-create landing contract.
export function useNewWorkspaceConversation(cwd: string | null) {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    if (!cwd) return;
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
