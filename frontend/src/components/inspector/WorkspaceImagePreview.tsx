import { useLocation, useNavigate } from "react-router-dom";
import { useRef } from "react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { apiRequest } from "@/lib/client/api";
import { useUiStore } from "@/lib/ui";
import type { FilePreviewInspector } from "@/types/thread";
import { ImagePreview } from "./ImagePreview";
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
    const blob = await regionSnapshot(image, rect);
    const form = new FormData();
    form.append("file", blob, "region.png");
    const path = `image-regions/${crypto.randomUUID()}.png`;
    const query = new URLSearchParams({ cwd, path });
    await apiRequest(`/api/files/upload?${query}`, { method: "POST", body: form });
    const runtime = useRuntimeStore.getState();
    if (!image.isConnected || route.current !== initialRoute || runtime.activeSessionId !== session)
      return;
    const origin = source.root === "base" ? `base/${source.path}` : source.path;
    const revision = source.sha256 ? ` (sha256 ${source.sha256})` : "";
    const description = `${origin}${revision} [x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height} px]`;
    const ui = useUiStore.getState();
    ui.addWorkspaceReference({
      cwd,
      path,
      name: source.filename,
      isDir: false,
      imageRegion: description,
    });
    ui.setInspectorVisible(false);
    const root = `/workspace/${encodeURIComponent(cwd)}`;
    if (location.pathname !== root && !location.pathname.startsWith(root + "/session/")) {
      navigate(
        runtime.cwd === cwd && session ? `${root}/session/${encodeURIComponent(session)}` : root,
      );
    }
  }
  return <ImagePreview url={url} filename={source.filename} onAsk={ask} />;
}
