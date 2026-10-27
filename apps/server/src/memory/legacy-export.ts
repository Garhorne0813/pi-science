import { createHash } from "node:crypto";
import { readFile, lstat, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { validateWorkspaceCwd } from "../security/workspace-security.js";
import { workspaceFile, metadataRoot } from "../storage/persistence.js";

/** Offline interchange/backup only: legacy approval flags never become Memory approvals. */
export async function exportLegacyMemory(
  workspace: string,
  destination: string,
) {
  const cwd = await validateWorkspaceCwd(workspace);
  const metadata = await realpath(metadataRoot(cwd));
  const files: Array<{
    path: string;
    sha256: string;
    utf8: string;
    contentBase64: string;
  }> = [];
  for (const path of ["memory/ledger.json", "project-state.json"]) {
    const source = workspaceFile(cwd, path);
    try {
      const info = await lstat(source);
      const location = relative(metadata, await realpath(source));
      if (location.startsWith("..") || isAbsolute(location))
        throw new Error(`Legacy source escapes metadata root: ${path}`);
      if (!info.isFile() || info.size > 16 * 1024 * 1024)
        throw new Error(`Invalid or oversized legacy file: ${path}`);
      const bytes = await readFile(source);
      files.push({
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        utf8: bytes.toString("utf8"),
        contentBase64: bytes.toString("base64"),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!files.length)
    throw new Error("No legacy Memory Ledger or project-state data found");
  const output = resolve(destination);
  await writeFile(
    output,
    JSON.stringify(
      {
        format: "pi-science-legacy-memory-export",
        version: 1,
        reviewStatus: "unreviewed_legacy",
        workspace: cwd,
        exportedAt: new Date().toISOString(),
        files,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return { output, files: files.map(({ path, sha256 }) => ({ path, sha256 })) };
}
