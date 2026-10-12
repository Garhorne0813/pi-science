/** Image pixels and document text have different useful magnification ranges.
 * Include the current fit scale so crossing into manual zoom never reverses
 * direction, even for extremely large images or tiny scientific rasters. */
export function imageScaleLimits(fit: number, maximum = 4, current = fit) {
  return { min: Math.min(0.001, fit / 16, current), max: Math.max(maximum, fit * 16, current) };
}

export function clampImageScale(value: number, limits: { min: number; max: number }) {
  return Math.max(limits.min, Math.min(limits.max, value));
}
