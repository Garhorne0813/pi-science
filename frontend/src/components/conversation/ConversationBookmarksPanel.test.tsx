import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationBookmarksPanel } from "./ConversationBookmarksPanel";
import i18n from "../../i18n";
import type { ConversationBookmark } from "../../lib/conversation-navigation";

function bookmark(id: string, overrides: Partial<ConversationBookmark> = {}): ConversationBookmark {
  return {
    bookmark_id: id,
    session_id: "s1",
    message_id: `m-${id}`,
    role: "assistant",
    quote: "verified result",
    label: null,
    origin: "user",
    status: "accepted",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof ConversationBookmarksPanel>[0]> = {}) {
  const onJump = vi.fn();
  const onAccept = vi.fn();
  const onReject = vi.fn();
  const onDelete = vi.fn();
  const onSuggest = vi.fn();
  render(
    <ConversationBookmarksPanel
      bookmarks={[]}
      loading={false}
      open
      onClose={vi.fn()}
      onJump={onJump}
      onAccept={onAccept}
      onReject={onReject}
      onDelete={onDelete}
      onSuggest={onSuggest}
      suggesting={false}
      {...props}
    />,
  );
  return { onJump, onAccept, onReject, onDelete, onSuggest };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe("ConversationBookmarksPanel", () => {
  it("renders nothing when closed", () => {
    renderPanel({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows an empty state", () => {
    renderPanel();
    expect(screen.getByText(/No bookmarks yet/i)).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    renderPanel({ loading: true });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("jumps to an accepted bookmark and deletes it", () => {
    const { onJump, onDelete } = renderPanel({ bookmarks: [bookmark("b1", { label: "Key result" })] });
    fireEvent.click(screen.getByRole("button", { name: /Key result/ }));
    expect(onJump).toHaveBeenCalledWith("m-b1");
    fireEvent.click(screen.getByRole("button", { name: "Remove bookmark" }));
    expect(onDelete).toHaveBeenCalledWith("b1");
  });

  it("accepts and rejects proposals but does not delete them directly", () => {
    const { onAccept, onReject, onDelete } = renderPanel({
      bookmarks: [bookmark("p1", { status: "proposed", origin: "agent_proposal" })],
    });
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith("p1");
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("suggests bookmarks via the dedicated action", () => {
    const { onSuggest } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Suggest bookmarks" }));
    expect(onSuggest).toHaveBeenCalledTimes(1);
  });

  it("uses a non-modal region role and closes on Escape", () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    expect(screen.getByRole("region", { name: "Bookmarks" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on unrelated keys", () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
