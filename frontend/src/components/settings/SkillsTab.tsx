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

function SkillTable({
  id,
  title,
  emptyMessage,
  skills,
  workspaceCwd,
  saving,
  onToggle,
  onEdit,
  onDelete,
}: {
  id: string;
  title: string;
  emptyMessage: string;
  skills: Skill[];
  workspaceCwd: string | null;
  saving: string | null;
  onToggle: (skill: Skill, enabled: boolean) => void;
  onEdit: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
}) {
  const { t } = useTranslation();
  const hasActions = workspaceCwd !== null && skills.some((skill) => skill.source === "project");

  return (
    <section aria-labelledby={id} className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 id={id} className="text-ui-label font-semibold text-text">{title}</h2>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{skills.length}</span>
      </div>
      <div className="ui-card-flat overflow-hidden rounded-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left">
            <thead className="border-b border-border bg-surface-2/50">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-ui-caption font-medium text-muted">{t("skills.tableName")}</th>
                  <th scope="col" className="px-4 py-2.5 text-ui-caption font-medium text-muted">{t("skills.tableDescription")}</th>
                  <th scope="col" className="px-4 py-2.5 text-ui-caption font-medium text-muted">{t("skills.tableStatus")}</th>
                  {hasActions && <th scope="col" className="px-4 py-2.5 text-ui-caption font-medium text-muted">{t("skills.tableActions")}</th>}
                  <th scope="col" className="w-16 px-4 py-2.5 text-center text-ui-caption font-medium text-muted">{t("skills.tableEnabled")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {skills.length === 0 ? (
                <tr>
                  <td colSpan={hasActions ? 5 : 4} className="px-4 py-8 text-center text-sm text-muted">{emptyMessage}</td>
                </tr>
              ) : (
                skills.map((skill) => {
                  const valid = skill.validation?.valid !== false;
                  const projectEditable = workspaceCwd !== null && skill.source === "project";
                  return (
                    <tr key={skill.skill_id || skill.name} className="align-top hover:bg-surface-2/30">
                      <td className="px-4 py-3">
                        <div className="flex min-w-44 items-start gap-2">
                          <Package size={16} className="mt-0.5 shrink-0 text-muted" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                              <span className="truncate">{skill.name}</span>
                              {skill.source && <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${sourceBadge[skill.source]}`}>{skill.source}</span>}
                            </div>
                            {!!skill.requirements?.length && <p className="mt-1 text-[10px] text-muted">{t("skills.requirements")}: {skill.requirements.map((item) => `${item.name}${item.version ? ` ${item.version}` : ""}`).join(", ")}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="max-w-[28rem] px-4 py-3 text-xs text-muted">
                        <p className="line-clamp-2">{skill.description}</p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {valid ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-ok-text"><ShieldCheck size={13} />{t("skills.validated")}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-error-text"><AlertTriangle size={13} />{t("skills.needsAttention")}</span>
                        )}
                      </td>
                      {hasActions && (
                        <td className="px-4 py-3">
                          {projectEditable ? (
                            <div className="flex items-center gap-1">
                              <button type="button" aria-label={t("skills.edit", { name: skill.name })} onClick={() => onEdit(skill)} className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text">
                                <Pencil size={13} />
                              </button>
                              <button type="button" aria-label={t("skills.delete", { name: skill.name })} onClick={() => onDelete(skill)} className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-error-text">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted">{t("skills.readOnly")}</span>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          {saving === skill.name && <Loader2 size={12} className="shrink-0 animate-spin text-muted" />}
                          <input type="checkbox" aria-label={t("skills.enable", { name: skill.name })} checked={skill.enabled !== false} disabled={saving !== null} onChange={(event) => onToggle(skill, event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

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

  const builtinSkills = skills.filter((skill) => skill.source === "builtin");
  const userSkills = skills.filter((skill) => skill.source !== "builtin");

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
      <div className="space-y-card">
        <SkillTable
          id="builtin-skills-heading"
          title={t("skills.builtin")}
          emptyMessage={t("skills.noBuiltin")}
          skills={builtinSkills}
          workspaceCwd={workspaceCwd}
          saving={saving}
          onToggle={(skill, enabled) => void toggle(skill, enabled)}
          onEdit={(skill) => void startEdit(skill)}
          onDelete={setDeleteConfirm}
        />
        <SkillTable
          id="user-skills-heading"
          title={t("skills.user")}
          emptyMessage={t("skills.noUser")}
          skills={userSkills}
          workspaceCwd={workspaceCwd}
          saving={saving}
          onToggle={(skill, enabled) => void toggle(skill, enabled)}
          onEdit={(skill) => void startEdit(skill)}
          onDelete={setDeleteConfirm}
        />
      </div>

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
