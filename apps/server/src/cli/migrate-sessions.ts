import { acquireSingleInstanceLock } from "../launcher/instance-lock.js";
import { configPath } from "../storage/persistence.js";
import { realpath } from "node:fs/promises";
import { migrateLegacySessions } from "../runtime/agent/migrate-legacy-sessions.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const workspaces = args.filter((arg) => !arg.startsWith("--"));
  if (!workspaces.length || args.some((arg) => arg.startsWith("--") && arg !== "--dry-run")) {
    console.error("Usage: pnpm migrate:sessions [--dry-run] /absolute/workspace [...workspaces]\nStop Pi Science before converting. Originals are retained; no API key is needed.");
    process.exitCode = 2;
    return;
  }
  const lock = await acquireSingleInstanceLock(configPath("instance.lock"));
  try {
    for (const workspace of workspaces) {
      try {
        const cwd = await realpath(workspace);
        const records = await migrateLegacySessions(cwd, dryRun);
        console.log(JSON.stringify({ cwd, dryRun, records }, null, 2));
        if (records.some((record) => record.status === "failed")) process.exitCode = 1;
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    }
  } finally { await lock.release(); }
}
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
