# Tool progress examples

Write `<<pi-progress>>` at the start of a line, followed by one space, a JSON object, and a newline. The complete line must not exceed 512 UTF-8 bytes. See `example.py`, `example.R`, and `example.sh` for runnable examples. Python scripts can import `report_progress` from `progress.py`.

The Python example sleeps 0.4 seconds per item, so it runs for about four seconds.

Ordinary output is never read as progress. The number covers only the named scope, not the whole task.
