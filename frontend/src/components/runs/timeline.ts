import type { ExecutionRecord } from "@pi-science/contracts";

/** Missing/invalid starts and terminal ends are shown separately, never invented. */
export function executionTimeline(runs: ExecutionRecord[], now = Date.now()) {
  const rows = runs.map((run) => {
    const start = Date.parse(run.started_at ?? "");
    const active = run.status === "running" || run.status === "pending";
    const end = run.ended_at ? Date.parse(run.ended_at) : active ? Math.max(start, now) : NaN;
    return { run, start, end, active, known: Number.isFinite(start) && Number.isFinite(end) && end >= start };
  });
  const known = rows.filter((row) => row.known);
  const start = known.length ? Math.min(...known.map((row) => row.start)) : now;
  const end = known.length ? Math.max(...known.map((row) => row.end)) : now;
  const span = Math.max(1, end - start);
  return { start, end, rows: rows.sort((a, b) => (a.known && b.known ? a.start - b.start : Number(b.known) - Number(a.known))).map((row) => ({
    ...row, left: row.known ? 100 * (row.start - start) / span : 0,
    width: row.known ? 100 * (row.end - row.start) / span : 0,
  })) };
}

export function timelineTicks(start: number, end: number, zoom = 1) {
  const span = Math.max(1, end - start);
  const target = span / (5 * zoom);
  const steps = [1, 5, 10, 50, 100, 500, 1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];
  let step = steps.find((value) => value >= target) ?? Math.ceil(target / 86_400_000) * 86_400_000;
  // Large gaps between nice intervals must not leave only two labelled ticks.
  const first = Math.ceil(start / step) * step;
  if (step >= 10 && end > start && (end - first) / step < 2) step /= 2;
  const ticks = [];
  for (let time = Math.ceil(start / step) * step; time <= end && ticks.length < 200; time += step) {
    ticks.push({ time, left: 100 * (time - start) / span, major: true });
    if (time + step / 2 <= end) ticks.push({ time: time + step / 2, left: 100 * (time + step / 2 - start) / span, major: false });
  }
  return ticks;
}
