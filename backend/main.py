"""Pi-Science backend — FastAPI application entry point."""

import asyncio
import atexit
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import CORS_ORIGINS, HOST, PORT, ensure_dirs
from api.sessions import router as sessions_router
from api.files import router as files_router
from api.kernels import router as kernels_router
from api.provenance import router as provenance_router
from api.compute import router as compute_router
from api.settings import router as settings_router
from api.workspaces import router as workspaces_router
from api.skills import router as skills_router
from api.notebooks import router as notebooks_router
from api.runs import router as runs_router
from services.pi_manager import pi_manager
from services.kernel_manager import kernel_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan — initialize and clean up resources."""
    ensure_dirs()
    print(f"[pi-science] Starting backend on {HOST}:{PORT}")
    print(f"[pi-science] CORS origins: {CORS_ORIGINS}")
    yield
    # Cleanup on shutdown
    print("[pi-science] Shutting down kernels...")
    await kernel_manager.shutdown_all()
    print("[pi-science] Shutting down pi processes...")
    await pi_manager.shutdown_all()


app = FastAPI(
    title="Pi-Science API",
    description="Backend API for pi-science: scientific AI workbench powered by pi agent runtime",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API routes
app.include_router(sessions_router)
app.include_router(files_router)
app.include_router(kernels_router)
app.include_router(provenance_router)
app.include_router(compute_router)
app.include_router(settings_router)
app.include_router(workspaces_router)
app.include_router(skills_router)
app.include_router(notebooks_router)
app.include_router(runs_router)


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "active_pi_processes": pi_manager.active_count,
        "active_kernels": kernel_manager.active_count,
    }


# Model listing moved to api/settings.py


def main():
    """Run the FastAPI server."""
    import uvicorn
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        reload=True,
        log_level="info",
    )


# Register cleanup on exit
def _cleanup():
    loop = asyncio.new_event_loop()
    loop.run_until_complete(pi_manager.shutdown_all())
    loop.run_until_complete(kernel_manager.shutdown_all())
    loop.close()
atexit.register(_cleanup)


if __name__ == "__main__":
    main()
