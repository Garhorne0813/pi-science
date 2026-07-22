"""Settings API tests — API keys, model config, providers."""

import json
import os
import pytest


@pytest.mark.anyio
class TestSettingsAPI:
    async def test_runtime_extensions_reports_real_discovery(self, client, monkeypatch):
        import api.settings as settings

        monkeypatch.setattr(settings, "runtime_extension_status", lambda: [{
            "id": "pi-web-access",
            "name": "Web Access",
            "description": "Web tools",
            "installed": True,
            "path": "/runtime/node_modules/pi-web-access/index.ts",
        }])

        res = await client.get("/api/settings/extensions")

        assert res.status_code == 200
        assert res.json()["extensions"][0]["installed"] is True

    async def test_web_access_settings_hide_keys_and_inject_environment(self, client, temp_config_dir):
        from api.settings import get_env_with_keys, get_web_access_runtime

        saved = await client.put(
            "/api/settings/web-access",
            json={
                "provider": "tavily",
                "workflow": "auto-summary",
                "api_keys": {"tavily": "tvly-secret"},
            },
        )
        assert saved.status_code == 200
        assert saved.json()["provider"] == "tavily"
        tavily = next(item for item in saved.json()["providers"] if item["id"] == "tavily")
        assert tavily["has_key"] is True
        assert "tvly-secret" not in saved.text

        public = await client.get("/api/settings/web-access")
        assert public.status_code == 200
        assert "tvly-secret" not in public.text
        assert get_env_with_keys()["TAVILY_API_KEY"] == "tvly-secret"

        runtime_dir = get_web_access_runtime("/tmp/example-workspace")
        materialized = json.loads((runtime_dir / "web-search.json").read_text())
        assert materialized == {"provider": "tavily", "workflow": "auto-summary"}
        assert "tvly-secret" not in (runtime_dir / "web-search.json").read_text()

        removed = await client.put(
            "/api/settings/web-access",
            json={"provider": "auto", "workflow": "none", "remove_keys": ["tavily"]},
        )
        assert removed.status_code == 200
        tavily = next(item for item in removed.json()["providers"] if item["id"] == "tavily")
        assert tavily["has_key"] is False

    async def test_project_subagent_crud(self, client, temp_workspace):
        params = {"cwd": str(temp_workspace)}
        payload = {
            "name": "literature-auditor",
            "description": "Checks scientific sources",
            "prompt": "Review sources and report unsupported claims.",
            "model": "deepseek/deepseek-v4-flash",
            "thinking": "high",
            "tools": "read, grep, find, ls",
            "system_prompt_mode": "append",
            "inherit_project_context": True,
            "inherit_skills": True,
            "default_context": "fresh",
        }
        saved = await client.put(
            "/api/settings/subagents/literature-auditor",
            params=params,
            json=payload,
        )
        assert saved.status_code == 200
        assert saved.json()["restart_required"] is True
        agent_file = temp_workspace / ".pi" / "agents" / "literature-auditor.md"
        assert agent_file.is_file()
        assert "name: literature-auditor" in agent_file.read_text()

        listed = await client.get("/api/settings/subagents", params=params)
        assert listed.status_code == 200
        assert listed.json()["agents"][0]["name"] == "literature-auditor"
        assert listed.json()["agents"][0]["prompt"].startswith("Review sources")

        rejected = await client.put(
            "/api/settings/subagents/../escape",
            params=params,
            json={**payload, "name": "../escape"},
        )
        assert rejected.status_code in {400, 404}

        deleted = await client.delete(
            "/api/settings/subagents/literature-auditor",
            params=params,
        )
        assert deleted.status_code == 200
        assert not agent_file.exists()

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
        key_response = await client.put(
            "/api/settings/api-key",
            json={"provider": "openai", "api_key": "sk-test"},
        )
        assert key_response.status_code == 200
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

    async def test_set_model_requires_configured_provider(self, client, temp_config_dir):
        res = await client.put(
            "/api/settings/model",
            json={"model": "openai/gpt-5.1", "thinking": "medium"},
        )
        assert res.status_code == 400
        assert res.json()["detail"] == "Model requires a configured provider"

    async def test_config_defaults(self, client, temp_config_dir):
        """Without any config file, defaults are returned."""
        res = await client.get("/api/settings/config")
        data = res.json()
        assert data["model"] == ""
        assert data["thinking"] == "off"
        # No keys set
        assert not any(data["api_keys"].values())

    async def test_custom_model_uses_pi_ai_capabilities_and_clamps_thinking(self, client, temp_config_dir):
        from api.settings import _save_config

        _save_config({
            "custom_providers": [{
                "id": "custom-api",
                "name": "Custom API",
                "base_url": "https://llm.example.com/v1",
                "api": "openai-completions",
                "api_key": "sk-custom",
                "models": ["gpt-5.4", "gpt-4o"],
            }]
        })

        config = (await client.get("/api/settings/config")).json()
        models = {model["model"]: model for model in config["available_models"]}
        assert models["gpt-5.4"]["capability_source"] == "pi-ai:openai"
        assert models["gpt-5.4"]["thinking_levels"] == [
            "off", "minimal", "low", "medium", "high", "xhigh",
        ]
        assert models["gpt-4o"]["reasoning"] is False
        assert models["gpt-4o"]["thinking_levels"] == ["off"]

        saved = await client.put(
            "/api/settings/model",
            json={"model": "custom-custom-api/gpt-5.4", "thinking": "max"},
        )
        assert saved.status_code == 200
        assert saved.json()["thinking"] == "xhigh"

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

    async def test_skill_toggle_and_reset(self, client, temp_config_dir, monkeypatch):
        import api.skills as skills

        monkeypatch.setattr(skills, "_discover_all_skills", lambda _cwd=".": [
            ("research", "/tmp/research/SKILL.md", "user"),
            ("coding", "/tmp/coding/SKILL.md", "builtin"),
        ])

        initial = await client.get("/api/settings/skills")
        assert initial.status_code == 200
        assert all(item["enabled"] for item in initial.json()["skills"])

        disabled = await client.put(
            "/api/settings/skills/toggle",
            json={"name": "research", "enabled": False},
        )
        assert disabled.status_code == 200
        state = await client.get("/api/settings/skills")
        by_name = {item["name"]: item for item in state.json()["skills"]}
        assert by_name["research"]["enabled"] is False
        assert by_name["coding"]["enabled"] is True

        reset = await client.delete("/api/settings/skills")
        assert reset.status_code == 200
        assert (await client.get("/api/settings/skills")).json()["configured"] is False

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

    def test_custom_reasoning_model_enables_max_thinking(self, temp_config_dir):
        from api.settings import _save_config, get_custom_models_runtime

        _save_config({
            "custom_providers": [{
                "id": "custom-api",
                "name": "Custom API",
                "base_url": "https://llm.example.com/v1",
                "api": "openai-completions",
                "api_key": "sk-custom",
            "models": ["gpt-5.6-luna", "gpt-5.4", "plain-chat-model"],
            }]
        })

        agent_dir, _env = get_custom_models_runtime("/tmp/reasoning-workspace")
        payload = json.loads((agent_dir / "models.json").read_text())
        models = {
            model["id"]: model
            for model in payload["providers"]["custom-custom-api"]["models"]
        }

        assert models["gpt-5.6-luna"]["reasoning"] is True
        assert models["gpt-5.6-luna"]["thinkingLevelMap"]["max"] == "max"
        assert models["gpt-5.6-luna"]["compat"]["supportsReasoningEffort"] is True
        assert models["gpt-5.4"]["thinkingLevelMap"]["xhigh"] == "xhigh"
        assert "max" not in models["gpt-5.4"]["thinkingLevelMap"]
        assert models["plain-chat-model"]["reasoning"] is False


class TestPiModelCapabilities:
    def test_protocol_selects_canonical_pi_ai_provider(self):
        from services.pi_model_capabilities import get_pi_model_capability

        openai = get_pi_model_capability("custom-test", "gpt-5.4", api="openai-responses")
        assert openai is not None
        assert openai["capability_source"] == "pi-ai:openai"
        assert openai["thinking_levels"] == ["off", "minimal", "low", "medium", "high", "xhigh"]

        anthropic = get_pi_model_capability("custom-test", "claude-fable-5", api="anthropic-messages")
        assert anthropic is not None
        assert anthropic["capability_source"] == "pi-ai:anthropic"
        assert "off" not in anthropic["thinking_levels"]
        assert anthropic["thinking_levels"][-2:] == ["xhigh", "max"]


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
