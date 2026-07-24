import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Package, Puzzle, Wrench, Check, X, ChevronRight, ShieldCheck, AlertTriangle, RotateCcw, Loader2 } from "lucide-react";
import { applySessionReplacements, type SessionReplacement } from "../../lib/runtime-store";
import { WorkspacePage, WorkspacePageHeader } from "../../components/layout/WorkspacePage";

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & {
    ok?: boolean;
    error?: string;
    detail?: string;
    session_replacements?: SessionReplacement[];
  };
  if (!response.ok || data.ok === false) throw new Error(data.error || data.detail || fallback);
  if (Array.isArray(data.session_replacements)) {
    applySessionReplacements(data.session_replacements as SessionReplacement[]);
  }
  return data;
}

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

export function SkillsPage() {
  const { cwd: encodedCwd } = useParams<{ cwd: string }>();
  const cwd = encodedCwd ? decodeURIComponent(encodedCwd) : undefined;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const query = cwd ? `?${new URLSearchParams({ cwd })}` : "";
    Promise.all([
      fetch(`/api/skills${query}`).then(async (response) => {
        return readResponse<Skill[]>(response, "Unable to load skills");
      }),
      fetch("/api/skills/tools").then(async (response) => {
        return readResponse<Tool[]>(response, "Unable to detect tools");
      }),
      fetch("/api/settings/skills").then(async (response) => {
        return readResponse<{ skills?: Array<{ name: string; enabled: boolean }>; configured?: boolean }>(response, "Unable to load skill settings");
      }),
    ]).then(([skillData, toolData, settingsData]) => {
      if (cancelled) return;
      const enabled = new Map<string, boolean>((settingsData.skills || []).map((item: { name: string; enabled: boolean }) => [item.name, item.enabled]));
      setSkills(skillData.map((item: Skill) => ({ ...item, enabled: enabled.get(item.name) ?? item.enabled ?? true })));
      setTools(toolData);
      setConfigured(settingsData.configured === true);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cwd]);

  if (loading) return <div className="flex items-center justify-center h-full text-sm text-muted">Loading…</div>;

  const builtin = skills.filter(s => s.source === "builtin");
  const project = skills.filter(s => s.source === "project");
  const user = skills.filter(s => s.source === "user");

  const toggleSkill = async (skill: Skill, enabled: boolean) => {
    setSaving(skill.name);
    setError(null);
    setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item));
    try {
      const response = await fetch("/api/settings/skills/toggle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: skill.name, enabled }),
      });
      await readResponse<Record<string, unknown>>(response, "Unable to update skill settings");
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
      const response = await fetch("/api/settings/skills", { method: "DELETE" });
      await readResponse<Record<string, unknown>>(response, "Unable to reset skill settings");
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
        <WorkspacePageHeader title="Skills" description={
          <>
          Agent skills extend what the AI can do. Skills are loaded from{" "}
          <span className="font-mono text-xs">.pi/skills/</span> (project),{" "}
          <span className="font-mono text-xs">~/.pi/agent/skills/</span> (user),
          and bundled with pi-science.
          </>
        } />
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-text">
              <span className={configured ? "text-accent" : "text-ok"}>{configured ? "Custom skill selection" : "Auto-discovery enabled"}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted">Use the switches below to control skills for newly started Pi processes. Existing conversations keep their current runtime.</p>
          </div>
          {configured && <button type="button" onClick={() => void resetSkills()} disabled={saving !== null} className="flex min-h-9 items-center gap-1.5 rounded-input border border-border px-3 text-[11px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50">{saving === "reset" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Reset to auto-discover</button>}
        </div>
        {error && <p role="alert" className="mt-3 rounded-input bg-error/10 px-3 py-2 text-xs text-error">{error}</p>}

        <Section title="Scientific Environment" icon={<Wrench size={15} />} count={tools.length}>
          {tools.length === 0 ? (
            <Empty>Tool detection unavailable</Empty>
          ) : (
            tools.map(t => (
              <div key={t.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                {t.found ? <Check size={15} className="text-ok" /> : <X size={15} className="text-muted" />}
                <span className="w-24 text-text">{t.name}</span>
                <span className="flex-1 truncate font-mono text-xs text-muted">
                  {t.found ? t.version || "installed" : "not found"}
                </span>
              </div>
            ))
          )}
        </Section>

        {builtin.length > 0 && (
          <Section title="Built-in Skills" icon={<Puzzle size={15} />} count={builtin.length}>
            {builtin.map(s => <SkillRow key={s.skill_id || s.name} skill={s} tag="built-in" onSelect={setSelected} onToggle={toggleSkill} saving={saving === s.name} />)}
          </Section>
        )}

        <Section title="Project Skills" icon={<Puzzle size={15} />} count={project.length}>
          {project.length === 0 ? (
            <Empty>No project skills. Add SKILL.md files to .pi/skills/</Empty>
          ) : (
            project.map(s => <SkillRow key={s.skill_id || s.name} skill={s} tag="project" onSelect={setSelected} onToggle={toggleSkill} saving={saving === s.name} />)
          )}
        </Section>

        <Section title="User Skills" icon={<Puzzle size={15} />} count={user.length}>
          {user.length === 0 ? (
            <Empty>No user skills. Add SKILL.md files to ~/.pi/agent/skills/</Empty>
          ) : (
            user.map(s => <SkillRow key={s.skill_id || s.name} skill={s} tag="user" onSelect={setSelected} onToggle={toggleSkill} saving={saving === s.name} />)
          )}
        </Section>

        {selected && <SkillDetail skill={selected} onClose={() => setSelected(null)} />}
    </WorkspacePage>
  );
}

