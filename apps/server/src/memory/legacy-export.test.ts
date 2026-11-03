import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { exportLegacyMemory } from "./legacy-export.js";
it("exports legacy data byte-for-byte without approval, import, overwrite or source mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-memory-export-"));
  try {
    await mkdir(join(root, ".pi-science", "memory"), { recursive: true });
    const data = Buffer.from('{"approved":true,"body":"old finding"}\r\n');
    const source = join(root, ".pi-science", "memory", "ledger.json");
    await writeFile(source, data);
    const output = join(root, "export.json");
    await exportLegacyMemory(root, output);
    const result = JSON.parse(await readFile(output, "utf8"));
    expect(result.reviewStatus).toBe("unreviewed_legacy");
    expect(Buffer.from(result.files[0].contentBase64, "base64")).toEqual(data);
    expect(result.files[0].sha256).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
    expect(await readFile(source)).toEqual(data);
    await expect(exportLegacyMemory(root, output)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(source)).toEqual(data);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
