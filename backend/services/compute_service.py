"""Remote compute service — SSH and Slurm job management."""

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

COMPUTE_CONFIG_FILE = ".pi-science/compute.json"


class Machine:
    def __init__(self, host: str, label: str = "", user: str = "", port: int = 22,
                 identity_file: str = "", scheduler: str = ""):
        self.host = host
        self.label = label or host
        self.user = user or os.environ.get("USER", "")
        self.port = port
        self.identity_file = identity_file or os.path.expanduser("~/.ssh/id_rsa")
        self.scheduler = scheduler  # "" = direct SSH, "slurm" = SLURM


def load_machines(cwd: str) -> list[dict]:
    """Load configured remote machines from .pi-science/compute.json."""
    config_path = Path(cwd) / COMPUTE_CONFIG_FILE
    if not config_path.exists():
        return []
    try:
        data = json.loads(config_path.read_text())
        return data.get("machines", [])
    except (json.JSONDecodeError, KeyError):
        return []


def save_machines(cwd: str, machines: list[dict]):
    """Save remote machine configurations."""
    config_path = Path(cwd) / COMPUTE_CONFIG_FILE
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"machines": machines}, indent=2))


def probe_machine(host: str, user: str = "", port: int = 22,
                  identity_file: str = "") -> dict:
    """Probe a remote machine for hardware info."""
    user = user or os.environ.get("USER", "")
    identity_file = identity_file or os.path.expanduser("~/.ssh/id_rsa")
    ssh_opts = _ssh_opts(identity_file)
    info: dict = {"host": host, "reachable": False}

    try:
        # Check connectivity
        result = subprocess.run(
            ["ssh"] + ssh_opts + ["-p", str(port), f"{user}@{host}", "echo ok"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            info["error"] = result.stderr.strip()
            return info
        info["reachable"] = True

        # Get hardware info
        info["hostname"] = _ssh_cmd(host, user, port, identity_file, "hostname").strip()
        info["cores"] = _ssh_cmd(host, user, port, identity_file, "nproc").strip()
        info["memory"] = _ssh_cmd(host, user, port, identity_file,
                                  "free -h | awk '/^Mem:/{print $2}'").strip()
        info["gpus"] = _ssh_cmd(host, user, port, identity_file,
                                "nvidia-smi -L 2>/dev/null | wc -l || echo 0").strip()

        # Check Slurm
        slurm = _ssh_cmd(host, user, port, identity_file,
                         "which sbatch 2>/dev/null && echo yes || echo no").strip()
        info["has_slurm"] = slurm == "yes"
    except Exception as e:
        info["error"] = str(e)

    return info


def submit_job(cwd: str, machine_label: str, command: str, job_name: str = "",
               input_files: list[str] = None, output_files: list[str] = None,
               slurm_opts: dict = None) -> dict:
    """Submit a job to a remote machine (direct SSH or Slurm)."""
    machines = load_machines(cwd)
    machine = next((m for m in machines if m.get("label") == machine_label), None)
    if not machine:
        return {"ok": False, "error": f"Machine '{machine_label}' not found"}

    host = machine["host"]
    user = machine.get("user") or os.environ.get("USER", "")
    port = machine.get("port", 22)
    identity_file = machine.get("identity_file") or os.path.expanduser("~/.ssh/id_rsa")
    ssh_opts = _ssh_opts(identity_file)
    scheduler = machine.get("scheduler", "")

    job_id = f"job_{int(time.time() * 1000)}"
    job_name = job_name or f"pi-science-{job_id}"

    # Upload input files
    if input_files:
        for f in input_files:
            src = Path(cwd) / f
            dst = f"{user}@{host}:~/{f}"
            subprocess.run(["scp"] + ssh_opts + ["-P", str(port), str(src), dst], check=True)

    if scheduler == "slurm" and slurm_opts:
        # Submit via Slurm
        slurm_script = f"#!/bin/bash\n#SBATCH --job-name={job_name}\n"
        for k, v in slurm_opts.items():
            slurm_script += f"#SBATCH --{k.replace('_', '-')}={v}\n"
        slurm_script += f"\n{command}\n"
        script_path = Path(cwd) / f".pi-science/slurm_{job_id}.sh"
        script_path.write_text(slurm_script)
        _run_ssh(host, user, port, ssh_opts, f"sbatch ~/slurm_{job_id}.sh")
    else:
        # Direct SSH
        _run_ssh(host, user, port, ssh_opts, command)

    # Fetch output files
    outputs = []
    if output_files:
        for f in output_files:
            dst = Path(cwd) / "results" / job_name / f
            dst.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["scp"] + ssh_opts + ["-P", str(port),
                           f"{user}@{host}:~/{f}", str(dst)], check=True)
            outputs.append({"path": str(dst.relative_to(cwd)), "size": dst.stat().st_size if dst.exists() else 0})

    # Record to runs.jsonl
    from api.runs import _runs_file
    rf = _runs_file(cwd)
    record = {
        "runId": job_id,
        "command": command,
        "surface": "ssh",
        "host": host,
        "status": "ok",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "jobName": job_name,
        "outputs": outputs,
    }
    rf.parent.mkdir(parents=True, exist_ok=True)
    with open(rf, "a") as f:
        f.write(json.dumps(record) + "\n")

    return {"ok": True, "jobId": job_id, "outputs": outputs}


def _ssh_opts(identity_file: str) -> list[str]:
    return ["-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-i", identity_file]


def _ssh_cmd(host: str, user: str, port: int, identity_file: str, cmd: str) -> str:
    ssh_opts = _ssh_opts(identity_file)
    result = subprocess.run(
        ["ssh"] + ssh_opts + ["-p", str(port), f"{user}@{host}", cmd],
        capture_output=True, text=True, timeout=15,
    )
    return result.stdout if result.returncode == 0 else ""


def _run_ssh(host: str, user: str, port: int, identity_file: list[str], cmd: str):
    ssh_opts = _ssh_opts(identity_file)
    subprocess.Popen(
        ["ssh"] + ssh_opts + ["-p", str(port), f"{user}@{host}", cmd],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
