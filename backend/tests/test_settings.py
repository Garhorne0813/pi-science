"""Settings API tests — API keys, model config, providers."""

import json
import os
import pytest


@pytest.mark.anyio
class TestSettingsAPI:
    async def test_list_providers(self, client):
        """GET /api/settings/providers returns supported providers."""
        res = await client.get("/api/settings/providers")
        assert res.status_code == 200
        data = res.json()
        assert "providers" in data
        providers = data["providers"]
        assert len(providers) > 0
        # Each provider has id, name, models, has_key
        for p in providers:
            assert "id" in p
            assert "name" in p
            assert "models" in p
            assert "has_key" in p

    async def test_get_config(self, client, temp_config_dir):
        """GET /api/settings/config returns current config."""
        res = await client.get("/api/settings/config")
        assert res.status_code == 200
        data = res.json()
        assert "api_keys" in data
        assert "model" in data
        assert "thinking" in data
        assert "providers" in data

    async def test_set_and_delete_api_key(self, client, temp_config_dir):
        """PUT /api/settings/api-key stores a key; DELETE removes it."""
        # Set
        res = await client.put(
            "/api/settings/api-key",
            json={"provider": "anthropic", "api_key": "sk-ant-test123"},
        )
        assert res.status_code == 200
        assert res.json()["ok"] is True

        # Verify config file was written
        config_path = temp_config_dir / "config.json"
        assert config_path.exists()
        stored = json.loads(config_path.read_text())
        assert stored["api_keys"]["anthropic"] == "sk-ant-test123"

        # Delete
        res = await client.delete("/api/settings/api-key/anthropic")
        assert res.status_code == 200
        assert res.json()["ok"] is True

        # Verify removed
        stored = json.loads(config_path.read_text())
        assert "anthropic" not in stored.get("api_keys", {})

    async def test_set_api_key_unknown_provider(self, client, temp_config_dir):
        """PUT with unknown provider returns 400."""
        res = await client.put(
            "/api/settings/api-key",
            json={"provider": "unknown-llm", "api_key": "sk-xxx"},
        )
        assert res.status_code == 400

    async def test_set_model(self, client, temp_config_dir):
        """PUT /api/settings/model updates config."""
        res = await client.put(
            "/api/settings/model",
            json={"model": "openai/gpt-5.1", "thinking": "medium"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["model"] == "openai/gpt-5.1"

        # Verify persisted
        config_path = temp_config_dir / "config.json"
        stored = json.loads(config_path.read_text())
        assert stored["model"] == "openai/gpt-5.1"
        assert stored["thinking"] == "medium"

    async def test_config_defaults(self, client, temp_config_dir):
        """Without any config file, defaults are returned."""
        res = await client.get("/api/settings/config")
        data = res.json()
        assert data["model"] == "anthropic/claude-sonnet-5-20250929"
        assert data["thinking"] == "high"
        # No keys set
        assert not any(data["api_keys"].values())

    async def test_custom_provider_discover_and_save(self, client, temp_config_dir, monkeypatch):
        import api.settings as settings

        monkeypatch.setattr(settings, "_fetch_custom_models", lambda base_url, api_key: ["luna-small", "luna-max"])
        discovered = await client.post(
            "/api/settings/custom-providers/discover",
            json={
                "name": "Luna Gateway",
                "base_url": "https://llm.example.com/v1",
                "api_key": "sk-custom",
            },
        )
        assert discovered.status_code == 200
        provider = discovered.json()["provider"]
        assert provider["id"] == "luna-gateway"
        assert provider["models"] == ["luna-small", "luna-max"]
        assert provider["has_key"] is True

        saved = await client.put(
            f"/api/settings/custom-providers/{provider['id']}",
            json={
                "name": provider["name"],
                "base_url": provider["base_url"],
                "api_key": "sk-custom",
                "api": provider["api"],
                "models": provider["models"],
            },
        )
        assert saved.status_code == 200
        config = await client.get("/api/settings/config")
        data = config.json()
        assert data["custom_providers"][0]["has_key"] is True
        assert "custom-luna-gateway/luna-max" in {m["id"] for m in data["available_models"]}
        assert "api_key" not in data["custom_providers"][0]

    def test_custom_models_runtime_uses_env_backed_key(self, temp_config_dir):
        from api.settings import _save_config, get_custom_models_runtime

        _save_config({
            "custom_providers": [{
                "id": "luna-gateway",
                "name": "Luna Gateway",
                "base_url": "https://llm.example.com/v1",
                "api": "openai-completions",
                "api_key": "sk-custom",
                "models": ["luna-max"],
            }]
        })
        agent_dir, env = get_custom_models_runtime("/tmp/workspace")
        assert agent_dir is not None
        assert env["PI_SCIENCE_CUSTOM_LUNA_GATEWAY_API_KEY"] == "sk-custom"
        payload = json.loads((agent_dir / "models.json").read_text())
        assert payload["providers"]["custom-luna-gateway"]["models"][0]["id"] == "luna-max"
        assert payload["providers"]["custom-luna-gateway"]["apiKey"].startswith("$")


class TestProviderEnvMap:
    """Tests for PROVIDER_ENV_MAP in settings module."""

    def test_all_providers_have_env_vars(self):
        from api.settings import PROVIDER_ENV_MAP, PROVIDERS
        provider_ids = {p["id"] for p in PROVIDERS}
        mapped_ids = set(PROVIDER_ENV_MAP.keys())
        # All PROVIDERS should have an env var mapping
        for pid in provider_ids:
            assert pid in mapped_ids, f"Provider {pid} missing from PROVIDER_ENV_MAP"


class TestGetEnvWithKeys:
    """Tests for get_env_with_keys()."""

    def test_injects_stored_keys(self, temp_config_dir):
        from api.settings import _save_config, get_env_with_keys

        _save_config({"api_keys": {"deepseek": "sk-test-deepseek"}})

        env = get_env_with_keys()
        assert env["DEEPSEEK_API_KEY"] == "sk-test-deepseek"

    def test_env_var_takes_priority(self, temp_config_dir):
        from api.settings import _save_config, get_env_with_keys

        os.environ["DEEPSEEK_API_KEY"] = "sk-from-env"
        _save_config({"api_keys": {"deepseek": "sk-from-config"}})

        env = get_env_with_keys()
        # Env var takes priority over config
        assert env["DEEPSEEK_API_KEY"] == "sk-from-env"

        del os.environ["DEEPSEEK_API_KEY"]


@pytest.mark.anyio
class TestMcpSettings:
    async def test_mcp_runtime_config_filters_enabled_servers(self, client, temp_config_dir):
        from api.settings import _save_config, get_mcp_runtime_config

        source = temp_config_dir / "mcp.json"
        source.write_text(json.dumps({
            "mcpServers": {
                "paper-search": {"command": "paper-search"},
                "biomcp": {"command": "biomcp"},
            }
        }))
        _save_config({"mcp_servers": ["paper-search"]})

        runtime = get_mcp_runtime_config()
        assert runtime is not None
        generated = json.loads(runtime.read_text())
        assert list(generated["mcpServers"]) == ["paper-search"]

        res = await client.get("/api/settings/mcp")
        assert res.status_code == 200
        assert res.json()["configured"] == ["biomcp", "paper-search"]
        assert res.json()["servers"] == ["paper-search"]

    async def test_mcp_toggle_updates_runtime_config(self, client, temp_config_dir):
        from api.settings import _save_config

        source = temp_config_dir / "mcp.json"
        source.write_text(json.dumps({
            "mcpServers": {
                "paper-search": {"command": "paper-search"},
                "biomcp": {"command": "biomcp"},
            }
        }))
        _save_config({})

        res = await client.put("/api/settings/mcp/biomcp?enabled=false")
        assert res.status_code == 200
        data = res.json()
        assert data["enabled"] is False
        runtime = json.loads((temp_config_dir / "mcp-runtime.json").read_text())
        assert "biomcp" not in runtime["mcpServers"]
