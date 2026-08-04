import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { agentProfilesQuery, settingsApi } from "../../lib/settings";
import type { AgentProfile } from "../../lib/settings";
import { Section } from "./Section";

export function AgentProfilesSection() {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const profilesRead = useQuery(agentProfilesQuery(t("settings.profiles.loadError")));
  const profiles: AgentProfile[] = profilesRead.data?.profiles || [];
  const error = createError ?? (profilesRead.error instanceof Error ? profilesRead.error.message : null);

  const create = async () => {
    const normalized = name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_");
    if (!normalized || !displayName.trim()) return;
    try {
      await settingsApi.createAgentProfile({
        name: normalized,
        display_name: displayName.trim(),
        description: "User-created profile", // stored server-side, not UI copy — stays untranslated

        read_scope: ["workspace"],
        write_scope: ["workspace-approved"],
      }, t("settings.profiles.createError"));
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setName("");
    setDisplayName("");
  };

  return (
    <Section title={t("settings.profiles.title")}>
      {error && <p className="mb-2 text-[11px] text-error">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="PROFILE_NAME" className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] font-mono text-text outline-none" />
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("settings.profiles.displayName")} className="rounded-input border border-border bg-surface-2 px-3 py-2 text-[12px] text-text outline-none" />
        <button type="button" onClick={() => void create()} className="rounded-input bg-accent px-3 py-2 text-[12px] font-medium text-accent-fg disabled:opacity-40" disabled={!name.trim() || !displayName.trim()}>
          {t("settings.profiles.create")}
        </button>
      </div>
      <div className="mt-3 divide-y divide-faint border-y border-faint">
        {profiles.map((profile) => (
          <div key={profile.name} className="min-h-14 py-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-text">{profile.display_name}</span>
              <span className="font-mono text-[10px] text-muted">
                {profile.name} · {profile.source}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-muted">
              {profile.unrestricted
                ? t("settings.profiles.unrestricted")
                : <>{t("settings.profiles.read")}: {(profile.read_scope || []).join(", ") || t("settings.profiles.none")} · {t("settings.profiles.write")}: {(profile.write_scope || []).join(", ") || t("settings.profiles.none")}</>}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}
