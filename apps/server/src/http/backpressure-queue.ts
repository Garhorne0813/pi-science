export interface QueueLimits { readonly maxBytes: number; readonly maxItems: number }
export interface QueueOverflow { readonly bytes: number; readonly items: number }

export class BoundedQueue {
  private readonly pending: string[] = [];
  private pendingBytes = 0;

  constructor(private readonly limits: QueueLimits) {}

  offer(text: string): boolean {
    const bytes = Buffer.byteLength(text);
    if (bytes > this.limits.maxBytes || this.pendingBytes + bytes > this.limits.maxBytes || this.pending.length >= this.limits.maxItems) return false;
    this.pending.push(text); this.pendingBytes += bytes;
    return true;
  }

  shift(): string | undefined {
    const text = this.pending.shift();
    if (text !== undefined) this.pendingBytes -= Buffer.byteLength(text);
    return text;
  }

  clear(): QueueOverflow {
    const discarded = { bytes: this.pendingBytes, items: this.pending.length };
    this.pending.length = 0; this.pendingBytes = 0;
    return discarded;
  }

  get bytes(): number { return this.pendingBytes; }
  get items(): number { return this.pending.length; }
}
