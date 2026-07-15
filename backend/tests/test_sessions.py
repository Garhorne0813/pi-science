"""Tests for session API endpoints — compact, export, and session lifecycle."""

import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from main import app
from models import PiConfig


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    """Async HTTP test client."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


# ── Compact endpoint ──

class TestCompactEndpoint:
    @pytest.mark.anyio
    async def test_compact_session_not_found(self, client):
        """Compact should return error for non-existent session."""
        with patch("api.sessions.pi_manager") as mock_mgr:
            mock_mgr.get_by_session.return_value = None
            res = await client.post("/api/sessions/nonexistent/compact")
            assert res.status_code == 200
            data = res.json()
            assert data["ok"] is False

    @pytest.mark.anyio
    async def test_compact_forwards_to_pi(self, client):
        """Compact should send 'compact' command to pi process."""
        mock_pi = MagicMock()
        mock_pi.send_command = AsyncMock(return_value={"success": True})

        with patch("api.sessions.pi_manager") as mock_mgr:
            mock_mgr.get_by_session.return_value = mock_pi
            res = await client.post("/api/sessions/test-session/compact")
            assert res.status_code == 200
            data = res.json()
            assert data["ok"] is True
            mock_pi.send_command.assert_called_once_with("compact")


# ── Export endpoint ──

class TestExportEndpoint:
    @pytest.mark.anyio
    async def test_export_session_not_found(self, client, temp_workspace):
        """Export should 404 when session has no messages on disk or in memory."""
        with patch("api.sessions.pi_manager") as mock_mgr:
            mock_mgr.get_by_session.return_value = None
            # No session on disk either (temp_workspace has no .pi-science)
            res = await client.get("/api/sessions/nonexistent/export?format=html")
            assert res.status_code == 404

    @pytest.mark.anyio
    async def test_export_html_empty_session(self, client):
        """Export HTML for a session with messages returns HTML."""
        with patch("api.sessions._read_session_from_disk") as mock_read:
            mock_read.return_value = [
                {
                    "id": "msg-1",
                    "role": "user",
                    "content": [{"type": "text", "text": "Hello"}],
                    "timestamp": "2026-01-01T00:00:00Z",
                },
                {
                    "id": "msg-2",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Hi there!"}],
                    "timestamp": "2026-01-01T00:00:01Z",
                },
            ]
            res = await client.get("/api/sessions/test-session/export?format=html")
            assert res.status_code == 200
            html = res.text
            assert "<!DOCTYPE html>" in html
            assert "Hello" in html
            assert "Hi there!" in html

    @pytest.mark.anyio
    async def test_export_jsonl_empty_session(self, client):
        """Export JSONL for a session with messages returns NDJSON."""
        with patch("api.sessions._read_session_from_disk") as mock_read:
            mock_read.return_value = [
                {
                    "id": "msg-1",
                    "role": "user",
                    "content": [{"type": "text", "text": "Hello"}],
                    "timestamp": "2026-01-01T00:00:00Z",
                },
            ]
            res = await client.get("/api/sessions/test-session/export?format=jsonl")
            assert res.status_code == 200
            assert res.headers["content-type"] == "application/x-ndjson"
            lines = res.text.strip().split("\n")
            assert len(lines) == 1
            assert json.loads(lines[0])["role"] == "user"

    @pytest.mark.anyio
    async def test_export_html_default_format(self, client):
        """Export without format parameter defaults to HTML."""
        with patch("api.sessions._read_session_from_disk") as mock_read:
            mock_read.return_value = [
                {
                    "id": "msg-1",
                    "role": "user",
                    "content": [{"type": "text", "text": "test"}],
                    "timestamp": "2026-01-01T00:00:00Z",
                },
            ]
            res = await client.get("/api/sessions/test-session/export")
            assert res.status_code == 200
            assert "<!DOCTYPE html>" in res.text


# ── Session CRUD edge cases ──

class TestSessionCrud:
    @pytest.mark.anyio
    async def test_list_sessions_empty_dir(self, client, temp_workspace):
        """List sessions returns empty list for directory with no sessions."""
        res = await client.get(
            "/api/sessions",
            params={"cwd": str(temp_workspace)},
        )
        assert res.status_code == 200
        assert res.json() == []

    @pytest.mark.anyio
    async def test_delete_nonexistent(self, client):
        """Delete non-existent session returns ok:false with error."""
        with patch("api.sessions.pi_manager") as mock_mgr:
            mock_mgr.get_by_session.return_value = None
            res = await client.delete("/api/sessions/nonexistent?cwd=.")
            assert res.status_code == 200
            data = res.json()
            assert data["ok"] is False
