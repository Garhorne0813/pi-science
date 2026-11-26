import { useLocation, useNavigate } from "react-router-dom";
import { useRef } from "react";
import { v4 as uuid } from "uuid";
import { useModelConfig } from "@/hooks/useModelConfig";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { apiRequest } from "@/lib/client/api";
import { findLocalPromptRequest, promptContentDigest } from "@/lib/client/prompt-request-cache";
import { conversationSessionId } from "@/lib/conversation/session-route";
import { injectWorkspaceReferences } from "@/lib/files";
import { useUiStore } from "@/lib/ui";
import type { FilePreviewInspector } from "@/types/thread";
import { ImagePreview } from "./ImagePreview";
import { RegionAskError, uploadImageRegion } from "./image-region-ask";
import { regionSnapshot, type PixelRect } from "./image-region";

interface RegionSubmission {
  route: string;
  session: string | null;
  rect: PixelRect;
  attachment: NonNullable<Awaited<ReturnType<typeof uploadImageRegion>>>;
  delivery?: { question: string; id: string; queued: boolean };
}

export function WorkspaceImagePreview({
  url,
  source,
  cwd,
}: {
  url: string;
  source: FilePreviewInspector;
  cwd: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const routeSession = conversationSessionId(location.pathname);
  const model = useModelConfig(cwd, routeSession);
  const route = useRef(location.key);
  route.current = location.key;
  const submission = useRef<RegionSubmission | null>(null);

  async function ask(image: HTMLImageElement, rect: PixelRect, question: string) {
    const initialRoute = route.current;
    const onSamePage = () => image.isConnected && route.current === initialRoute;
    let runtime = useRuntimeStore.getState();
    if (!model.selectedModel || model.configuringModel)
      throw new RegionAskError("send", "No available model");
    if (runtime.cwd !== cwd) await runtime.connect(cwd, routeSession);
    runtime = useRuntimeStore.getState();
    if (!onSamePage()) return false;
    if (runtime.cwd !== cwd || (routeSession && runtime.activeSessionId !== routeSession)) {
      throw new RegionAskError("send", "Conversation is still connecting");
    }
    const session = runtime.activeSessionId;
    const isCurrent = () => {
      const current = useRuntimeStore.getState();
      return onSamePage() && current.cwd === cwd && current.activeSessionId === session;
    };
    let attempt = submission.current;
    if (
      !attempt ||
      attempt.route !== initialRoute ||
      attempt.session !== session ||
      attempt.rect !== rect
    ) {
      const attachment = await uploadImageRegion(
        { image, rect, source },
        {
          isCurrent,
          snapshot: regionSnapshot,
          upload: async (blob, path) => {
            const form = new FormData();
            form.append("file", blob, "region.png");
            const query = new URLSearchParams({ cwd, path });
            await apiRequest(`/api/files/upload?${query}`, { method: "POST", body: form });
          },
        },
      );
      if (!attachment || !isCurrent()) return false;
      attempt = { route: initialRoute, session, rect, attachment };
      submission.current = attempt;
    }
    if (!isCurrent()) return false;
    runtime = useRuntimeStore.getState();
    if (runtime.pendingInteraction || runtime.pendingQuestionnaire) {
      throw new RegionAskError("send", "Conversation is waiting for an answer");
    }
    const { path, description } = attempt.attachment;
    const message = injectWorkspaceReferences(question, [
      { cwd, path, name: source.filename, isDir: false, imageRegion: description },
    ]);
    const delivery =
      attempt.delivery?.question === question
        ? attempt.delivery
        : { question, id: uuid(), queued: Boolean(session && runtime.working) };
    attempt.delivery = delivery;
    const createdSession = () => {
      const current = useRuntimeStore.getState();
      if (current.cwd !== cwd || !current.activeSessionId) return null;
      const request = findLocalPromptRequest(
        cwd,
        current.activeSessionId,
        promptContentDigest(message),
      );
      return request?.clientMessageId === delivery.id ? current.activeSessionId : null;
    };
    let sentSession = session;
    try {
      if (delivery.queued) await runtime.enqueueMessage(message, delivery.id);
      else
        sentSession =
          (await runtime.sendPrompt(message, delivery.id)) ?? session ?? createdSession();
    } catch (error) {
      // A first send can create the session before its prompt fails. Keep the
      // same screenshot and request ID when retrying that specific session.
      if (!session) attempt.session = createdSession();
      throw new RegionAskError("send", "Could not send the region question", error);
    }
    submission.current = null;
    const current = useRuntimeStore.getState();
    if (onSamePage() && current.cwd === cwd && current.activeSessionId === sentSession) {
      useUiStore.getState().setInspectorMaximized(false);
      if (sentSession && sentSession !== routeSession) {
        navigate(
          `/workspace/${encodeURIComponent(cwd)}/session/${encodeURIComponent(sentSession)}`,
          {
            replace: location.pathname === `/workspace/${encodeURIComponent(cwd)}`,
            state: { preserveRegionQuestionDraft: true },
          },
        );
      }
    }
    return true;
  }
  return <ImagePreview url={url} filename={source.filename} onAsk={ask} />;
}
