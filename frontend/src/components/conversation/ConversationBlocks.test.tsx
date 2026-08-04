import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../i18n";
import { renderBlocks } from "./ConversationBlocks";
import type { ThreadBlock } from "../../types/thread";

const agent = (id: string, text: string): ThreadBlock => ({
  kind: "agent",
  id,
  parts: [{ id: `${id}-part`, text }],
});

const tool = (id: string): ThreadBlock => ({
  kind: "tool",
  id: `tool-${id}`,
  callId: id,
  tool: "bash",
  status: "done",
});

describe("ConversationBlocks", () => {
  it("shows one copy action for a response split across tool groups", () => {
    render(
      <>
        {renderBlocks([
          agent("a1", "好的，我来探索工作区的现有数据。先看一下整体结构。"),
          tool("ls"),
          agent("a2", "venv 内容淹没了输出，我排除它再看实际的工作文件。"),
          tool("find"),
          agent("a3", "工作区内容很精简。现在看一下脚本、数据和已有图。"),
          tool("read"),
          agent("a4", "已完成探索。"),
        ], { cwd: "/workspace", sessionId: "session-1" })}
      </>,
    );

    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
  });
});
