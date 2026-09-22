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
    expect(screen.getByRole("region", { name: "Approval required" })).toBeInTheDocument();
    expect(screen.getByText("Project environment")).toBeInTheDocument();
    expect(screen.getByText("Creates a new revision")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onRespond).toHaveBeenCalledWith({ confirmed: true });
  });

  it("does not let question text override an explicit non-permission kind", () => {
    const onRespond = vi.fn();
    render(<InteractionPrompt interaction={{
      requestId: "question-1",
      kind: "question",
      method: "input",
      title: "Why was permission denied?",
    }} onRespond={onRespond} />);
    expect(screen.queryByRole("region", { name: "Approval required" })).not.toBeInTheDocument();
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
