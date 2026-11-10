"""A runnable emitter example. Both loops report the same scope, so the bar
keeps moving instead of restarting."""

import time

from pi_progress import bar, report

for item in bar(range(1, 11), total=10, label="Processing items", unit="items"):
    time.sleep(0.2)

# No total here, so the row counts files and shows no bar.
for item in range(1, 5):
    time.sleep(0.2)
    report(item, label="Rechecking", unit="files")
