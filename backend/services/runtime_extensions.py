"""Discover optional Pi runtime extensions next to the configured CLI."""

import json
from pathlib import Path
from typing import Optional

from config import PI_CLI_PATH


EXTENSION_SPECS = (
    {
        "id": "pi-mcp-adapter",
        "name": "MCP Adapter",
        "description": "Bridges configured MCP servers into Pi.",
    },
    {
        "id": "pi-subagents",
        "name": "Subagents",
        "description": "Adds focused scout, researcher, planner, worker, reviewer, and oracle agents.",
    },
    {
        "id": "pi-web-access",
        "name": "Web Access",
        "description": "Adds web search, URL fetching, and supported media extraction.",
    },
    {
        "id": "context-mode",
        "name": "Context Mode",
        "description": "Sandboxed code execution + FTS5 knowledge index for long scientific sessions.",
        "entrypoints": ("build/adapters/pi/extension.js",),
    },
)


def _candidate_roots(cli_path: str) -> list[Path]:
    raw = Path(cli_path).expanduser()
    resolved = raw.resolve(strict=False)
    roots: list[Path] = []
    for path in (raw.parent, resolved.parent, *resolved.parents):
        if path not in roots:
            roots.append(path)
    return roots


def find_runtime_package(package: str, cli_path: Optional[str] = None) -> Optional[Path]:
    """Find an installed extension package directory next to the CLI."""
    for root in _candidate_roots(cli_path or PI_CLI_PATH):
        package_dir = root / "node_modules" / package
        if package_dir.is_dir():
            return package_dir
    return None


def find_runtime_extension(
    package: str,
    cli_path: Optional[str] = None,
    extra_entrypoints: tuple[str, ...] = (),
) -> Optional[Path]:
    """Find an extension entrypoint in a local-repo or npm runtime layout."""
    for root in _candidate_roots(cli_path or PI_CLI_PATH):
        package_dir = root / "node_modules" / package
        entrypoints = []
        manifest = package_dir / "package.json"
        if manifest.is_file():
            try:
                payload = json.loads(manifest.read_text(encoding="utf-8"))
                entrypoints.extend(payload.get("pi", {}).get("extensions", []))
            except (json.JSONDecodeError, OSError, TypeError):
                pass
        entrypoints.extend(extra_entrypoints)
        entrypoints.extend(("index.ts", "index.js", "dist/index.js"))
        for entrypoint in dict.fromkeys(entrypoints):
            candidate = package_dir / entrypoint
            if candidate.is_file():
                return candidate
    return None


def runtime_extension_status(cli_path: Optional[str] = None) -> list[dict]:
    result = []
    for spec in EXTENSION_SPECS:
        path = find_runtime_extension(
            spec["id"], cli_path, extra_entrypoints=spec.get("entrypoints", ())
        )
        result.append({
            "id": spec["id"],
            "name": spec["name"],
            "description": spec["description"],
            "installed": path is not None,
            "path": str(path) if path else None,
        })
    return result
