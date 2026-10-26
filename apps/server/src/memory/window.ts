import type { MemorySettings } from "./schema.js";
type WindowConfig = MemorySettings["dream"]["allowedWindow"];
function local(ms: number, timeZone: string) {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) => p.find((x) => x.type === type)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}
function dateOffset(date: string, days: number) {
  return new Date(Date.parse(date + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
// Enumerating UTC minutes also handles non-hour offsets, skipped local minutes and repeated DST boundaries.
function boundary(
  date: string,
  time: string,
  zone: string,
  end: boolean,
): number {
  const nominal = Date.parse(date + "T" + time + ":00Z");
  const matches: number[] = [];
  let after: number | undefined;
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const target = date + " " + time;
  for (
    let t = nominal - 16 * 3600000;
    t <= nominal + 16 * 3600000;
    t += 60000
  ) {
    const value = formatter.format(t).replace(",", "");
    if (value === target) matches.push(t);
    else if (value > target && (after === undefined || t < after)) after = t;
  }
  if (matches.length) return end ? matches.at(-1)! : matches[0]!;
  if (after !== undefined) return after;
  throw new Error("Cannot resolve local window boundary");
}
const cache = new Map<string, { start: number; end: number }>();
export function resolveWindow(
  config: WindowConfig,
  now: number,
): {
  allowed: boolean;
  key: string;
  start: number;
  end: number;
  windowStartLocalDate: string;
  timeZone: string;
} {
  const current = local(now, config.timeZone),
    cross = config.start > config.end;
  const date =
    cross && current.time < config.end
      ? dateOffset(current.date, -1)
      : current.date;
  if (!config.enabled)
    return {
      allowed: true,
      key: date + "@" + config.timeZone,
      start: 0,
      end: Number.MAX_SAFE_INTEGER,
      windowStartLocalDate: date,
      timeZone: config.timeZone,
    };
  const key = [date, config.timeZone, config.start, config.end].join("@");
  let interval = cache.get(key);
  if (!interval) {
    interval = {
      start: boundary(date, config.start, config.timeZone, false),
      end: boundary(
        cross ? dateOffset(date, 1) : date,
        config.end,
        config.timeZone,
        true,
      ),
    };
    if (cache.size > 256) cache.clear();
    cache.set(key, interval);
  }
  return {
    ...interval,
    allowed: now >= interval.start && now < interval.end,
    key,
    windowStartLocalDate: date,
    timeZone: config.timeZone,
  };
}
