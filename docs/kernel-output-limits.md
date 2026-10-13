# Kernel output limits

A notebook cell can produce output without bound. A `print` of a 64 MiB string, a
`_repr_png_` of a large figure, and a deep recursion traceback all reach the same
stdio protocol line. The host bounds each of them at the source, in the bridge
that produced it, and clamps again in the Node manager that receives it. The
kernel process therefore cannot grow the protocol line or its own memory past the
caps, and the reader sees what was dropped.

One module owns every number. `apps/server/src/runtime/kernel/kernel-output-limits.ts`
holds the caps, the markers, the clamp helpers, and the argv builder. The bridges
(`bridges/kernel_bridge.py`, `bridges/kernel_bridge.R`) hold a copy of the
defaults for a manual run.

## Caps

| field | default | configuration |
| --- | --- | --- |
| `stdoutChars` | 65,536 | `PI_SCIENCE_KERNEL_STDOUT_CHARS` |
| `stderrChars` | 65,536 | `PI_SCIENCE_KERNEL_STDERR_CHARS`, also the cap for the `error` traceback |
| `resultChars` | 262,144 | `PI_SCIENCE_KERNEL_RESULT_CHARS` |
| `mimeChars` | 1,048,576 | `PI_SCIENCE_KERNEL_MIME_CHARS`, per payload |
| `outputsChars` | 2,097,152 | `PI_SCIENCE_KERNEL_OUTPUTS_CHARS`, the whole cell's rich payload budget |
| `displayOutputs` | 20 | argv only, no environment variable |
| `frameChars` | 21,692,416 | derived, not configurable |

`kernelOutputLimits` reads the five environment variables. A value is accepted
only when it parses as an integer of at least 128. Anything else keeps the
default, and the reader never throws. 128 is the floor because a smaller cap
retains less than the truncation marker itself, which is not a useful result to
hand a reader. A test that needs a smaller cap injects the limits object
directly.

The caps reach a bridge as argv, never as environment:

```
kernel_bridge.py --limits '{"stdout_chars":65536,...,"display_outputs":20}'
```

A dist build copies only the two bridge files, so the host process must not
depend on the kernel inheriting its own environment. An omitted flag leaves the
bridge on its own defaults, which are the values in the table above.

`frameChars` is the longest protocol line the host will parse:

```
frameChars = 6 * (stdoutChars + 2 * stderrChars + resultChars + mimeChars + outputsChars) + 65_536
```

The factor of six is the worst case for one character of cap. JSON escapes a C0
control character to six characters. A result line carries `stdout`, `stderr`,
`error`, `result`, `mime`, and `outputs` at once, and `error` is a second use of
the stderr cap. A line longer than `frameChars` is a protocol violation. The host
rejects every in-flight cell with a `KernelProtocolError`, marks the session
exited, and kills the child, because the point of the guard is to not parse or
retain a line that large. The derivation lives in one function, so a raised cap
raises the guard with it and cannot make a compliant line fail.

## Units

A cap counts characters, and each language counts them its own way.

| language | unit |
| --- | --- |
| Node | JavaScript UTF-16 code unit |
| Python | code point, `len` |
| R | `nchar(type = "chars")` |

A character cap bounds UTF-8 bytes at four times the cap. A non-BMP character is
one Python code point and two Node code units, so a bridge-bounded payload can
still be over the cap in Node and be clamped a second time. That second clamp
drops the orphaned code unit when a slice would land between a surrogate pair. An
unpaired surrogate reaches `encodeURIComponent` in the renderer and throws there,
so a split pair is not acceptable output.

The counts in a truncation report mix the two units. The bridge counts code
points and the manager counts code units, and the report adds them together. A
cell that ends in a large non-BMP value therefore reports a total that is neither
its code-point drop nor its code-unit drop.

