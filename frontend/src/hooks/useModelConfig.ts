import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { clampThinkingLevel, conversationModelOptions, type AvailableModel } from "../lib/client/pi-science-client";
import { useRuntimeStore } from "../lib/agent-runtime";
import { queryClient } from "../lib/client/query-client";
import { settingsApi, settingsKey } from "../lib/settings";

interface ModelConfigData {
  available_models?: AvailableModel[];
  model?: string;
  thinking?: string;
}

/** Model + thinking-level selection for the conversation composer. */
export function useModelConfig(cwd: string, sessionId: string | undefined) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeSessionId = useRuntimeStore((s) => s.activeSessionId);
  const runtimeModel = useRuntimeStore((s) => s.model);
  const runtimeThinking = useRuntimeStore((s) => s.thinking);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [thinking, setThinking] = useState("high");
  const [modelError, setModelError] = useState<string | null>(null);
  const [configuringModel, setConfiguringModel] = useState(false);
  // Guards against stale async completion: every operation bumps the ref, and
  // the route session the operation started in is compared with the latest one
  // before any local state is applied, so a slow save cannot overwrite the
  // model/thinking of a session the user navigated to in the meantime.
  const operationRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      // The route changed while an operation was in flight: invalidate it so
      // its completion/finally cannot touch state, and release the loading
      // flag the skipped finally would otherwise leave stuck forever.
      operationRef.current += 1;
      setConfiguringModel(false);
    }
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const key = settingsKey("config", cwd ?? null);
    let cancelled = false;
    const applyConfig = (data?: ModelConfigData) => {
      if (!data || cancelled) return;
      const runtime = useRuntimeStore.getState();
      const allAvailableModels: AvailableModel[] = Array.isArray(data.available_models) ? data.available_models : [];
      const availableModels = conversationModelOptions(allAvailableModels);
      setModels(availableModels);
      const nextModel = runtime.model || data.model || "";
      const nextModelInfo = availableModels.find((model: AvailableModel) => model.id === nextModel);
      const supported = nextModelInfo?.thinking_levels || [];
      const configuredThinking = runtime.thinking || data.thinking || "high";
      setSelectedModel(nextModel);
      setThinking(supported.length > 0 ? clampThinkingLevel(configuredThinking, supported) : configuredThinking);
      setModelError(availableModels.length === 0
        ? t("conversation.configureProvider")
        : null);
    };
    // The settings dialog saves the model while this page stays mounted under
    // the modal, so the composer tracks the shared cache instead of only the
    // initial fetch.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && JSON.stringify(event.query.queryKey) === JSON.stringify(key)) {
        applyConfig(event.query.state.data as ModelConfigData | undefined);
      }
    });
    applyConfig(queryClient.getQueryData(key) as ModelConfigData | undefined);
    settingsApi.config<ModelConfigData>(cwd)
      .then((data) => applyConfig(data))
      .catch((cause) => setModelError(cause instanceof Error ? cause.message : t("conversation.modelListError")));
    return () => { cancelled = true; unsubscribe(); };
  }, [activeSessionId, cwd, t]);

  useEffect(() => {
    if (runtimeModel) setSelectedModel(runtimeModel);
    if (runtimeThinking) setThinking(runtimeThinking);
  }, [runtimeModel, runtimeThinking]);

  const selectedModelInfo = models.find((model) => model.id === selectedModel);
  const thinkingLevels = selectedModelInfo?.thinking_levels?.length
    ? selectedModelInfo.thinking_levels
    : selectedModel
      ? [thinking]
      : [];

  const applyModelConfig = async (model: string, nextThinking: string) => {
    const previousModel = selectedModel;
    const previousThinking = thinking;
    const operation = ++operationRef.current;
    const startedSession = sessionIdRef.current;
    setSelectedModel(model);
    setThinking(nextThinking);
    setModelError(null);
    setConfiguringModel(true);
    try {
      const store = useRuntimeStore.getState();
      // Session-local change requires the store to be actively tracking the
      // exact session this route shows. Anything else is a route/store
      // mismatch and must never touch the workspace default model.
      const sessionMatches = Boolean(
        startedSession && store.activeSessionId === startedSession && store.cwd === cwd,
      );
      if (sessionMatches) {
        // The store action talks to POST /api/sessions/:id/model, applies the
        // new model/thinking to the runtime, and returns the (possibly
        // replaced) session id. The workspace default model is deliberately
        // left untouched.
        const replacementId = await store.setModel(model, nextThinking);
        const current = useRuntimeStore.getState();
        if (operationRef.current !== operation || sessionIdRef.current !== startedSession) return;
        setSelectedModel(current.model || model);
        setThinking(current.thinking || nextThinking);
        if (replacementId && replacementId !== startedSession) {
          navigate(
            `/workspace/${encodeURIComponent(cwd)}/session/${replacementId}`,
            { replace: true },
          );
        }
        return;
      }
      if (startedSession || store.activeSessionId) {
        // Route and store disagree about which session is active (or the route
        // lost its session while the store still has one). Changing the model
        // could hit the wrong conversation, so refuse instead of silently
        // writing the workspace default.
        throw new Error(t("conversation.sessionUnavailable"));
      }
      // No route session and no active store session (blank page before the
      // first conversation): keep the workspace-default fallback so the user
      // can pick a model ahead of time.
      const data = await settingsApi.saveModel<{ model?: string; thinking?: string }>(model, nextThinking, cwd);
      if (operationRef.current !== operation || sessionIdRef.current !== startedSession) return;
      setSelectedModel(typeof data.model === "string" ? data.model : model);
      setThinking(typeof data.thinking === "string" ? data.thinking : nextThinking);
    } catch (e) {
      if (operationRef.current !== operation || sessionIdRef.current !== startedSession) return;
      setSelectedModel(previousModel);
      setThinking(previousThinking);
      const message = e instanceof Error ? e.message : t("conversation.modelSetError");
      setModelError(message);
    } finally {
      if (operationRef.current === operation && sessionIdRef.current === startedSession) {
        setConfiguringModel(false);
      }
    }
  };

  const handleModelChange = (model: string): Promise<void> => {
    const nextModelInfo = models.find((item) => item.id === model);
    const supported = nextModelInfo?.thinking_levels || [];
    return applyModelConfig(model, clampThinkingLevel(thinking, supported));
  };

  const handleThinkingChange = (level: string): Promise<void> => {
    if (!selectedModel) return Promise.resolve();
    return applyModelConfig(selectedModel, level);
  };

  return { models, selectedModel, thinking, thinkingLevels, selectedModelInfo, modelError, configuringModel, handleModelChange, handleThinkingChange };
}
