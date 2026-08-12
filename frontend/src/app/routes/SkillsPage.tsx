import { useEffect, useState } from "react";
import { Package, Puzzle, Wrench, Check, X, ChevronRight, ShieldCheck, AlertTriangle, RotateCcw, Loader2 } from "lucide-react";
import { WorkspacePage, WorkspacePageHeader } from "../../components/layout/WorkspacePage";
import { skillsApi, skillsKey, type SkillReadiness } from "../../lib/skills";
import { SkillReadinessBadge, RequirementStatusList } from "../../components/skills/SkillReadiness";
import { SkillContentPreview } from "../../components/skills/SkillContentPreview";
import { settingsApi, invalidateSettings } from "../../lib/settings";
import { apiRequest } from "../../lib/client/api";
import { queryClient } from "../../lib/client/query-client";
import { applySessionReplacements, type SessionReplacement } from "../../lib/agent-runtime";
import { useWorkspaceCwd } from "../../lib/workspace";
import { useTranslation } from "react-i18next";

interface Skill {
  skill_id: string;
  digest: string;
  name: string;
  description: string;
  version: string;
  category: string;
  license: string;
  risk: "low" | "medium" | "high";
  location: string;
  source: string;
  enabled?: boolean;
  requirements?: Array<{ name: string; kind: string; optional?: boolean; version?: string | null }>;
  third_party?: Array<{ name: string; kind: string; license?: string | null; info_url?: string | null; terms_url?: string | null }>;
  files?: Array<{ path: string; kind: string; size: number }>;
  validation?: { valid: boolean; errors: string[]; warnings: string[]; checked_at: string };
  shadowed?: string[];
}

interface Tool {
  name: string;
  found: boolean;
  version?: string | null;
}

/** Enabling a skill changes both the skill catalog and the settings that record the choice. */
function invalidateSkillSelection() {
  void queryClient.invalidateQueries({ queryKey: skillsKey() });
  invalidateSettings();
}

