import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const writeQueues = new Map<string, Promise<void>>();

export function metadataRoot(workspace: string): string {
  return join(resolve(workspace), ".pi-science");
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await withFileWriteLock(path, async () => {
    await appendJsonLineUnlocked(path, value);
  });
}

export async function appendJsonLineUnlocked(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export async function withFileWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const pending = previous.then(() => gate);
  writeQueues.set(key, pending);
  await previous;
  try { return await operation(); } finally { release(); if (writeQueues.get(key) === pending) writeQueues.delete(key); }
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    const result: T[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { result.push(JSON.parse(line) as T); } catch { /* tolerate a torn tail */ }
    }
    return result;
  } catch {
    return [];
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function configRoot(): string {
  const configured = process.env.PI_SCIENCE_HOME;
  const candidates = [
    configured ? resolve(configured) : resolve(process.env.HOME ?? ".", ".pi-science"),
    resolve(process.cwd(), ".runtime", "pi-science"),
  ];
  for (const candidate of candidates) {
    const probe = join(candidate, `.write-probe-${process.pid}`);
    try {
      mkdirSync(candidate, { recursive: true });
      writeFileSync(probe, "", "utf8");
      unlinkSync(probe);
      return candidate;
    } catch {
      try { unlinkSync(probe); } catch { /* best effort */ }
      // Try the project-local runtime root when the home directory is managed
      // or mounted read-only.
    }
  }
  return candidates[0]!;
}

export function configPath(name: string): string {
  return join(configRoot(), name);
}

export function workspaceFile(workspace: string, name: string): string {
  return join(metadataRoot(workspace), name);
}
