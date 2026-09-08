import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Migration } from "./protocol.js";

const migrationFiles = [
  { version: 1, name: "0001_initial.sql", url: new URL("./migrations/0001_initial.sql", import.meta.url) },
  { version: 2, name: "0002_mcp_connectors.sql", url: new URL("./migrations/0002_mcp_connectors.sql", import.meta.url) },
  { version: 3, name: "0003_global_mcp_settings.sql", url: new URL("./migrations/0003_global_mcp_settings.sql", import.meta.url), compatibleChecksums: ["502092b1102857c4affd53158935ed0b1b862245397077da72e25c0a547b8a96"] },
  { version: 4, name: "0004_project_mcp_tool_grants.sql", url: new URL("./migrations/0004_project_mcp_tool_grants.sql", import.meta.url), compatibleChecksums: ["d89e957d8ad3894af8b0ea976658055e2477bea5e0ba4cc13e26ef128693410c"] },
] as const;

export async function loadMigrations(): Promise<Migration[]> {
  const migrations = await Promise.all(migrationFiles.map(async (entry) => {
    const sql = await readFile(entry.url, "utf8");
    return { version: entry.version, name: entry.name, sql, checksum: checksum(sql), ...("compatibleChecksums" in entry ? { compatibleChecksums: [...entry.compatibleChecksums] } : {}) } satisfies Migration;
  }));
  validateMigrations(migrations);
  return migrations;
}

export function validateMigrations(migrations: readonly Migration[]): void {
  let previous = 0;
  const versions = new Set<number>();
  const names = new Set<string>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous || versions.has(migration.version)) {
      throw new Error(`SQLite migrations must have strictly increasing unique versions: ${migration.version}`);
    }
    if (!migration.name || names.has(migration.name)) throw new Error(`Duplicate SQLite migration name: ${migration.name}`);
    if (!migration.sql.trim()) throw new Error(`SQLite migration is empty: ${migration.name}`);
    if (!/^[0-9a-f]{64}$/.test(migration.checksum)) throw new Error(`Invalid SQLite migration checksum: ${migration.name}`);
    if (migration.compatibleChecksums?.some((value) => !/^[0-9a-f]{64}$/.test(value))) throw new Error(`Invalid compatible SQLite migration checksum: ${migration.name}`);
    previous = migration.version;
    versions.add(migration.version);
    names.add(migration.name);
  }
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function migrationAssetNames(): string[] {
  return migrationFiles.map((entry) => basename(entry.url.pathname));
}
