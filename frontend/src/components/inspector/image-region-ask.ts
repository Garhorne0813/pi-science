import { ApiError } from "@/lib/client/api";
import { imageRegionPath } from "@/lib/files/image-region-path";
import type { FilePreviewInspector } from "@/types/thread";
import type { PixelRect } from "./image-region";

/** Why attaching a region failed. The inspector picks its copy from this, so a
 *  dropped connection does not read like an upload the workspace refused. */
export type RegionAskFailureKind = "network" | "rejected" | "unknown" | "send";

export class RegionAskError extends Error {
  readonly kind: RegionAskFailureKind;
  /** The failure this one classifies, kept so callers can log the original. */
  readonly original: unknown;

  constructor(kind: RegionAskFailureKind, message: string, original?: unknown) {
    super(message);
    this.name = "RegionAskError";
    this.kind = kind;
    this.original = original;
  }
}

export interface RegionAskRequest {
  image: HTMLImageElement;
  rect: PixelRect;
  source: FilePreviewInspector;
}

export interface RegionAskPorts {
  /** Re-checked before every step that leaves a trace: a route or session
   *  change during an await must not upload an orphaned PNG or attach a
   *  reference to a conversation the user already left. */
  isCurrent: () => boolean;
  snapshot: (image: HTMLImageElement, rect: PixelRect) => Promise<Blob>;
  upload: (blob: Blob, path: string) => Promise<void>;
}

/** Turns the pixels the user selected into a workspace image reference. */
export async function uploadImageRegion(
  { image, rect, source }: RegionAskRequest,
  ports: RegionAskPorts,
): Promise<{ path: string; description: string } | null> {
  try {
    if (!ports.isCurrent()) return null;
    const blob = await ports.snapshot(image, rect);
    if (!ports.isCurrent()) return null;
    const path = imageRegionPath();
    await ports.upload(blob, path);
    return ports.isCurrent() ? { path, description: regionDescription(source, rect) } : null;
  } catch (error) {
    throw classifyRegionAskFailure(error);
  }
}

/** The reference text the agent reads: where the pixels came from and which
 *  rectangle of the source image they are. */
function regionDescription(source: FilePreviewInspector, rect: PixelRect): string {
  const origin = source.root === "base" ? `base/${source.path}` : source.path;
  const revision = source.sha256 ? ` (sha256 ${source.sha256})` : "";
  return `${origin}${revision} [x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height} px]`;
}

function classifyRegionAskFailure(error: unknown): RegionAskError {
  if (error instanceof RegionAskError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiError)
    return new RegionAskError(
      error.status >= 400 && error.status < 500 ? "rejected" : "unknown",
      message,
      error,
    );
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || /timed out|failed to fetch|networkerror|load failed/i.test(message))
    return new RegionAskError("network", message, error);
  return new RegionAskError("unknown", message, error);
}
