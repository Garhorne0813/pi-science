"""Pi-Science CLI entry point."""
import os
import sys
import argparse
import json


def main():
    parser = argparse.ArgumentParser(
        description="Pi-Science: Scientific AI Workbench"
    )
    parser.add_argument(
        "command", nargs="?", choices=["skills"],
        help="Run a maintenance command instead of starting the server",
    )
    parser.add_argument(
        "subcommand", nargs="?", choices=["validate", "init", "eval"],
        help="Maintenance subcommand (skills validate/init/eval)",
    )
    parser.add_argument(
        "path", nargs="?", default=".",
        help="Skill directory, or skill name for skills init",
    )
    parser.add_argument(
        "fixture", nargs="?", default=None,
        help="Fixture JSON path for skills eval",
    )
    parser.add_argument(
        "--host", default=os.environ.get("PI_SCIENCE_HOST", "127.0.0.1"),
        help="Host to bind to"
    )
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PI_SCIENCE_PORT", "8787")),
        help="Port to bind to"
    )
    parser.add_argument(
        "--pi-cli", default=os.environ.get("PI_CLI_PATH", ""),
        help="Path to pi CLI"
    )
    parser.add_argument(
        "--init", action="store_true",
        help="Initialize config directory and exit"
    )
    parser.add_argument(
        "--strict", action="store_true",
        help="Treat skill validation warnings as errors",
    )
    args = parser.parse_args()

    if args.command == "skills":
        if args.subcommand == "init":
            from pathlib import Path
            name = args.path
            if not name or not name.replace("-", "").replace("_", "").isalnum():
                parser.error("skills init requires a simple skill name")
            target = Path(".pi") / "skills" / name
            target.mkdir(parents=True, exist_ok=False)
            (target / "SKILL.md").write_text(
                "---\n"
                f"name: {name}\n"
                "description: Describe when this skill should be loaded.\n"
                "version: 0.1.0\nlicense: Apache-2.0\ncategory: general\n"
                "requirements: []\nthird_party: []\nrisk: low\n---\n\n# Skill\n\n",
                encoding="utf-8",
            )
            print(target)
            raise SystemExit(0)
        if args.subcommand == "eval":
            if not args.fixture:
                parser.error("skills eval requires SKILL_DIR and FIXTURE_JSON")
            from pathlib import Path
            from services.skill_catalog import parse_skill
            from services.skill_eval import evaluate_skill, load_fixtures

            skill_dir = Path(args.path).expanduser().resolve()
            skill_file = skill_dir / "SKILL.md" if skill_dir.is_dir() else skill_dir
            record = parse_skill(skill_file, "project", skill_file.parent)
            result = evaluate_skill(record.metadata.name, record.metadata.description, load_fixtures(args.fixture))
            print(json.dumps(result, ensure_ascii=False, indent=2))
            raise SystemExit(0 if result["failed"] == 0 else 1)
        if args.subcommand != "validate":
            parser.error("skills requires validate, init, or eval")
        from services.skill_catalog import validate_directory

        validations = validate_directory(args.path)
        payload = {
            "valid": all(item.valid for item in validations),
            "validations": [item.model_dump() for item in validations],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        has_warnings = any(item.get("warnings") for item in payload["validations"])
        raise SystemExit(0 if payload["valid"] and not (args.strict and has_warnings) else 1)

    # Ensure pi CLI path is set
    if args.pi_cli:
        os.environ["PI_CLI_PATH"] = args.pi_cli
    elif not os.environ.get("PI_CLI_PATH"):
        # Try common locations
        import shutil
        found = shutil.which("pi")
        if found:
            os.environ["PI_CLI_PATH"] = found
        else:
            print("Warning: PI_CLI_PATH not set. Set it via --pi-cli or PI_CLI_PATH env var.")
            print("Pi agent runtime will not be available.")

    if args.init:
        from config import ensure_dirs
        ensure_dirs()
        print(f"Pi-Science config initialized at {os.environ.get('PI_SCIENCE_HOME', '~/.pi-science')}")
        return

    print(f"Starting Pi-Science backend on {args.host}:{args.port}...")
    import uvicorn
    import os as _os
    backend_dir = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
    sys.path.insert(0, backend_dir)
    uvicorn.run(
        "main:app",
        host=args.host,
        port=args.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
