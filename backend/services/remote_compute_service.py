"""Remote SSH/Slurm compute helpers used by the legacy compute API."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from services.egress_gateway import EgressGateway
from services.workspace_context import WorkspaceContext


COMPUTE_CONFIG_FILE = ".pi-science/compute.json"


def load_machines(cwd: str) -> list[dict]:
    path = Path(cwd).expanduser() / COMPUTE_CONFIG_FILE
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return payload.get("machines", []) if isinstance(payload, dict) else []


def save_machines(cwd: str, machines: list[dict]) -> None:
    path = Path(cwd).expanduser() / COMPUTE_CONFIG_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"machines": machines}, indent=2), encoding="utf-8")


def _ssh_opts(identity_file: str) -> list[str]:
    return ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-i", identity_file]


async def probe_machine(cwd: str, host: str, user: str = "", port: int = 22, identity_file: str = "") -> dict:
    user = user or os.environ.get("USER", "")
    identity_file = identity_file or os.path.expanduser("~/.ssh/id_rsa")
    context = WorkspaceContext.from_cwd(cwd, allow_process_cwd=True)
    result = await EgressGateway(context).run(
        ["ssh", *_ssh_opts(identity_file), "-p", str(port), f"{user}@{host}", "echo ok"],
        destination=f"ssh://{host}:{port}", timeout=15,
    )
    return {"host": host, "reachable": result.returncode == 0, "error": result.stderr.strip() if result.returncode else ""}


async def submit_job(cwd: str, machine_label: str, command: str, job_name: str = "", input_files: list[str] | None = None, output_files: list[str] | None = None, slurm_opts: dict | None = None) -> dict:
    machines = load_machines(cwd)
    machine = next((item for item in machines if item.get("label") == machine_label), None)
    if machine is None:
        return {"ok": False, "error": f"Machine '{machine_label}' not found"}
    user = machine.get("user") or os.environ.get("USER", "")
    identity = machine.get("identity_file") or os.path.expanduser("~/.ssh/id_rsa")
    job_id = f"job_{int(time.time() * 1000)}"
    context = WorkspaceContext.from_cwd(cwd, allow_process_cwd=True)
    result = await EgressGateway(context).run(
        ["ssh", *_ssh_opts(identity), "-p", str(machine.get("port", 22)), f"{user}@{machine['host']}", command],
        destination=f"ssh://{machine['host']}:{machine.get('port', 22)}", data_class="compute", timeout=30,
    )
    return {"ok": result.returncode == 0, "jobId": job_id, "stdout": result.stdout, "stderr": result.stderr}
