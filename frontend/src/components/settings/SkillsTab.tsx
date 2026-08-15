import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Package, RotateCcw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../lib/client/api";
import { queryClient } from "../../lib/client/query-client";
import { invalidateSettings, settingsApi, settingsKey } from "../../lib/settings";

type Skill = {
  skill_id: string;
  name: string;
  description: string;
  enabled?: boolean;
  validation?: { valid: boolean };
  requirements?: Array<{ name: string; optional?: boolean; version?: string | null }>;
};

type SkillsResponse = { skills?: Skill[]; configured?: boolean };

function invalidateSkills() {
  void queryClient.invalidateQueries({ queryKey: settingsKey("skills") });
  invalidateSettings();
}

export function SkillsTab() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    settingsApi.skills<SkillsResponse>().then((response) => {
      if (cancelled) return;
      setSkills(response.skills ?? []);
      setConfigured(response.configured === true);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

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

  if (loading) return <div className="flex min-h-[240px] items-center justify-center text-sm text-muted"><Loader2 size={18} className="mr-2 animate-spin" />{t("common.loading")}</div>;

  return (
    <div className="space-y-card pt-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <p className="text-ui-body text-muted">{t("skills.settingsDescription")}</p>
          <p className="mt-1 text-ui-caption text-muted">{t("skills.selectionHint")}</p>
        </div>
        {configured && (
          <button type="button" onClick={() => void reset()} disabled={saving !== null} className="flex min-h-9 items-center gap-1.5 rounded-input border border-border px-3 text-ui-caption text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50">
            {saving === "reset" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            {t("skills.resetDiscovery")}
          </button>
        )}
      </div>
      {error && <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-caption text-error">{error}</p>}
      <section aria-label={t("skills.title")} className="ui-card-flat divide-y divide-border overflow-hidden rounded-card">
        {skills.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">{t("skills.empty")}</div>
        ) : skills.map((skill) => {
          const valid = skill.validation?.valid !== false;
          return (
            <div key={skill.skill_id || skill.name} className="flex items-center gap-3 px-4 py-3">
              <Package size={16} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-text">
                  <span className="truncate">{skill.name}</span>
                  {valid ? <ShieldCheck size={13} className="shrink-0 text-ok" /> : <AlertTriangle size={13} className="shrink-0 text-error" />}
                </div>
                <p className="line-clamp-2 text-xs text-muted">{skill.description}</p>
                {!!skill.requirements?.length && <p className="mt-1 text-[10px] text-muted">{t("skills.requirements")}: {skill.requirements.map((item) => `${item.name}${item.version ? ` ${item.version}` : ""}`).join(", ")}</p>}
              </div>
              {saving === skill.name && <Loader2 size={12} className="shrink-0 animate-spin text-muted" />}
              <input type="checkbox" aria-label={t("skills.enable", { name: skill.name })} checked={skill.enabled !== false} disabled={saving !== null} onChange={(event) => void toggle(skill, event.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
            </div>
          );
        })}
      </section>
    </div>
  );
}
