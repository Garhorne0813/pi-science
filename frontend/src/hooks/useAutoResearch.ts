import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResearchStarter } from "../components/conversation/ResearchModePicker";

/** Mode selection only; execution, confirmation, stop and resume belong to Conversation. */
export function useAutoResearch(conversationKey: string | null) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ResearchStarter | null>(null);
  const [prompt, setPrompt] = useState(() => t("conversation.defaultPrompt"));
  useEffect(() => { setMode(null); setPrompt(t("conversation.defaultPrompt")); }, [conversationKey, t]);
  return { mode, setMode, prompt, setPrompt };
}
