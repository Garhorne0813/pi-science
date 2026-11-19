import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiRequest } from "../../../lib/client/api";

type GrantState = Record<"bash" | "notebook", boolean | undefined>;
type Permissions = { global: GrantState; project: GrantState };

export function ExecutionPermissions({ cwd }: { cwd: string | null }) {
  const { t } = useTranslation();
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/settings/execution-permissions${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`;
  useEffect(() => {
    let active = true;
    apiRequest<Permissions>(url).then((value) => { if (active) setPermissions(value); }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [url]);
  async function revoke(scope: "project" | "global", tool: "bash" | "notebook") {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/settings/execution-permissions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, tool, ...(cwd ? { cwd } : {}) }) });
      setPermissions(await apiRequest<Permissions>(url));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="rounded-card border border-faint p-4">
    <h3 className="text-ui-label font-medium">{t("settings.executionPermissions.title")}</h3>
    {error && <p role="alert" className="mt-2 text-xs text-error-text">{error}</p>}
    {permissions && (["global", ...(cwd ? ["project"] : [])] as Array<"global" | "project">).map((scope) =>
      (["bash", "notebook"] as const).filter((tool) => permissions[scope][tool]).map((tool) =>
        <div key={`${scope}:${tool}`} className="mt-3 flex items-center justify-between gap-3 text-ui-caption">
          <span>{tool === "bash" ? "Bash" : "Notebook"} · {t(`settings.executionPermissions.${scope}`)}</span>
          <button type="button" disabled={busy} onClick={() => void revoke(scope, tool)} className="rounded-input border border-border px-2 py-1 disabled:opacity-50">{t("settings.executionPermissions.revoke")}</button>
        </div>)))}
    {permissions && !Object.values(permissions.global).some(Boolean) && !Object.values(permissions.project).some(Boolean) && <p className="mt-2 text-ui-caption text-muted">{t("settings.executionPermissions.empty")}</p>}
  </section>;
}
