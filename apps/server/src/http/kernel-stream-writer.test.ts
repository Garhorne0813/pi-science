import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelStreamWriter, type KernelStreamLimits } from "./kernel-stream-writer.js";

const limits: KernelStreamLimits = { liveBytes: 200, liveFrames: 2, terminalFrameBytes: 2048, blockedDrainTimeoutMs: 1000 };
const frame = (text: string) => ({ type: "stream", stream: "stdout", text });
const line = (text: string) => JSON.stringify(frame(text)) + "\n";
const sinks: TestSink[] = [];
afterEach(() => { for (const sink of sinks.splice(0)) sink.destroy(); vi.useRealTimers(); });

class TestSink extends Writable {
  readonly chunks: Buffer[] = [];
  readonly headers: unknown[] = [];
  private releaseWrite: (() => void) | null = null;
  stalled: boolean;
  constructor(stalled = false) { super({ highWaterMark: stalled ? 1 : 64 * 1024 }); this.stalled = stalled; sinks.push(this); }
  writeHead(status: number, headers: Record<string, string>): void { this.headers.push({ status, headers }); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    if (this.stalled) this.releaseWrite = callback; else callback();
  }
  resumeWrites(): void { this.stalled = false; const callback = this.releaseWrite; this.releaseWrite = null; callback?.(); }
  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
  frames(): Array<Record<string, unknown>> { return this.text().trim().split("\n").filter(Boolean).map((text) => JSON.parse(text) as Record<string, unknown>); }
}

function writer(sink: TestSink, overrides: Partial<KernelStreamLimits> = {}, onRecord = vi.fn()) {
  return { writer: new KernelStreamWriter({ sink, executionId: "exec_test", statusCode: 200, headers: { "content-type": "application/x-ndjson" }, limits: { ...limits, ...overrides }, onRecord }), onRecord };
}

