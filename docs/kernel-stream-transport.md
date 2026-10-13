# Kernel stream transport limits

Reference for `POST /api/kernels/execute-stream` in `apps/server/src/http/routes/kernel-execution-routes.ts` and the
writer in `apps/server/src/http/kernel-stream-writer.ts`.

## Limits

| Limit | Value | Constant |
| --- | --- | --- |
| Live stream bytes held while the socket is blocked | 524288 | `DEFAULT_LIMITS.liveBytes` |
| Live stream frames held while the socket is blocked | 512 | `DEFAULT_LIMITS.liveFrames` |
| Terminal frame | 1048576 bytes | `DEFAULT_LIMITS.terminalFrameBytes` |
| One socket write | 16384 bytes | `WRITE_BYTES` |
| Blocked socket before detach | 30000 ms | `DEFAULT_LIMITS.blockedDrainTimeoutMs` |

The transport reads the boolean that `Writable.write` returns, and it arms one `drain` listener while blocked. A frame
whose write returns `false` stays inside the socket, so the writer stops and waits for `drain` instead of queuing more.

## Live stream truncation

The route keeps the first live bytes and drops the rest.

- While the byte or frame limit has room, frames go to the socket.
- On the first frame that does not fit, the live view becomes truncated for the rest of the execution. This frame and
  every later live frame are counted in `bytes_dropped` and `frames_dropped`, and none of them are queued.
- One `stream_truncated` frame is written after the retained frames and before the `result` frame. Its fields are
  `bytes_dropped`, `frames_dropped`, `live_bytes_limit`, and `live_frames_limit`.
- Retained live text is a prefix of the produced text. Frames keep their original order.

## Terminal frame

The `result` frame is written after the retained frames and the notice, and it is always the last frame.

When the serialized frame exceeds `terminalFrameBytes`, the writer trims the longest text fields first. Each trimmed field
keeps a head, the marker `… [truncated] …`, and a tail, so both ends of the output survive. Then it drops trailing
`outputs` entries, then trailing `mime` entries, and as a last resort it drops every other field except `type`,
`execution_id`, `ok`, `error`, the text fields, and `stream_transport`. `terminal_truncated` records that trimming
happened.

## Disconnect

A disconnect detaches the transport. It does not cancel the cell.

The cell runs to completion. The route writes the execution evidence with the real status, `succeeded`, `failed`,
`interrupted`, or `timed_out`. The writer removes its `drain`, `close`, and `error` listeners, clears the retained
frames, counts them as dropped, and drops its reference to the response. Later stream events are counted as dropped and
never touch the socket. A client that lost the stream reads `GET /api/executions/<execution_id>?cwd=<workspace>` and
sees the terminal status, the output previews, and the transport counters. There is no mid-cell reattach.

## Counters

`GET /api/executions/<execution_id>` returns them at `usage.stream_transport`, the `result` frame returns the same object
at `stream_transport`, and one `kernel_stream_finished` log record carries them with the delivery outcome.

| Field | Meaning |
| --- | --- |
| `live_bytes_limit`, `live_frames_limit`, `terminal_frame_limit_bytes` | The limits this execution ran with |
| `frames_sent` | Frames accepted by the socket |
| `frames_dropped`, `bytes_dropped` | Live frames and bytes never delivered, including terminal trimming and post-disconnect events |
| `pending_bytes_high_water` | Largest number of bytes held in the queue |
| `terminal_frame_bytes` | Size of the serialized `result` frame |
| `terminal_truncated` | The `result` frame was trimmed to fit |
| `truncated` | `bytes_dropped > 0`, the flag the notebook cell reads |
| `client_disconnected` | The client left before the cell finished |
| `blocked_ms` | Total time the socket was blocked |
| `terminal_written` | The `result` frame was accepted by the socket |
| `blocked_drain_timed_out` | The socket stayed blocked past the limit and the writer destroyed it |

`usage.stream_transport` is the transport state at the moment the cell finished, before delivery. A disconnect or a stall
during terminal delivery appears in the log record, not in this snapshot.
