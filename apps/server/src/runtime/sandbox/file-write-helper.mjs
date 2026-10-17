import { constants } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const destination = process.argv[2];
const chunks = []; let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 16 * 1024 * 1024) throw new Error("File write exceeds 16 MiB");
  chunks.push(chunk);
}
await mkdir(dirname(destination), { recursive: true });
const pending = join(dirname(destination), `.pi-write-${randomUUID()}.tmp`);
try {
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | 0x20000000, 0o600);
  try {
    try { const previous = await stat(destination); if (!previous.isFile() || previous.nlink !== 1) throw new Error("Write requires a single-link regular file"); await file.chmod(previous.mode & 0o777); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await file.writeFile(Buffer.concat(chunks)); await file.sync();
  } finally { await file.close(); }
  // The process sandbox, rather than a host path check, bounds both names
  // throughout this rename even if a live kernel replaces a parent directory.
  await rename(pending, destination);
} finally { await rm(pending, { force: true }); }
