"""Session resume/fork plumbing tests that do not require the pi runtime."""

import json

import pytest

from config import get_sessions_dir
from api.sessions import _read_session_from_disk
from models import PiConfig
from services.pi_manager import PiManager


class FakePi:
    def __init__(self, cwd: str):
        self.cwd = cwd
        self.session_id = "active-session"
        self.is_alive = True
        self.calls: list[tuple[str, dict]] = []

    async def send_command(self, command: str, **params):
        self.calls.append((command, params))
        return {"success": True}


def _write_session(cwd, session_id: str):
    session_dir = get_sessions_dir(str(cwd)) / "encoded"
    session_dir.mkdir(parents=True)
    path = session_dir / f"{session_id}.jsonl"
    path.write_text(json.dumps({"type": "session", "id": session_id}) + "\n")
    return path


def test_find_session_file_uses_exact_session_id(tmp_path):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    assert mgr._find_session_file("session-123", str(tmp_path)) == path.resolve()
    assert mgr._find_session_file("session-12", str(tmp_path)) is None


def test_read_session_history_uses_workspace_cwd(tmp_path):
    session_dir = get_sessions_dir(str(tmp_path)) / "encoded"
    session_dir.mkdir(parents=True)
    path = session_dir / "session-456.jsonl"
    path.write_text(
        json.dumps({"type": "session", "id": "session-456"})
        + "\n"
        + json.dumps({
            "type": "message",
            "id": "message-1",
            "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]},
        })
        + "\n"
    )
    messages = _read_session_from_disk("session-456", str(tmp_path))
    assert messages[0]["content"][0]["text"] == "hello"


@pytest.mark.anyio
async def test_resume_session_switches_existing_process(tmp_path):
    mgr = PiManager()
    path = _write_session(tmp_path, "session-123")
    cwd = str(tmp_path.resolve())
    fake = FakePi(cwd)
    mgr._processes[cwd] = fake
    mgr._session_map[fake.session_id] = cwd

    resumed = await mgr.resume_session("session-123", cwd, PiConfig())

    assert resumed is fake
    assert fake.calls == [("switch_session", {"sessionPath": str(path.resolve())})]
