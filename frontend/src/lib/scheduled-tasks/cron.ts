/** 5-field cron (分 时 日 月 周) pure helpers for the scheduled-tasks UI.
 *
 *  Timezone note: full IANA timezone math is a phase-2 concern. The preview
 *  approximates the browser's local wall clock using the Date UTC getters, so
 *  results are deterministic and the UI shows a note that exact IANA timezone
 *  support is coming later. `nextCronRuns` accepts a timezone for API
 *  compatibility but does not use it yet. */

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6],  // day of week (0 = Sunday)
];

/** Validates a 5-field cron expression: star, plain numbers, step (star-slash-n), lists and ranges. */
export function isValidCron(cron: string): boolean {
  if (typeof cron !== "string") return false;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => parseField(field, FIELD_RANGES[index][0], FIELD_RANGES[index][1]));
}

function parseField(field: string, min: number, max: number): boolean {
  if (field === "*") return true;
  if (field.includes(",")) return field.split(",").length > 1 && field.split(",").every((part) => parseField(part, min, max));
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return Number.isInteger(step) && step >= 1 && step <= max;
  }
  if (field.includes("-")) {
    const parts = field.split("-");
    if (parts.length !== 2) return false;
    const [start, end] = parts.map(Number);
    return Number.isInteger(start) && Number.isInteger(end) && start >= min && end <= max && start <= end;
  }
  const value = Number(field);
  return /^\d+$/.test(field) && value >= min && value <= max;
}

/** Scan window: 5 weeks of minutes, long enough to surface the next 5
 *  triggers for weekly schedules (the longest common preset). A monthly cron
 *  may still return fewer than `count` runs — the preview shows what exists. */
const SCAN_WINDOW_MINUTES = 7 * 5 * 24 * 60;

/** Returns the next `count` trigger instants for a valid cron, scanning minute
 *  by minute (at most 5 weeks forward) starting at `from` (default: now).
 *  The timezone parameter is accepted for API compatibility; the scan runs on
 *  the UTC wall clock as a browser-local approximation (see file header). */
export function nextCronRuns(cron: string, _timezone: string, count: number, from: Date = new Date()): Date[] {
  if (!isValidCron(cron) || count <= 0) return [];
  const fields = cron.trim().split(/\s+/);
  const results: Date[] = [];
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  for (let step = 0; step < SCAN_WINDOW_MINUTES && results.length < count; step += 1) {
    if (matches(fields, cursor)) results.push(new Date(cursor));
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return results;
}

function matches(fields: string[], date: Date): boolean {
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  // Day-of-month and day-of-week are ANDed (a stricter preview than Vixie's OR).
  return fields.every((field, index) => fieldMatches(field, values[index], FIELD_RANGES[index][0], FIELD_RANGES[index][1]));
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;
  if (field.includes(",")) return field.split(",").some((part) => fieldMatches(part, value, min, max));
  if (field.startsWith("*/")) return value % Number(field.slice(2)) === 0;
  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number);
    return value >= start && value <= end;
  }
  const n = Number(field);
  return Number.isInteger(n) && n >= min && n <= max && n === value;
}

const DOW_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

const pad = (value: string) => value.padStart(2, "0");

/** Human-readable Chinese description for common cron combinations; unknown
 *  combinations return the raw expression unchanged. */
export function humanReadableCron(cron: string): string {
  if (typeof cron !== "string") return String(cron);
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron.trim();
  const [minute, hour, dom, month, dow] = fields;
  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "每分钟";
  if (minute === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "每小时";
  if (minute === "0" && dom === "*" && month === "*" && dow === "*") return `每天 ${pad(hour)}:00`;
  if (minute === "0" && dom === "*" && month === "*" && dow === "1-5") return `每周一至周五 ${pad(hour)}:00`;
  if (minute === "0" && dom === "*" && month === "*" && /^\d$/.test(dow)) return `每周${DOW_NAMES[Number(dow)]} ${pad(hour)}:00`;
  if (minute === "0" && month === "*" && dow === "*" && /^\d+$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) return `每月 ${dom} 日 ${pad(hour)}:00`;
  return cron.trim();
}
