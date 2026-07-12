"""Pi-Science CLI entry point."""
import os
import sys
import argparse


def main():
    parser = argparse.ArgumentParser(
        description="Pi-Science: Scientific AI Workbench"
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
    args = parser.parse_args()

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
