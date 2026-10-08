import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DefaultModelSelection, ModelSelection, SessionModelSelection } from "@pi-science/contracts";
import { clampThinkingLevel, conversationModelOptions } from "../lib/client/pi-science-client";
import { useRuntimeStore } from "../lib/agent-runtime";
import { queryClient } from "../lib/client/query-client";
import { modelSelectionApi, modelSelectionKeys } from "../lib/model-selection";

/** Defaults seed drafts; durable per-session selection owns existing conversations. */
export function useModelConfig(cwd: string, sessionId: string | undefined) {
  const { t } = useTranslation();
  const activeSessionId = useRuntimeStore((state) => state.activeSessionId);
  const runtimeCwd = useRuntimeStore((state) => state.cwd);
  const draft = useRuntimeStore((state) => state.draftModelSelection);
  const target = sessionId ?? (runtimeCwd === cwd ? activeSessionId : null);
  const scope = JSON.stringify([cwd, target]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mutationVersion = useRef(0);
  const [pending, setPending] = useState<string | null>(null);
  const [override, setOverride] = useState<{ scope: string; selection: ModelSelection } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  useEffect(() => { mutationVersion.current++; setOverride(null); setFailure(null); setPending(null); }, [scope]);
  const catalog = useQuery(modelSelectionApi.catalogQuery(cwd), queryClient);
  const owner = useQuery<DefaultModelSelection | SessionModelSelection>({
    queryKey: target ? modelSelectionKeys.session(cwd, target) : modelSelectionKeys.default,
    queryFn: ({ signal }) => target ? modelSelectionApi.readSession(cwd, target, { signal }) : modelSelectionApi.readDefault({ signal }),
    staleTime: 0,
  }, queryClient);
  const catalogModels = catalog.data?.available_models;
  const models = useMemo(() => conversationModelOptions(catalogModels ?? []), [catalogModels]);
  const selection = override?.scope === scope ? override.selection
    : !target && draft?.cwd === cwd ? draft.selection : owner.data?.selection;
  const candidate = selection?.model ?? "";
  const selectedModelInfo = models.find((model) => model.id === candidate);
  const selectedModel = selectedModelInfo ? candidate : "";
  const thinking = selection?.thinking ?? "off";
  const needsModelSwitch = Boolean(catalog.data && candidate && !selectedModelInfo);
  const error = owner.error ?? catalog.error;
  const modelError = failure?.scope === scope ? failure.message : error ? error.message
    : needsModelSwitch ? t("conversation.unavailableModel", { model: candidate })
    : catalog.data && models.length === 0 ? t("conversation.configureProvider") : null;
  const thinkingLevels = selectedModelInfo?.thinking_levels?.length ? selectedModelInfo.thinking_levels : selectedModel ? [thinking] : [];

  const applyModelConfig = async (model: string, nextThinking: string) => {
    if (pending === scope) return;
    const version = ++mutationVersion.current;
    const requested: ModelSelection = { model, thinking: nextThinking as ModelSelection["thinking"] };
    setOverride({ scope, selection: requested });
    setFailure(null);
    if (!target) {
      // No session exists yet: retain a workspace-owned draft for the first
      // create, without saving defaults or creating an empty conversation.
      useRuntimeStore.setState({ draftModelSelection: { cwd, selection: requested } });
      setOverride(null);
      return;
    }
    setPending(scope);
    try {
      const result = await modelSelectionApi.saveSession(cwd, target, requested);
      if (currentScope.current !== scope || version !== mutationVersion.current) return;
      setOverride(null);
      const runtime = useRuntimeStore.getState();
      if (runtime.cwd === cwd && runtime.activeSessionId === target) {
        useRuntimeStore.setState({ model: result.selection.model, thinking: result.selection.thinking, contextWindow: null, contextPercent: null });
        // A failed snapshot read cannot undo an already committed selection.
        // Session state is a best-effort refresh, not part of the committed
        // model change. Do not keep Composer blocked on a slow state GET.
        void runtime.client?.getSessionState(target, cwd).then((state) => {
          const latest = useRuntimeStore.getState();
          if (state && latest.cwd === cwd && latest.activeSessionId === target && currentScope.current === scope && version === mutationVersion.current) {
            useRuntimeStore.setState({ model: state.model ?? result.selection.model, thinking: state.thinking ?? result.selection.thinking,
              contextTokens: state.context_tokens ?? null, contextWindow: state.context_window ?? null, contextPercent: state.context_percent ?? null });
          }
        }).catch(() => undefined);
      }
    } catch (cause) {
      if (currentScope.current !== scope || version !== mutationVersion.current) return;
      setOverride(null);
      setFailure({ scope, message: cause instanceof Error ? cause.message : t("conversation.modelSetError") });
    } finally {
      if (currentScope.current === scope && version === mutationVersion.current) setPending(null);
    }
  };
  const handleModelChange = (model: string) => {
    const selected = models.find((item) => item.id === model);
    void applyModelConfig(model, clampThinkingLevel(thinking, selected?.thinking_levels ?? []));
  };
  const handleThinkingChange = (level: string) => { if (selectedModel) void applyModelConfig(selectedModel, level); };
  return { models, selectedModel, thinking, thinkingLevels, selectedModelInfo, modelError, needsModelSwitch, configuringModel: pending === scope, handleModelChange, handleThinkingChange };
}
