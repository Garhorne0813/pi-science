"""Skill catalog, metadata validation, and API contract tests."""

from pathlib import Path

import pytest

from services.skill_catalog import catalog, parse_skill


def _write_skill(root: Path, name: str, body: str) -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    path = directory / "SKILL.md"
    path.write_text(body, encoding="utf-8")
    return path


def test_parse_multiline_front_matter_and_nested_metadata(tmp_path):
    path = _write_skill(
        tmp_path,
        "demo",
        """---
name: demo
description: >
  A multiline description
  that is folded by YAML.
version: 1.2.3
category: analysis
requirements:
  - python
  - name: numpy
    kind: package
third_party:
  - kind: library
    name: NumPy
    license: BSD-3-Clause
---

# Demo
""",
    )
    record = parse_skill(path, "project", tmp_path)
    assert record.validation.valid is True
    assert record.metadata.description == "A multiline description that is folded by YAML.\n"
    assert [item.name for item in record.metadata.requirements] == ["python", "numpy"]
    assert record.digest
    assert record.skill_id


def test_invalid_front_matter_is_reported_without_crashing(tmp_path):
    path = _write_skill(tmp_path, "bad", "---\nname: Bad Name\ndescription: [\n---\n")
    record = parse_skill(path, "project", tmp_path)
    assert record.validation.valid is False
    assert record.validation.errors


def test_catalog_prefers_project_skill_over_duplicate_builtin(tmp_path, monkeypatch):
    project_skill = _write_skill(
        tmp_path / ".pi" / "skills",
        "same",
        "---\nname: same\ndescription: Project copy\n---\n",
    )
    import services.skill_catalog as skill_catalog

    monkeypatch.setattr(skill_catalog, "SKILLS_DIR", tmp_path / "builtin")
    _write_skill(
        tmp_path / "builtin",
        "same",
        "---\nname: same\ndescription: Builtin copy\n---\n",
    )
    records = catalog(str(tmp_path))
    same = next(item for item in records if item.name == "same")
    assert same.source == "project"
    assert same.description == "Project copy"


@pytest.mark.anyio
async def test_skills_api_lists_project_metadata(client, tmp_path):
    (tmp_path / ".pi-science").mkdir()
    (tmp_path / ".pi" / "skills" / "demo").mkdir(parents=True)
    (tmp_path / ".pi" / "skills" / "demo" / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo skill\ncategory: test\n---\n", encoding="utf-8"
    )
    listed = await client.get("/api/skills", params={"cwd": str(tmp_path)})
    assert listed.status_code == 200
    demo = next(item for item in listed.json() if item["name"] == "demo")
    assert demo["source"] == "project"
    assert demo["category"] == "test"
    assert demo["validation"]["valid"] is True
    detail = await client.get(f"/api/skills/{demo['skill_id']}", params={"cwd": str(tmp_path)})
    assert detail.status_code == 200
    assert detail.json()["digest"] == demo["digest"]


@pytest.mark.anyio
async def test_skills_api_validation_reports_invalid_skill(client, tmp_path):
    (tmp_path / ".pi-science").mkdir()
    skill_dir = tmp_path / ".pi" / "skills" / "bad"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("not front matter", encoding="utf-8")
    response = await client.post("/api/skills/validate", params={"path": str(skill_dir)})
    assert response.status_code == 200
    assert response.json()["valid"] is False
