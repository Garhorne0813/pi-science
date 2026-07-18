"""Session skill snapshot and event persistence tests."""

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

