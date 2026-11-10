import { describe, expect, it } from "vitest";
import { ddProgressAdapter } from "./dd.js";
import { pvProgressAdapter } from "./pv.js";
import { rsyncProgressAdapter } from "./rsync.js";

describe("ddProgressAdapter", () => {
  it("counts bytes without inventing a bar", () => {
    expect(ddProgressAdapter.read("1048576 bytes (1.0 MB, 1.0 MiB) copied, 0.5 s, 2.0 MB/s")).toEqual([
      { scopeId: "dd:progress", scopeLabel: "Copied", current: 1048576, totalKind: "unknown", unit: "bytes" },
    ]);
  });

  it("takes the newest sentence when carriage returns are cleaned away", () => {
    expect(ddProgressAdapter.read("512 bytes copied, 0.1 s, 5.0 kB/s1024 bytes copied, 0.2 s, 5.0 kB/s").at(-1)?.current).toBe(1024);
  });

  it("reads only a copy asked for progress reports", () => {
    expect(ddProgressAdapter.matches?.("dd if=disk.img of=/dev/rdisk2 status=progress bs=4m")).toBe(true);
    expect(ddProgressAdapter.matches?.("dd if=disk.img of=disk.img")).toBe(false);
  });
});

describe("pvProgressAdapter", () => {
  it("reads bytes and size from a machine format", () => {
    expect(pvProgressAdapter.read("524288/1048576 1048576/1048576")).toEqual([{ scopeId: "bytes:1048576", scopeLabel: "Transfer", current: 1048576, total: 1048576, totalKind: "fixed", unit: "bytes" }]);
  });

  it("reports nothing for the default percentage-only output", () => {
    expect(pvProgressAdapter.read("  45%")).toEqual([]);
  });

  it("does not read a copy that asked for no machine format", () => {
    expect(pvProgressAdapter.matches?.("pv file.bin > out.bin")).toBe(false);
    expect(pvProgressAdapter.matches?.("pv --format '%b/%s ' file.bin > out.bin")).toBe(true);
  });
});

describe("rsyncProgressAdapter", () => {
  it("counts files from one progress2 record", () => {
    expect(rsyncProgressAdapter.read("  1,234,567  45%  1.20MB/s    0:00:03 (xfr#1, to-chk=6/10)")).toEqual([
      { scopeId: "files", scopeLabel: "Checking files", current: 4, total: 10, totalKind: "reestimated", unit: "files" },
    ]);
  });

  it("reads only a transfer asked for progress2", () => {
    expect(rsyncProgressAdapter.matches?.("rsync -a --info=progress2 a/ b/")).toBe(true);
    expect(rsyncProgressAdapter.matches?.("rsync -a a/ b/")).toBe(false);
  });
});
