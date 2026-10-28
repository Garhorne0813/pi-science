import { it, expect } from "vitest";
import { InMemorySqliteStateStore } from "../storage/sqlite/state-store.js";
const corpus = [
  ["中文回答", "用户偏好中文回答，专业英文术语保留原文", "中文 回答"],
  ["代码命名", "用户偏好 Python 变量使用 snake_case", "Python snake_case"],
  ["简洁段落", "用户偏好简洁段落而非嵌套列表", "简洁 段落"],
  ["图表配色", "用户偏好图表使用深色背景和紫色线条", "图表 深色"],
  ["CSV 导出", "用户偏好 CSV 导出使用 UTF-8 编码", "CSV UTF-8"],
  ["运行引用", "用户偏好以 run-042 标识日志链接", "run-042"],
  ["Artifact 引用", "用户偏好保留 artifact-v2 整体标识", "artifact-v2"],
  ["日期格式", "用户偏好日期使用 ISO 8601 格式", "ISO 8601"],
  ["交互语言", "用户偏好界面使用英文", "界面 英文"],
  [
    "Workflow summary",
    "User prefers concise workflow summaries",
    "concise workflow",
  ],
] as const;
it("evaluates Chinese/mixed-language R@1 against raw unicode61 FTS5 on the same ACL-filtered corpus", async () => {
  const store = new InMemorySqliteStateStore();
  await store.start();
  const context = {
    ownerId: "benchmark",
    projectId: "corpus",
    actor: "user" as const,
  };
  const call = (action: string, input: Record<string, unknown> = {}) =>
    store.memory<any>({ action, input, context });
  try {
    const { revision, ...s } = await call("settings");
    await call("settings.update", {
      expectedRevision: revision,
      settings: { ...s, enabled: true },
    });
    await store.run(
      "CREATE VIRTUAL TABLE recall_baseline USING fts5(id UNINDEXED, text)",
    );
    const ids: string[] = [];
    for (const [title, body] of corpus) {
      const r = (
        await call("write", {
          content: {
            scope: "project",
            kind: "preference",
            title,
            body,
            evidenceLevel: "user_stated",
            sources: [{kind:"message",locator:"corpus@user"}],
          },
        })
      ).record;
      // The retrieval corpus is explicitly curated; it must not define the auto-review whitelist.
      if(r.status==="pending_review") await call("approve",{id:r.id,expectedRevision:r.revision,contentHash:r.contentHash});
      expect((await call("read",{id:r.id})).record.status).toBe("active");
      ids.push(r.id);
      await store.run("INSERT INTO recall_baseline VALUES(?,?)", [
        r.id,
        title + " " + body,
      ]);
    }
    let unified = 0,
      baseline = 0;
    for (let i = 0; i < corpus.length; i++) {
      const query = corpus[i]![2];
      const actual = (await call("recall", { q: query })).records[0]?.id;
      if (actual === ids[i]) unified++;
      const plain = await store.get<{ id: string }>(
        "SELECT id FROM recall_baseline WHERE recall_baseline MATCH ? ORDER BY bm25(recall_baseline) LIMIT 1",
        [
          query
            .split(/\s+/)
            .map((t) => '"' + t + '"')
            .join(" OR "),
        ],
      );
      if (plain?.id === ids[i]) baseline++;
    }
    expect(unified / corpus.length).toBeGreaterThanOrEqual(0.8);
    expect(unified).toBeGreaterThan(baseline);
  } finally {
    await store.close();
  }
});
