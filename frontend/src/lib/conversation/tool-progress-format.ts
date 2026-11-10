/** Byte counts arrive from adapters as the producer's own number with
 *  `unit: "bytes"`; the activity row is the only place that turns one into a
 *  human unit, so the contract keeps reporting bytes and every renderer agrees.
 *  Powers of 1000, matching `frontend/src/i18n/format.ts`: one decimal below
 *  ten, none from ten up, and a value that rounds to 1000 moves up a unit. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(value: number, locale?: string): string {
  const bytes = Number.isFinite(value) && value > 0 ? value : 0;
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  let exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log10(bytes) / 3));
  let scaled = bytes / 1000 ** exponent;
  let digits = scaled < 10 ? 1 : 0;
  scaled = Number.parseFloat(scaled.toFixed(digits));
  if (scaled >= 1000 && exponent < BYTE_UNITS.length - 1) {
    exponent += 1;
    scaled = bytes / 1000 ** exponent;
    digits = scaled < 10 ? 1 : 0;
    scaled = Number.parseFloat(scaled.toFixed(digits));
  }
  const text = new Intl.NumberFormat(locale, {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(scaled);
  return `${text} ${BYTE_UNITS[exponent]}`;
}