A lone surrogate has no UTF-8 encoding, and the bridge writes its lines with
`ensure_ascii=False` so that a real non-BMP character costs one code point rather
than a twelve-character escape. The bridge's stdout replaces an unencodable
character, so one `sys.stdout.write('\ud800')` cannot fail the write and kill the
kernel.

## Retention policy

| surface | over its budget |
| --- | --- |
| `stdout`, `stderr` | head + marker + tail, total length at most the channel cap. A channel at or under its cap is returned unchanged |
| live `stream` events for a channel | emit the retained head, then one event carrying only the marker, then stay silent for that channel. The live view stops at the head even when the final payload keeps the whole channel |
| `error` (traceback) | head + marker + tail, total length at most `stderrChars` |
| `result` (repr of the tail expression) | head + marker, total at most `resultChars` |
| MIME payload of `text/*` or `image/svg+xml` | head + marker + tail, total at most `mimeChars` |
| MIME payload of `image/*` or `application/json` | drop the whole payload and name it in the notice |
| the cell's rich payloads together, across `mime` and every `outputs[].data` value | drop later payloads whole and name each one in the notice |
| more than `displayOutputs` outputs | drop the extra payloads and collect their markers in the notice |

A value at or under its cap passes through byte-identical, so the clamp is
idempotent and the manager's second pass over a compliant bridge payload changes
nothing.

## Truncation report

```ts
interface KernelTruncationReport {
  stdout_chars?: number;
  stderr_chars?: number;
  result_chars?: number;
  rich_chars?: number;
  outputs_dropped?: number;
}
```

Every value counts characters that were produced but not delivered, and every
value is an integer above zero. A key is present only when something dropped, so
`{}` and an absent `truncated` field both mean the cell was intact.

| key | meaning |
| --- | --- |
| `stdout_chars` | characters the cell wrote to stdout that the reader does not receive |
| `stderr_chars` | characters written to stderr, plus the dropped part of the `error` traceback |
| `result_chars` | characters of the tail expression's repr that were cut |
| `rich_chars` | characters dropped from MIME payloads, by the per-payload cap and by the cell's rich budget |
| `outputs_dropped` | payloads produced minus payloads delivered. The notice is not a payload, so it is not counted |

The counts describe the delivered final payload only. A live stream event is not
counted, because the protocol carries the same stdout a second time in the result
line and counting both would report more characters missing than the payload is
missing.

## The notice

A drop marker must be visible. A marker appended to a surviving `text/plain`
value is not rendered when the same output also kept, for example, `text/html`, so
every dropped payload is named in its own output instead.

- A payload dropped whole appends `kernelPayloadMarker(mime)`, for example
  `"\n… [truncated: image/png]"`, to a cell-level notice list.
- A display-count drop appends one `KERNEL_TRUNCATION_MARKER` per dropped payload
  to that same list.
- A payload truncated in place keeps its marker in place and does not join the
  list.
- When the list is not empty, the cell ends with one extra output whose only key
  is `text/plain`, holding the joined markers.

The notice takes one of the `displayOutputs` slots. When the payload list is
already full, the last payload is dropped first and counted in `outputs_dropped`,
and the notice takes its place.

Both layers apply the same rule, and both keep the notice text bounded. A count drop contributes one marker however many payloads it drops, and each dropped MIME contributes one marker for its name, so a cell that drops a million outputs still emits a notice of a few dozen characters. The counts live in the truncation report instead. The notice also never costs the cell its tail value: it takes its slot from the last plain display output, so an `execute_result` keeps its own.

`NotebookOutputs` renders a `text/plain`-only
entry as text, so the marker is visible with no frontend change. A marker written
under `image/png` would render as a broken image and is forbidden.

The agent writes cell output back to the `.ipynb` file and the reader reopens it.
`notebookExecutionOutputs` in `runtime/shared/extensions/pi-science-notebook.ts`
recognizes the notice by its `text/plain` marker and places it first among the
rich outputs, so neither its own 20-output slice nor the 20-output slice in
`notebook-routes.ts` can cut it.

## Residual risks

