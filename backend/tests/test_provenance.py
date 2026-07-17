"""Provenance store and API tests."""

import pytest
from services.provenance_store import ProvenanceStore, get_store


class TestProvenanceStore:
    """Unit tests for ProvenanceStore."""

    @pytest.fixture
    def store(self, temp_workspace):
        """Create a store backed by a temp directory."""
        return ProvenanceStore(str(temp_workspace))

    @pytest.mark.anyio
    async def test_record_and_query(self, store):
        """Record provenance entries and query them back."""
        # Record an entry
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

        # Query by path
        records = await store.query(path="output.csv")
        assert len(records) == 1
        assert records[0].version == 1

        # Record a second version
        rec2 = await store.record(
            path="output.csv",
            session_id="sess-2",
            tool="edit",
            content="x,y,z\n4,5,6\n",
            diff="-a,b,c\n+x,y,z",
        )
        assert rec2.version == 2

        # Query versions
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


@pytest.mark.anyio
class TestProvenanceAPI:
    async def test_query_empty(self, client, temp_workspace):
        """GET /api/provenance returns empty when no records."""
        res = await client.get(f"/api/provenance?cwd={temp_workspace}")
        assert res.status_code == 200
        data = res.json()
        assert data["records"] == []
        assert data["total"] == 0

    async def test_record_and_query(self, client, temp_workspace):
        """POST /api/provenance/record then GET /api/provenance."""
        cwd = str(temp_workspace)
        # Record
        res = await client.post(
            f"/api/provenance/record?cwd={cwd}&path=result.csv&session_id=sess-1&tool=write&content=hello"
        )
        assert res.status_code == 200
        data = res.json()
        assert data["path"] == "result.csv"
        assert data["version"] == 1

        # Query
        res = await client.get(f"/api/provenance?cwd={cwd}")
        data = res.json()
        assert data["total"] == 1
        assert data["records"][0]["path"] == "result.csv"

    async def test_versions_endpoint(self, client, temp_workspace):
        """GET /api/provenance/versions/{path} returns version history."""
        cwd = str(temp_workspace)
        # Record v1
        await client.post(
            f"/api/provenance/record?cwd={cwd}&path=data.csv&session_id=s1&tool=write&content=v1"
        )
        # Record v2
        await client.post(
            f"/api/provenance/record?cwd={cwd}&path=data.csv&session_id=s2&tool=edit&diff=-old+new"
        )

        res = await client.get(f"/api/provenance/versions/data.csv?cwd={cwd}")
        data = res.json()
        assert data["path"] == "data.csv"
        assert len(data["versions"]) == 2

    async def test_env_lockfile_rejects_path_like_hash(self, client, temp_workspace):
        cwd = str(temp_workspace)
        res = await client.get(f"/api/provenance/env/not-a-hash?cwd={cwd}")
        assert res.status_code == 400

    async def test_capture_environment(self, client, temp_workspace):
        """POST /api/provenance/capture returns env snapshot."""
        cwd = str(temp_workspace)
        res = await client.post(f"/api/provenance/capture?cwd={cwd}")
        assert res.status_code == 200
        data = res.json()
        assert "python" in data
        assert "platform" in data
        assert "ts" in data
