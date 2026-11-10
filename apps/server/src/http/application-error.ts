import { ApplicationError, type ApplicationErrorKind } from "../modules/application-error.js";
const statuses: Record<ApplicationErrorKind, number> = {
  invalid_input: 400,
  unsupported: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  capacity: 429,
  unavailable: 503,
  internal: 500,
};
export function applicationErrorStatus(error: Pick<ApplicationError, "kind">): number {
  return statuses[error.kind];
}
