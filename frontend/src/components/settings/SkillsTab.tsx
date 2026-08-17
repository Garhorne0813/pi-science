import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AlertTriangle, ChevronDown, Loader2, Package, Pencil, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/client/api";
import { queryClient } from "../../lib/client/query-client";
import { invalidateSettings, settingsApi, settingsKey } from "../../lib/settings";
import { SkillChatDialog, SkillEditorDialog, SkillGithubDialog, SkillUploadDialog } from "./SkillDialogs";

type Skill = {
  skill_id: string;
  name: string;
  description: string;
  enabled?: boolean;
  source?: "builtin" | "project" | "user";
  validation?: { valid: boolean };
  requirements?: Array<{ name: string; optional?: boolean; version?: string | null }>;
};

type SkillsResponse = { skills?: Skill[]; configured?: boolean };

function invalidateSkills() {
  void queryClient.invalidateQueries({ queryKey: settingsKey("skills") });
  invalidateSettings();
}

const sourceBadge: Record<string, string> = {
  project: "bg-accent/10 text-accent",
  user: "bg-surface-2 text-muted",
  builtin: "bg-surface-2 text-muted",
};

export function SkillsTab({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<{ name: string; description: string; body?: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Skill | null>(null);

  useEffect(() => {
    let cancelled = false;
    settingsApi.skills<SkillsResponse>(workspaceCwd).then((response) => {
      if (cancelled) return;
      setSkills(response.skills ?? []);
      setConfigured(response.configured === true);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [workspaceCwd]);

  const reload = async () => {
    try {
      const response = await settingsApi.skills<SkillsResponse>(workspaceCwd);
      setSkills(response.skills ?? []);
      setConfigured(response.configured === true);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggle = async (skill: Skill, enabled: boolean) => {
    setSaving(skill.name);
    setError(null);
    setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item));
    try {
      const response = await apiRequest<{ configured?: boolean }>("/api/settings/skills/toggle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skill.name, enabled }),
      });
      setConfigured(response.configured === true);
      invalidateSkills();
    } catch (cause) {
      setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: skill.enabled } : item));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  };

  const reset = async () => {
    setSaving("reset");
    setError(null);
    try {
      await apiRequest("/api/settings/skills", { method: "DELETE" });
      setSkills((current) => current.map((skill) => ({ ...skill, enabled: true })));
      setConfigured(false);
      invalidateSkills();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  };

  const startEdit = async (skill: Skill) => {
    if (!workspaceCwd) return;
    setError(null);
    try {
      const response = await apiRequest<{ content: string }>(`/api/skills/${encodeURIComponent(skill.skill_id)}/content?cwd=${encodeURIComponent(workspaceCwd)}`);
      const body = response.content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").replace(/^\n/, "");
      setEditing({ name: skill.name, description: skill.description, body });
      setEditorOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const confirmDelete = async (skill: Skill) => {
    if (!workspaceCwd) return;
    setError(null);
    setDeleteConfirm(null);
    try {
      await apiRequest(`/api/settings/skills/${encodeURIComponent(skill.skill_id)}?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "DELETE" });
      invalidateSkills();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (loading) return <div className="flex min-h-[240px] items-center justify-center text-sm text-muted"><Loader2 size={18} className="mr-2 animate-spin" />{t("common.loading")}</div>;

  return (
    <div className="space-y-card pt-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <p className="text-ui-body text-muted">{t("skills.settingsDescription")}</p>
          <p className="mt-1 text-ui-caption text-muted">{t("skills.selectionHint")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {configured && (
            <button type="button" onClick={() => void reset()} disabled={saving !== null} className="flex min-h-9 items-center gap-1.5 rounded-input border border-border px-3 text-ui-caption text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50">
              {saving === "reset" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
              {t("skills.resetDiscovery")}
            </button>
          )}
          {workspaceCwd && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" disabled={saving !== null} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-ui-caption text-white hover:opacity-90 disabled:opacity-50">
                  <Plus size={12} />
                  {t("skills.add")}
                  <ChevronDown size={12} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8} className="ui-popover z-[110] min-w-[15rem] rounded-card p-1.5 text-ui-label text-text outline-none">
                  <DropdownMenu.Item onSelect={() => { setEditing(null); setEditorOpen(true); }} className="flex min-h-9 cursor-default select-none items-center gap-2 rounded-input px-2.5 py-2 outline-none data-[highlighted]:bg-surface-hover">
                    {t("skills.writeFromScratch")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => setUploadOpen(true)} className="flex min-h-9 cursor-default select-none items-center gap-2 rounded-input px-2.5 py-2 outline-none data-[highlighted]:bg-surface-hover">
                    {t("skills.uploadSkill")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => setGithubOpen(true)} className="flex min-h-9 cursor-default select-none items-center gap-2 rounded-input px-2.5 py-2 outline-none data-[highlighted]:bg-surface-hover">
                    {t("skills.githubImport")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => setChatOpen(true)} className="flex min-h-9 cursor-default select-none items-center gap-2 rounded-input px-2.5 py-2 outline-none data-[highlighted]:bg-surface-hover">
                    {t("skills.chatWithClaude")}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </div>
      {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-caption text-error-text">{error}</p>}
      <section aria-label={t("skills.title")} className="ui-card-flat divide-y divide-border overflow-hidden rounded-card">
        {skills.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">{t("skills.empty")}</div>
        ) : skills.map((skill) => {
          const valid = skill.validation?.valid !== false;
          const projectEditable = workspaceCwd !== null && skill.source === "project";
          return (
            <div key={skill.skill_id || skill.name} className="flex items-center gap-3 px-4 py-3">
              <Package size={16} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-text">
                  <span className="truncate">{skill.name}</span>
                  {skill.source && <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${sourceBadge[skill.source]}`}>{skill.source}</span>}
                  {valid ? <ShieldCheck size={13} className="shrink-0 text-ok-text" /> : <AlertTriangle size={13} className="shrink-0 text-error-text" />}
                </div>
                <p className="line-clamp-2 text-xs text-muted">{skill.description}</p>
                {!!skill.requirements?.length && <p className="mt-1 text-[10px] text-muted">{t("skills.requirements")}: {skill.requirements.map((item) => `${item.name}${item.version ? ` ${item.version}` : ""}`).join(", ")}</p>}
              </div>
              {projectEditable && (
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" aria-label={t("skills.edit", { name: skill.name })} onClick={() => void startEdit(skill)} className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text">
                    <Pencil size={13} />
                  </button>
                  <button type="button" aria-label={t("skills.delete", { name: skill.name })} onClick={() => setDeleteConfirm(skill)} className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-error-text">
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
              {saving === skill.name && <Loader2 size={12} className="shrink-0 animate-spin text-muted" />}
              <input type="checkbox" aria-label={t("skills.enable", { name: skill.name })} checked={skill.enabled !== false} disabled={saving !== null} onChange={(event) => void toggle(skill, event.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
            </div>
          );
        })}
      </section>

      {deleteConfirm && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteConfirm(null); }}>
          <div role="alertdialog" aria-modal="true" aria-label={t("skills.deleteTitle", { name: deleteConfirm.name })} className="ui-dialog w-[min(420px,calc(100vw-32px))] rounded-large border border-border bg-surface-raised p-5 shadow-pop">
            <h2 className="text-ui-title font-medium text-text">{t("skills.deleteTitle", { name: deleteConfirm.name })}</h2>
            <p className="mt-2 text-ui-body text-muted">{t("skills.deleteMessage", { name: deleteConfirm.name })}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-input border border-border px-3 py-1.5 text-ui-caption text-muted hover:bg-surface-2" onClick={() => setDeleteConfirm(null)}>{t("common.cancel")}</button>
              <button type="button" onClick={() => void confirmDelete(deleteConfirm)} className="rounded-input bg-error px-3 py-1.5 text-ui-caption text-white">{t("skills.deleteConfirm")}</button>
            </div>
          </div>
        </div>
      )}

      <SkillEditorDialog open={editorOpen} cwd={workspaceCwd ?? ""} initial={editing} onClose={() => { setEditorOpen(false); void reload(); }} />
      <SkillUploadDialog open={uploadOpen} cwd={workspaceCwd ?? ""} onClose={() => { setUploadOpen(false); void reload(); }} />
      <SkillGithubDialog open={githubOpen} cwd={workspaceCwd ?? ""} onClose={() => { setGithubOpen(false); void reload(); }} />
      <SkillChatDialog open={chatOpen} cwd={workspaceCwd} onClose={() => setChatOpen(false)} />
    </div>
  );
}