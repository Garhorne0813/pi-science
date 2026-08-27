#!/usr/bin/env python3
"""Minimal local Python kernel for the AI4S Workbench notebook.

A persistent process that holds one namespace across cells (shared state, like a
Jupyter kernel) and speaks a line-delimited JSON protocol over stdin/stdout:

    request : {"id": "<str>", "code": "<str>"}\\n
    response: {"id","ok","stdout","stderr","result","error"}\\n

Standard library only — no ipykernel/ZMQ — so it runs against whatever Python the
user has, offline, with no model key. `result` mirrors Jupyter: the repr of the
final expression when a cell ends in one, else null.
"""
import ast
import base64
import io
import json
import os
import signal
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout


class StreamCapture(io.StringIO):
    def __init__(self, stream: str, emit):
        super().__init__()
        self.stream = stream
        self.emit = emit

    def write(self, text: str):
        written = super().write(text)
        if text:
            self.emit(self.stream, text)
        return written


def rich_mime(value) -> dict[str, str]:
    """Collect safe Jupyter-style representations without requiring IPython."""
    bundle: dict[str, str] = {}
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


def run_cell(ns: dict, code: str, emit=lambda _stream, _text: None):
    """Execute code and return stdout, stderr, result, error, interrupted and MIME data."""
    out = StreamCapture("stdout", emit)
    err_out = StreamCapture("stderr", emit)
    try:
        parsed = ast.parse(code, mode="exec")
    except SyntaxError:
        return "", "", None, traceback.format_exc(limit=1), False, {}

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
                    result = repr(value)
                    mime = rich_mime(value)
    except KeyboardInterrupt:
        return out.getvalue(), err_out.getvalue(), None, "KeyboardInterrupt", True, {}
    except Exception:  # surface the traceback to the notebook, like a kernel does
        return out.getvalue(), err_out.getvalue(), None, traceback.format_exc(), False, {}

    return out.getvalue(), err_out.getvalue(), result, None, False, mime


def main() -> None:
    # Force UTF-8 on the stdio protocol regardless of the OS locale. On Windows,
    # piped stdin/stdout default to the ANSI code page (e.g. cp936/GBK), which
    # corrupts non-ASCII source like `print("中文")` before it is executed. This
    # is self-contained (independent of how the process is spawned); a no-op
    # where stdio is already UTF-8.
    for stream in (sys.stdin, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")

    # Windows delivers CTRL_BREAK_EVENT as SIGBREAK. Convert it into the same
    # in-cell KeyboardInterrupt path as POSIX SIGINT so an interrupted cell
    # reports `interrupted` instead of losing the whole kernel process.
    sigbreak = getattr(signal, "SIGBREAK", None)
    if sigbreak is not None:
        def raise_interrupt(_signum, _frame):
            raise KeyboardInterrupt
        signal.signal(sigbreak, raise_interrupt)

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
            protocol_out.write(json.dumps({"id": req_id, "type": "stream", "stream": stream, "text": text}) + "\n")
            protocol_out.flush()
        stdout, stderr, result, error, interrupted, mime = run_cell(ns, req.get("code", ""), emit)
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
        }
        protocol_out.write(json.dumps(resp) + "\n")
        protocol_out.flush()


if __name__ == "__main__":
    main()
