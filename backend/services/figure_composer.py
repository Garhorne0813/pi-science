"""Small deterministic multi-panel image composer."""

from __future__ import annotations

import math
from pathlib import Path

from services.workspace_security import resolve_workspace_file


def compose(workspace: str, panels: list[str], output: str, *, columns: int = 2, padding: int = 16) -> dict:
    if not panels:
        raise ValueError("at least one panel is required")
    try:
        from PIL import Image, ImageOps, ImageDraw
    except ImportError as exc:
        raise ValueError("Pillow is required for figure composition") from exc
    root = Path(workspace).expanduser().resolve()
    images = []
    for panel in panels:
        path = resolve_workspace_file(root, panel)
        if not path.exists():
            raise FileNotFoundError(panel)
        with Image.open(path) as image:
            images.append(image.convert("RGB"))
    columns = max(1, min(columns, len(images)))
    rows = math.ceil(len(images) / columns)
    cell_width = max(image.width for image in images)
    cell_height = max(image.height for image in images)
    canvas = Image.new("RGB", (columns * cell_width + (columns + 1) * padding, rows * cell_height + (rows + 1) * padding), "white")
    draw = ImageDraw.Draw(canvas)
    for index, image in enumerate(images):
        x = padding + (index % columns) * (cell_width + padding)
        y = padding + (index // columns) * (cell_height + padding)
        canvas.paste(ImageOps.contain(image, (cell_width, cell_height)), (x, y))
        draw.text((x + 4, y + 4), chr(ord("A") + index), fill="black")
    output_path = resolve_workspace_file(root, output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, dpi=(300, 300))
    return {"path": output_path.relative_to(root).as_posix(), "panels": panels, "columns": columns, "rows": rows, "width": canvas.width, "height": canvas.height}

