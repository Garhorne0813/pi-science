import type { Writable } from "node:stream";
import { BoundedQueue } from "./backpressure-queue.js";

export interface KernelStreamLimits {
  readonly liveBytes: number;
  readonly liveFrames: number;
  readonly terminalFrameBytes: number;
  readonly blockedDrainTimeoutMs: number;
}

export interface KernelStreamTransport {
  live_bytes_limit: number;
  live_frames_limit: number;
  terminal_frame_limit_bytes: number;
  frames_sent: number;
  frames_dropped: number;
  bytes_dropped: number;
  pending_bytes_high_water: number;
  terminal_frame_bytes: number;
  terminal_truncated: boolean;
  client_disconnected: boolean;
  blocked_ms: number;
  truncated: boolean;
  terminal_written: boolean;
  blocked_drain_timed_out: boolean;
}

export interface PreparedTerminal {
  readonly line: string;
  readonly noticeLine: string | null;
  readonly transport: KernelStreamTransport;
}

type Frame = { type: string } & Record<string, unknown>;
type RecordCallback = (record: { event: string; level: "info" | "warn"; fields: Record<string, unknown> }) => void;
const DEFAULT_LIMITS: KernelStreamLimits = { liveBytes: 512 * 1024, liveFrames: 512, terminalFrameBytes: 1024 * 1024, blockedDrainTimeoutMs: 30_000 };
const WRITE_BYTES = 16 * 1024;
const STREAM_TEXT_UNITS = 2048;
const TRUNCATION_MARKER = "\n… [truncated] …\n";

function sliceText(text: string, start: number, maxUnits: number, maxBytes: number): string {
  let end = start; let bytes = 0;
  while (end < text.length && end - start < maxUnits) {
    const code = text.charCodeAt(end); const next = text.charCodeAt(end + 1);
    const pair = code >= 0xD800 && code <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF;
    const units = pair ? 2 : 1; const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (end - start + units > maxUnits || bytes + size > maxBytes) break;
    end += units; bytes += size;
  }
  return text.slice(start, end);
}

export class KernelStreamWriter {
  private sink: Writable | null;
  private readonly options: { executionId: string; statusCode: number; headers: Record<string, string>; onRecord?: RecordCallback };
  private readonly queue: BoundedQueue;
  private readonly limits: KernelStreamLimits;
  private readonly counters: KernelStreamTransport;
  private phase: "live" | "prepared" | "finishing" | "finished" = "live";
  private detached = false;
  private headersWritten = false;
  private liveTruncated = false;
  private dropRecorded = false;
  private prepared: PreparedTerminal | null = null;
  private active: { line: string; offset: number; terminal: boolean } | null = null;
  private terminalLines: string[] = [];
  private blockedAt: number | null = null;
  private blockedTimer: NodeJS.Timeout | null = null;
  private completion: Promise<void> | null = null;
  private resolveCompletion: (() => void) | null = null;

  constructor(options: { sink: Writable; executionId: string; statusCode: number; headers: Record<string, string>; limits?: KernelStreamLimits; onRecord?: RecordCallback }) {
    const { sink, limits, ...metadata } = options;
    this.options = metadata; this.sink = sink; this.limits = limits ?? DEFAULT_LIMITS;
    this.queue = new BoundedQueue({ maxBytes: this.limits.liveBytes, maxItems: this.limits.liveFrames });
    this.counters = { live_bytes_limit: this.limits.liveBytes, live_frames_limit: this.limits.liveFrames, terminal_frame_limit_bytes: this.limits.terminalFrameBytes, frames_sent: 0, frames_dropped: 0, bytes_dropped: 0, pending_bytes_high_water: 0, terminal_frame_bytes: 0, terminal_truncated: false, client_disconnected: false, blocked_ms: 0, truncated: false, terminal_written: false, blocked_drain_timed_out: false };
    this.sink.once("close", this.onClose); this.sink.once("error", this.onClose);
    if (this.sink.destroyed) this.onClose();
  }

  send(frame: Frame): void {
    if (this.phase !== "live") return;
    if (!this.headersWritten && !this.detached) this.pump();
    if (frame.type === "stream" && typeof frame.text === "string" && frame.text.length > STREAM_TEXT_UNITS) {
      for (let offset = 0; offset < frame.text.length;) {
        const text = sliceText(frame.text, offset, STREAM_TEXT_UNITS, WRITE_BYTES);
        this.sendLine(JSON.stringify({ ...frame, text }) + "\n"); offset += text.length;
      }
    } else this.sendLine(JSON.stringify(frame) + "\n");
  }

