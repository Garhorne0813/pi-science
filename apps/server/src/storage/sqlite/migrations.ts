import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Migration } from "./protocol.js";

const migrationFiles = [
  { version: 1, name: "0001_initial.sql", url: new URL("./migrations/0001_initial.sql", import.meta.url) },
] as const;

export async function loadMigrations(): Promise<Migration[]> {
  const migrations = await Promise.all(migrationFiles.map(async (entry) => {
    const sql = await readFile(entry.url, "utf8");
    return { version: entry.version, name: entry.name, sql, checksum: checksum(sql) } satisfies Migration;
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
