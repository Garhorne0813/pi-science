#!/usr/bin/env python3
"""Minimal local Python kernel for the AI4S Workbench notebook.

A persistent process that holds one namespace across cells (shared state, like a
Jupyter kernel) and speaks a line-delimited JSON protocol over stdin/stdout:

    request : {"id": "<str>", "code": "<str>"}\\n
    response: {"id","ok","stdout","stderr","result","error","mime","outputs","truncated"}\\n

Standard library only — no ipykernel/ZMQ — so it runs against whatever Python the
user has, offline, with no model key. `result` mirrors Jupyter: the repr of the
final expression when a cell ends in one, else null. Explicit `display()` calls and
common matplotlib `show()` calls are returned as display outputs. The host passes
its output caps as `--limits <json>`; the defaults below apply when the flag is
absent. `truncated` counts characters produced but not delivered and is omitted
when nothing dropped.
"""
import ast
import base64
import io
import json
import os
import re
import signal
import sys
import traceback
from collections import deque
from contextlib import redirect_stderr, redirect_stdout


MAX_DISPLAY_OUTPUTS = 20  # the default for a manual run; keep in sync with DEFAULT_KERNEL_OUTPUT_LIMITS.displayOutputs
KERNEL_TRUNCATION_MARKER = "\n… [truncated]"
DEFAULT_LIMITS = {
    "stdout_chars": 65536,
    "stderr_chars": 65536,
    "result_chars": 262144,
    "mime_chars": 1048576,
    "outputs_chars": 2097152,
    "display_outputs": MAX_DISPLAY_OUTPUTS,
}


def kernel_payload_marker(mime: str) -> str:
    return "\n… [truncated: {}]".format(mime)


class CellNotice:
    """The cell's drop notice, kept small on purpose: one marker for a count drop plus one
    marker per distinct dropped MIME. A cell that drops a million outputs still emits one
    short notice, and the counts live in the report instead."""

    def __init__(self) -> None:
        self.count_dropped = 0
        self.payload: list = []

    def count(self) -> None:
        self.count_dropped += 1

    def payloads(self, markers: list) -> None:
        for marker in markers:
            if marker not in self.payload:
                self.payload.append(marker)

    def empty(self) -> bool:
        return not self.count_dropped and not self.payload

    def text(self) -> str:
        return (KERNEL_TRUNCATION_MARKER if self.count_dropped else "") + "".join(self.payload)


def evict_display(outputs: list) -> None:
    """The notice takes a display slot. Prefer the last plain display so that a tail
    expression, which the cell appends last, keeps its slot and stays visible."""
    for index in range(len(outputs) - 1, -1, -1):
        if outputs[index].get("output_type") == "display_data":
            del outputs[index]
            return
    outputs.pop()


def limits_from_argv(argv: list) -> dict:
    """Read the host's caps; a missing, unreadable or non-positive value keeps the default."""
    limits = dict(DEFAULT_LIMITS)
    if "--limits" not in argv:
        return limits
    try:
        provided = json.loads(argv[argv.index("--limits") + 1])
    except (IndexError, ValueError):
        return limits
    if isinstance(provided, dict):
        for key in DEFAULT_LIMITS:
            value = provided.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                limits[key] = value
    return limits


def charge(report: dict, key: str, dropped: int) -> None:
    if dropped > 0:
        report[key] = report.get(key, 0) + dropped


