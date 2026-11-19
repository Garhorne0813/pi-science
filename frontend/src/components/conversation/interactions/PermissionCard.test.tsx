import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import i18n, { i18nReady } from "../../../i18n";
import { PermissionCard } from "./PermissionCard";
import type { PendingInteraction } from "../../../lib/agent-runtime";

await i18nReady;

beforeEach(async () => {
  await i18n.changeLanguage("zh-Hans");
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

function renderCard(interaction: PendingInteraction) {
  render(<PermissionCard
    interaction={interaction}
    submitting={false}
    selectedOption={null}
    selectedConfirmation={null}
    selectedAlwaysAllow={false}
    onRespond={() => undefined}
  />);
}

describe("PermissionCard presentation keys", () => {
  it("renders a managed MCP approval in the active locale", () => {
    renderCard({
      requestId: "mcp-1",
      method: "confirm",
      kind: "permission",
      title: "Allow echo: echo?",
      message: "Arguments: {}",
      mcpGrant: { connectorId: "connector", toolName: "echo" },
      presentation: {
        titleKey: "interaction.mcpPermission.title",
        titleParams: { connector: "echo", tool: "echo" },
        messageKey: "interaction.mcpPermission.arguments",
        messageParams: { preview: "{}" },
      },
    });
    expect(screen.getByText("允许 echo：echo？")).toBeInTheDocument();
    expect(screen.getByText("参数：{}")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("{{");
  });

  it("renders a network approval and its option labels in the active locale", () => {
    renderCard({
      requestId: "network-1",
      method: "select",
      kind: "permission",
      title: "Network access: api.example.org",
      message: "Download study data\n\nAllow api.example.org over a TCP tunnel for analysis across all projects?",
      options: [
        { label: "Always allow", value: "allow" },
        { label: "Deny this request", value: "deny_once" },
        { label: "Never allow", value: "deny" },
      ],
      presentation: {
        titleKey: "interaction.networkApproval.title",
        titleParams: { domain: "api.example.org" },
        messageKey: "interaction.networkApproval.messageWithReasonTls",
        messageParams: { reason: "下载研究数据", domain: "api.example.org", profile: "analysis", port: 443 },
        optionLabelKeys: {
          allow: "interaction.networkApproval.alwaysAllow",
          deny_once: "interaction.networkApproval.denyThisRequest",
          deny: "interaction.networkApproval.neverAllow",
        },
      },
    });
    expect(screen.getByText("网络访问：api.example.org")).toBeInTheDocument();
    expect(document.body.textContent).toContain("下载研究数据");
    expect(document.body.textContent).toContain("443 端口");
    expect(document.body.textContent).toContain("代理不验证 TLS 握手");
    expect(document.body.textContent).toContain("设置 → 网络");
    expect(document.body.textContent).not.toContain("加密隧道");
    expect(screen.getByRole("button", { name: "跨项目始终允许" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝本次请求" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "永不允许" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("{{");
  });

  it("renders a private network target as plain HTTP instead of an encrypted tunnel", () => {
    renderCard({
      requestId: "network-http-1",
      method: "select",
      kind: "permission",
      title: "Network access: 192.168.1.10:8080",
      message: "Download study data\n\nAllow 192.168.1.10:8080 over HTTP for analysis across all projects?",
      options: [
        { label: "Always allow", value: "allow" },
        { label: "Deny this request", value: "deny_once" },
        { label: "Never allow", value: "deny" },
      ],
      presentation: {
        titleKey: "interaction.networkApproval.title",
        titleParams: { domain: "192.168.1.10:8080" },
        messageKey: "interaction.networkApproval.messageWithReasonHttp",
        messageParams: { reason: "下载研究数据", domain: "192.168.1.10:8080", profile: "analysis", port: 8080 },
        optionLabelKeys: {
          allow: "interaction.networkApproval.alwaysAllow",
          deny_once: "interaction.networkApproval.denyThisRequest",
          deny: "interaction.networkApproval.neverAllow",
        },
      },
    });
    expect(screen.getByText("网络访问：192.168.1.10:8080")).toBeInTheDocument();
    expect(document.body.textContent).toContain("以 HTTP 访问");
    expect(document.body.textContent).toContain("端口 8080");
    expect(document.body.textContent).toContain("设置 → 网络");
    expect(document.body.textContent).not.toContain("加密隧道");
    expect(document.body.textContent).not.toContain("{{");
  });

  it("falls back to the server strings when no presentation is attached", () => {
    renderCard({
      requestId: "legacy-1",
      method: "select",
      kind: "permission",
      title: "Network access: api.example.org",
      message: "Allow api.example.org across all projects?",
      options: [
        { label: "Always allow", value: "allow" },
        { label: "Never allow", value: "deny" },
      ],
    });
    expect(screen.getByText("Network access: api.example.org")).toBeInTheDocument();
    expect(screen.getByText("Allow api.example.org across all projects?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Never allow" })).toBeInTheDocument();
  });
});
