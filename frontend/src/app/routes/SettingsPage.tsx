import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useUiStore } from "../../lib/ui";
import { useWorkspaceCwd } from "../../lib/workspace";
import { isSettingsSection } from "../../lib/settings/settings-sections";

/** Deep-link target for `/settings` and `/workspace/:cwd/settings`.
 *  The dialog itself lives in ProjectsLayout; this shell opens it on mount and
 *  returns to the workspace home (or the project list) once it closes. */
export function SettingsPage() {
  const cwd = useWorkspaceCwd();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sectionParam = searchParams.get("section");
  const openSettings = useUiStore((s) => s.openSettings);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const lastOpen = useRef(false);

  useEffect(() => {
    openSettings(cwd, isSettingsSection(sectionParam) ? sectionParam : "general");
    return () => closeSettings();
  }, [cwd, openSettings, closeSettings, sectionParam]);

  // Only navigate away after the dialog was actually open (the first render
  // sees `settingsOpen === false` before the open effect above applies).
  useEffect(() => {
    if (settingsOpen) {
      lastOpen.current = true;
      return;
    }
    if (lastOpen.current) navigate(cwd ? `/workspace/${encodeURIComponent(cwd)}` : "/", { replace: true });
    lastOpen.current = false;
  }, [settingsOpen, navigate, cwd]);

  return null;
}