def bound_text(value: str, cap: int) -> tuple:
    """Head + marker + tail at most `cap` characters, with the dropped count."""
    if len(value) <= cap:
        return value, 0
    marker = KERNEL_TRUNCATION_MARKER[:cap]
    head_cap = max((cap - len(marker)) // 2, 0)
    tail_cap = max(cap - len(marker) - head_cap, 0)
    kept = value[:head_cap] + marker + (value[len(value) - tail_cap:] if tail_cap else "")
    return kept, len(value) - len(kept)


def bound_head(value: str, cap: int) -> tuple:
    """Head + marker at most `cap` characters; a repr keeps no tail."""
    if len(value) <= cap:
        return value, 0
    marker = KERNEL_TRUNCATION_MARKER[:cap]
    kept = value[: max(cap - len(marker), 0)] + marker
    return kept, len(value) - len(kept)


def bound_payload(value: str, mime: str, cap: int):
    """Returns (text, dropped), or None when the payload must be dropped whole: half a
    base64 image or half a JSON document is unusable, a text payload still reads."""
    if len(value) <= cap:
        return value, 0
    if mime.startswith("text/") or mime == "image/svg+xml":
        return bound_text(value, cap)
    return None


def bound_bundle(bundle: dict, limits: dict, rich: dict, report: dict) -> tuple:
    """Clamp or drop every payload in one bundle, charging the cell's shared rich budget.
    Returns the kept bundle and one marker per payload dropped whole; the caller
    collects those markers into the cell's notice output."""
    kept = {}
    markers = []
    for mime, value in bundle.items():
        outcome = bound_payload(value, mime, limits["mime_chars"])
        if outcome is not None and len(outcome[0]) <= rich["remaining"]:
            rich["remaining"] -= len(outcome[0])
            charge(report, "rich_chars", len(value) - len(outcome[0]))
            kept[mime] = outcome[0]
        else:
            charge(report, "rich_chars", len(value))
            markers.append(kernel_payload_marker(mime))
    return kept, markers


class BoundedStreamCapture(io.StringIO):
    """Retains one channel's head and tail within its cap, and mirrors only the head to
    the live stream: past the head a reader gets one marker event and then silence."""

    def __init__(self, stream: str, emit, cap: int):
        super().__init__()
        self.stream = stream
        self.emit = emit
        self.cap = cap
        self.head_cap = max((cap - len(KERNEL_TRUNCATION_MARKER)) // 2, 0)
        self.tail_cap = max(cap - len(KERNEL_TRUNCATION_MARKER) - self.head_cap, 0)
        self.head: list = []  # retains up to the whole cap, so a payload that fits is lossless
        self.head_len = 0
        self.live_len = 0
        self.tail: deque = deque()
        self.tail_len = 0
        self.total = 0
        self.muted = False

    def write(self, text: str) -> int:
        produced = len(text)
        if text:
            self.total += produced
            room = self.cap - self.head_len
            head = text[:room] if room > 0 else ""
            if head:
                self.head.append(head)
                self.head_len += len(head)
            # The tail keeps the last `tail_cap` characters of the whole channel, because
            # a truncated payload shows the head of the channel and the tail of it, and the
            # part between them is what the marker stands for.
            self._retain_tail(text)
            live_room = self.head_cap - self.live_len
            live = head[:live_room] if live_room > 0 else ""
            if live:
                self.live_len += len(live)
                self.emit(self.stream, live)
            if self.total > self.live_len and not self.muted:
                # The live view stops at the head, so it says so once and then stays quiet;
                # the final payload may still hold the whole channel.
                self.emit(self.stream, KERNEL_TRUNCATION_MARKER)
                self.muted = True
        return produced

    def _retain_tail(self, text: str) -> None:
        if len(text) >= self.tail_cap:
            # One chunk longer than the whole tail budget replaces it outright, so the
            # chunk itself is never what keeps the buffer alive.
            text = text[len(text) - self.tail_cap:] if self.tail_cap > 0 else ""
            self.tail.clear()
            self.tail_len = 0
        if text:
            self.tail.append(text)
            self.tail_len += len(text)
        while self.tail and self.tail_len - len(self.tail[0]) >= self.tail_cap:
            self.tail_len -= len(self.tail.popleft())
        if self.tail and self.tail_len > self.tail_cap:
            excess = self.tail_len - self.tail_cap
            self.tail[0] = self.tail[0][excess:]
            self.tail_len -= excess

    def retained(self) -> str:
        if self.total <= self.cap:
            return "".join(self.head)
        head = "".join(self.head)[: self.head_cap]
        return head + KERNEL_TRUNCATION_MARKER[: self.cap] + "".join(self.tail)

    @property
    def dropped(self) -> int:
        return self.total - len(self.retained())


def rich_mime(value) -> dict:
    """Collect safe Jupyter-style representations without requiring IPython."""
    bundle = {}
    for method, mime in (("_repr_html_", "text/html"), ("_repr_svg_", "image/svg+xml")):
        renderer = getattr(value, method, None)
        if callable(renderer):
            try:
                rendered = renderer()
                if rendered:
                    bundle[mime] = str(rendered)
            except Exception:
                pass
    png_renderer = getattr(value, "_repr_png_", None)
    if callable(png_renderer):
        try:
            rendered = png_renderer()
            if isinstance(rendered, tuple):
                rendered = rendered[0]
            if isinstance(rendered, bytes):
                bundle["image/png"] = base64.b64encode(rendered).decode("ascii")
        except Exception:
            pass
    # Structured values benefit from a JSON representation. Scalars already
    # have a clearer text/plain repr and rendering both would duplicate output.
    if isinstance(value, (dict, list, tuple)):
        try:
            bundle["application/json"] = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            pass
    return bundle


def display_mime(value) -> dict:
    bundle = rich_mime(value)
    bundle.setdefault("text/plain", repr(value))
    return bundle


def capture_matplotlib_figures(outputs: list, displayed_figures: set, limits: dict, rich: dict, report: dict, notice: CellNotice) -> int:
    """Capture figures after code calls show(), without requiring IPython. Returns the
    figures dropped by the display-output count cap."""
    try:
        import matplotlib.pyplot as plt
    except Exception:
        return 0
    dropped = 0
    for number in plt.get_fignums():
        figure = plt.figure(number)
        identity = id(figure)
        if identity in displayed_figures:
            continue
        if len(outputs) >= limits["display_outputs"]:
            dropped += 1
            notice.count()
            continue
        try:
            figure.canvas.draw()
            buffer = io.BytesIO()
            figure.savefig(buffer, format="png")
            png = base64.b64encode(buffer.getvalue()).decode("ascii")
            data, markers = bound_bundle({"image/png": png}, limits, rich, report)
            notice.payloads(markers)
            outputs.append({"output_type": "display_data", "data": data})
            displayed_figures.add(identity)
        except Exception:
            pass
    return dropped


def run_cell(ns: dict, code: str, emit=lambda _stream, _text: None, limits=None):
    """Execute code and return streams, result, MIME data, display outputs, and the drop report."""
    limits = limits or dict(DEFAULT_LIMITS)
    report = {}
    rich = {"remaining": limits["outputs_chars"]}
    out = BoundedStreamCapture("stdout", emit, limits["stdout_chars"])
    err_out = BoundedStreamCapture("stderr", emit, limits["stderr_chars"])
    display_outputs: list = []
    notice = CellNotice()
    displayed_figures: set = set()
    dropped_outputs = 0

    def display(*values) -> None:
        nonlocal dropped_outputs
        for value in values:
            if len(display_outputs) >= limits["display_outputs"]:
                # The cap drops what it cannot show; the host counts them as well.
                dropped_outputs += 1
                notice.count()
                continue
            data, markers = bound_bundle(display_mime(value), limits, rich, report)
            notice.payloads(markers)
            display_outputs.append({"output_type": "display_data", "data": data})
            if hasattr(value, "savefig") and hasattr(value, "canvas"):
                displayed_figures.add(id(value))

    def streamed_text() -> tuple:
        charge(report, "stdout_chars", out.dropped)
        charge(report, "stderr_chars", err_out.dropped)
        charge(report, "outputs_dropped", dropped_outputs)
        return out.retained(), err_out.retained()

    def finalize() -> None:
        """A drop marker is its own output holding one text/plain value: a marker beside
        a surviving payload is not rendered, and the notice takes a display slot."""
        if notice.empty():
            return
        if len(display_outputs) >= limits["display_outputs"]:
            evict_display(display_outputs)
            charge(report, "outputs_dropped", 1)
        display_outputs.append({"output_type": "display_data", "data": {"text/plain": notice.text()}})

    # Keep a fresh collector for each cell while preserving the shared namespace.
    ns["display"] = display
    try:
        parsed = ast.parse(code, mode="exec")
    except SyntaxError:
        error, dropped = bound_text(traceback.format_exc(limit=1), limits["stderr_chars"])
        charge(report, "stderr_chars", dropped)
        return "", "", None, error, False, {}, [], report

    body = parsed.body
    result = None
    mime = {}
    # Jupyter behaviour: if the cell ends in an expression, show its value.
    tail_expr = None
    if body and isinstance(body[-1], ast.Expr):
        last = body.pop()
        assert isinstance(last, ast.Expr)
        tail_expr = ast.Expression(last.value)

    try:
        with redirect_stdout(out), redirect_stderr(err_out):
            if body:
                exec(compile(ast.Module(body, []), "<cell>", "exec"), ns)  # noqa: S102
            if tail_expr is not None:
                value = eval(compile(tail_expr, "<cell>", "eval"), ns)  # noqa: S307
                if value is not None:
                    result, dropped = bound_head(repr(value), limits["result_chars"])
                    charge(report, "result_chars", dropped)
                    mime, markers = bound_bundle(rich_mime(value), limits, rich, report)
                    notice.payloads(markers)
                    if len(display_outputs) >= limits["display_outputs"]:
                        # The tail expression keeps the last slot, so its value is visible.
                        evict_display(display_outputs)
                        dropped_outputs += 1
                        notice.count()
                    display_outputs.append({
                        "output_type": "execute_result",
                        "data": {"text/plain": result, **mime},
                    })
                    if hasattr(value, "savefig") and hasattr(value, "canvas"):
                        displayed_figures.add(id(value))
            if re.search(r"\bshow\s*\(", code):
                dropped_outputs += capture_matplotlib_figures(display_outputs, displayed_figures, limits, rich, report, notice)
    except KeyboardInterrupt:
        stdout, stderr = streamed_text()
        finalize()
        return stdout, stderr, None, "KeyboardInterrupt", True, {}, display_outputs, report
    except Exception:  # surface the traceback to the notebook, like a kernel does
        stdout, stderr = streamed_text()
        error, dropped = bound_text(traceback.format_exc(), limits["stderr_chars"])
        charge(report, "stderr_chars", dropped)
        finalize()
        return stdout, stderr, None, error, False, {}, display_outputs, report

    stdout, stderr = streamed_text()
    finalize()
    return stdout, stderr, result, None, False, mime, display_outputs, report


def main() -> None:
    # Force UTF-8 on the stdio protocol regardless of the OS locale. On Windows,
    # piped stdin/stdout default to the ANSI code page (e.g. cp936/GBK), which
    # corrupts non-ASCII source like `print("中文")` before it is executed. This
    # is self-contained (independent of how the process is spawned); a no-op
    # where stdio is already UTF-8. A lone surrogate has no UTF-8 encoding and
    # ensure_ascii=False leaves one raw on the wire, so stdout replaces it
    # instead of failing the write and killing the kernel over one cell.
    for stream in (sys.stdin, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace" if stream is sys.stdout else "strict")

    # Windows delivers CTRL_BREAK_EVENT as SIGBREAK. Convert it into the same
    # in-cell KeyboardInterrupt path as POSIX SIGINT so an interrupted cell
    # reports `interrupted` instead of losing the whole kernel process.
    sigbreak = getattr(signal, "SIGBREAK", None)
    if sigbreak is not None:
        def raise_interrupt(_signum, _frame):
            raise KeyboardInterrupt
        signal.signal(sigbreak, raise_interrupt)

    limits = limits_from_argv(sys.argv[1:])
    protocol_out = sys.stdout
    # The bridge is launched by absolute path, so Python would otherwise put
    # the bridge directory—not the workspace—at the front of sys.path.
    workspace = os.getcwd()
    if workspace not in sys.path:
        sys.path.insert(0, workspace)
    ns: dict = {"__name__": "__main__"}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        req_id = req.get("id")
        def emit(stream: str, text: str):
            protocol_out.write(json.dumps({"id": req_id, "type": "stream", "stream": stream, "text": text}, ensure_ascii=False) + "\n")
            protocol_out.flush()
        stdout, stderr, result, error, interrupted, mime, outputs, truncated = run_cell(ns, req.get("code", ""), emit, limits)
        resp = {
            "id": req_id,
            "type": "result",
            "ok": error is None,
            "stdout": stdout,
            "stderr": stderr,
            "result": result,
            "error": error,
            "interrupted": interrupted,
            "mime": mime,
            "outputs": outputs,
        }
        if truncated:
            resp["truncated"] = truncated
        protocol_out.write(json.dumps(resp, ensure_ascii=False) + "\n")
        protocol_out.flush()


if __name__ == "__main__":
    main()
