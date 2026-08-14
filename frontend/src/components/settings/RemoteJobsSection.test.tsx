import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemoteJobsSection } from "./RemoteJobsSection";
import i18n from "../../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const job = {
  job_id: "job-12345678",
  machine_label: "gpu",
  host: "compute.example.org",
  status: "running" as const,
  remote_pid: "42",
  output_glob: "results/*.csv",
  created_at: "2026-08-14T00:00:00.000Z",
  exit_code: null,
  artifact_ids: [],
};

let submitted: Record<string, unknown> | null;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/compute/jobs/job-12345678?")) return jsonResponse({ ...job, status: "succeeded", exit_code: 0 });
  if (url.includes("/api/compute/jobs?")) return jsonResponse({ jobs: [job] });
  if (url.includes("/api/compute/run?")) {
    submitted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse({ ok: true, job: { ...job } });
  }
  return jsonResponse({ error: `unhandled ${url}` }, 404);
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  submitted = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RemoteJobsSection", () => {
  it("probes active jobs when loading the list", async () => {
    render(<RemoteJobsSection workspaceCwd="proj" machineLabels={["gpu"]} />);
    expect(await screen.findByText("succeeded")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/compute/jobs/job-12345678?"))).toBe(true);
    expect(screen.getByRole("button", { name: "Harvest outputs" })).toBeInTheDocument();
  });

  it("submits the command as one shell command", async () => {
    render(<RemoteJobsSection workspaceCwd="proj" machineLabels={["gpu"]} />);
    await screen.findByText("succeeded");
    fireEvent.change(screen.getByLabelText("shell command"), { target: { value: "python train.py --out result.csv" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(submitted?.command).toBe("python train.py --out result.csv"));
  });
});
