import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import { InteractionPrompt } from "./InteractionPrompt";

const approval = {
  requestId: "mcp-approval-1",
  method: "select" as const,
  title: "MCP: papers wants to run search",
  options: ["Allow once", "Allow for session", "Deny"],
};

describe("InteractionPrompt", () => {
  it("renders confirmation permissions as an accessible approval card", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={{ requestId: "install-1", kind: "permission", method: "confirm", title: "Install scipy", operation: "Install scipy 1.17", scope: "Project environment", effect: "Creates a new revision" }} onRespond={onRespond} />);
    expect(screen.getByRole("alertdialog", { name: "Approval required" })).toBeInTheDocument();
    expect(screen.getByText("Project environment")).toBeInTheDocument();
    expect(screen.getByText("Creates a new revision")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onRespond).toHaveBeenCalledWith({ confirmed: true });
  });

  it("moves focus to the permission alertdialog when it appears", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={{ requestId: "install-focus", kind: "permission", method: "confirm", title: "Install scipy" }} onRespond={onRespond} />);
    expect(screen.getByRole("alertdialog", { name: "Approval required" })).toHaveFocus();
  });

  it("does not let question text override an explicit non-permission kind", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={{
      requestId: "question-1",
      kind: "question",
      method: "input",
      title: "Why was permission denied?",
    }} onRespond={onRespond} />);
    expect(screen.queryByRole("alertdialog", { name: "Approval required" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Because the scope was too broad." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledWith({ value: "Because the scope was too broad." });
  });

  it("sends the selected MCP approval once and locks the buttons while pending", async () => {
    let resolveResponse!: () => void;
    const onRespond = vi.fn(() => new Promise<void>((resolve) => { resolveResponse = resolve; }));
    render(<InteractionPrompt interaction={approval} onRespond={onRespond} />);

    const allow = screen.getByRole("button", { name: "Allow once" });
    fireEvent.click(allow);
    fireEvent.click(allow);

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({ value: "Allow once" });
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow for session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow once" }).querySelector(".animate-spin")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow for session" }).querySelector(".animate-spin")).toBeNull();

    resolveResponse();
  });

  it("confirms once with Enter on the focused permission dialog, but not while composing or on buttons", () => {
    const onRespond = vi.fn(() => new Promise<void>(() => undefined));
    render(<InteractionPrompt interaction={{ requestId: "mcp-enter", kind: "permission", method: "confirm", title: "Run MCP search" }} onRespond={onRespond} />);

    const dialog = screen.getByRole("alertdialog", { name: "Approval required" });
    fireEvent.keyDown(dialog, { key: "Enter", isComposing: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Allow once" }), { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Enter" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({ confirmed: true });
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  });

  it("exposes persistent permission only for a managed MCP tool and tracks its pending action", () => {
    const onRespond = vi.fn(() => new Promise<void>(() => undefined));
    const grant = { connectorId: "connector_papers", toolName: "search" };
    render(<InteractionPrompt interaction={{
      requestId: "mcp-persistent", kind: "permission", method: "confirm", title: "Run MCP search", mcpGrant: grant,
    }} onRespond={onRespond} />);

    const scope = screen.getByRole("combobox", { name: "Approval scope" });
    expect(scope).toHaveValue("project");
    expect(screen.getByRole("option", { name: "Allow in this conversation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onRespond).toHaveBeenCalledWith({ confirmed: true, alwaysAllow: true });
    expect(scope).toBeDisabled();
    expect(screen.getByRole("button", { name: "Allow" }).querySelector(".animate-spin")).toBeTruthy();
  });

  it("sends a conversation-scoped MCP approval", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={{
      requestId: "mcp-conversation", kind: "permission", method: "confirm", title: "Run MCP search",
      mcpGrant: { connectorId: "connector_papers", toolName: "search" },
    }} onRespond={onRespond} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Approval scope" }), { target: { value: "conversation" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onRespond).toHaveBeenCalledWith({ value: "conversation" });
  });

  it("confirms a project-wide execution grant before sending it", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={{
      requestId: "bash-project", kind: "permission", method: "select", title: "Run bash?", message: "python -V",
      presentation: { titleKey: "interaction.localExecution.title", titleParams: { tool: "bash" } },
    }} onRespond={onRespond} />);
    const scope = screen.getByRole("combobox", { name: "Approval scope" });
    expect(scope).toHaveValue("conversation");
    fireEvent.change(scope, { target: { value: "project" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByText(/Future code from this tool/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm scope" }));
    expect(onRespond).toHaveBeenCalledWith({ value: "project" });
  });

  it("never shows persistent permission for a generic confirmation", () => {
    render(<InteractionPrompt interaction={{ requestId: "install", kind: "permission", method: "confirm", title: "Install scipy" }} onRespond={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "Approval scope" })).not.toBeInTheDocument();
  });

  it("shows pending feedback on the confirmation action that was actually chosen", () => {
    const onRespond = vi.fn(() => new Promise<void>(() => undefined));
    render(<InteractionPrompt interaction={{ requestId: "install-2", kind: "permission", method: "confirm", title: "Install scipy" }} onRespond={onRespond} />);

    const deny = screen.getByRole("button", { name: "Deny" });
    const allow = screen.getByRole("button", { name: "Allow once" });
    fireEvent.click(deny);

    expect(onRespond).toHaveBeenCalledWith({ confirmed: false });
    expect(deny.querySelector(".animate-spin")).toBeTruthy();
    expect(allow.querySelector(".animate-spin")).toBeNull();
  });

  it("shows a failed response and enables the approval choices for retry", async () => {
    const onRespond = vi.fn().mockRejectedValueOnce(new Error("Runtime is unavailable")).mockResolvedValue(undefined);
    render(<InteractionPrompt interaction={approval} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Runtime is unavailable");

    const retry = screen.getByRole("button", { name: "Deny" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
  });
});
