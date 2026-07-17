"""Runtime extension discovery tests."""

import json

from services.runtime_extensions import find_runtime_extension, runtime_extension_status


def test_discovers_extensions_next_to_symlinked_npm_cli(tmp_path):
    runtime = tmp_path / "runtime" / "pi"
    package_cli = runtime / "node_modules" / "@earendil-works" / "pi-coding-agent" / "dist" / "cli.js"
    package_cli.parent.mkdir(parents=True)
    package_cli.write_text("// cli")
    public_cli = runtime / "cli.js"
    public_cli.symlink_to(package_cli)
    extension = runtime / "node_modules" / "pi-web-access" / "index.ts"
    extension.parent.mkdir(parents=True)
    extension.write_text("// extension")

    assert find_runtime_extension("pi-web-access", str(public_cli)) == extension


def test_status_reports_missing_extensions_without_inventing_paths(tmp_path):
    cli = tmp_path / "cli.js"
    cli.write_text("// cli")

    status = runtime_extension_status(str(cli))

    assert {item["id"] for item in status} == {
        "pi-mcp-adapter",
        "pi-subagents",
        "pi-web-access",
        "context-mode",
    }
    assert all(item["installed"] is False and item["path"] is None for item in status)


def test_uses_extension_entrypoint_declared_by_package_manifest(tmp_path):
    runtime = tmp_path / "runtime"
    cli = runtime / "cli.js"
    cli.parent.mkdir(parents=True)
    cli.write_text("// cli")
    package = runtime / "node_modules" / "pi-subagents"
    entrypoint = package / "src" / "extension" / "index.ts"
    entrypoint.parent.mkdir(parents=True)
    entrypoint.write_text("// extension")
    (package / "package.json").write_text(json.dumps({
        "pi": {"extensions": ["./src/extension/index.ts"]},
    }))

    assert find_runtime_extension("pi-subagents", str(cli)) == entrypoint
