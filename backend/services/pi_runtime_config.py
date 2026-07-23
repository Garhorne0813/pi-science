"""Build Pi runtime subprocess launch arguments and environment."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
from typing import Optional

from config import (
    BASE_DIR,
    PI_CLI_PATH,
    PI_DEFAULT_MODEL,
    PI_DEFAULT_THINKING,
    PI_MODE,
    PI_NODE_PATH,
    PI_TSCONFIG_PATH,
    PI_TSX_PATH,
)
from models import PiConfig


@dataclass(frozen=True)
class PiRuntimeLaunch:
    args: list[str]
    env: dict[str, str]
    model: str
    thinking: str


def build_runtime_launch(
    cwd: str,
    session_dir: str,
    config: PiConfig,
    *,
    session_path: Optional[str] = None,
) -> PiRuntimeLaunch:
    """Return subprocess args/env for one Pi RPC runtime."""
    settings: dict = {}
    try:
        from services.settings_store import load_config

        settings = load_config()
    except Exception:
        pass

    effective_model = config.model or settings.get("model") or PI_DEFAULT_MODEL
    thinking = config.thinking or settings.get("thinking") or PI_DEFAULT_THINKING

    if PI_MODE == "dev" and PI_TSX_PATH:
        args = [
            PI_NODE_PATH,
            PI_TSX_PATH,
            "--tsconfig",
            PI_TSCONFIG_PATH,
            PI_CLI_PATH,
            "--mode",
            "rpc",
        ]
    else:
        args = [
            PI_NODE_PATH,
            PI_CLI_PATH,
            "--mode",
            "rpc",
        ]

    from services.runtime_extensions import find_runtime_package, runtime_extension_status

    enable_context_mode = os.environ.get("PI_SCIENCE_ENABLE_CONTEXT_MODE", "0") == "1"
    for extension in runtime_extension_status(PI_CLI_PATH):
        if extension["installed"] and (
            extension["id"] != "context-mode" or enable_context_mode
        ):
            args.extend(["-e", extension["path"]])

    args.extend([
        *(["--model", effective_model] if effective_model else []),
        "--thinking",
        thinking,
        "--session-dir",
        session_dir,
        "--no-extensions",
    ])

    skills_configured = bool(settings.get("skills_configured", False))
    if skills_configured:
        args.append("--no-skills")
        for skill_path in settings.get("skill_paths", []):
            if isinstance(skill_path, str) and skill_path.strip():
                args.extend(["--skill", skill_path])
    else:
        context_mode = find_runtime_package("context-mode", PI_CLI_PATH)
        if enable_context_mode and context_mode and (context_mode / "skills").is_dir():
            args.extend(["--skill", str(context_mode / "skills")])

    if session_path:
        args.extend(["--session", session_path])

    from api.settings import get_mcp_runtime_config

    mcp_config = get_mcp_runtime_config(cwd)
    if mcp_config:
        args.extend(["--mcp-config", str(mcp_config)])

    for skill_path in config.skills:
        args.extend(["--skill", skill_path])
    for ext_path in config.extensions:
        args.extend(["-e", ext_path])

    from api.settings import get_custom_models_runtime, get_env_with_keys, get_web_access_runtime

    env = get_env_with_keys()
    custom_agent_dir, custom_env = get_custom_models_runtime(cwd)
    agent_dir = get_web_access_runtime(cwd, custom_agent_dir)
    if agent_dir is None:
        # Pi falls back to ~/.pi/agent when this is unset. In managed and
        # sandboxed environments that directory may be unreadable or not
        # writable, and Pi's lockfile creation then aborts startup. Keep all
        # runtime-owned state under the configured Pi-Science data root and
        # isolate it per workspace.
        workspace_key = hashlib.sha256(
            str(Path(cwd).expanduser().resolve()).encode("utf-8")
        ).hexdigest()[:12]
        agent_dir = BASE_DIR / "pi-agent" / workspace_key
        try:
            agent_dir.mkdir(parents=True, exist_ok=True)
        except PermissionError:
            # A managed runtime may expose PI_SCIENCE_HOME as read-only. The
            # workspace itself is already validated and writable because Pi
            # stores its session files there, so use its local control-plane
            # directory as a safe last-resort root.
            agent_dir = Path(cwd).resolve() / ".pi-science" / "agent" / workspace_key
            agent_dir.mkdir(parents=True, exist_ok=True)
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    # Pi itself currently resolves settings from PI_CODING_AGENT_DIR; the
    # explicit PI_CONFIG_DIR also keeps bundled adapters and MCP bridges from
    # probing the user's unrelated ~/.pi installation.
    env["PI_CONFIG_DIR"] = str(agent_dir)
    env["PI_WORKSPACE_DIR"] = str(Path(cwd).resolve())
    env.update(custom_env)

    if config.provider:
        env["PI_DEFAULT_PROVIDER"] = config.provider

    # Keep context-mode-owned databases alongside the same workspace-scoped
    # Pi agent directory. CONTEXT_MODE_DATA_DIR is the current override; the
    # legacy CONTEXT_MODE_DIR is retained for older extension builds.
    env["CONTEXT_MODE_DATA_DIR"] = str(agent_dir)
    env["CONTEXT_MODE_DIR"] = str(agent_dir / "context-mode")
    wrapper_path = ensure_pi_subagent_wrapper(BASE_DIR, args)
    if wrapper_path:
        env["PI_SUBAGENT_PI_BINARY_ENV"] = wrapper_path
    env["PATH"] = f"{BASE_DIR}:{env.get('PATH', '')}"

    return PiRuntimeLaunch(args=args, env=env, model=effective_model, thinking=thinking)


def ensure_pi_subagent_wrapper(base_dir: Path, parent_args: list[str]) -> Optional[str]:
    """Create a wrapper that lets pi-subagents spawn the current Pi runtime."""
    try:
        node_index = next(
            index
            for index, value in enumerate(parent_args)
            if value == "node" or value.endswith("/node")
        )
        node_bin = parent_args[node_index]
        tsx = parent_args[node_index + 1]
        tsconfig_flag = parent_args[node_index + 2]
        tsconfig_path = parent_args[node_index + 3]
        cli_path = parent_args[node_index + 4]
    except (StopIteration, IndexError):
        return None

    if tsconfig_flag != "--tsconfig":
        return None

    wrapper_path = base_dir / "pi-subagent-wrapper.sh"
    script = (
        "#!/bin/bash\n"
        "# Auto-generated by pi_runtime_config - do not edit\n"
        f'exec "{node_bin}" "{tsx}" "{tsconfig_flag}" "{tsconfig_path}" "{cli_path}" "$@"\n'
    )
    try:
        current = wrapper_path.read_text()
    except FileNotFoundError:
        current = ""
    if current != script:
        wrapper_path.write_text(script)
        wrapper_path.chmod(0o755)
    return str(wrapper_path)
