"""Report measurable progress to Pi-Science from a Python script.

Copy this file next to the script, or add its directory to PYTHONPATH. Nothing
imports it automatically and nothing monkey-patches a library until you ask it
to, so a script that never uses it behaves exactly as before.

    from pi_progress import report, bar, enable_rich

    for index, item in enumerate(items, 1):
        report(index, len(items), label="Processing files", unit="files")

`report` writes one control record to stderr. Pi-Science removes the record
from the output, so ordinary printing, exit codes and tracebacks are untouched.
"""

import json
import sys

SENTINEL = "<<pi-progress>>"
_DEFAULT_SCOPE = "python"


def report(current=None, total=None, *, scope=_DEFAULT_SCOPE, label="Progress", unit=None, total_kind=None, phase=None, stream=None):
    """Emit one measurement. `total=None` counts without a bar."""
    payload = {"version": 1, "scopeId": scope, "scopeLabel": label}
    if current is not None:
        payload["current"] = current
    if total is not None:
        payload["total"] = total
    payload["totalKind"] = total_kind or ("fixed" if total is not None else "unknown")
    if unit:
        payload["unit"] = unit
    if phase:
        payload["phase"] = phase
    # One write per record: a partial line would be read as ordinary output.
    target = stream or sys.stderr
    target.write(SENTINEL + " " + json.dumps(payload, separators=(",", ":")) + "\n")
    target.flush()


def bar(iterable, *, total=None, label="Progress", unit="items", scope=_DEFAULT_SCOPE, every=1):
    """Yield from `iterable` and report every `every` steps."""
    length = total if total is not None else (len(iterable) if hasattr(iterable, "__len__") else None)
    for index, item in enumerate(iterable, 1):
        yield item
        if index % every == 0:
            report(index, length, scope=scope, label=label, unit=unit)


_enabled = []


def enable_rich():
    """Report from rich.progress through its own task objects.

    Opt-in, and `disable_rich()` puts the original method back. Only the
    refresh is observed: task.completed, task.total and task.description, never
    the rendered terminal text.
    """
    from rich.progress import Progress

    if _enabled:
        return
    original = Progress.refresh

    def refresh(self):
        original(self)
        for task in self.tasks:
            if getattr(task, "total", None):
                report(task.completed, task.total, scope="rich:%d" % task.id, label=task.description or "Progress", unit="items")

    Progress.refresh = refresh
    _enabled.append((Progress, original))


def disable_rich():
    """Put rich.progress back the way it was."""
    for progress, original in _enabled:
        progress.refresh = original
    _enabled.clear()
