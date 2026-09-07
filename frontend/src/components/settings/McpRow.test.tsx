import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { McpConnector } from "@pi-science/contracts";
import i18n from "../../i18n";
import { McpRow } from "./McpRow";

const connector: McpConnector = {
  connector_id: "mcp-long-name",
  name: "connector-with-a-very-long-machine-readable-name-that-must-not-cross-columns",
  display_name: "Connector with a very long display name that must stay inside the name column",
  description: "description-with-one-extremely-long-unbroken-token-that-must-not-cross-into-the-status-column",
  source: "custom",
  transport: "stdio",
  endpoint_url: null,
  command: "node",
  args: ["server.js"],
  socket_path: null,
  runtime_config: { lifecycle: "lazy", expose_resources: true, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false },
  credential_ref: null,
  revision: 1,
  created_at: 1,
  updated_at: 1,
  settings: { connector_id: "mcp-long-name", enabled: true, include_tools: [], exclude_tools: [], approval_mode: "ask", revision: 1, created_at: 1, updated_at: 1 },
  config_state: "valid",
  auth_state: "not-required",
  runtime_state: "ready",
  tool_count: 1,
  error: null,
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("McpRow", () => {
  it("constrains long names and descriptions to their table columns", () => {
    render(<table><tbody><McpRow connector={connector} busy={false} selected={false} actionsEnabled onSelect={vi.fn()} onToggle={vi.fn()} onProbe={vi.fn()} /></tbody></table>);

    const nameButton = screen.getByRole("button", { name: `Show details for ${connector.display_name}` });
    const nameCell = nameButton.closest("td");
    const description = screen.getByText(connector.description);
    const descriptionCell = description.closest("td");

    expect(nameButton).toHaveClass("w-full", "max-w-full", "overflow-hidden");
    expect(nameCell).toHaveClass("overflow-hidden");
    expect(screen.getByText(connector.display_name)).toHaveClass("min-w-0", "flex-1", "truncate");
    expect(screen.getByText(connector.name)).toHaveClass("block", "truncate");
    expect(description).toHaveClass("line-clamp-2", "break-words");
    expect(descriptionCell).toHaveClass("overflow-hidden");
  });
});
