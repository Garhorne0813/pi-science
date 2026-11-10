import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useRef, useState } from "react";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18nReady } from "../../i18n";
import { FeedbackContext } from "../feedback/feedback-context";

const runtime = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("../../lib/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/agent-runtime")>();
  return { ...actual, useRuntimeStore: (selector: (state: never) => unknown) => selector(runtime.state as never) };
});
// The controls under test are the composer's own; the surrounding seats are
// replaced so a test failure names the wiring rather than a transcript widget.
vi.mock("./MentionComposer", async () => {
  const { createElement } = await import("react");
  return {
    MentionComposer: (props: { inputRef: unknown; value: string; onChange: (value: string, mentions: unknown[], entities: unknown[]) => void }) =>
      createElement("textarea", { ref: props.inputRef, value: props.value, onChange: (event: { target: { value: string } }) => props.onChange(event.target.value, [], []) }),
  };
});
vi.mock("./ApprovalModeMenu", () => ({ ApprovalModeMenu: () => null }));
vi.mock("./ModelControlMenu", () => ({ ModelControlMenu: () => null }));
vi.mock("../todo/ComposerTodo", () => ({ ComposerTodo: () => null }));

import { ConversationComposer } from "./ConversationComposer";

type ComposerState = ComponentProps<typeof ConversationComposer>["composer"];
type ModelState = ComponentProps<typeof ConversationComposer>["model"];
type ResearchState = ComponentProps<typeof ConversationComposer>["research"];

const queuedMessage = (overrides: Record<string, unknown> = {}) => ({
  id: "8fd824aa-51d3-4f63-839c-09e021b7970b",
  text: "then summarize the table",
  status: "queued" as const,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const noop = async () => undefined;

interface HarnessProps {
  working: boolean;
  initialInput?: string;
  queued?: ReturnType<typeof queuedMessage>[];
  onSend?: () => Promise<void>;
  onAbort?: () => Promise<unknown>;
  cancel?: (entryId: string) => Promise<void>;
  toast?: (message: string, tone?: string) => void;
}

function Harness({ working, initialInput = "", queued = [], onSend = noop, onAbort = noop, cancel = noop, toast = vi.fn() }: HarnessProps) {
  const [input, setInput] = useState(initialInput);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  runtime.state = {
    cwd: "/tmp/pr244",
    activeSessionId: "session-1",
    mcpDiagnostics: undefined,
    queueSessionId: "session-1",
    queuedMessages: queued,
    queuePaused: false,
    thread: { blocks: [] },
    sendPrompt: noop,
    loadQueue: noop,
    resumeQueue: noop,
    cancelQueuedMessage: cancel,
    dispatchQueuedMessage: async () => "accepted",
    retryQueuedMessage: noop,
  };
  const composer = {
    input,
    setInput,
    entities: [],
    setEntities: vi.fn(),
    mentions: [],
    files: [],
    setFiles: vi.fn(),
    workspaceReferences: [],
    quote: null,
    inputRef,
    composingRef: { current: false },
    dragOver: false,
    setDragOver: vi.fn(),
    fileInputRef: { current: null },
    handleSend: onSend,
    handleKeyDown: vi.fn(),
    handleDrop: vi.fn(),
    handleFilePick: vi.fn(),
  } as unknown as ComposerState;
  const model = {
    models: [],
    selectedModel: "model-1",
    selectedModelInfo: { context_window: 128000 },
    needsModelSwitch: false,
    thinking: "high",
    thinkingLevels: [],
    configuringModel: false,
    modelError: null,
    handleModelChange: vi.fn(),
    handleThinkingChange: vi.fn(),
  } as unknown as ModelState;
  return (
    <MemoryRouter>
      <FeedbackContext.Provider value={{ toast: toast as never, confirm: async () => true }}>
        <ConversationComposer
          workspaceCwd="/tmp/pr244"
          status="ready"
          activeSessionId="session-1"
          sessionStats={null}
          contextTokens={null}
          contextWindow={null}
          contextPercent={null}
          compactionEnabled={false}
          compactionThresholdPercent={null}
          working={working}
          promptDeliveryNotice={null}
          interactionPending={false}
          reviewingProject={false}
          reviewNotice={null}
          autoReviewOn={false}
          modelControlsDisabled={false}
          showWelcome={false}
          showScrollDown={false}
          composer={composer}
          model={model}
          research={{ prompt: "Ask anything" } as unknown as ResearchState}
          onScrollToBottom={vi.fn()}
          onReview={vi.fn()}
          onAbort={onAbort}
          onRemoveWorkspaceReference={vi.fn()}
        />
      </FeedbackContext.Provider>
    </MemoryRouter>
  );
}

beforeAll(async () => { await i18nReady; });

describe("ConversationComposer primary action", () => {
  it("keeps a single accent action while running with an empty input", () => {
    render(<Harness working />);
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to the follow-up queue" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".bg-accent-fill")).toHaveLength(1);
  });

  it("swaps the slot to queue-send for a draft and back to Stop when cleared", () => {
    const onSend = vi.fn(async () => undefined);
    render(<Harness working onSend={onSend} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "follow up" } });
    const secondaryStop = screen.getByRole("button", { name: "Stop generation" });
    expect(secondaryStop.className).toContain("h-6");
    expect(secondaryStop.className).not.toContain("bg-accent-fill");
    expect(screen.getByRole("button", { name: "Add to the follow-up queue" }).className).toContain("bg-accent-fill");
    fireEvent.click(screen.getByRole("button", { name: "Add to the follow-up queue" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.change(textarea, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Stop generation" }).className).toContain("bg-accent-fill");
  });
});

describe("editing a queued message in the composer", () => {
  it("cancels the entry, fills the input, and puts the caret at the end", async () => {
    const cancel = vi.fn(async () => undefined);
    render(<Harness working={false} queued={[queuedMessage()]} cancel={cancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(queuedMessage().id));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(queuedMessage().text));
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
  });

  it("does not overwrite text the user is already writing", async () => {
    const cancel = vi.fn(async () => undefined);
    const toast = vi.fn();
    render(<Harness working={false} initialInput="my draft" queued={[queuedMessage()]} cancel={cancel} toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Finish or clear the composer first", "info"));
    expect(cancel).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("my draft");
  });

  it("leaves the draft alone when cancelling the entry fails", async () => {
    const cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    const toast = vi.fn();
    render(<Harness working={false} queued={[queuedMessage()]} cancel={cancel} toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Could not update the queue", "error"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
});
