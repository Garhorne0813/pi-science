import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { i18nReady } from "../../i18n";
import { StoredOutputs } from "./NotebookOutputs";

const PAYLOAD_MARKER = "\n… [truncated: image/png]";

describe("StoredOutputs truncation notices", () => {
  // The kernel names a dropped payload in its own text-only output, because a
  // marker beside a surviving payload is suppressed below.
  it("renders a text-only notice next to a rich output and keeps the rich payload", async () => {
    await i18nReady;
    render(<StoredOutputs outputs={[
      { output_type: "display_data", data: { "text/html": "<b>figure</b>" } },
      { output_type: "display_data", data: { "text/plain": PAYLOAD_MARKER } },
    ]} />);

    expect(screen.getByText(/… \[truncated: image\/png\]/)).toBeVisible();
    expect(document.querySelector("iframe")).not.toBeNull();
  });

  it("suppresses text when a rich representation survives, which is why the notice stands alone", async () => {
    await i18nReady;
    const { container } = render(<StoredOutputs outputs={[
      { output_type: "display_data", data: { "image/png": "aGk=", "text/plain": PAYLOAD_MARKER } },
    ]} />);

    expect(screen.queryByText(/… \[truncated: image\/png\]/)).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("data:image/png");
  });

  it("shows an in-place marker on a payload that was truncated rather than dropped", async () => {
    await i18nReady;
    render(<StoredOutputs outputs={[
      { output_type: "stream", name: "stdout", text: `head\n… [truncated]tail` },
    ]} />);

    expect(screen.getByText(/… \[truncated\]/)).toBeVisible();
  });
});
