from progress import report_progress

for item in range(1, 11):
    report_progress("items:1", "Processing items", item, 10, "items")