describe("KernelStreamWriter", () => {
  it("writes straight through and owns lazy headers", async () => {
    const sink = new TestSink(); const { writer: stream, onRecord } = writer(sink);
    expect(sink.headers).toEqual([]);
    stream.send(frame("first")); stream.send(frame("second"));
    expect(sink.text()).toBe(line("first") + line("second")); expect(sink.headers).toHaveLength(1);
    const prepared = stream.prepareTerminal({ type: "result", ok: true });
    expect(Object.isFrozen(prepared.transport)).toBe(true); expect(JSON.parse(prepared.line).stream_transport).toEqual(prepared.transport);
    await stream.finish(prepared);
    expect(sink.frames().map((entry) => entry.type)).toEqual(["stream", "stream", "result"]);
    expect(stream.telemetry()).toMatchObject({ frames_sent: 3, bytes_dropped: 0, terminal_written: true, client_disconnected: false });
    expect(onRecord.mock.calls.map(([record]) => record.event)).toEqual(["kernel_stream_finished"]);
    for (const event of ["drain", "close", "error", "finish"]) expect(sink.listenerCount(event)).toBe(0);
  });

  it("keeps the bounded prefix, drops all later frames, and reports one notice after drain", async () => {
    const sink = new TestSink(true); const { writer: stream, onRecord } = writer(sink);
    for (const text of ["a", "b", "c", "d", "e"]) stream.send(frame(text));
    expect(sink.text()).toBe(line("a")); expect(sink.listenerCount("drain")).toBe(1);
    const snapshot = stream.telemetry();
    expect(snapshot).toMatchObject({ frames_sent: 1, frames_dropped: 2, bytes_dropped: Buffer.byteLength(line("d") + line("e")), pending_bytes_high_water: Buffer.byteLength(line("b") + line("c")) });
    expect(snapshot.pending_bytes_high_water).toBeLessThanOrEqual(limits.liveBytes);
    expect(onRecord.mock.calls.filter(([record]) => record.event === "kernel_stream_backpressure_drop")).toHaveLength(1);
    sink.resumeWrites();
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.send(frame("f"));
    const prepared = stream.prepareTerminal({ type: "result", ok: true });
    await stream.finish(prepared); await stream.finish(prepared);
    expect(sink.frames().map((entry) => entry.type === "stream" ? entry.text : entry.type)).toEqual(["a", "b", "c", "stream_truncated", "result"]);
    expect(sink.frames()[3]).toMatchObject({ bytes_dropped: Buffer.byteLength(line("d") + line("e") + line("f")), frames_dropped: 3 });
    expect(sink.frames().at(-1)?.stream_transport).toEqual(prepared.transport);
    expect(onRecord.mock.calls.filter(([record]) => record.event === "kernel_stream_finished")).toHaveLength(1);
  });

  it("enforces the byte cap even before the item cap", async () => {
    const sink = new TestSink(true); const { writer: stream } = writer(sink, { liveBytes: Buffer.byteLength(line("one")), liveFrames: 20 });
    for (const text of ["one", "two", "three", "four"]) stream.send(frame(text));
    expect(stream.telemetry()).toMatchObject({ frames_dropped: 2, pending_bytes_high_water: Buffer.byteLength(line("two")) });
    sink.resumeWrites(); await stream.finish(stream.prepareTerminal({ type: "result" }));
    expect(sink.frames().filter((entry) => entry.type === "stream").map((entry) => entry.text)).toEqual(["one", "two"]);
  });

  it("refuses an oversized live frame and never resumes the truncated view", async () => {
    const sink = new TestSink(); const { writer: stream } = writer(sink);
    stream.send(frame("x".repeat(200))); stream.send(frame("tail"));
    expect(sink.text()).toBe(""); expect(stream.telemetry().frames_dropped).toBe(2);
    await stream.finish(stream.prepareTerminal({ type: "result" }));
    expect(sink.frames().map((entry) => entry.type)).toEqual(["stream_truncated", "result"]);
  });

  it("prepares a byte-capped terminal frame with both text ends and the marker", async () => {
    const sink = new TestSink(); const { writer: stream } = writer(sink);
    const stdout = "HEAD" + "😀\n\"".repeat(6000) + "TAIL";
    const prepared = stream.prepareTerminal({ type: "result", stdout, stderr: "", result: null, execution_id: "exec_test" });
    expect(sink.text()).toBe(""); expect(Buffer.byteLength(prepared.line)).toBeLessThanOrEqual(limits.terminalFrameBytes);
    const terminal = JSON.parse(prepared.line);
    expect(terminal.stdout.startsWith("HEAD")).toBe(true); expect(terminal.stdout.endsWith("TAIL")).toBe(true); expect(terminal.stdout).toContain("\n… [truncated] …\n");
    expect(prepared.transport).toMatchObject({ terminal_truncated: true, truncated: true, terminal_frame_bytes: Buffer.byteLength(prepared.line) });
    expect(prepared.transport.bytes_dropped).toBeGreaterThan(0);
    await stream.finish(prepared);
    expect(sink.frames().at(-1)?.stream_transport).toEqual(prepared.transport);
    expect(sink.chunks.every((chunk) => chunk.length <= 16 * 1024)).toBe(true);
  });

  it("freezes one transport snapshot even when recording the truncation takes time", async () => {
    vi.useFakeTimers();
    const sink = new TestSink(true);
    const onRecord = vi.fn((record) => { if (record.event === "kernel_stream_backpressure_drop") vi.setSystemTime(Date.now() + 10); });
    const { writer: stream } = writer(sink, {}, onRecord);
    stream.send(frame("first"));
    const prepared = stream.prepareTerminal({ type: "result", stdout: "x".repeat(10000) });
    expect(JSON.parse(prepared.line).stream_transport).toEqual(prepared.transport);
    expect(prepared.transport.terminal_frame_bytes).toBe(Buffer.byteLength(prepared.line));
    sink.resumeWrites(); await stream.finish(prepared);
  });

  it("drops trailing outputs then trailing mime entries to fit the terminal bound without mutating the result", async () => {
    const sink = new TestSink(); const { writer: stream } = writer(sink);
    const outputs = [{ output_type: "display_data", data: { "text/plain": "x".repeat(3000) } }];
    const mime = { "image/png": "y".repeat(3000) };
    const prepared = stream.prepareTerminal({ type: "result", outputs, mime });
    expect(JSON.parse(prepared.line)).toMatchObject({ outputs: [], mime: {}, stream_transport: { terminal_truncated: true } });
    expect(outputs).toHaveLength(1); expect(mime["image/png"]).toHaveLength(3000);
    await stream.finish(prepared);
  });

  it("sends a long terminal line in byte chunks without corrupting UTF-8", async () => {
    const sink = new TestSink(true); const { writer: stream } = writer(sink, { terminalFrameBytes: 64 * 1024 });
    const prepared = stream.prepareTerminal({ type: "result", stdout: "😀".repeat(9000) });
    const finished = stream.finish(prepared); expect(sink.chunks[0]?.length).toBeLessThanOrEqual(16 * 1024); expect(sink.chunks[0]?.length).toBeGreaterThan(16 * 1024 - 4);
    sink.resumeWrites(); await finished;
    expect(sink.frames().at(-1)?.stdout).toBe("😀".repeat(9000));
    expect(sink.chunks.every((chunk) => chunk.length <= 16 * 1024)).toBe(true);
  });

  it("splits live text at 2048 units without splitting pairs or changing text", async () => {
    const sink = new TestSink(); const { writer: stream } = writer(sink, { liveBytes: 16 * 1024 });
    const text = "a".repeat(2047) + "😀".repeat(3000) + "\u0000\n\"\\".repeat(1000);
    stream.send(frame(text)); await stream.finish(stream.prepareTerminal({ type: "result" }));
    const live = sink.frames().filter((entry) => entry.type === "stream").map((entry) => String(entry.text));
    expect(live.join("")).toBe(text); expect(live.every((chunk) => chunk.length <= 2048)).toBe(true);
    expect(live.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true);
    expect(sink.chunks.every((chunk) => chunk.length <= 16 * 1024)).toBe(true);
  });

  it("keeps a bounded live prefix when a single event is huge", async () => {
    const sink = new TestSink(true); const { writer: stream } = writer(sink, { liveBytes: 8 * 1024, liveFrames: 100 });
    const text = "HEAD" + "😀".repeat(100000) + "TAIL";
    stream.send(frame(text)); const prepared = stream.prepareTerminal({ type: "result" }); const finished = stream.finish(prepared);
    sink.resumeWrites(); await finished;
    const retained = sink.frames().filter((entry) => entry.type === "stream").map((entry) => String(entry.text)).join("");
    expect(retained.length).toBeGreaterThan(0); expect(text.startsWith(retained)).toBe(true);
    expect(sink.chunks.every((chunk) => chunk.length <= 16 * 1024)).toBe(true);
    expect(prepared.transport).toMatchObject({ truncated: true }); expect(prepared.transport.pending_bytes_high_water).toBeLessThanOrEqual(8 * 1024);
    expect(sink.frames().filter((entry) => entry.type === "stream_truncated")).toHaveLength(1);
  });

  it("drops excessive metadata as a last resort and still prepares a terminal result", async () => {
    const sink = new TestSink(); const { writer: stream } = writer(sink);
    const frame = { type: "result", ok: true, execution_id: "exec_test", stdout: "head and tail", metadata: Array.from({ length: 10000 }, (_value, index) => index) };
    const prepared = stream.prepareTerminal(frame);
    expect(Buffer.byteLength(prepared.line)).toBeLessThanOrEqual(limits.terminalFrameBytes);
    expect(JSON.parse(prepared.line)).toMatchObject({ type: "result", ok: true, execution_id: "exec_test", stdout: "head and tail", stream_transport: { truncated: true, terminal_truncated: true } });
    expect(JSON.parse(prepared.line).metadata).toBeUndefined(); await stream.finish(prepared);
  });

  it("prepares a terminal failure even for a non-serializable result", async () => {
    const sink = new TestSink(); const { writer: stream } = writer(sink);
    const frame: { type: string; cycle?: unknown } = { type: "result" }; frame.cycle = frame;
    const prepared = stream.prepareTerminal(frame);
    expect(JSON.parse(prepared.line)).toMatchObject({ type: "result", ok: false, execution_id: "exec_test", stream_transport: { truncated: true, terminal_truncated: true } });
    await stream.finish(prepared);
  });

  it("detaches on close, counts queued and subsequent frames, and resolves finish", async () => {
    const sink = new TestSink(true); const { writer: stream, onRecord } = writer(sink);
    stream.send(frame("a")); stream.send(frame("b")); stream.send(frame("c"));
    sink.destroy(); await new Promise<void>((resolve) => setImmediate(resolve));
    stream.send(frame("d"));
    expect(sink.text()).toBe(line("a")); expect(stream.telemetry()).toMatchObject({ client_disconnected: true, frames_dropped: 3, bytes_dropped: Buffer.byteLength(line("b") + line("c") + line("d")) });
    expect((stream as unknown as { sink: Writable | null }).sink).toBeNull();
    for (const event of ["drain", "close", "error", "finish"]) expect(sink.listenerCount(event)).toBe(0);
    await stream.finish(stream.prepareTerminal({ type: "result" }));
    expect(onRecord.mock.calls.filter(([record]) => record.event === "kernel_stream_client_disconnected")).toHaveLength(1);
  });

  it("ignores sends after preparation and finish and makes finish idempotent", async () => {
    const sink = new TestSink(); const { writer: stream } = writer(sink);
    const prepared = stream.prepareTerminal({ type: "result" }); stream.send(frame("late"));
    const finished = stream.finish(prepared); expect(stream.finish(prepared)).toBe(finished); await finished;
    const before = stream.telemetry(); stream.send(frame("later"));
    expect(stream.telemetry()).toEqual(before); expect(sink.frames()).toHaveLength(1);
  });

  it("times out a sink that never drains, destroys it, and resolves finish", async () => {
    vi.useFakeTimers(); const sink = new TestSink(true); const { writer: stream } = writer(sink, { blockedDrainTimeoutMs: 30 });
    stream.send(frame("a")); stream.send(frame("b"));
    const prepared = stream.prepareTerminal({ type: "result" }); const finished = stream.finish(prepared);
    await vi.advanceTimersByTimeAsync(30); await finished;
    expect(sink.destroyed).toBe(true); expect(stream.telemetry()).toMatchObject({ blocked_drain_timed_out: true, terminal_written: false, frames_dropped: 1, blocked_ms: 30 });
    expect(prepared.transport.blocked_drain_timed_out).toBe(false);
    expect(sink.listenerCount("drain")).toBe(0);
  });

  it("detaches instead of writing when the sink is already destroyed", () => {
    const sink = new TestSink(); const { writer: stream } = writer(sink);
    stream.send(frame("a"));
    const writes: string[] = [];
    const original = sink.write.bind(sink);
    sink.write = ((chunk: Buffer, ...rest: unknown[]) => { writes.push(String(chunk)); return original(chunk, ...(rest as [])); }) as typeof sink.write;
    sink.destroy();
    stream.send(frame("b"));
    expect(writes).toEqual([]);
    expect(stream.telemetry()).toMatchObject({ client_disconnected: true, terminal_written: false });
    expect(sink.listenerCount("drain")).toBe(0);
  });

  it("handles a sink error without throwing or writing again", async () => {    const sink = new TestSink(true); const { writer: stream } = writer(sink);
    stream.send(frame("a")); stream.send(frame("b"));
    expect(() => sink.emit("error", new Error("socket failed"))).not.toThrow(); stream.send(frame("c"));
    await stream.finish(stream.prepareTerminal({ type: "result" }));
    expect(sink.text()).toBe(line("a")); expect(stream.telemetry()).toMatchObject({ client_disconnected: true, frames_dropped: 2, terminal_written: false });
  });
});
