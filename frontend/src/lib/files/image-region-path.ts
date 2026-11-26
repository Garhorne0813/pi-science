/** Region snapshots are uploaded into this workspace directory, and the chat
 *  reference parser only accepts the paths this module can produce. */
export const IMAGE_REGION_DIR = "image-regions";

/** RFC 4122 v4 shape, 8-4-4-4-12 hex. */
const IMAGE_REGION_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** `crypto.randomUUID` exists only in secure contexts, which excludes the LAN
 *  `http://` addresses the app is routinely opened from; `getRandomValues` has
 *  no such restriction, so the id is assembled here instead. The id stays
 *  UUID-shaped because references already stored in a transcript must keep
 *  parsing (`lib/client/random-id.ts` mints opaque suffixes, not this shape). */
export function imageRegionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Workspace-relative path of a region snapshot. */
export function imageRegionPath(id: string = imageRegionId()): string {
  return `${IMAGE_REGION_DIR}/${id}.png`;
}

/** Whether `path` names a region snapshot this frontend could have uploaded.
 *  Exactly `<dir>/<uuid>.png`: extra segments, relative hops, and absolute
 *  paths are rejected even though the workspace serves them elsewhere. */
export function isImageRegionPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.length !== 2) return false;
  const [directory, file] = segments;
  return (
    directory === IMAGE_REGION_DIR &&
    file.endsWith(".png") &&
    IMAGE_REGION_ID.test(file.slice(0, -".png".length))
  );
}
