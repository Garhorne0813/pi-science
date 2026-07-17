"""Event normalizer unit tests — pi JSONL → SSE event format."""

from services.event_normalizer import normalize_event


class TestNormalizeEvent:
    """Tests for normalize_event() converting pi RPC events to SSE."""

    def test_text_delta_becomes_text_updated(self):
        event = {
            "type": "message_update",
            "message": {"id": "msg-1", "role": "assistant"},
            "assistantMessageEvent": {"type": "text_delta", "text": "Hello world"},
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "text.updated"
        assert result["sessionId"] == "session-1"
        assert result["text"] == "Hello world"

    def test_message_start_user_returns_none(self):
        """User messages are already in the frontend, skip SSE."""
        event = {
            "type": "message_start",
            "message": {"id": "msg-1", "role": "user"},
        }
        result = normalize_event(event, "session-1")
        assert result is None

    def test_message_start_assistant_returns_empty_text(self):
        """Assistant start creates an empty text.updated placeholder."""
        event = {
            "type": "message_start",
            "message": {"id": "msg-1", "role": "assistant"},
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "text.updated"
        assert result["text"] == ""

    def test_tool_execution_start(self):
        event = {
            "type": "tool_execution_start",
            "toolCallId": "tc-1",
            "toolName": "read",
            "args": {"file_path": "data.csv"},
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "tool.updated"
        assert result["status"] == "running"
        assert result["tool"] == "read"
        assert result["callId"] == "tc-1"
        assert result["input"] == {"file_path": "data.csv"}

    def test_tool_execution_end_success(self):
        event = {
            "type": "tool_execution_end",
            "toolCallId": "tc-1",
            "toolName": "read",
            "result": {"output": "file content here"},
            "isError": False,
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "tool.updated"
        assert result["status"] == "done"

    def test_tool_execution_end_error(self):
        event = {
            "type": "tool_execution_end",
            "toolCallId": "tc-1",
            "toolName": "bash",
            "result": "command not found",
            "isError": True,
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "tool.updated"
        assert result["status"] == "error"

    def test_agent_settled(self):
        event = {"type": "agent_settled"}
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "session.idle"

    def test_extension_handled_settled_preserves_marker(self):
        result = normalize_event(
            {"type": "agent_settled", "handledWithoutTurn": True},
            "session-1",
        )

        assert result["handledWithoutTurn"] is True

    def test_tool_update_partial_output(self):
        event = {
            "type": "tool_execution_update",
            "toolCallId": "tc-1",
            "toolName": "bash",
            "args": {"command": "pip install numpy"},
            "partialResult": "Collecting numpy...",
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "tool.updated"
        assert result["status"] == "running"
        assert "Collecting numpy" in result["partialOutput"]

    def test_tool_update_without_identity_preserves_frontend_fallback(self):
        event = {
            "type": "tool_execution_update",
            "toolCallId": "tc-1",
            "partialResult": "still running",
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["tool"] == ""
        assert "input" not in result

    def test_tool_end_without_identity_preserves_frontend_fallback(self):
        event = {
            "type": "tool_execution_end",
            "toolCallId": "tc-1",
            "result": "done",
            "isError": False,
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["tool"] == ""

    def test_error_event(self):
        event = {"type": "error", "message": "Connection refused"}
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "error"
        assert "Connection refused" in result["message"]

    def test_extension_ui_confirm(self):
        event = {
            "type": "extension_ui_request",
            "id": "ext-1",
            "method": "confirm",
            "title": "Confirmation",
            "message": "Allow this operation?",
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "permission.asked"
        assert result["title"] == "Confirmation"

    def test_extension_ui_select_preserves_question_fields(self):
        event = {
            "type": "extension_ui_request",
            "id": "ext-2",
            "method": "select",
            "title": "Choose",
            "message": "Pick one",
            "options": ["A", "B"],
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["type"] == "question.asked"
        assert result["message"] == "Pick one"
        assert result["options"] == ["A", "B"]

    def test_unknown_event_returns_none(self):
        event = {"type": "unknown_thing", "data": "whatever"}
        result = normalize_event(event, "session-1")
        assert result is None

    def test_edit_tool_extracts_diff(self):
        event = {
            "type": "tool_execution_end",
            "toolCallId": "tc-2",
            "toolName": "edit",
            "result": {"diff": "-old line\n+new line"},
            "isError": False,
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert result["diff"] == "-old line\n+new line"

    def test_stringify_complex_result(self):
        """Result objects are stringified for display."""
        event = {
            "type": "tool_execution_end",
            "toolCallId": "tc-3",
            "toolName": "write",
            "result": {"output": "File written", "path": "/tmp/test.txt"},
            "isError": False,
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert "File written" in result.get("output", "")

    def test_large_tool_payloads_are_bounded(self):
        event = {
            "type": "tool_execution_start",
            "toolCallId": "tc-large",
            "toolName": "write",
            "args": {"content": "x" * 50000},
        }
        result = normalize_event(event, "session-1")
        assert result is not None
        assert len(result["input"]["content"]) < 25000
        assert "truncated" in result["input"]["content"]


class TestStringify:
    """Edge cases for _stringify_result helper."""

    def _call(self, result):
        from services.event_normalizer import _stringify_result
        return _stringify_result(result)

    def test_none(self):
        assert self._call(None) == ""

    def test_string(self):
        assert self._call("hello") == "hello"

    def test_dict_with_output_key(self):
        assert self._call({"output": "result"}) == "result"

    def test_dict_with_text_key(self):
        assert self._call({"text": "content"}) == "content"

    def test_dict_with_result_key(self):
        assert self._call({"result": "42"}) == "42"

    def test_dict_no_common_keys(self):
        r = self._call({"custom": "data"})
        assert "custom" in r  # Falls back to str(dict)
