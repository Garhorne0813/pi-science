import json


def report_progress(scope_id, scope_label, current, total, unit):
    payload = {"version": 1, "scopeId": scope_id, "scopeLabel": scope_label, "current": current, "total": total, "unit": unit, "totalKind": "fixed"}
    print("<<pi-progress>> " + json.dumps(payload, separators=(",", ":")), flush=True)
