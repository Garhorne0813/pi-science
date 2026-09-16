import { test, expect, type Page } from "@playwright/test";

type ActivityWindow = Window & { emitActivity: (type: string, payload: Record<string, unknown>) => void };
const emit = (page: Page, type: string, payload: Record<string, unknown> = {}) =>
  page.evaluate(({ type, payload }) => (window as unknown as ActivityWindow).emitActivity(type, payload), { type, payload });
const bottomGap = (page: Page) => page.locator(".conversation-scroller").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const answer = (count: number) => Array.from({ length: count }, (_, index) => `第 ${index + 1} 项验证：消息高度变化后保持跟随，同时允许用户主动上滑查看历史。`).join("\n\n");

test("follows two consecutive replies and preserves explicit history browsing", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const animate = testInfo.project.name.includes("dark");
  await page.emulateMedia({ reducedMotion: animate ? "no-preference" : "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ dark }) => {
    localStorage.setItem("pi-science.theme", JSON.stringify(dark ? "dark" : "light"));
    localStorage.setItem("pi-science.locale", JSON.stringify("zh-Hans"));
    class FakeSource extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      static instances: FakeSource[] = [];
      readyState = 0;
      onopen?: (event: Event) => void;
      constructor(public url: string) {
        super(); FakeSource.instances.push(this);
        setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")); }, 0);
      }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, "EventSource", { value: FakeSource });
    (window as unknown as ActivityWindow).emitActivity = (type, payload) => {
      const source = FakeSource.instances.findLast((item) => item.url.includes("/sessions/") && item.readyState === 1);
      if (!source) throw new Error("Session event stream is not connected");
      source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ type, sessionId: "visual-session-1", ...payload }) }));
    };
  }, { dark: testInfo.project.name.includes("dark") });
  await page.route("**/api/sessions/*/messages?*", (route) => route.fulfill({ json: { messages: [{ id: "u-first", role: "user", content: [{ type: "text", text: "检查消息自动跟随，并优化运行中的展示。" }] }], next_cursor: null, has_more: false, snapshot_version: "follow-v1" } }));
  await page.route("**/api/sessions/*/artifacts?*", (route) => route.fulfill({ json: { turns: [] } }));
  await page.goto("/workspace/%2Ftmp%2Fvisual-demo/session/visual-session-1");
  await expect(page.locator(".ui-user-message")).toContainText("检查消息自动跟随");
  await emit(page, "agent_start");
  await emit(page, "text.updated", { partId: "purpose-1", text: "定位第二轮消息没有自动跟随的原因" });
  await emit(page, "tool.updated", { callId: "read-1", tool: "read", status: "running", input: { path: "useConversationScroll.ts" } });
  await expect(page.getByText("定位第二轮消息没有自动跟随的原因", { exact: true })).toBeVisible();
  await emit(page, "tool.updated", { callId: "read-1", tool: "read", status: "done" });
  await emit(page, "text.updated", { partId: "first-answer", text: answer(35) });
  await expect.poll(() => bottomGap(page)).toBeLessThan(8);
  await emit(page, "session.idle", { handledWithoutTurn: true });
  await expect(page.getByRole("region", { name: "执行记录" })).toHaveCount(0);
  await expect.poll(() => bottomGap(page)).toBeLessThan(8);

  const scroller = page.locator(".conversation-scroller");
  await scroller.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(200);
  await expect(page.getByLabel("回到最新")).toBeVisible();

  // Real composer send resets following before the second turn is measured.
  await page.locator("textarea").fill("继续验证第二轮消息，并整理测试结果。");
  await page.getByLabel("Send message", { exact: true }).click();
  await expect(page.locator(".ui-user-message").last()).toContainText("继续验证第二轮");
  await emit(page, "agent_start");
  await emit(page, "tool.updated", { callId: "read-2", tool: "read", status: "running", input: { path: "scroll.ts", description: "检查第二轮消息追加后的滚动位置" } });
  await expect(page.getByText("检查第二轮消息追加后的滚动位置", { exact: true })).toBeVisible();
  await expect.poll(() => bottomGap(page)).toBeLessThan(8);
  await emit(page, "tool.updated", { callId: "read-2", tool: "read", status: "done" });
  await emit(page, "tool.updated", { callId: "read-3", tool: "read", status: "running", input: { path: "list.ts", description: "确认虚拟列表测量后仍然跟随最新内容" } });
  await expect(page.getByText("确认虚拟列表测量后仍然跟随最新内容", { exact: true })).toBeVisible();
  await expect(page.getByText("检查第二轮消息追加后的滚动位置", { exact: true })).toHaveCount(0);
  const live = page.locator('[data-thread-block-ids][data-state="running"]');
  await expect(live.locator("[data-orb-variant]")).toHaveCount(1);
  const orb = live.locator("[data-orb-variant]");
  expect(await orb.evaluate((el) => el.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"))).toBe(animate);
  expect(await orb.evaluate((el) => ["::before", "::after"].every((pseudo) => getComputedStyle(el.parentElement!, pseudo).content === "none"))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("second-turn-running.png") });

  await emit(page, "tool.updated", { callId: "read-3", tool: "read", status: "done" });
  for (const count of [8, 16, 30]) {
    await emit(page, "text.updated", { partId: "second-answer", text: answer(count) });
    await expect.poll(() => bottomGap(page)).toBeLessThan(8);
  }
  await scroller.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(200);
  const browsedTop = await scroller.evaluate((el) => el.scrollTop);
  await emit(page, "text.updated", { partId: "second-answer", text: answer(40) });
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(600);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(browsedTop + 8);
  await page.getByLabel("回到最新").click();
  await expect.poll(() => bottomGap(page)).toBeLessThan(8);
  await emit(page, "session.idle", { handledWithoutTurn: true });
  await expect(page.getByRole("region", { name: "执行记录" })).toHaveCount(0);
  await expect.poll(() => bottomGap(page)).toBeLessThan(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
