# Pi-Science Desktop

Electron desktop shell for the existing Pi-Science React application and Node control plane.

## Development

From the repository root:

```bash
pnpm desktop:dev
```

This builds the shared contracts, server, frontend and desktop main process, installs the pinned Electron binary when needed, then starts the desktop application.

## Package the current platform

Install the Pi Orbit runtime first, then run:

```bash
bash scripts/install.sh
pnpm desktop:package
```

On Windows, use `scripts/install.ps1` before `pnpm desktop:package`. The unpacked application is written to `apps/desktop/out/` for the host OS and CPU architecture.

The resource assembler includes the production frontend, an isolated production deployment of the control plane, built-in skills, the selected Pi Orbit binary and installed runtime extensions. Generated `.stage/` and `out/` directories are not committed.

Current packages are unsigned development artifacts. Public distribution still requires platform icons, macOS signing/notarization, Windows signing and installer/update publishing.

## Packaged smoke test

The desktop main process supports a no-window smoke mode used by release validation. It starts the packaged control-plane subprocess, checks readiness and the authenticated API, creates a temporary workspace and a real Pi Orbit session, removes the temporary workspace, then shuts down cleanly:

```bash
PI_SCIENCE_DESKTOP_SMOKE=1 \
PI_SCIENCE_DESKTOP_USER_DATA="$PWD/.runtime/desktop-smoke/user-data" \
PI_SCIENCE_DESKTOP_WORKSPACES="$PWD/.runtime/desktop-smoke/workspaces" \
"apps/desktop/out/Pi-Science-darwin-arm64/Pi-Science.app/Contents/MacOS/pi-science"
```
