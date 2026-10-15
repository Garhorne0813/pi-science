/**
 * Every kernel output cap lives here and reaches the bridges as argv, never as
 * environment: a dist build copies exactly the two bridge files, and the host
 * process must not depend on the kernel inheriting its own env.
 *
 * A character means a JavaScript UTF-16 code unit in Node, a Python `len` code
 * point, and an R `nchar(type = "chars")` character, so a character cap bounds
 * UTF-8 bytes at four times the cap.
 */
export const KERNEL_TRUNCATION_MARKER = "\n… [truncated]";

/** A partial image or JSON document is unusable, so a dropped payload is named instead. */
export function kernelPayloadMarker(mime: string): string {
  return `\n… [truncated: ${mime}]`;
}

/** Both markers contain this prefix, so one predicate recognizes every notice. */
export const KERNEL_TRUNCATION_NOTICE_PREFIX = "… [truncated";

export function isKernelTruncationNotice(value: string): boolean {
  return value.includes(KERNEL_TRUNCATION_NOTICE_PREFIX);
}

export interface KernelOutputLimits {
  readonly stdoutChars: number;
  readonly stderrChars: number;
  readonly resultChars: number;
  readonly mimeChars: number;
  readonly outputsChars: number;
  readonly displayOutputs: number;
  readonly frameChars: number;
}

/**
 * The longest line the host will parse. JSON escapes a C0 control character to
 * six characters, and the error field is a second use of the stderr cap, so the
 * guard is six times the cap sum plus headroom for the JSON structure.
 */
function kernelFrameChars(stdoutChars: number, stderrChars: number, resultChars: number, mimeChars: number, outputsChars: number): number {
  return 6 * (stdoutChars + 2 * stderrChars + resultChars + mimeChars + outputsChars) + 65_536;
}

export const DEFAULT_KERNEL_OUTPUT_LIMITS: KernelOutputLimits = {
  stdoutChars: 65_536,
  stderrChars: 65_536,
  resultChars: 262_144,
  mimeChars: 1_048_576,
  outputsChars: 2_097_152,
  displayOutputs: 20,
  frameChars: kernelFrameChars(65_536, 65_536, 262_144, 1_048_576, 2_097_152),
};

/** A cap below this retains less than the truncation marker, which is a mistake rather than a cap. */
const MINIMUM_OUTPUT_CHARS = 128;

function configuredCap(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MINIMUM_OUTPUT_CHARS ? parsed : null;
}

/**
 * An unparseable, non-positive or below-floor override keeps the default; this
 * never throws. The env names are the five character caps named in
 * `docs/kernel-output-limits.md`.
 */
export function kernelOutputLimits(environment: NodeJS.ProcessEnv = process.env): KernelOutputLimits {
  const defaults = DEFAULT_KERNEL_OUTPUT_LIMITS;
  const read = (name: string, fallback: number) => configuredCap(environment[name]) ?? fallback;
  const stdoutChars = read("PI_SCIENCE_KERNEL_STDOUT_CHARS", defaults.stdoutChars);
  const stderrChars = read("PI_SCIENCE_KERNEL_STDERR_CHARS", defaults.stderrChars);
  const resultChars = read("PI_SCIENCE_KERNEL_RESULT_CHARS", defaults.resultChars);
  const mimeChars = read("PI_SCIENCE_KERNEL_MIME_CHARS", defaults.mimeChars);
  const outputsChars = read("PI_SCIENCE_KERNEL_OUTPUTS_CHARS", defaults.outputsChars);
  return { stdoutChars, stderrChars, resultChars, mimeChars, outputsChars, displayOutputs: defaults.displayOutputs, frameChars: kernelFrameChars(stdoutChars, stderrChars, resultChars, mimeChars, outputsChars) };
}

export function kernelOutputLimitArgs(limits: KernelOutputLimits): string[] {
  return ["--limits", JSON.stringify({ stdout_chars: limits.stdoutChars, stderr_chars: limits.stderrChars, result_chars: limits.resultChars, mime_chars: limits.mimeChars, outputs_chars: limits.outputsChars, display_outputs: limits.displayOutputs })];
}

/** A cap at or below the marker length can retain nothing but a piece of the marker. */
function markerWithinCap(cap: number): string {
  return cap >= KERNEL_TRUNCATION_MARKER.length ? KERNEL_TRUNCATION_MARKER : KERNEL_TRUNCATION_MARKER.slice(0, Math.max(cap, 0));
}

/**
 * A cap counts UTF-16 code units here and code points in a bridge, so a re-clamp
 * can land between a surrogate pair; an unpaired surrogate throws in
 * `encodeURIComponent` at the renderer.
 */
function trimTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function trimLeadingLowSurrogate(text: string): string {
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

/** Head + marker + tail, at most `cap` characters; a value at or under `cap` round-trips exactly. */
export function boundKernelText(value: string, cap: number): string {
  if (value.length <= cap) return value;
  const marker = markerWithinCap(cap);
  const headLength = Math.max(Math.floor((cap - marker.length) / 2), 0);
  const tailLength = Math.max(cap - marker.length - headLength, 0);
  const tail = tailLength > 0 ? trimLeadingLowSurrogate(value.slice(value.length - tailLength)) : "";
  return trimTrailingHighSurrogate(value.slice(0, headLength)) + marker + tail;
}

/** The same retention as `boundKernelText`, named so a live stream call site reads as a stream clamp. */
export function boundKernelStreamText(value: string, cap: number): string {
  return boundKernelText(value, cap);
}

/** Head + marker, at most `cap` characters; a repr or a text payload keeps only its head. */
export function boundKernelHeadText(value: string, cap: number): string {
  if (value.length <= cap) return value;
  const marker = markerWithinCap(cap);
  return trimTrailingHighSurrogate(value.slice(0, Math.max(cap - marker.length, 0))) + marker;
}

/** `null` means drop the payload and name it with `kernelPayloadMarker(mime)` in the cell's notice output. */
export function boundKernelPayload(value: string, mime: string, cap: number): string | null {
  if (value.length <= cap) return value;
  return mime.startsWith("text/") || mime === "image/svg+xml" ? boundKernelText(value, cap) : null;
}