  private sendLine(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.detached || this.liveTruncated || bytes > this.limits.liveBytes) { this.liveTruncated = true; this.drop(bytes, 1); return; }
    if (this.blockedAt !== null || this.active) {
      if (!this.queue.offer(line)) { this.liveTruncated = true; this.drop(bytes, 1); }
      this.counters.pending_bytes_high_water = Math.max(this.counters.pending_bytes_high_water, this.queue.bytes);
      return;
    }
    this.active = { line, offset: 0, terminal: false };
    this.pump();
  }

  prepareTerminal(frame: Frame): PreparedTerminal {
    if (this.prepared) return this.prepared;
    this.phase = "prepared";
    const blockedMs = this.telemetry().blocked_ms;
    let payload: Frame;
    try {
      const parsed = JSON.parse(JSON.stringify(frame)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Invalid kernel result");
      payload = parsed as Frame;
    }
    catch { payload = { type: "result", execution_id: this.options.executionId, ok: false, error: "Kernel result could not be serialized" }; this.counters.terminal_truncated = true; }
    delete payload.stream_transport;
    const originalBytes = Buffer.byteLength(JSON.stringify(payload) + "\n");
    const build = () => {
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload) + "\n");
      this.counters.bytes_dropped += Math.max(0, originalBytes - payloadBytes) - cutBytes;
      cutBytes = Math.max(0, originalBytes - payloadBytes);
      let line = "";
      for (;;) {
        line = JSON.stringify({ ...payload, stream_transport: { ...this.telemetry(), blocked_ms: blockedMs } }) + "\n";
        const bytes = Buffer.byteLength(line);
        if (bytes === this.counters.terminal_frame_bytes) return line;
        this.counters.terminal_frame_bytes = bytes;
      }
    };
    let cutBytes = 0;
    let line = build();
    const textFields = Object.keys(payload).filter((key) => key !== "type" && key !== "execution_id" && typeof payload[key] === "string");
    while (Buffer.byteLength(line) > this.limits.terminalFrameBytes) {
      const key = textFields.filter((field) => (payload[field] as string).length > TRUNCATION_MARKER.length + 2).sort((a, b) => (payload[b] as string).length - (payload[a] as string).length)[0];
      if (!key) break;
      const text = payload[key] as string;
      const keep = Math.max(1, Math.floor((text.length - TRUNCATION_MARKER.length) / 4));
      payload[key] = text.slice(0, keep).replace(/[\uD800-\uDBFF]$/, "") + TRUNCATION_MARKER + text.slice(-keep).replace(/^[\uDC00-\uDFFF]/, "");
      this.counters.terminal_truncated = true; line = build();
    }
    if (Array.isArray(payload.outputs)) {
      const outputs = [...payload.outputs]; payload.outputs = outputs;
      while (Buffer.byteLength(line) > this.limits.terminalFrameBytes && outputs.length > 0) { outputs.pop(); this.counters.terminal_truncated = true; line = build(); }
    }
    if (payload.mime && typeof payload.mime === "object" && !Array.isArray(payload.mime)) {
      const mime: Record<string, unknown> = { ...payload.mime }; payload.mime = mime;
      for (const key of Object.keys(mime).reverse()) {
        if (Buffer.byteLength(line) <= this.limits.terminalFrameBytes) break;
        delete mime[key]; this.counters.terminal_truncated = true; line = build();
      }
    }
    if (Buffer.byteLength(line) > this.limits.terminalFrameBytes) {
      payload = { type: "result", execution_id: this.options.executionId, ...Object.fromEntries(["ok", "error", "stdout", "stderr", "result"].filter((key) => typeof payload[key] === "string" || typeof payload[key] === "boolean" || payload[key] === null).map((key) => [key, payload[key]])) };
      this.counters.terminal_truncated = true; line = build();
    }
    if (cutBytes > 0) this.recordDrop();
    const transport = Object.freeze({ ...this.telemetry(), blocked_ms: blockedMs });
    const noticeLine = transport.bytes_dropped > 0 ? JSON.stringify({ type: "stream_truncated", execution_id: this.options.executionId, bytes_dropped: transport.bytes_dropped, frames_dropped: transport.frames_dropped, live_bytes_limit: transport.live_bytes_limit, live_frames_limit: transport.live_frames_limit }) + "\n" : null;
    this.prepared = Object.freeze({ line, noticeLine, transport });
    return this.prepared;
  }

  finish(prepared: PreparedTerminal): Promise<void> {
    if (this.completion) return this.completion;
    this.phase = "finishing";
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
    if (this.detached) this.complete();
    else {
      this.terminalLines = prepared.noticeLine ? [prepared.noticeLine, prepared.line] : [prepared.line];
      this.pump();
    }
    return this.completion;
  }

  telemetry(): KernelStreamTransport {
    return Object.freeze({ ...this.counters, truncated: this.counters.bytes_dropped > 0 || this.counters.terminal_truncated, blocked_ms: this.counters.blocked_ms + (this.blockedAt === null ? 0 : Date.now() - this.blockedAt) });
  }

  private pump(): void {
    if (this.detached || this.blockedAt !== null) return;
    const sink = this.sink!;
    try {
      if (!this.headersWritten) {
        const response = sink as Writable & { writeHead?: (statusCode: number, headers: Record<string, string>) => void };
        response.writeHead?.(this.options.statusCode, this.options.headers); this.headersWritten = true;
      }
      while (!this.detached && this.blockedAt === null) {
        if (sink.destroyed || sink.writableEnded) { this.onClose(); return; }
        if (!this.active) {
          const line = this.queue.shift();
          if (line !== undefined) this.active = { line, offset: 0, terminal: false };
          else if (this.phase === "finishing" && this.terminalLines.length > 0) {
            const terminal = this.terminalLines.length === 1;
            this.active = { line: this.terminalLines.shift()!, offset: 0, terminal };
          } else {
            if (this.phase === "finishing") { sink.once("finish", this.onEnd); sink.end(); }
            return;
          }
        }
        const active = this.active;
        const chunk = sliceText(active.line, active.offset, WRITE_BYTES, WRITE_BYTES);
        const accepted = sink.write(chunk);
        if (this.detached) return;
        active.offset += chunk.length;
        if (active.offset === active.line.length) { this.counters.frames_sent += 1; if (active.terminal) this.counters.terminal_written = true; this.active = null; }
        if (!accepted) {
          this.blockedAt = Date.now(); sink.once("drain", this.onDrain);
          this.blockedTimer = setTimeout(() => {
            this.counters.blocked_drain_timed_out = true;
            this.detach(); sink.destroy();
          }, this.limits.blockedDrainTimeoutMs);
          this.blockedTimer.unref();
        }
      }
    } catch { this.onClose(); }
  }

  private readonly onDrain = () => { this.unblock(); this.pump(); };
  private readonly onEnd = () => { this.detach(); };
  private readonly onClose = () => {
    if (this.detached) return;
    this.counters.client_disconnected = true;
    this.record("kernel_stream_client_disconnected", "info"); this.detach();
  };

  private unblock(): void {
    if (this.blockedAt !== null) this.counters.blocked_ms += Date.now() - this.blockedAt;
    this.blockedAt = null;
    if (this.blockedTimer) clearTimeout(this.blockedTimer);
    this.blockedTimer = null;
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true; this.unblock();
    this.sink?.removeListener("drain", this.onDrain); this.sink?.removeListener("close", this.onClose); this.sink?.removeListener("error", this.onClose); this.sink?.removeListener("finish", this.onEnd);
    this.sink = null;
    const discarded = this.queue.clear(); this.drop(discarded.bytes, discarded.items);
    if (this.active) { if (!this.active.terminal) this.drop(Buffer.byteLength(this.active.line.slice(this.active.offset)), 1); this.active = null; }
    this.terminalLines = [];
    if (this.phase === "finishing") this.complete();
  }

  private complete(): void {
    this.phase = "finished";
    this.record("kernel_stream_finished", this.counters.bytes_dropped > 0 || !this.counters.terminal_written ? "warn" : "info");
    this.resolveCompletion?.(); this.resolveCompletion = null;
  }

  private drop(bytes: number, items: number): void {
    this.counters.bytes_dropped += bytes; this.counters.frames_dropped += items;
    if (bytes > 0 || items > 0) this.recordDrop();
  }

  private recordDrop(): void {
    if (this.dropRecorded) return;
    this.dropRecorded = true; this.record("kernel_stream_backpressure_drop", "warn");
  }

  private record(event: string, level: "info" | "warn"): void {
    try { this.options.onRecord?.({ event, level, fields: { ...this.telemetry(), execution_id: this.options.executionId } }); } catch { /* Logging must not strand a hijacked response. */ }
  }
}
