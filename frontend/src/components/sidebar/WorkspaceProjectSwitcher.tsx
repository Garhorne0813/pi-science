import { useQuery } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, FolderOpen, LayoutGrid } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/client/api";
import { queryClient } from "../../lib/client/query-client";
import { workspacePathLeaf } from "../../lib/workspace";
import { closeSidebarOnNarrow } from "./workspace-navigation";

type WorkspaceChoice = { name: string; path: string; last_modified: string; last_activity_at?: string };

export function WorkspaceProjectSwitcher({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: ({ signal }) => apiRequest<WorkspaceChoice[]>("/api/workspaces", { signal }),
    staleTime: 30_000,
  }, queryClient);
  const recent = [...data]
    .sort((a, b) => Date.parse(b.last_activity_at ?? b.last_modified) - Date.parse(a.last_activity_at ?? a.last_modified))
    .slice(0, 6);
  const open = (path: string) => {
    navigate(path);
    closeSidebarOnNarrow();
  };

  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-input px-2 py-1.5 text-left text-text hover:bg-surface-hover" aria-label={t("projects.switchProject")}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><FolderOpen size={16} /></span>
        <span className="min-w-0 flex-1 truncate text-ui-body font-semibold">{workspacePathLeaf(cwd)}</span>
        <ChevronDown size={15} className="shrink-0 text-muted" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="start" sideOffset={6} collisionPadding={8} className="ui-popover z-[120] min-w-[240px] max-w-[320px] rounded-card p-1 text-ui-label text-text shadow-lg">
        {recent.map(workspace => <DropdownMenu.Item key={workspace.path} onSelect={() => open(`/workspace/${encodeURIComponent(workspace.path)}`)} className="flex h-nav cursor-default select-none items-center gap-2 rounded-input px-2 outline-none data-[highlighted]:bg-surface-hover">
          <Check size={14} className={workspace.path === cwd ? "text-accent" : "invisible"} />
          <span className="min-w-0 flex-1 truncate">{workspace.name || workspacePathLeaf(workspace.path)}</span>
        </DropdownMenu.Item>)}
        {recent.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
        <DropdownMenu.Item onSelect={() => open("/")} className="flex h-nav cursor-default select-none items-center gap-2 rounded-input px-2 font-medium outline-none data-[highlighted]:bg-surface-hover">
          <LayoutGrid size={14} />{t("projects.manageAll")}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
