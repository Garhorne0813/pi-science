"""Provenance store tests."""

import asyncio
import pytest
from services.provenance_store import ProvenanceStore, get_store


@pytest.mark.anyio
async def test_concurrent_records_receive_distinct_versions(tmp_path):
    store = ProvenanceStore(str(tmp_path))
    records = await asyncio.gather(*(
        store.record(path="same.csv", session_id="s", tool="write", content=str(index))
        for index in range(12)
    ))

    assert sorted(record.version for record in records) == list(range(1, 13))


class TestProvenanceStore:
    """Unit tests for ProvenanceStore."""

    @pytest.fixture
    def store(self, temp_workspace):
        """Create a store backed by a temp directory."""
        return ProvenanceStore(str(temp_workspace))

    @pytest.mark.anyio
    async def test_record_and_query(self, store):
        """Record provenance entries and query them back."""
        rec1 = await store.record(
            path="output.csv",
            session_id="sess-1",
            tool="write",
            tool_call_id="tc-1",
            model="anthropic/claude-sonnet-5",
            content="a,b,c\n1,2,3\n",
        )
        assert rec1.version == 1
        assert rec1.path == "output.csv"
        assert rec1.sessionId == "sess-1"
        assert rec1.contentHash is not None
        assert rec1.content == "a,b,c\n1,2,3\n"

        records = await store.query(path="output.csv")
        assert len(records) == 1
        assert records[0].version == 1

        rec2 = await store.record(
            path="output.csv",
            session_id="sess-2",
            tool="edit",
            content="x,y,z\n4,5,6\n",
            diff="-a,b,c\n+x,y,z",
        )
        assert rec2.version == 2

        versions = await store.get_versions("output.csv")
        assert len(versions) == 2
        assert versions[0].version == 2  # Newest first
        assert versions[1].version == 1

    @pytest.mark.anyio
    async def test_query_by_session(self, store):
        """Filter provenance by session ID."""
        await store.record(
            path="a.txt", session_id="sess-A", tool="write", content="hello"
        )
        await store.record(
            path="b.txt", session_id="sess-B", tool="write", content="world"
        )

        a_records = await store.query(session_id="sess-A")
        assert len(a_records) == 1
        assert a_records[0].path == "a.txt"

    @pytest.mark.anyio
    async def test_query_limit(self, store):
        """Query respects the limit parameter."""
        for i in range(5):
            await store.record(
                path=f"file_{i}.txt",
                session_id="sess-1",
                tool="write",
                content=f"content {i}",
            )

        records = await store.query(limit=3)
        assert len(records) == 3

    @pytest.mark.anyio
    async def test_empty_query(self, store):
        """Query on empty store returns empty list."""
        records = await store.query()
        assert records == []

    @pytest.mark.anyio
    async def test_record_count(self, store):
        """Record count tracks appended entries."""
        assert store.record_count == 0
        await store.record(path="a.txt", session_id="s1", tool="write", content="a")
        assert store.record_count == 1
        await store.record(path="b.txt", session_id="s1", tool="write", content="b")
        assert store.record_count == 2

    @pytest.mark.anyio
    async def test_content_hash_is_deterministic(self, store):
        """Same content produces same hash."""
        r1 = await store.record(
            path="a.txt", session_id="s1", tool="write", content="hello"
        )
        r2 = await store.record(
            path="a.txt", session_id="s2", tool="write", content="hello"
        )
        assert r1.contentHash == r2.contentHash

    @pytest.mark.anyio
    async def test_large_content_is_capped_but_hashes_full_content(self, store):
        content = "x" * 100_001
        record = await store.record(
            path="large.txt", session_id="s1", tool="write", content=content
        )
        assert record.content == "x" * 100_000 + "\n[truncated]"
        assert record.contentHash is not None


class TestGetStore:
    """Tests for the store singleton registry."""

    def test_same_workspace_returns_same_store(self, temp_workspace):
        store1 = get_store(str(temp_workspace))
        store2 = get_store(str(temp_workspace))
        assert store1 is store2

    def test_different_workspaces_return_different_stores(self):
        import tempfile
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            store_a = get_store(a)
            store_b = get_store(b)
            assert store_a is not store_b
