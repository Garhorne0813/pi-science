"""Pi-Science scientific runtime — FastAPI application entry point.

The control plane (sessions, SSE, Pi subprocess management, files, settings,
jobs, artifacts, project knowledge, etc.) is owned by the Node gateway.
Python now serves only the scientific runtime: kernels and notebooks.
"""

from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from config import CORS_ORIGINS, HOST, PORT, ensure_dirs
from api.kernels import router as kernels_router
from api.notebooks import router as notebooks_router, shutdown_jupyter_server
from services.kernel_manager import kernel_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan — initialize and clean up resources."""
    ensure_dirs()
    print(f"[pi-science] Starting scientific runtime on {HOST}:{PORT}")
    print(f"[pi-science] CORS origins: {CORS_ORIGINS}")
    yield
    # Cleanup on shutdown
    print("[pi-science] Shutting down kernels...")
    await kernel_manager.shutdown_all()
    print("[pi-science] Shutting down Jupyter Lab...")
    await shutdown_jupyter_server()


app = FastAPI(
    title="Pi-Science Scientific Runtime",
    description="Scientific runtime for pi-science: kernels and notebooks",
    version="0.2.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def require_internal_token(request, call_next):
    """Optionally make the Python process an internal-only runtime."""
    if os.environ.get("PI_SCIENCE_REQUIRE_INTERNAL_TOKEN") == "1":
        if request.url.path != "/api/health":
            expected = os.environ.get("PI_SCIENCE_INTERNAL_TOKEN", "")
            supplied = request.headers.get("x-pi-science-internal-token", "")
            if not expected or supplied != expected:
                return JSONResponse({"detail": "internal runtime authentication required"}, status_code=403)
    return await call_next(request)


# CORS for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register scientific runtime routes only.
app.include_router(kernels_router)
app.include_router(notebooks_router)


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "active_kernels": kernel_manager.active_count,
    }


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


if __name__ == "__main__":
    main()
