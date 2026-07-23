import { describe, expect, it } from "vitest";
import { SseBackpressureBuffer } from "./sse-routes.js";

describe("SSE backpressure buffer", () => {
  it("stays bounded by item count and byte size", () => {
    const buffer = new SseBackpressureBuffer(8, 2);
    expect(buffer.enqueue("1234")).toBe(true);
    expect(buffer.enqueue("5678")).toBe(true);
    expect(buffer.enqueue("x")).toBe(false);
    expect(buffer.length).toBe(2);
  });

  it("consumes the accepted item when the stream signals backpressure", () => {
    const buffer = new SseBackpressureBuffer(100, 10);
    buffer.enqueue("first");
    buffer.enqueue("second");
    const firstDrain: string[] = [];
    buffer.drain((text) => { firstDrain.push(text); return false; });
    expect(firstDrain).toEqual(["first"]);
    expect(buffer.length).toBe(1);
    const secondDrain: string[] = [];
    buffer.drain((text) => { secondDrain.push(text); return true; });
    expect(secondDrain).toEqual(["second"]);
    expect(buffer.length).toBe(0);
  });
});
