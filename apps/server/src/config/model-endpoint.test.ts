import { describe, expect, it } from "vitest";
import { endpointId } from "./model-endpoint.js";

describe("model endpoint identity", () => {
  it("is stable and changes with endpoint coordinates", () => {
    expect(endpointId("Lab", "https://example.test/v1")).toBe(endpointId("Lab", "https://example.test/v1"));
    expect(endpointId("Lab", "https://example.test/v1")).not.toBe(endpointId("Lab", "https://other.test/v1"));
  });
});
