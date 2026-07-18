"""Deterministic, content-level artifact checks."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any, Iterable


def verify_file(path: Path) -> dict[str, Any]:
    checks: dict[str, Any] = {"exists": path.exists(), "readable": False}
    errors: list[str] = []
    if not path.exists() or not path.is_file():
        return {"status": "failed", "checks": checks, "errors": ["file does not exist"]}
    try:
        size = path.stat().st_size
        checks["size"] = size
        path.open("rb").read(32)
        checks["readable"] = True
    except OSError as exc:
        errors.append(f"file is not readable: {exc}")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    checks["mime"] = mime
    if mime.startswith("image/"):
        try:
            from PIL import Image, ImageStat

            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                checks["width"], checks["height"] = image.size
                checks["dpi"] = image.info.get("dpi")
                stat = ImageStat.Stat(image.convert("RGB"))
                checks["flat_image"] = max(stat.extrema[0][1] - stat.extrema[0][0], 0) == 0
                if checks["width"] < 2 or checks["height"] < 2:
                    errors.append("image dimensions are too small")
                if checks["flat_image"]:
                    errors.append("image contains one flat color")
        except Exception as exc:
            errors.append(f"image validation failed: {exc}")
    return {"status": "passed" if not errors else "failed", "checks": checks, "errors": errors}


def check_claim_data(
    claim: str,
    values: Iterable[float],
    *,
    direction: str | None = None,
    minimum: float | None = None,
    maximum: float | None = None,
) -> dict[str, Any]:
    """Check simple, explicit numeric claims without interpreting prose."""
    numbers = [float(value) for value in values]
    errors: list[str] = []
    if not numbers:
        errors.append("claim has no numeric values")
    if direction == "positive" and numbers and not all(value > 0 for value in numbers):
        errors.append("claim requires all values to be positive")
    if direction == "negative" and numbers and not all(value < 0 for value in numbers):
        errors.append("claim requires all values to be negative")
    if minimum is not None and numbers and min(numbers) < minimum:
        errors.append(f"minimum value is below {minimum}")
    if maximum is not None and numbers and max(numbers) > maximum:
        errors.append(f"maximum value exceeds {maximum}")
    return {
        "status": "passed" if not errors else "failed",
        "claim": claim,
        "values": numbers,
        "checks": {"direction": direction, "minimum": minimum, "maximum": maximum},
        "errors": errors,
    }

