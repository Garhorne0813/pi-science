"""Session skill snapshot and event persistence tests."""

from pathlib import Path

import aiofiles
import pytest

from services.session_manifest import (
    append_session_skill_snapshot,
    append_skill_event,
    read_session_skills,
    read_skill_events,
)


@pytest.mark.anyio
async def test_session_skill_snapshot_is_redacted_and_readable(temp_workspace):
    await append_session_skill_snapshot(
        str(temp_workspace),
        "session-1",
        [{"skill_id": "id", "name": "demo", "digest": "hash", "source": "project", "enabled": True, "path": "/secret"}],
    )
    await append_skill_event(str(temp_workspace), "session-1", "skill_loaded", skill_id="id", skill_name="demo")
    snapshot = await read_session_skills(str(temp_workspace), "session-1")
    assert snapshot["skills"] == [{"skill_id": "id", "name": "demo", "digest": "hash", "source": "project", "enabled": True}]
    events = await read_skill_events(str(temp_workspace), "session-1")
    assert events[0]["event"] == "skill_loaded"
    assert "path" not in events[0]


@pytest.mark.anyio
async def test_manifest_falls_back_when_workspace_file_is_not_writable(tmp_path, monkeypatch):
    import services.session_manifest as manifest

    workspace = tmp_path / "workspace"
    (workspace / ".pi-science").mkdir(parents=True)
    fallback_root = tmp_path / "runtime"
    monkeypatch.setattr(manifest, "BASE_DIR", fallback_root)
    real_open = aiofiles.open

    def permission_denied_for_workspace(file, *args, **kwargs):
        if Path(file).is_relative_to(workspace):
            raise PermissionError("workspace metadata is read-only")
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(manifest.aiofiles, "open", permission_denied_for_workspace)

    await append_session_skill_snapshot(str(workspace), "session-1", [{"name": "demo"}])
    await append_skill_event(str(workspace), "session-1", "skill_loaded", skill_name="demo")

    assert (await read_session_skills(str(workspace), "session-1"))["skills"][0]["name"] == "demo"
    assert (await read_skill_events(str(workspace), "session-1"))[0]["event"] == "skill_loaded"
    assert list((fallback_root / "workspace-metadata").glob("*/session-skills.jsonl"))
