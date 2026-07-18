"""Workspace policy checks for remote MCP/model services."""

from __future__ import annotations

from urllib.parse import urlparse

from services.project_knowledge_store import ProjectKnowledgeStore


def check_remote_egress(workspace: str, url: str | None = None, data_class: str | None = None) -> tuple[bool, str | None]:
    policy = ProjectKnowledgeStore(workspace).get_policy()
    if not policy.external_services_allowed:
        return False, "external services are disabled by project policy"
    if data_class and data_class in policy.blocked_data_classes:
        return False, f"data class is blocked by project policy: {data_class}"
    if policy.allowed_egress_domains and url:
        domain = urlparse(url).hostname or ""
        if domain not in policy.allowed_egress_domains:
            return False, f"egress domain is not allowlisted: {domain}"
    return True, None

