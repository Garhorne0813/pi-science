import { readFile, stat } from "node:fs/promises";
import type { CitationSource, CitationSourceStatus } from "@pi-science/contracts";
import { resolveWorkspaceFile } from "../../security/workspace-security.js";
import type { CapturedSource } from "./source-capture.js";

const MAX_VERIFY_BYTES = 8 * 1024 * 1024;
const BINARY_DETAIL = "Binary source; no text excerpt was retained.";
const WEB_VERIFIED_DETAIL = "Excerpt captured when the page was fetched; the live page may have changed and this does not confirm the page supports the answer.";
const WEB_UNAVAILABLE_DETAIL = "No text excerpt was captured from this page.";

async function readWorkspaceFile(absolutePath: string): Promise<string> {
  return readFile(absolutePath, "utf8");
}

function resolve(captured: CapturedSource, status: CitationSourceStatus, statusDetail: string | null): CitationSource {
  return {
    id: captured.id,
    kind: captured.kind,
    identity: captured.identity,
    title: captured.title,
    locator: captured.locator,
    excerpt: captured.excerpt,
    capturedAt: captured.capturedAt,
    evidence: captured.evidence,
    status,
    statusDetail,
  };
}

function verifyWeb(captured: CapturedSource): CitationSource {
  if (captured.binary) return resolve(captured, "unavailable", BINARY_DETAIL);
  if (captured.excerpt && captured.capturedAt) return resolve(captured, "verified", WEB_VERIFIED_DETAIL);
  return resolve(captured, "unavailable", WEB_UNAVAILABLE_DETAIL);
}

async function verifyFile(cwd: string, captured: CapturedSource, read: (absolutePath: string) => Promise<string>): Promise<CitationSource> {
  let absolutePath: string;
  try {
    absolutePath = await resolveWorkspaceFile(cwd, captured.identity);
  } catch (error) {
    return resolve(captured, "forbidden", error instanceof Error ? error.message : "Path is outside the workspace");
  }
  try {
    const info = await stat(absolutePath);
    if (info.size > MAX_VERIFY_BYTES) return resolve(captured, "unavailable", "File is larger than 8 MB; the excerpt was not verified.");
  } catch {
    return resolve(captured, "missing", "File is no longer present in the workspace.");
  }
  let content: string;
  try {
    content = await read(absolutePath);
  } catch {
    return resolve(captured, "missing", "File is no longer present in the workspace.");
  }
  if (!captured.excerpt) return resolve(captured, "unavailable", captured.binary ? BINARY_DETAIL : "No text excerpt was retained for this source.");
  if (content.includes(captured.excerpt)) return resolve(captured, "verified", null);
  return resolve(captured, "changed", "Excerpt came from the read at answer time; the file has changed since then.");
}

/** Verify captured sources against the current workspace. Local files only:
 *  networked sources keep the evidence from their own fetch. Never throws. */
export async function verifyCitationSources(cwd: string, captured: CapturedSource[], read: (absolutePath: string) => Promise<string> = readWorkspaceFile): Promise<CitationSource[]> {
  const verified: CitationSource[] = [];
  for (const source of captured) {
    try {
      if (source.kind === "web") verified.push(verifyWeb(source));
      else if (source.kind === "file") verified.push(await verifyFile(cwd, source, read));
      else verified.push(resolve(source, "identifier-only", "Identified in the answer text; no read evidence."));
    } catch (error) {
      verified.push(resolve(source, "unavailable", error instanceof Error ? error.message : "Source could not be verified"));
    }
  }
  return verified;
}
