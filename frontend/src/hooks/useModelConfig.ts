import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { clampThinkingLevel, conversationModelOptions, type AvailableModel } from "../lib/client/pi-science-client";
import { applySessionReplacements, useRuntimeStore, type SessionReplacement } from "../lib/agent-runtime";
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
  // The saved settings config is the authoritative model/thinking source: the
  // composer and the settings page both save through PUT /api/settings/model,
  // while the runtime store lags behind (it only catches up after the server
  // restarts runtimes and the replacement session's state arrives). Track the
  // last settings-provided values per workspace so late runtime updates fill
  // gaps but never override a configured value — and never leak one workspace's
  // saved config into another workspace that has none.
  const settingsRef = useRef<{ cwd: string; model?: string; thinking?: string } | null>(null);
  // The runtime store's model/thinking are global (the last session state
  // seen), so a value is only attributable to the current workspace if it
  // changed after the hook started observing that workspace. Remember the
  // snapshot taken when the hook mounted or switched workspaces so a stale
  // value from a previous workspace cannot leak into a new one that has no
  // config of its own (e.g. its config failed to load and no runtime state
  // ever arrives).
  const runtimeSnapshotRef = useRef<{ cwd: string; model: string | null; thinking: string | null } | null>(null);

  useEffect(() => {
    const key = settingsKey("config", cwd ?? null);
    let cancelled = false;
    const applyConfig = (data?: ModelConfigData) => {
      if (!data || cancelled) return;
      const runtime = useRuntimeStore.getState();
      const allAvailableModels: AvailableModel[] = Array.isArray(data.available_models) ? data.available_models : [];
      const availableModels = conversationModelOptions(allAvailableModels);
      setModels(availableModels);
      // The saved settings config wins over the active runtime's snapshot:
      // right after a settings save the runtime still reports the previous
      // model until the reload's replacement session state arrives, so the
      // runtime-first order keeps the composer stuck on the old value.
      const nextModel = data.model || runtime.model || "";
      const nextModelInfo = availableModels.find((model: AvailableModel) => model.id === nextModel);
      const supported = nextModelInfo?.thinking_levels || [];
      const configuredThinking = data.thinking || runtime.thinking || "high";
      settingsRef.current = { cwd, model: data.model || undefined, thinking: data.thinking || undefined };
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
    // Fill the gap when the current workspace's settings carry no model/thinking
    // yet (first connect before any config was saved); never override a
    // configured value with a stale or racing runtime snapshot, and never let a
    // previous workspace's saved config block this workspace's runtime updates.
    const settings = settingsRef.current;
    const scoped = settings?.cwd === cwd;
    const snapshot = runtimeSnapshotRef.current;
    if (!snapshot) {
      // Fresh mount: the store describes the boot target, so it may fill gaps.
      runtimeSnapshotRef.current = { cwd, model: runtimeModel, thinking: runtimeThinking };
      if ((!scoped || !settings.model) && runtimeModel) setSelectedModel(runtimeModel);
      if ((!scoped || !settings.thinking) && runtimeThinking) setThinking(runtimeThinking);
      return;
    }
    if (snapshot.cwd !== cwd) {
      // Workspace switch: the store may still describe the previous workspace
      // (its session state arrives asynchronously, or never — e.g. the new
      // workspace's config failed to load). Clear the previous selection; only
      // a store value that changes after the switch is trustworthy here.
      runtimeSnapshotRef.current = { cwd, model: runtimeModel, thinking: runtimeThinking };
      if (!scoped || !settings.model) setSelectedModel("");
      if (!scoped || !settings.thinking) setThinking("high");
      return;
    }
    // Same workspace: a late runtime update fills gaps but never overrides the
    // saved settings config.
    if ((!scoped || !settings.model) && runtimeModel !== snapshot.model) setSelectedModel(runtimeModel ?? "");
    if ((!scoped || !settings.thinking) && runtimeThinking !== snapshot.thinking) setThinking(runtimeThinking ?? "high");
  }, [cwd, runtimeModel, runtimeThinking]);

  const selectedModelInfo = models.find((model) => model.id === selectedModel);
  const thinkingLevels = selectedModelInfo?.thinking_levels?.length
    ? selectedModelInfo.thinking_levels
    : selectedModel
      ? [thinking]
      : [];

  const applyModelConfig = async (model: string, nextThinking: string) => {
    const previousModel = selectedModel;
    const previousThinking = thinking;
    setSelectedModel(model);
    setThinking(nextThinking);
    setModelError(null);
    setConfiguringModel(true);
    try {
      const data = await settingsApi.saveModel<{
        model?: string;
        thinking?: string;
        session_replacements?: SessionReplacement[];
      }>(model, nextThinking, cwd);
      const replacementId = applySessionReplacements(
        Array.isArray(data.session_replacements) ? data.session_replacements as SessionReplacement[] : [],
      );
      setSelectedModel(typeof data.model === "string" ? data.model : model);
      setThinking(typeof data.thinking === "string" ? data.thinking : nextThinking);
      if (replacementId && replacementId !== sessionId) {
        navigate(
          `/workspace/${encodeURIComponent(cwd)}/session/${replacementId}`,
          { replace: true },
        );
      }
    } catch (e) {
      setSelectedModel(previousModel);
      setThinking(previousThinking);
      const message = e instanceof Error ? e.message : t("conversation.modelSetError");
      setModelError(message);
    } finally {
      setConfiguringModel(false);
    }
  };

  const handleModelChange = (model: string) => {
    const nextModelInfo = models.find((item) => item.id === model);
    const supported = nextModelInfo?.thinking_levels || [];
    void applyModelConfig(model, clampThinkingLevel(thinking, supported));
  };

  const handleThinkingChange = (level: string) => {
    if (!selectedModel) return;
    void applyModelConfig(selectedModel, level);
  };

  return { models, selectedModel, thinking, thinkingLevels, selectedModelInfo, modelError, configuringModel, handleModelChange, handleThinkingChange };
}