- The R bridge accumulates output inside a single expression until the cell
  timeout. Only the payload and the protocol line are bounded at emit time.
- `readline` in the manager assembles a whole line before the frame guard runs, so
  the guard bounds parsing and retention, not the first allocation.
- The clamp is measured in characters, not bytes.
- The persistence-side constants are unchanged. The 16 KiB text preview, the 4 MiB
  image limit, and the 20-output limit in `notebook-routes.ts` still apply, and the
  bridge caps now make the 4 MiB image path unreachable from a kernel cell.
- Report counts mix UTF-16 code units and code points, as the Units section says.
- A live stream stops at the head even when the final payload holds the whole
  channel, so the live view can show its marker for a cell that lost nothing.
- The notice is one entry per cell. A reader that inspects a single output cannot
tell which payload the marker names.

## Measurement

```
node scripts/benchmark-kernel-output.mjs
node scripts/benchmark-kernel-output.mjs --display-storm 2000000
```

The script drives the real Python bridge on one cell that writes 64 MiB to stdout,
8 MiB to stderr, and ends in a value exposing a 12 MiB `_repr_png_`, a 4 MiB
`_repr_html_`, and a 4 MiB `application/json` dictionary. It samples the bridge's
resident memory with `ps -o rss= -p <pid>` every 25 ms, counts the bytes the
bridge wrote to stdout, and times the run. It runs the cell twice, once with every
cap at 1,000,000,000 as the pre-fix comparison and once with the defaults above.
`--workload-mib` scales the workload down for a slow machine.

Measured on this machine (Darwin arm64, macOS 15.6.1, `node v26.0.0`, `python3` 3.12.12),
default workload, 2026-10-13:

| run | bridge peak RSS | bytes on stdout | wall |
| --- | --- | --- | --- |
| unbounded caps | 549.5 MiB | 192.0 MiB | 0.49 s |
| shipped defaults | 116.3 MiB | 2.2 MiB | 0.05 s |

Every number in that table is measured, not derived. The bridge's own report for
the bounded run is `truncated={"rich_chars":24117254,"stdout_chars":67043328,"stderr_chars":8323072}`,
with `stdout_chars` and `stderr_chars` in its `--limits` JSON both 65,536 and a
9-character `result`. Transport fell from 192.0 MiB to 2.2 MiB, which is the
bridge's stdout bytes for both the stream events and the result line. Peak RSS
fell from 549.5 MiB to 116.3 MiB, and the residual is the library and allocator
cost of the un-bounded intermediates the workload builds before it bounds them,
chiefly the 12 MiB PNG buffer and its base64 encoding.

Peak RSS is the noisiest of the three numbers. The transport bytes repeat exactly
at 192.0 MiB and 2.2 MiB across runs, and the wall time stays within 0.07 s.
Three runs sampled between 545.6 MiB and 549.6 MiB of peak for the unbounded case
and between 116.3 MiB and 158.0 MiB for the bounded case. A 25 ms sampling
interval is coarse over a half-second run, so a sample can land before or after
the peak allocation. The script reports the highest sample it saw, which is a
floor on the true peak.

The display storm is the other pathological cell. It calls `display()` far past
the count cap, so the bridge drops payloads and still has to say so.

| run | response characters | peak RSS | wall |
| --- | --- | --- | --- |
| 2,000,000 displays | 1,457 | 13.3 MiB | 0.22 s |

The response holds the 20 allowed outputs and one notice of 15 characters, and
reports `outputs_dropped: 1999981`. A notice that grew by one marker per dropped
display would instead put about 30 MB on the wire and trip the frame guard, which
turns the cell into a protocol failure and kills the namespace.

Repeating the measurement at four times the workload (`--workload-mib 256`) moves
the unbounded run to 1354.4 MiB of peak RSS and 768.0 MiB of transport in 1.94 s,
and leaves the bounded run at 2.2 MiB, which is the scaling the caps predict.
