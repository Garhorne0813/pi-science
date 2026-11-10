import { Readable } from "node:stream";

const MAX_SSE_PENDING_BYTES = 512 * 1024;
const MAX_SSE_PENDING_ITEMS = 512;

export class SseBackpressureBuffer {
  private readonly pending: string[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly maxBytes = MAX_SSE_PENDING_BYTES,
    private readonly maxItems = MAX_SSE_PENDING_ITEMS,
  ) {}

  enqueue(text: string): boolean {
    const bytes = Buffer.byteLength(text);
    if (
      bytes > this.maxBytes ||
      this.pending.length >= this.maxItems ||
      this.pendingBytes + bytes > this.maxBytes
    )
      return false;
    this.pending.push(text);
    this.pendingBytes += bytes;
    return true;
  }

  drain(write: (text: string) => boolean): void {
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.pendingBytes -= Buffer.byteLength(next);
      if (!write(next)) return;
    }
  }

  get bytes(): number {
    return this.pendingBytes;
  }
  get length(): number {
    return this.pending.length;
  }
  clear(): void {
    this.pending.length = 0;
    this.pendingBytes = 0;
  }
}

/** Bounded transport shared by replayable conversation events and refresh-only
 * execution notifications. Overflow disconnects; each consumer resynchronizes
 * using its own protocol (cursor replay or REST refresh). */
export class BoundedSseStream extends Readable {
  private readonly pending: SseBackpressureBuffer;
  private blocked = false;

  constructor(
    private readonly maxBytes = MAX_SSE_PENDING_BYTES,
    maxItems = MAX_SSE_PENDING_ITEMS,
  ) {
    super({ highWaterMark: 64 * 1024 });
    this.pending = new SseBackpressureBuffer(maxBytes, maxItems);
  }

  get pendingItems(): number {
    return this.pending.length;
  }
  get bufferedBytes(): number {
    return this.readableLength + this.pending.bytes;
  }

  enqueue(text: string): boolean {
    if (this.destroyed) return false;
    if (
      this.bufferedBytes + Buffer.byteLength(text) > this.maxBytes ||
      !this.pending.enqueue(text)
    ) {
      this.destroy();
      return false;
    }
    if (!this.blocked) this.flush();
    return true;
  }

  override _read(): void {
    this.blocked = false;
    this.flush();
  }

  private flush(): void {
    this.pending.drain((text) => {
      const ready = this.push(text);
      if (!ready) this.blocked = true;
      return ready;
    });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.pending.clear();
    callback(error);
  }
}
