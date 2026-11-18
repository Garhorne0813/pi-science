import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionRecord } from "@pi-science/contracts";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon";

const STATUSES: ExecutionRecord["status"][] = ["succeeded", "running", "pending", "timed_out", "cancelled", "interrupted", "lost", "failed"];

describe("ExecutionStatusIcon", () => {
  afterEach(cleanup);

  it("is decorative and never leaks the raw status enum to assistive tech", () => {
    for (const status of STATUSES) {
      const { container, unmount } = render(<ExecutionStatusIcon status={status} />);
      const svg = container.querySelector("svg");
      expect(svg, status).not.toBeNull();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).not.toHaveAttribute("aria-label");
      expect(container.textContent).toBe("");
      unmount();
    }
  });
});
