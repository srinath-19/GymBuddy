from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .db.database import create_tables
from .routes.chat import router as chat_router
from .routes.coach import router as coach_router
from .routes.pacer import router as pacer_router
from .routes.transcribe import router as transcribe_router
from .routes.tts import router as tts_router
from .routes.workouts import router

logger = logging.getLogger(__name__)


def _get_allowed_origins() -> list[str]:
    raw_origins = os.environ.get("CORS_ALLOWED_ORIGINS", "").strip()
    if raw_origins:
        return [origin.strip() for origin in raw_origins.split(",") if origin.strip()]

    frontend_url = os.environ.get("FRONTEND_URL", "").strip()
    if frontend_url:
        return [frontend_url]

    return ["http://localhost:3000"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: ensure DB table exists
    await create_tables()
    yield
    # Shutdown: NullPool closes connections automatically; nothing to clean up


app = FastAPI(
    title="GymBuddy API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"success": False, "data": None, "error": "Internal server error"},
    )


app.include_router(router)
app.include_router(coach_router)
app.include_router(chat_router)
app.include_router(pacer_router)
app.include_router(tts_router)
app.include_router(transcribe_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
