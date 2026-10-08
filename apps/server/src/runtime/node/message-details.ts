export const MAX_TOOL_DETAILS_BYTES = 100_000;

/** Keep the existing history projection limit shared across both formats. */
export function boundedToolDetails(value: unknown): unknown {
  if (value === undefined) return undefined;
  try { return JSON.stringify(value).length <= MAX_TOOL_DETAILS_BYTES ? value : undefined; }
  catch { return undefined; }
}
