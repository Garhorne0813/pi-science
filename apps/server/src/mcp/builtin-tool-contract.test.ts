import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { builtinMcpConnectors } from "./builtin-connectors.js";

describe("builtin MCP tool contracts", () => {
  it("publishes every registered tool with a nonempty input schema", async () => {
    const connectors = builtinMcpConnectors();
    const failures: string[] = [];
    let next = 0;
    let count = 0;

    async function inspect() {
      while (next < connectors.length) {
        const connector = connectors[next++]!;
        const definition = connector.definition;
        const transport = new StdioClientTransport({ command: definition.command!, args: definition.args });
        const client = new Client({ name: "pi-science-schema-test", version: "1" });
        try {
          await client.connect(transport);
          const { tools } = await client.listTools();
          count += tools.length;
          const expected = connector.tools.map((tool) => tool.name).sort();
          const actual = tools.map((tool) => tool.name).sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${definition.name}: tool list differs from builtin catalog`);
          for (const tool of tools) {
            const properties = tool.inputSchema?.properties ?? {};
            if (!Object.keys(properties).length) failures.push(`${definition.name}/${tool.name}: empty input schema`);
            if (!tool.description?.trim()) failures.push(`${definition.name}/${tool.name}: missing description`);
            for (const required of tool.inputSchema?.required ?? []) {
              if (!(required in properties)) failures.push(`${definition.name}/${tool.name}: required field ${required} is absent`);
            }
          }
        } catch (error) {
          failures.push(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await client.close().catch(() => undefined);
        }
      }
    }

    await Promise.all(Array.from({ length: 4 }, () => inspect()));
    expect(failures).toEqual([]);
    expect(count).toBe(connectors.reduce((total, connector) => total + connector.tools.length, 0));
  }, 30_000);
});
