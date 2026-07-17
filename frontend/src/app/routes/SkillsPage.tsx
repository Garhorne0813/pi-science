import { useEffect, useState } from "react";
import { Package, Puzzle, Wrench, Check, X } from "lucide-react";

interface Skill {
  name: string;
  description: string;
  location: string;
  source: string;
}

interface Tool {
  name: string;
  found: boolean;
  version?: string | null;
}

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/skills").then(r => r.json()),
      fetch("/api/skills/tools").then(r => r.json()),
    ]).then(([s, t]) => {
      setSkills(s);
      setTools(t);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center justify-center h-full text-sm text-muted">Loading…</div>;

  const builtin = skills.filter(s => s.source === "builtin");
  const project = skills.filter(s => s.source === "project");
  const user = skills.filter(s => s.source === "user");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <h1 className="font-serif text-xl text-text">Skills</h1>
        <p className="mt-1 text-sm text-muted">
          Agent skills extend what the AI can do. Skills are loaded from{" "}
          <span className="font-mono text-xs">.pi/skills/</span> (project),{" "}
          <span className="font-mono text-xs">~/.pi/agent/skills/</span> (user),
          and bundled with pi-science.
        </p>

        {/* Environment tools */}
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

        {/* Builtin skills */}
        {builtin.length > 0 && (
          <Section title="Built-in Skills" icon={<Puzzle size={15} />} count={builtin.length}>
            {builtin.map(s => <SkillRow key={s.name} skill={s} tag="built-in" />)}
          </Section>
        )}

        {/* Project skills */}
        <Section title="Project Skills" icon={<Puzzle size={15} />} count={project.length}>
          {project.length === 0 ? (
            <Empty>No project skills. Add SKILL.md files to .pi/skills/</Empty>
          ) : (
            project.map(s => <SkillRow key={s.name} skill={s} tag="project" />)
          )}
        </Section>

        {/* User skills */}
        <Section title="User Skills" icon={<Puzzle size={15} />} count={user.length}>
          {user.length === 0 ? (
            <Empty>No user skills. Add SKILL.md files to ~/.pi/agent/skills/</Empty>
          ) : (
            user.map(s => <SkillRow key={s.name} skill={s} tag="user" />)
          )}
        </Section>
      </div>
    </div>
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

function SkillRow({ skill, tag }: { skill: Skill; tag: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Package size={16} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text">{skill.name}</div>
        <div className="text-xs text-muted line-clamp-2">{skill.description}</div>
      </div>
      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted ring-1 ring-border">{tag}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center text-sm text-muted">{children}</div>;
}