function Section({ title, icon, count, children }: { title: string; icon: React.ReactNode; count: number; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted">
        {icon} {title} <span className="text-muted/50">({count})</span>
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
        {children}
      </div>
    </section>
  );
}

function SkillRow({ skill, tag, onSelect, onToggle, saving }: { skill: Skill; tag: string; onSelect: (skill: Skill) => void; onToggle: (skill: Skill, enabled: boolean) => void; saving: boolean }) {
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
        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted ring-1 ring-border">{tag}</span>
        <ChevronRight size={15} className="mt-0.5 shrink-0 text-muted" />
      </button>
      <label className="mr-4 flex shrink-0 items-center gap-2 text-[10px] text-muted">
        {saving && <Loader2 size={11} className="animate-spin" />}
        <input type="checkbox" aria-label={`Enable ${skill.name}`} checked={skill.enabled !== false} disabled={saving} onChange={(event) => void onToggle(skill, event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
      </label>
    </div>
  );
}

function SkillDetail({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const valid = skill.validation?.valid !== false;
  return (
    <div className="mt-6 rounded-card border border-border bg-surface p-4" role="dialog" aria-label={`${skill.name} details`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text">{skill.name}</h2>
          <p className="mt-1 text-xs text-muted">{skill.description}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2">Close</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted sm:grid-cols-4">
        <span>v{skill.version}</span><span>{skill.category}</span><span>{skill.license}</span><span>{skill.source}</span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs">
        {valid ? <ShieldCheck size={14} className="text-ok" /> : <AlertTriangle size={14} className="text-error" />}
        <span className={valid ? "text-ok" : "text-error"}>{valid ? "Validated" : "Needs attention"}</span>
        <span className="ml-auto font-mono text-[10px] text-muted">{skill.digest}</span>
      </div>
      {(skill.requirements?.length || skill.third_party?.length || skill.files?.length) ? (
        <div className="mt-3 space-y-2 border-t border-faint pt-3 text-xs text-muted">
          {!!skill.requirements?.length && <div><span className="font-medium text-text">Requirements:</span> {skill.requirements.map((item) => `${item.name}${item.version ? ` ${item.version}` : ""}`).join(", ")}</div>}
          {!!skill.third_party?.length && <div><span className="font-medium text-text">Third-party:</span> {skill.third_party.map((item) => `${item.name}${item.license ? ` (${item.license})` : ""}`).join(", ")}</div>}
          {!!skill.files?.length && <div><span className="font-medium text-text">Files:</span> {skill.files.length}</div>}
        </div>
      ) : null}
      {!!skill.validation?.errors?.length && <ul className="mt-2 list-disc pl-4 text-xs text-error">{skill.validation.errors.map((item) => <li key={item}>{item}</li>)}</ul>}
      {!!skill.validation?.warnings?.length && <ul className="mt-2 list-disc pl-4 text-xs text-warn">{skill.validation.warnings.map((item) => <li key={item}>{item}</li>)}</ul>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center text-sm text-muted">{children}</div>;
}
