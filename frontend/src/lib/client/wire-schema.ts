export interface WireSchema<T> {
  parse(input: unknown): T;
}

/** Convert an untrusted JSON payload into a typed wire value at the transport seam. */
export function parseWirePayload<T>(input: unknown, schema: WireSchema<T>, fallback: string): T {
  try {
    return schema.parse(input);
  } catch {
    throw new Error(`${fallback}: invalid response payload`);
  }
}
