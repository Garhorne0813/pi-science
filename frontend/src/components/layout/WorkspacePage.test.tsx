import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { rememberLastConversation } from "../../lib/conversation/last-conversation";
import i18n from "../../i18n";
import { WorkspacePageHeader } from "./WorkspacePage";

function renderHeader(entry: string) {
  render(<MemoryRouter initialEntries={[entry]}><Routes><Route path="/workspace/:cwd/*" element={<WorkspacePageHeader title="Files" />} /></Routes></MemoryRouter>);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  useRuntimeStore.setState({ cwd: "proj", activeSessionId: null });
});
afterEach(() => cleanup());

it("returns to the conversation carried by the current page URL", () => {
  renderHeader("/workspace/proj/runs?session_id=session-from-url");
  expect(screen.getByRole("link", { name: "Back to conversation" })).toHaveAttribute("href", "/workspace/proj/session/session-from-url");
});

it("restores the last viewed conversation after a page refresh", () => {
  rememberLastConversation("proj", "remembered-session");
  renderHeader("/workspace/proj/files");
  expect(screen.getByRole("link", { name: "Back to conversation" })).toHaveAttribute("href", "/workspace/proj/session/remembered-session");
});

it("returns to the new-conversation draft instead of a previous session", () => {
  rememberLastConversation("proj", "remembered-session");
  renderHeader("/workspace/proj/files?conversation=new");
  expect(screen.getByRole("link", { name: "Back to conversation" })).toHaveAttribute("href", "/workspace/proj/new");
});
