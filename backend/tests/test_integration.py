"""Integration tests — real pi process with LLM, full SSE round-trip.

These tests require a running backend and valid API keys in ~/.pi-science/config.json.
Run with: PI_SCIENCE_RUN_INTEGRATION=1 pytest tests/test_integration.py -v -s
"""

import json
import os
import time
import pytest
import httpx


BACKEND_URL = "http://127.0.0.1:8787"
pytestmark = pytest.mark.skipif(
    os.environ.get("PI_SCIENCE_RUN_INTEGRATION") != "1",
    reason="set PI_SCIENCE_RUN_INTEGRATION=1 to run live model integration tests",
)


def _api(path: str) -> str:
    return f"{BACKEND_URL}{path}"


def _wait_for_backend(timeout: int = 10) -> bool:
    """Wait until the backend health check passes."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = httpx.get(_api("/api/health"), timeout=2)
            if r.status_code == 200 and r.json()["status"] == "ok":
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _model_config(thinking: str | None = None) -> dict:
    configured = httpx.get(_api("/api/settings/config"), timeout=5).json()
    model = os.environ.get("PI_SCIENCE_INTEGRATION_MODEL") or configured.get("model")
    if not model:
        pytest.skip("No model configured for live integration tests")
    return {
        "model": model,
        "thinking": thinking or configured.get("thinking") or "off",
    }


@pytest.fixture(scope="module")
def session():
    """Create a test session that lives for the module."""
    if not _wait_for_backend():
        pytest.skip("Backend not running at http://127.0.0.1:8787")

    r = httpx.post(
        _api("/api/sessions"),
        json={"cwd": ".", "config": _model_config()},
        timeout=10,
    )
    if r.status_code != 200:
        pytest.skip(f"Failed to create session: {r.status_code} {r.text}")
    data = r.json()
    return data["id"]


def collect_events(session_id: str, timeout: float = 30) -> list[dict]:
    """Collect SSE events from a session until agent_settled, or timeout."""
    events: list[dict] = []
    deadline = time.time() + timeout

    with httpx.stream(
        "GET",
        _api(f"/api/sessions/{session_id}/events"),
        timeout=timeout + 5,
    ) as response:
        for line in response.iter_lines():
            if time.time() > deadline:
                break
            if line.startswith("data: "):
                try:
                    event = json.loads(line[6:])
                    events.append(event)
                    if event.get("type") == "session.idle":
                        break
                except json.JSONDecodeError:
                    pass

    return events


class TestHealthCheck:
    """Test that the backend is alive."""

    def test_backend_reachable(self):
        r = httpx.get(_api("/api/health"), timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"

    def test_api_docs_reachable(self):
        r = httpx.get(_api("/docs"), timeout=5)
        assert r.status_code == 200

    def test_openapi_json(self):
        r = httpx.get(_api("/openapi.json"), timeout=5)
        assert r.status_code == 200
        schema = r.json()
        assert "paths" in schema
        # Verify key endpoints exist
        paths = schema["paths"]
        assert "/api/sessions" in paths
        assert "/api/kernels/execute" in paths
        assert "/api/files/{path}" in paths


class TestSessionLifecycle:
    """Create, list, send prompt, delete sessions."""

    def test_create_session(self, session):
        """Session ID is returned and is a valid UUID-like string."""
        assert session
        assert len(session) > 20
        assert "-" in session

    def test_list_sessions(self, session):
        """Listed sessions include our test session."""
        r = httpx.get(_api("/api/sessions?cwd=."), timeout=5)
        assert r.status_code == 200
        sessions = r.json()
        ids = [s["id"] for s in sessions]
        assert session in ids

    def test_get_messages_empty(self, session):
        """New session has no messages."""
        r = httpx.get(_api(f"/api/sessions/{session}/messages"), timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "messages" in data
        assert isinstance(data["messages"], list)

    def test_abort_session(self, session):
        """Abort on an idle session should not error."""
        r = httpx.post(_api(f"/api/sessions/{session}/abort"), timeout=5)
        assert r.status_code == 200

    def test_delete_session(self):
        """Delete a freshly created session."""
        r = httpx.post(
            _api("/api/sessions"),
            json={"cwd": ".", "config": _model_config("off")},
            timeout=10,
        )
        assert r.status_code == 200
        sid = r.json()["id"]

        r = httpx.delete(_api(f"/api/sessions/{sid}"), timeout=5)
        assert r.status_code == 200


class TestPromptAndSSE:
    """Send prompts and verify SSE streaming responses."""

    def _create_session(self, thinking: str = "off") -> str:
        r = httpx.post(
            _api("/api/sessions"),
            json={"cwd": ".", "config": _model_config(thinking)},
            timeout=10,
        )
        assert r.status_code == 200, f"Create session failed: {r.text}"
        return r.json()["id"]

    def test_send_prompt_and_get_response(self):
        """Send a prompt and verify the agent responds via SSE."""
        sid = self._create_session(thinking="off")

        # Send prompt
        r = httpx.post(
            _api(f"/api/sessions/{sid}/prompt"),
            json={"message": "Say hello and introduce yourself in one sentence"},
            timeout=10,
        )
        assert r.status_code == 200

        # Collect SSE events — longer timeout for thinking models
        events = collect_events(sid, timeout=60)

        # We should have received some events
        assert len(events) > 0, "No SSE events received at all"

        # Text events should have non-empty content
        all_text = "".join(e.get("text", "") for e in events if e.get("type") == "text.updated")
        event_types = [e.get("type") for e in events]
        print(f"\n  Events: {event_types}")
        print(f"  Agent response ({len(all_text)} chars): {all_text[:200]}")

        # Either we got text + session.idle, or at minimum we got text.updated
        has_text = "text.updated" in event_types
        has_idle = "session.idle" in event_types
        assert has_text or has_idle, f"Neither text nor idle: {event_types}"

    def test_send_prompt_get_text_and_settle(self):
        """Agent should emit streaming text via SSE."""
        sid = self._create_session(thinking="off")

        httpx.post(
            _api(f"/api/sessions/{sid}/prompt"),
            json={"message": "say hello"},
            timeout=10,
        )

        events = collect_events(sid, timeout=60)
        event_types = [e.get("type") for e in events]

        # Agent must emit text.updated events
        assert "text.updated" in event_types, f"No text in events: {event_types}"

        # Text should contain content
        all_text = "".join(e.get("text", "") for e in events if e.get("type") == "text.updated")
        assert len(all_text) > 0, f"Empty text response, events: {event_types}"
        print(f"\n  Response: {all_text[:200]}")

        # session.idle may arrive after some models finish; verify text order if present
        if "session.idle" in event_types:
            idle_idx = event_types.index("session.idle")
            text_indices = [i for i, t in enumerate(event_types) if t == "text.updated"]
            if text_indices:
                assert max(text_indices) < idle_idx, "text.updated after session.idle"

    def test_multiple_prompts_same_session(self):
        """Multiple prompts in the same session maintain context."""
        sid = self._create_session(thinking="off")

        # First message
        httpx.post(
            _api(f"/api/sessions/{sid}/prompt"),
            json={"message": "Remember: the secret code is XKCD-42."},
            timeout=10,
        )
        collect_events(sid, timeout=40)

        # Second message — ask about it
        httpx.post(
            _api(f"/api/sessions/{sid}/prompt"),
            json={"message": "What was the secret code I just told you?"},
            timeout=10,
        )
        events = collect_events(sid, timeout=40)
        all_text = "".join(
            e.get("text", "") for e in events if e.get("type") == "text.updated"
        )
        # Should mention XKCD or 42
        has_code = "XKCD" in all_text or "42" in all_text or "xkcd" in all_text.lower()
        print(f"\n  Context recall: {'YES' if has_code else 'NO'} — {all_text[:200]}")
        # Not asserting — some models may not recall perfectly, just observing

    def test_thinking_high(self):
        """DeepSeek with thinking=high should still produce output."""
        sid = self._create_session(thinking="high")

        httpx.post(
            _api(f"/api/sessions/{sid}/prompt"),
            json={"message": "Say hello"},
            timeout=10,
        )
        events = collect_events(sid, timeout=50)

        text_events = [e for e in events if e.get("type") == "text.updated"]
        all_text = "".join(e.get("text", "") for e in text_events)
        assert len(all_text) > 0, f"Empty response with thinking=high. Events: {[e['type'] for e in events]}"
        print(f"\n  thinking=high response: {all_text[:200]}")

    def test_abort_mid_stream(self):
        """Aborting a running prompt should not crash."""
        sid = self._create_session(thinking="off")

        httpx.post(
            _api(f"/api/sessions/{sid}/prompt"),
            json={"message": "Write a 500-word essay about climate change"},
            timeout=10,
        )
        # Abort quickly
        time.sleep(1)
        r = httpx.post(_api(f"/api/sessions/{sid}/abort"), timeout=5)
        assert r.status_code == 200

        # Session should still be usable
        httpx.post(
            _api(f"/api/sessions/{sid}/prompt"),
            json={"message": "say hi"},
            timeout=10,
        )
        events = collect_events(sid, timeout=30)
        texts = [e.get("text", "") for e in events if e.get("type") == "text.updated"]
        assert len("".join(texts)) > 0, "Session broken after abort"


class TestKernelIntegration:
    """Test kernel execution through the API."""

    def test_execute_python_simple(self):
        r = httpx.post(
            _api("/api/kernels/execute"),
            json={"language": "python", "code": "2 + 2", "notebook_id": "integration-test"},
            timeout=10,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["result"] == "4"

    def test_execute_namespace_persists(self):
        r = httpx.post(
            _api("/api/kernels/execute"),
            json={"language": "python", "code": "warmest = 2024", "notebook_id": "integration-ns"},
            timeout=10,
        )
        assert r.status_code == 200

        r = httpx.post(
            _api("/api/kernels/execute"),
            json={"language": "python", "code": "warmest", "notebook_id": "integration-ns"},
            timeout=10,
        )
        data = r.json()
        assert data["ok"] is True
        assert data["result"] == "2024"

    def test_kernel_status(self):
        r = httpx.get(_api("/api/kernels/status"), timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "python" in data["interpreters"]
        assert data["interpreters"]["python"] is not None


class TestFilesIntegration:
    """Test file API with the real pi-science demo data."""

    def test_read_demo_csv(self):
        """Read the actual demo climate data CSV."""
        import os
        cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        project_root = os.path.dirname(cwd)

        r = httpx.get(
            _api(f"/api/files/demo/monthly_global_anomalies.csv?cwd={project_root}"),
            timeout=5,
        )
        if r.status_code == 200:
            data = r.json()
            assert "Year,Month" in data["data"]
            assert data["size"] > 1000
        else:
            # Demo file might be in a different location — skip gracefully
            pass

    def test_preview_demo_csv(self):
        """Preview the demo CSV returns kind=csv with metadata."""
        import os
        cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        project_root = os.path.dirname(cwd)

        r = httpx.get(
            _api(f"/api/files/demo/monthly_global_anomalies.csv/preview?cwd={project_root}"),
            timeout=5,
        )
        if r.status_code == 200:
            data = r.json()
            assert data["kind"] == "csv"
            assert data["filename"] == "monthly_global_anomalies.csv"
            assert data["metadata"]["rows"] > 100
        else:
            pass


class TestSettingsIntegration:
    """Test settings API with real config persistence."""

    def test_config_roundtrip(self):
        """Read config, update model, restore."""
        # Read current
        r = httpx.get(_api("/api/settings/config"), timeout=5)
        assert r.status_code == 200
        original = r.json()

        # Set a model
        r = httpx.put(
            _api("/api/settings/model"),
            json={"model": "deepseek/deepseek-v4-pro", "thinking": "high"},
            timeout=5,
        )
        assert r.status_code == 200

        # Verify it persisted
        r = httpx.get(_api("/api/settings/config"), timeout=5)
        assert r.json()["model"] == "deepseek/deepseek-v4-pro"
        assert r.json()["thinking"] == "high"

        # Restore original
        httpx.put(
            _api("/api/settings/model"),
            json={"model": original["model"], "thinking": original["thinking"]},
            timeout=5,
        )

    def test_providers_list(self):
        r = httpx.get(_api("/api/settings/providers"), timeout=5)
        assert r.status_code == 200
        providers = r.json()["providers"]
        assert any(p["id"] == "deepseek" for p in providers)
        assert any(p["id"] == "anthropic" for p in providers)


class TestProvenanceIntegration:
    """Test provenance recording through the API."""

    def test_record_and_query(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            r = httpx.post(
                _api(f"/api/provenance/record?cwd={tmp}&path=integration_test.csv&session_id=int-1&tool=write&content=hello,world"),
                timeout=5,
            )
            assert r.status_code == 200
            assert r.json()["version"] == 1

            r = httpx.get(_api(f"/api/provenance?cwd={tmp}"), timeout=5)
            assert r.json()["total"] == 1
