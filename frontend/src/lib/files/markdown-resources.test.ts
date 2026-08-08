import { describe, expect, it } from "vitest";
import { resolveMarkdownResource, type MarkdownResourceContext } from "./markdown-resources";

const CWD = "/Users/cyq/pi-science-workspaces/test";
const ctx: MarkdownResourceContext = { cwd: CWD };

describe("resolveMarkdownResource", () => {
  it("keeps external URLs untouched", () => {
    for (const href of ["https://example.com/a.png", "http://x.dev/b?q=1", "data:image/png;base64,AAA", "blob:abc", "mailto:a@b.c"]) {
      expect(resolveMarkdownResource(href, ctx)).toEqual({ kind: "external", url: href });
    }
  });

  it("rejects file:// references as invalid (web app cannot load local files)", () => {
    expect(resolveMarkdownResource("file:///Users/me/plot.png", ctx)).toEqual({ kind: "invalid" });
    expect(resolveMarkdownResource("file:///C:/Users/me/plot.png", ctx)).toEqual({ kind: "invalid" });
  });

  it("rejects empty, anchor-only and fragment paths", () => {
    expect(resolveMarkdownResource("", ctx)).toEqual({ kind: "invalid" });
    expect(resolveMarkdownResource("#section", ctx)).toEqual({ kind: "invalid" });
    expect(resolveMarkdownResource("   ", ctx)).toEqual({ kind: "invalid" });
  });

  it("resolves workspace-relative paths against the workspace root", () => {
    const res = resolveMarkdownResource("figures/plot.png", ctx);
    expect(res).toMatchObject({ kind: "workspace", path: "figures/plot.png" });
    expect((res as { url: string }).url).toContain("/api/files/serve/figures/plot.png?cwd=");
  });

  it("strips ./ prefixes", () => {
    expect(resolveMarkdownResource("./images/a.png", ctx)).toMatchObject({ kind: "workspace", path: "images/a.png" });
  });

  it("resolves relative paths against the document directory", () => {
    const docCtx: MarkdownResourceContext = { cwd: CWD, documentPath: `${CWD}/reports/readme.md` };
    expect(resolveMarkdownResource("./images/a.png", docCtx)).toMatchObject({ kind: "workspace", path: "reports/images/a.png" });
    expect(resolveMarkdownResource("images/a.png", docCtx)).toMatchObject({ kind: "workspace", path: "reports/images/a.png" });
  });

  it("allows ../ that stays inside the workspace and rejects escapes", () => {
    const docCtx: MarkdownResourceContext = { cwd: CWD, documentPath: `${CWD}/reports/readme.md` };
    expect(resolveMarkdownResource("../figures/b.png", docCtx)).toMatchObject({ kind: "workspace", path: "figures/b.png" });
    expect(resolveMarkdownResource("../../outside.png", docCtx)).toEqual({ kind: "invalid" });
    expect(resolveMarkdownResource("../../../etc/passwd", docCtx)).toEqual({ kind: "invalid" });
  });

  it("resolves unix absolute paths under cwd and strips the cwd prefix", () => {
    expect(resolveMarkdownResource(`${CWD}/figures/plot.png`, ctx)).toMatchObject({ kind: "workspace", path: "figures/plot.png" });
  });

  it("interprets workspace-root shorthand (/figures/a.png) inside the workspace", () => {
    expect(resolveMarkdownResource("/figures/a.png", ctx)).toMatchObject({ kind: "workspace", path: "figures/a.png" });
  });

  it("normalizes .. in absolute paths and rejects paths that climb above the workspace root", () => {
    expect(resolveMarkdownResource("/figures/../../etc/passwd", ctx)).toEqual({ kind: "invalid" });
    expect(resolveMarkdownResource("/../../secret.txt", ctx)).toEqual({ kind: "invalid" });
  });

  it("normalizes .. inside the cwd prefix without breaking the resolution", () => {
    expect(resolveMarkdownResource(`${CWD}/figures/../a.png`, ctx)).toMatchObject({ kind: "workspace", path: "a.png" });
  });

  it("handles Windows drive paths and backslashes (case-insensitive drive)", () => {
    const winCtx: MarkdownResourceContext = { cwd: "C:/Users/cyq/pi-science-workspaces/test" };
    expect(resolveMarkdownResource("C:\\figures\\a.png", winCtx)).toMatchObject({ kind: "workspace", path: "figures/a.png" });
    expect(resolveMarkdownResource("c:/Users/cyq/pi-science-workspaces/test/figures/a.png", winCtx)).toMatchObject({ kind: "workspace", path: "figures/a.png" });
    const winDoc: MarkdownResourceContext = { cwd: "C:/Users/cyq/pi-science-workspaces/test", documentPath: "C:/Users/cyq/pi-science-workspaces/test/reports/readme.md" };
    expect(resolveMarkdownResource(".\\images\\a.png", winDoc)).toMatchObject({ kind: "workspace", path: "reports/images/a.png" });
  });

  it("keeps query/fragment out of the encoded path", () => {
    const res = resolveMarkdownResource("figures/a.png?raw=1#top", ctx);
    expect(res).toMatchObject({ kind: "workspace", path: "figures/a.png" });
    const url = (res as { url: string }).url;
    expect(url).toContain("/api/files/serve/figures/a.png?cwd=");
    expect(url).toContain("&raw=1#top");
  });

  it("encodes spaces and CJK characters in the path", () => {
    const res = resolveMarkdownResource("我的 图片/图 1.png", ctx);
    expect(res).toMatchObject({ kind: "workspace", path: "我的 图片/图 1.png" });
    expect((res as { url: string }).url).toContain("%E6%88%91%E7%9A%84%20%E5%9B%BE%E7%89%87");
  });

  it("passes the root override into the serve URL", () => {
    const res = resolveMarkdownResource("figures/a.png", { cwd: CWD, root: "base" });
    expect((res as { url: string }).url).toContain("root=base");
  });
});
