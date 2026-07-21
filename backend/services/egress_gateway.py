"""The single policy seam for workspace-scoped outbound operations."""

from __future__ import annotations

import asyncio
import subprocess
from dataclasses import dataclass
from typing import Sequence

from services.egress_policy import check_remote_egress
from services.workspace_context import WorkspaceContext


class EgressDenied(PermissionError):
    pass


@dataclass(frozen=True, slots=True)
class EgressGateway:
    workspace: WorkspaceContext

    def authorize(self, url: str | None = None, data_class: str | None = None) -> None:
        allowed, reason = check_remote_egress(str(self.workspace), url, data_class)
        if not allowed:
            raise EgressDenied(reason or "outbound operation blocked by project policy")

    async def run(
        self,
        argv: Sequence[str],
        *,
        destination: str,
        data_class: str | None = None,
        timeout: float = 30,
    ) -> subprocess.CompletedProcess[str]:
        self.authorize(destination, data_class)
        return await asyncio.to_thread(
            subprocess.run,
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
