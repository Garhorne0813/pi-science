import { useTranslation } from "react-i18next";

import { WorkspacePage, WorkspacePageHeader } from "../../components/layout/WorkspacePage";
import { FileBrowser } from "../../components/sidebar/FileBrowser";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";

export function FilesPage() {
  const { t } = useTranslation();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const fileType = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("type") === "notebook"
    ? "notebook"
    : "all";

  return (
    <WorkspacePage
      className="overflow-hidden"
      contentClassName="flex h-full max-w-none flex-col px-4 py-4 sm:px-6 lg:px-6 lg:py-5"
    >
      <WorkspacePageHeader
        title={t("nav.files")}
        description={t("files.pageDescription")}
      />
      <div className="mt-4 min-h-0 flex-1 overflow-hidden">
        <FileBrowser cwd={workspaceCwd} embedded mode="page" fileType={fileType} />
      </div>
    </WorkspacePage>
  );
}
