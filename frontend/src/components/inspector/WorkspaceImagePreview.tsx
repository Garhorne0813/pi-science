import { useLocation, useNavigate } from "react-router-dom";
import { useRef } from "react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { apiRequest } from "@/lib/client/api";
import { useUiStore } from "@/lib/ui";
import type { FilePreviewInspector } from "@/types/thread";
import { ImagePreview } from "./ImagePreview";
import { askAboutImageRegion } from "./image-region-ask";
import { regionSnapshot, type PixelRect } from "./image-region";

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
  const route = useRef(location.key);
  route.current = location.key;

  async function ask(image: HTMLImageElement, rect: PixelRect) {
    const initialRoute = route.current;
    const session = useRuntimeStore.getState().activeSessionId;
    await askAboutImageRegion(
      { image, rect, source },
      {
        isCurrent: () =>
          image.isConnected &&
          route.current === initialRoute &&
          useRuntimeStore.getState().activeSessionId === session,
        snapshot: regionSnapshot,
        upload: async (blob, path) => {
          const form = new FormData();
          form.append("file", blob, "region.png");
          const query = new URLSearchParams({ cwd, path });
          await apiRequest(`/api/files/upload?${query}`, { method: "POST", body: form });
        },
        addReference: (path, description) =>
          useUiStore.getState().addWorkspaceReference({
            cwd,
            path,
            name: source.filename,
            isDir: false,
            imageRegion: description,
          }),
        finish: () => {
          useUiStore.getState().setInspectorVisible(false);
          const root = `/workspace/${encodeURIComponent(cwd)}`;
          if (location.pathname === root || location.pathname.startsWith(root + "/session/")) return;
          const runtime = useRuntimeStore.getState();
          navigate(
            runtime.cwd === cwd && session ? `${root}/session/${encodeURIComponent(session)}` : root,
          );
        },
      },
    );
  }
  return <ImagePreview url={url} filename={source.filename} onAsk={ask} />;
}
