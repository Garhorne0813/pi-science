"""Validated workspace root and its canonical Pi-Science paths."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from services.workspace_security import resolve_workspace_file, validate_workspace_cwd


@dataclass(frozen=True, slots=True)
class WorkspaceContext:
    """A workspace path that crossed the host-filesystem trust seam."""

    root: Path

    @classmethod
    def from_cwd(cls, cwd: str | Path, *, allow_process_cwd: bool = False) -> "WorkspaceContext":
        raw = str(cwd)
        if allow_process_cwd and raw == ".":
            root = Path.cwd().resolve()
        else:
            root = validate_workspace_cwd(raw)
        return cls(root=root)

    @property
    def metadata_root(self) -> Path:
        return self.root / ".pi-science"

    @property
    def sessions_root(self) -> Path:
        return self.metadata_root / "sessions"

    def resolve_file(self, relative_path: str, *, allow_metadata: bool = False) -> Path:
        return resolve_workspace_file(self.root, relative_path, allow_metadata=allow_metadata)

    def __str__(self) -> str:
        return str(self.root)
