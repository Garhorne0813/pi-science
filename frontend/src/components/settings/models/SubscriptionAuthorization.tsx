import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ModelOAuthSessionView } from "@pi-science/contracts";
import { apiRequest, ApiError } from "../../../lib/client/api";
import { button, field, primary, send, type CatalogProvider } from "./native-model-api";

type Props = { provider: CatalogProvider; revision: number; onSaved: (result?: { runtime?: string }) => Promise<void>; onFailure: (error: unknown) => Promise<void>; onDirty?: (dirty: boolean) => void; onBusy?: (busy: boolean) => void };
export function SubscriptionAuthorization({ provider, revision, onSaved, onFailure, onDirty, onBusy }: Props) {
  const { t } = useTranslation(); const client = useQueryClient();
  const key = ["model-oauth", provider.id];
  const current = useQuery({ queryKey: key, queryFn: () => apiRequest<{ session: ModelOAuthSessionView | null }>(`/api/model-config/oauth/${encodeURIComponent(provider.id)}/current`), retry: false, staleTime: 0,
    refetchInterval: (query) => query.state.data?.session?.status === "authorizing" ? 1000 : false });
  const session = current.data?.session ?? null;
  const active = session?.status === "authorizing";
  const activeRef = useRef<ModelOAuthSessionView | null>(null); const watched = useRef<string | null>(null); const completed = useRef<string | null>(null); const conflict = useRef<string | null>(null);
  const [answer, setAnswer] = useState(""); const [replace, setReplace] = useState(false); const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const subscription = provider.authentication.source === "oauth";
  const replacing = !subscription && (provider.authentication.configured ?? !["unconfigured", "unsupported"].includes(provider.authentication.source));
  const callbacks = useRef({ onSaved, onFailure, onDirty, onBusy }); callbacks.current = { onSaved, onFailure, onDirty, onBusy };
  useEffect(() => { setAnswer(""); }, [session?.prompt?.id]);
  useEffect(() => {
    activeRef.current = active ? session : null;
    callbacks.current.onDirty?.(active);
    if (active && session) watched.current = session.id;
    if (session?.error_code === "revision_conflict" && conflict.current !== session.id) {
      conflict.current = session.id;
      void Promise.all([client.invalidateQueries({ queryKey: ["model-config"] }), client.invalidateQueries({ queryKey: ["settings"] })]);
    }
    if (session?.status === "succeeded" && watched.current === session.id && completed.current !== session.id) {
      completed.current = session.id;
      void callbacks.current.onSaved({ runtime: session.runtime });
    }
  }, [active, session, client]);
  useEffect(() => () => {
    const pending = activeRef.current;
    if (pending) void apiRequest(`/api/model-config/oauth/sessions/${pending.id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    callbacks.current.onDirty?.(false);
  }, []);
  const update = (view: ModelOAuthSessionView) => { activeRef.current = view.status === "authorizing" ? view : null; client.setQueryData(key, { session: view }); };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); onBusy?.(true); setError(null);
    try { await action(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await callbacks.current.onFailure(cause);
      if (cause instanceof ApiError && cause.status === 409) void current.refetch();
    } finally { setBusy(false); onBusy?.(false); }
  };
  const prompt = session?.prompt;
  return <div className="space-y-4 text-ui-caption text-text">
    <div><h3 className="text-ui-label font-medium">{provider.subscription_name ?? provider.name}</h3><p className="mt-1 text-muted">{t("settings.oauth.account")}: {provider.authentication.oauth?.account ?? t("settings.native.unknown")} · {t("settings.oauth.plan")}: {provider.authentication.oauth?.plan ?? t("settings.native.unknown")}</p>
      {provider.authentication.oauth?.expires_at && <p className="mt-1 text-muted">{t("settings.oauth.expires")}: {new Date(provider.authentication.oauth.expires_at).toLocaleString()}</p>}
      <p className="mt-1 text-muted">{t(subscription ? `settings.oauth.grant.${provider.authentication.oauth?.status ?? "invalid"}` : "settings.oauth.notConnected")}</p>
    </div>
    {!active && <div className="space-y-3">
      {replacing && <label className="flex items-start gap-2"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />{t("settings.oauth.replaceHelp")}</label>}
      <button type="button" className={primary} disabled={busy || current.isPending || replacing && !replace} onClick={() => void run(async () => { const next = await send<ModelOAuthSessionView>(`/api/model-config/oauth/${encodeURIComponent(provider.id)}/start`, "POST", { revision, replace_existing: replace }); watched.current = next.id; update(next); })}>{t(subscription ? "settings.oauth.reauthorize" : "settings.oauth.start")}</button>
      {subscription && <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => void run(async () => { await send(`/api/model-config/oauth/${encodeURIComponent(provider.id)}/refresh`, "POST", { revision }); await onSaved(); })}>{t("settings.oauth.refresh")}</button><button type="button" className={button} disabled={busy} onClick={() => setConfirmDisconnect(true)}>{t("settings.oauth.disconnect")}</button></div>}
    </div>}
    {active && <div className="space-y-3">
      <p role="status" className="text-muted">{t("settings.oauth.authorizing")}</p>
      {session.events.map((event, index) => <div key={index} className="space-y-1 break-words">
        {event.type === "auth_url" ? <><a className="inline-flex min-h-9 items-center text-link underline" href={event.url} target="_blank" rel="noreferrer">{t("settings.oauth.openAuthorization")}</a>{event.instructions && <p className="text-muted">{event.instructions}</p>}</> : event.type === "device_code" ? <><a className="inline-flex min-h-9 items-center text-link underline" href={event.verificationUri} target="_blank" rel="noreferrer">{t("settings.oauth.openAuthorization")}</a><p>{t("settings.oauth.deviceCode")}: <strong className="select-all font-mono">{event.userCode}</strong></p></> : <><p className="text-muted">{event.message}</p>{event.links?.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="mr-3 inline-flex min-h-9 items-center text-link underline">{link.label ?? t("settings.oauth.moreInfo")}</a>)}</>}
      </div>)}
      {prompt && <form key={prompt.id} className="space-y-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { update(await send<ModelOAuthSessionView>(`/api/model-config/oauth/sessions/${session.id}/respond`, "POST", { prompt_id: prompt.id, value: answer })); setAnswer(""); }); }}><label className="block">{prompt.message}{prompt.type === "select" ? <select className={field} value={answer} required onChange={(e) => setAnswer(e.target.value)}><option value="" disabled>{t("settings.oauth.choose")}</option>{prompt.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input className={field} autoComplete="off" type={prompt.type === "secret" || prompt.type === "manual_code" ? "password" : "text"} placeholder={prompt.placeholder} value={answer} required={prompt.type !== "text"} onChange={(e) => setAnswer(e.target.value)} />}</label><button type="submit" className={primary} disabled={busy}>{t("settings.oauth.continue")}</button></form>}
      <p className="text-muted">{t("settings.oauth.cancelHelp")}</p><button type="button" className={button} disabled={busy} onClick={() => void run(async () => { update(await apiRequest<ModelOAuthSessionView>(`/api/model-config/oauth/sessions/${session.id}`, { method: "DELETE" })); setAnswer(""); })}>{t("settings.oauth.cancel")}</button>
    </div>}
    {session && session.status !== "authorizing" && session.status !== "succeeded" && <p role="status" className="text-muted">{t(`settings.oauth.error.${session.error_code ?? "oauth_login_failed"}`)}</p>}
    {(error || current.error) && <p role="alert" className="text-error-text">{error ?? current.error?.message}</p>}
    {confirmDisconnect && <div role="alert" className="space-y-2"><p>{t("settings.oauth.disconnectHelp")}</p><button type="button" className={button} disabled={busy} onClick={() => setConfirmDisconnect(false)}>{t("common.cancel")}</button><button type="button" className={`${primary} ml-2`} disabled={busy} onClick={() => void run(async () => { await send(`/api/model-config/oauth/${encodeURIComponent(provider.id)}`, "DELETE", { revision }); await onSaved(); })}>{t("settings.oauth.disconnect")}</button></div>}
  </div>;
}
