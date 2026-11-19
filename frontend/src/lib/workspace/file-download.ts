import { request, responseError } from "../client/http";
import { previewUrl } from "../files/files";
import { saveBlobAsFile } from "../shared/download";

/** Download a workspace file under its original name.
 *
 *  The bytes come from the same `/api/files/serve` URL the inspector previews,
 *  so no extra server route is needed and `request()` keeps the session cookie
 *  and the 45 s timeout.
 *
 *  The response is buffered in memory before the browser starts saving it, so a
 *  large file costs its whole size in heap for the duration of the download.
 *  Streaming straight to disk would need a server route that sets
 *  `Content-Disposition: attachment`; this flow deliberately avoids one. */
export async function downloadWorkspaceFile(cwd: string, path: string, name: string): Promise<void> {
  const response = await request(previewUrl(path, undefined, cwd));
  if (!response.ok) throw new Error(await failureMessage(response));
  saveBlobAsFile(await response.blob(), name);
}

/** Serve failures answer JSON `{ error }`; anything else falls back to the status. */
async function failureMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return responseError(body, `Download failed (HTTP ${response.status})`);
}