export function SkillsPage() {
  const { t } = useTranslation();
  // Also routed at /skills (no workspace): the APIs below take `cwd?: string`.
  const cwd = useWorkspaceCwd() ?? undefined;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Record<string, SkillReadiness>>({});
  const [readinessErrors, setReadinessErrors] = useState<Record<string, string>>({});
  const [readinessLoading, setReadinessLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Workspace switch: drop stale readiness state from the previous cwd.
    setReadiness({});
    setReadinessErrors({});
    setReadinessLoading(false);
    setSelected(null);
    setLoading(true);
    setError(null);
    Promise.all([
      skillsApi.list<Skill>(cwd),
      skillsApi.tools<Tool>(),
      settingsApi.skills<{ skills?: Array<{ name: string; enabled: boolean }>; configured?: boolean }>(cwd),
    ]).then(([skillData, toolData, settingsData]) => {
      if (cancelled) return;
      const enabled = new Map<string, boolean>((settingsData.skills || []).map((item: { name: string; enabled: boolean }) => [item.name, item.enabled]));
      setSkills(skillData.map((item: Skill) => ({ ...item, enabled: enabled.get(item.name) ?? item.enabled ?? true })));
      setTools(toolData);
      setConfigured(settingsData.configured === true);
      // Dependency readiness only matters for skills that declare requirements.
      const withRequirements = skillData.filter((item: Skill) => (item.requirements?.length ?? 0) > 0);
      if (withRequirements.length > 0) {
        setReadinessLoading(true);
        // Bounded concurrency (4): per-skill failures are recorded, never fatal.
        const results: Array<{ id: string; value: SkillReadiness } | { id: string; error: string }> = new Array(withRequirements.length);
        let next = 0;
        const probe = async () => {
          while (next < withRequirements.length) {
            const index = next++;
            const item = withRequirements[index];
            try {
              results[index] = { id: item.skill_id, value: await skillsApi.readiness(item.skill_id, cwd) };
            } catch (cause) {
              results[index] = { id: item.skill_id, error: cause instanceof Error ? cause.message : String(cause) };
            }
          }
        };
        Promise.all(Array.from({ length: Math.min(4, withRequirements.length) }, () => probe())).then(() => {
          if (cancelled) return;
          const loaded: Record<string, SkillReadiness> = {};
          const failed: Record<string, string> = {};
          for (const entry of results) {
            if (!entry) continue;
            if ("value" in entry) loaded[entry.id] = entry.value;
            else failed[entry.id] = entry.error;
          }
          setReadiness(loaded);
          setReadinessErrors(failed);
        }).finally(() => {
          if (!cancelled) setReadinessLoading(false);
        });
      }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    // StrictMode mounts, cleans up, and mounts effects again in development.
    // Ignore the obsolete result instead of aborting these short, idempotent
    // GETs, which otherwise leaves misleading red "cancelled" requests.
    return () => { cancelled = true; };
  }, [cwd]);

  if (loading) return <div className="flex items-center justify-center h-full text-sm text-muted">{t("common.loading")}</div>;

  const builtin = skills.filter(s => s.source === "builtin");
  const project = skills.filter(s => s.source === "project");
  const user = skills.filter(s => s.source === "user");

  const toggleSkill = async (skill: Skill, enabled: boolean) => {
    setSaving(skill.name);
    setError(null);
    setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item));
    try {
      const result = await apiRequest<{ session_replacements?: SessionReplacement[] }>("/api/settings/skills/toggle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, name: skill.name, enabled }),
      });
      if (result.session_replacements) applySessionReplacements(result.session_replacements);
      invalidateSkillSelection();
      setConfigured(true);
    } catch (cause) {
      setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: skill.enabled } : item));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  };

  const resetSkills = async () => {
    setSaving("reset");
    setError(null);
    try {
      if (!cwd) throw new Error("A workspace is required to reset runtime skills");
      const result = await apiRequest<{ session_replacements?: SessionReplacement[] }>(`/api/settings/skills?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" });
      if (result.session_replacements) applySessionReplacements(result.session_replacements);
      invalidateSkillSelection();
      setSkills((current) => current.map((item) => ({ ...item, enabled: true })));
      setConfigured(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  };

  return (
    <WorkspacePage>
        <WorkspacePageHeader title={t("skills.title")} description={
          <>
          {t("skills.descriptionPrefix")} <span className="font-mono text-xs">.pi/skills/</span> {t("skills.projectSource")},{" "}
          <span className="font-mono text-xs">~/.pi/agent/skills/</span> {t("skills.userSource")}, {t("skills.descriptionSuffix")}
          </>
        } />
        <div className="ui-card-flat mt-5 flex flex-wrap items-center justify-between gap-3 rounded-card px-4 py-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-text">
              <span className={configured ? "text-accent" : "text-ok"}>{configured ? t("skills.customSelection") : t("skills.autoDiscovery")}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted">{t("skills.selectionHint")}</p>
          </div>
          {configured && <button type="button" onClick={() => void resetSkills()} disabled={saving !== null} className="flex min-h-9 items-center gap-1.5 rounded-input border border-border px-3 text-[11px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50">{saving === "reset" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} {t("skills.resetDiscovery")}</button>}
        </div>
        {error && <p role="alert" className="mt-3 rounded-input bg-[color-mix(in_srgb,var(--error)_10%,transparent)] px-3 py-2 text-xs text-error">{error}</p>}

        <Section title={t("skills.scientificEnvironment")} icon={<Wrench size={15} />} count={tools.length}>
          {tools.length === 0 ? (
            <Empty>{t("skills.toolDetectionUnavailable")}</Empty>
          ) : (
            tools.map((tool) => (
              <div key={tool.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                {tool.found ? <Check size={15} className="text-ok" /> : <X size={15} className="text-muted" />}
                <span className="w-24 text-text">{tool.name}</span>
                <span className="flex-1 truncate font-mono text-xs text-muted">
                  {tool.found ? tool.version || t("skills.installed") : t("skills.notFound")}
                </span>
              </div>
            ))
          )}
        </Section>

        {builtin.length > 0 && (
          <Section title={t("skills.builtin")} icon={<Puzzle size={15} />} count={builtin.length}>
            {builtin.map(s => <SkillRow key={s.skill_id || s.name} skill={s} tag={t("skills.tagBuiltin")} onSelect={setSelected} onToggle={toggleSkill} saving={saving === s.name} readiness={readiness[s.skill_id]} readinessError={readinessErrors[s.skill_id]} readinessLoading={readinessLoading} />)}
          </Section>
        )}

        <Section title={t("skills.project")} icon={<Puzzle size={15} />} count={project.length}>
          {project.length === 0 ? (
            <Empty>{t("skills.noProject")}</Empty>
          ) : (
            project.map(s => <SkillRow key={s.skill_id || s.name} skill={s} tag={t("skills.tagProject")} onSelect={setSelected} onToggle={toggleSkill} saving={saving === s.name} readiness={readiness[s.skill_id]} readinessError={readinessErrors[s.skill_id]} readinessLoading={readinessLoading} />)
          )}
        </Section>

        <Section title={t("skills.user")} icon={<Puzzle size={15} />} count={user.length}>
          {user.length === 0 ? (
            <Empty>{t("skills.noUser")}</Empty>
          ) : (
            user.map(s => <SkillRow key={s.skill_id || s.name} skill={s} tag={t("skills.tagUser")} onSelect={setSelected} onToggle={toggleSkill} saving={saving === s.name} readiness={readiness[s.skill_id]} readinessError={readinessErrors[s.skill_id]} readinessLoading={readinessLoading} />)
          )}
        </Section>

        {selected && <SkillDetail key={`${cwd ?? ""}:${selected.skill_id}`} skill={selected} cwd={cwd} readiness={readiness[selected.skill_id]} readinessError={readinessErrors[selected.skill_id]} onClose={() => setSelected(null)} />}
    </WorkspacePage>
  );
}

function Section({ title, icon, count, children }: { title: string; icon: React.ReactNode; count: number; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted">
        {icon} {title} <span className="text-muted/50">({count})</span>
      </h2>
      <div className="ui-card-flat divide-y divide-border overflow-hidden rounded-card">
        {children}
      </div>
    </section>
  );
}

function SkillRow({ skill, tag, onSelect, onToggle, saving, readiness, readinessError, readinessLoading }: { skill: Skill; tag: string; onSelect: (skill: Skill) => void; onToggle: (skill: Skill, enabled: boolean) => void; saving: boolean; readiness?: SkillReadiness; readinessError?: string; readinessLoading?: boolean }) {
  const { t } = useTranslation();
  const valid = skill.validation?.valid !== false;
  return (
    <div className="flex items-center hover:bg-surface-2">
      <button type="button" onClick={() => onSelect(skill)} className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left">
        <Package size={16} className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 truncate text-sm font-medium text-text">
            {skill.name}
            {valid ? <ShieldCheck size={13} className="shrink-0 text-ok" /> : <AlertTriangle size={13} className="shrink-0 text-error" />}
          </div>
          <div className="text-xs text-muted line-clamp-2">{skill.description}</div>
        </div>
        {skill.requirements?.length ? <SkillReadinessBadge readiness={readiness} loading={readinessLoading} error={readinessError} /> : null}
        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted ring-1 ring-border">{tag}</span>
        <ChevronRight size={15} className="mt-0.5 shrink-0 text-muted" />
      </button>
      <label className="mr-4 flex shrink-0 items-center gap-2 text-[10px] text-muted">
        {saving && <Loader2 size={11} className="animate-spin" />}
        <input type="checkbox" aria-label={t("skills.enable", { name: skill.name })} checked={skill.enabled !== false} disabled={saving} onChange={(event) => void onToggle(skill, event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
      </label>
    </div>
  );
}

export function SkillDetail({ skill, cwd, readiness, readinessError, onClose }: { skill: Skill; cwd?: string; readiness?: SkillReadiness; readinessError?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const valid = skill.validation?.valid !== false;
  const [tab, setTab] = useState<"overview" | "source">("overview");
  const tabId = `skill-tab-${skill.skill_id}`;
  const tabs: Array<"overview" | "source"> = ["overview", "source"];
  const onTabKeyDown = (event: React.KeyboardEvent) => {
    const index = tabs.indexOf(tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next !== null) {
      event.preventDefault();
      setTab(tabs[next]);
      document.getElementById(`${tabId}-tab-${tabs[next]}`)?.focus();
    }
  };
  return (
    <div className="ui-card-flat mt-6 rounded-card p-4" role="dialog" aria-label={t("skills.details", { name: skill.name })}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text">{skill.name}</h2>
          <p className="mt-1 text-xs text-muted">{skill.description}</p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 whitespace-nowrap rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2">{t("common.close")}</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted sm:grid-cols-4">
        <span>v{skill.version}</span><span>{skill.category}</span><span>{skill.license}</span><span>{skill.source}</span>
      </div>
      <div role="tablist" aria-label={t("skills.details", { name: skill.name })} onKeyDown={onTabKeyDown} className="mt-3 flex gap-1 border-b border-faint">
        <TabButton id={`${tabId}-tab-overview`} panelId={`${tabId}-panel-overview`} active={tab === "overview"} label={t("skills.tabOverview")} onClick={() => setTab("overview")} />
        <TabButton id={`${tabId}-tab-source`} panelId={`${tabId}-panel-source`} active={tab === "source"} label={t("skills.tabSource")} onClick={() => setTab("source")} />
      </div>
      <div role="tabpanel" id={`${tabId}-panel-overview`} aria-labelledby={`${tabId}-tab-overview`} className="mt-3" hidden={tab !== "overview"}>
          <div className="flex items-center gap-2 text-xs">
            {valid ? <ShieldCheck size={14} className="text-ok" /> : <AlertTriangle size={14} className="text-error" />}
            <span className={valid ? "text-ok" : "text-error"}>{valid ? t("skills.validated") : t("skills.needsAttention")}</span>
            <span className="ml-auto font-mono text-[10px] text-muted">{skill.digest}</span>
          </div>
          {(skill.requirements?.length || skill.third_party?.length || skill.files?.length) ? (
            <div className="mt-3 space-y-2 border-t border-faint pt-3 text-xs text-muted">
              {!!skill.requirements?.length && <div><span className="font-medium text-text">{t("skills.requirements")}:</span> {skill.requirements.map((item) => `${item.name}${item.version ? ` ${item.version}` : ""}`).join(", ")}</div>}
              {!!skill.third_party?.length && <div><span className="font-medium text-text">{t("skills.thirdParty")}:</span> {skill.third_party.map((item) => `${item.name}${item.license ? ` (${item.license})` : ""}`).join(", ")}</div>}
              {!!skill.files?.length && <div><span className="font-medium text-text">{t("skills.files")}:</span> {skill.files.length}</div>}
            </div>
          ) : null}
          {readiness ? <RequirementStatusList readiness={readiness} /> : null}
          {readinessError ? <p role="alert" className="mt-2 text-xs text-muted">{t("skills.readinessError")}: {readinessError}</p> : null}
          {!!skill.validation?.errors?.length && <ul className="mt-2 list-disc pl-4 text-xs text-error">{skill.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>}
          {!!skill.validation?.warnings?.length && <ul className="mt-2 list-disc pl-4 text-xs text-warn">{skill.validation.warnings.map((item) => <li key={item}>{item}</li>)}</ul>}
        </div>
        <div role="tabpanel" id={`${tabId}-panel-source`} aria-labelledby={`${tabId}-tab-source`} className="mt-3" hidden={tab !== "source"}>
          {tab === "source" ? <SkillContentPreview skillId={skill.skill_id} cwd={cwd} /> : null}
        </div>
    </div>
  );
}

function TabButton({ id, panelId, active, label, onClick }: { id: string; panelId: string; active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      id={id}
      role="tab"
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`rounded-t-input border-b-2 px-3 py-1.5 text-xs transition-colors ${active ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`}
    >
      {label}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center text-sm text-muted">{children}</div>;
}
