import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { clampThinkingLevel, conversationModelOptions, type AvailableModel } from "../lib/pi-science-client";
import { applySessionReplacements, useRuntimeStore, type SessionReplacement } from "../lib/runtime-store";
import { queryClient } from "../lib/query-client";
import { settingsApi, settingsKey } from "../lib/settings-api";

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
