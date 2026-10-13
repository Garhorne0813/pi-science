import { describe, expect, it } from "vitest";
import { BoundedQueue } from "./backpressure-queue.js";

describe("BoundedQueue", () => {
  it("holds byte and item caps after every offer", () => {
    const queue = new BoundedQueue({ maxBytes: 10, maxItems: 3 });
    for (const text of ["a", "二", "333", "four", "", "x".repeat(11), "tail"]) {
      queue.offer(text); expect(queue.bytes).toBeLessThanOrEqual(10); expect(queue.items).toBeLessThanOrEqual(3);
    }
  });

  it("rejects without discarding the prefix, including oversized items", () => {
    const queue = new BoundedQueue({ maxBytes: 6, maxItems: 2 });
    expect(queue.offer("é")).toBe(true); expect(queue.offer("tail")).toBe(true);
    expect(queue.offer("x")).toBe(false); expect(queue.offer("oversized")).toBe(false);
    expect(queue.bytes).toBe(6); expect(queue.items).toBe(2);
    expect(queue.shift()).toBe("é"); expect(queue.shift()).toBe("tail"); expect(queue.shift()).toBeUndefined();
    expect(queue.bytes).toBe(0);
  });

  it("reports what clear discards and restores the caps", () => {
    const queue = new BoundedQueue({ maxBytes: 3, maxItems: 2 });
    expect([queue.offer("a"), queue.offer("bb"), queue.offer("c")]).toEqual([true, true, false]);
    expect(queue.clear()).toEqual({ bytes: 3, items: 2 });
    expect(queue.clear()).toEqual({ bytes: 0, items: 0 });
    expect(queue.offer("ccc")).toBe(true);
  });
});
