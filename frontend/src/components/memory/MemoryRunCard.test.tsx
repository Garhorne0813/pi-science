import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import i18n from "../../i18n";
import { MemoryRunCard, type MemoryRun } from "./MemoryRunCard";
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
const usage = {
  measuredTokens: 120,
  measuredCostUsd: 0.12,
  estimatedTokens: 300,
  estimatedCostUsd: 0.3,
  reservedTokens: 0,
  reservedCostUsd: 0,
};
function mount(overrides: Partial<MemoryRun> = {}) {
  return render(
    <MemoryRunCard
      run={{
        id: "retry",
        kind: "dream",
        status: "succeeded",
        reviewMode: "strict",
        createdAt: 1,
        usage,
        ...overrides,
      }}
      busy={false}
      stop={vi.fn()}
      retry={vi.fn()}
    />,
  );
}
it("sums measured and estimated attempts in the collapsed summary and preserves the breakdown", () => {
  mount();
  const summary = document.querySelector("summary")!;
  expect(
    within(summary).getByText(
      "Budget total (includes estimates / reservations): $0.42",
    ),
  ).toBeVisible();
  expect(within(summary).getByText("420 tokens")).toBeVisible();
  fireEvent.click(summary);
  expect(screen.getByText("120 tokens · $0.12")).toBeVisible();
  expect(screen.getByText("300 tokens · $0.30")).toBeVisible();
});
it("includes and separately identifies in-flight reservations", () => {
  mount({
    status: "running",
    usage: { ...usage, reservedTokens: 500, reservedCostUsd: 0.5 },
  });
  const summary = document.querySelector("summary")!;
  expect(
    within(summary).getByText(
      "Budget total (includes estimates / reservations): $0.92",
    ),
  ).toBeVisible();
  expect(within(summary).getByText("920 tokens")).toBeVisible();
  expect(
    within(summary).getByText("Includes reservation: $0.50 · 500 tokens"),
  ).toBeVisible();
});
it("keeps measured-only and legacy usage labeled as measured", () => {
  mount({ usage: undefined, tokens: 120, costUsd: 0.12 });
  expect(screen.getByText("Measured usage: $0.12")).toBeVisible();
  expect(screen.getByText("120 tokens")).toBeVisible();
});
