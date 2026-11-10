/** Application failures carry meaning; transports choose status codes. */
export const applicationErrorKinds = [
  "invalid_input",
  "unsupported",
  "forbidden",
  "not_found",
  "conflict",
  "capacity",
  "unavailable",
  "internal",
] as const;
export type ApplicationErrorKind = (typeof applicationErrorKinds)[number];
export class ApplicationError extends Error {
  constructor(
    readonly kind: ApplicationErrorKind,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}
export function isApplicationErrorKind(value: unknown): value is ApplicationErrorKind {
  return applicationErrorKinds.some((kind) => kind === value);
}
