import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { queryClient } from "../../lib/client/query-client";
import { settingsApi, subagentsQuery } from "../../lib/settings";
import type { ProjectSubagent } from "../../lib/settings";
import { useFeedback } from "../feedback/feedback-context";
import { Section } from "./Section";

const EMPTY_SUBAGENT: ProjectSubagent = {
  name: "",
  description: "",
  prompt: "",
  model: "",
  thinking: "high",
  tools: "read, grep, find, ls",
  system_prompt_mode: "replace",
  inherit_project_context: true,
  inherit_skills: false,
  default_context: "fresh",
};

export function SubagentSettings({ workspaceCwd }: { workspaceCwd: string | null }) {
  const { t } = useTranslation();
  const { confirm } = useFeedback();
  const [agents, setAgents] = useState<ProjectSubagent[]>([]);
  const [draft, setDraft] = useState<ProjectSubagent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Read and write failures share one error line, so the load stays imperative on top
  // of the shared cache rather than becoming a second error channel.
  const load = useCallback(async () => {
    if (!workspaceCwd) return;
    const data = await queryClient.fetchQuery(subagentsQuery(workspaceCwd, t("settings.subagents.loadError")));
    setAgents(data.agents || []);
  }, [workspaceCwd, t]);
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);

  const save = async () => {
    if (!workspaceCwd || !draft) return;
    const name = draft.name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || !draft.prompt.trim()) {
      setError(t("settings.subagents.validation"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await settingsApi.saveSubagent(workspaceCwd, name, { ...draft, name, prompt: draft.prompt.trim() }, t("settings.subagents.saveError"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      return;
    }
    setDraft(null);
    setNotice(t("settings.subagents.saved"));
    setBusy(false);
    await load();
  };

  const remove = async (agent: ProjectSubagent) => {
    if (!workspaceCwd) return;
    const confirmed = await confirm({
      title: t("settings.subagents.deleteTitle"),
      message: t("settings.subagents.deleteConfirm", { name: agent.name }),
      confirmLabel: t("common.delete"),
      destructive: true,
    });
    if (!confirmed) return;
    setError(null);
    try {
      await settingsApi.deleteSubagent(workspaceCwd, agent.name, t("settings.subagents.deleteError"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setNotice(t("settings.subagents.deleted"));
    await load();
  };

  return (
    <Section title={t("settings.subagents.title")}>
      {!workspaceCwd ? (
        <p className="rounded-input border border-dashed border-border px-3 py-3 text-[11px] text-muted">{t("settings.subagents.workspaceRequired")}</p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mb-3 rounded-input bg-error/10 px-3 py-2 text-[11px] text-error-text">
              {error}
            </p>
          )}
          {notice && <p className="mb-3 rounded-input bg-ok/10 px-3 py-2 text-[11px] text-ok-text">{notice}</p>}
          <div className="divide-y divide-faint border-y border-faint">
            {agents.map((agent) => (
              <div key={agent.name} className="flex min-h-14 items-start gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium text-text">{agent.name}</span>
                    {agent.model && <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[9px] text-muted">{agent.model}</span>}
                  </div>
                  <p className="mt-1 text-[11px] text-muted">{agent.description || t("settings.subagents.noDescription")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDraft({ ...agent });
                    setNotice(null);
                  }}
                  className="min-h-9 rounded-input px-2 text-[11px] text-accent hover:bg-accent/10"
                >
                  {t("settings.actions.edit")}
                </button>
                <button type="button" onClick={() => void remove(agent)} className="min-h-9 rounded-input px-2 text-error-text hover:bg-error/10">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          {!draft && (
            <button
              type="button"
              onClick={() => {
                setDraft({ ...EMPTY_SUBAGENT });
                setNotice(null);
              }}
              className="mt-3 flex min-h-10 items-center gap-1 rounded-input border border-border bg-surface-2 px-3 text-[12px] font-medium text-text hover:bg-surface"
            >
              <Plus size={13} /> {t("settings.subagents.new")}
            </button>
          )}
          {draft && (
            <div className="mt-4 border-y border-faint py-3">
              <div className="mb-3 flex min-h-10 items-center justify-between">
                <h3 className="text-[13px] font-semibold text-text">{agents.some((agent) => agent.name === draft.name) ? t("settings.subagents.editTitle", { name: draft.name }) : t("settings.subagents.new")}</h3>
                <button type="button" onClick={() => setDraft(null)} className="min-h-9 min-w-9 text-muted hover:text-text">
                  <X size={14} />
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.name")}</span>
                  <input
                    value={draft.name}
                    disabled={agents.some((agent) => agent.name === draft.name)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        name: event.target.value.toLowerCase().replace(/\s+/g, "-"),
                      })
                    }
                    placeholder="literature-auditor"
                    className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 font-mono text-[12px] text-text outline-none disabled:opacity-60"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.descriptionLabel")}</span>
                  <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder={t("settings.subagents.descriptionPlaceholder")} className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 text-[12px] text-text outline-none" />
                </label>
                <label>
                  <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.modelOverride")}</span>
                  <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder={t("settings.subagents.inheritModel")} className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 font-mono text-[12px] text-text outline-none" />
                </label>
                <label>
                  <span className="mb-1 block text-[11px] text-muted">{t("settings.model.thinking")}</span>
                  <select value={draft.thinking} onChange={(event) => setDraft({ ...draft, thinking: event.target.value })} className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 text-[12px] text-text outline-none">
                    <option value="">{t("settings.subagents.inherit")}</option>
                    {["off", "low", "medium", "high", "xhigh", "max"].map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="mt-3 block">
                <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.builtinTools")}</span>
                <input value={draft.tools} onChange={(event) => setDraft({ ...draft, tools: event.target.value })} placeholder="read, grep, find, ls" className="min-h-10 w-full rounded-input border border-border bg-surface-2 px-3 font-mono text-[12px] text-text outline-none" />
              </label>
              <label className="mt-3 block">
                <span className="mb-1 block text-[11px] text-muted">{t("settings.subagents.systemPrompt")}</span>
                <textarea value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} rows={8} placeholder={t("settings.subagents.promptPlaceholder")} className="w-full rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-text outline-none focus:border-accent" />
              </label>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={draft.inherit_project_context}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inherit_project_context: event.target.checked,
                      })
                    }
                  />{" "}
                  {t("settings.subagents.inheritProject")}
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={draft.inherit_skills}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inherit_skills: event.target.checked,
                      })
                    }
                  />{" "}
                  {t("settings.subagents.inheritSkills")}
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  {t("settings.subagents.promptMode")}{" "}
                  <select
                    value={draft.system_prompt_mode}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        system_prompt_mode: event.target.value as "replace" | "append",
                      })
                    }
                    className="rounded-input border border-border bg-surface-2 px-2 py-1"
                  >
                    <option value="replace">{t("settings.subagents.replace")}</option>
                    <option value="append">{t("settings.subagents.append")}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  {t("settings.subagents.context")}{" "}
                  <select
                    value={draft.default_context}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        default_context: event.target.value as "fresh" | "fork",
                      })
                    }
                    className="rounded-input border border-border bg-surface-2 px-2 py-1"
                  >
                    <option value="fresh">{t("settings.subagents.fresh")}</option>
                    <option value="fork">{t("settings.subagents.fork")}</option>
                  </select>
                </label>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setDraft(null)} className="min-h-10 rounded-input px-3 text-[12px] text-muted hover:bg-surface-2">
                  {t("common.cancel")}
                </button>
                <button type="button" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.prompt.trim()} className="flex min-h-10 items-center gap-1 rounded-input bg-accent-fill px-3 text-[12px] font-medium text-accent-fg disabled:opacity-40">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} {t("settings.subagents.save")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
