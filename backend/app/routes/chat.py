from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse

from ..agents.orchestrator import run_orchestrator
from ..auth.dependencies import get_current_user
from ..models.chat import ChatRequest
from ..services.conversation import TurnLimitExceededError
from ..services.pacer_session import PacerTurnLimitExceededError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["chat"])

# ---------------------------------------------------------------------------
# Simple per-user rate limiter — 20 requests per 60-second window.
# Consistent with single-process deployment (same constraint as conversation store).
# ---------------------------------------------------------------------------
_RATE_LIMIT = 20
_RATE_WINDOW = 60.0  # seconds

_user_request_times: defaultdict[str, list[float]] = defaultdict(list)


def _check_rate_limit(user_id: str) -> None:
    now = time.monotonic()
    window_start = now - _RATE_WINDOW
    timestamps = _user_request_times[user_id]
    # Drop timestamps outside the current window
    _user_request_times[user_id] = [t for t in timestamps if t > window_start]
    if len(_user_request_times[user_id]) >= _RATE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded: max {_RATE_LIMIT} requests per {int(_RATE_WINDOW)}s.",
        )
    _user_request_times[user_id].append(now)


def _ok(data: object) -> JSONResponse:
    return JSONResponse({"success": True, "data": data, "error": None})


@router.post("/chat")
async def chat(
    body: ChatRequest,
    current_user: dict = Depends(get_current_user),
) -> JSONResponse:
    user_id = UUID(current_user["sub"])
    _check_rate_limit(str(user_id))

    try:
        response = await run_orchestrator(body, user_id)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Agent timed out.",
        )
    except (TurnLimitExceededError, PacerTurnLimitExceededError) as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(e),
        )
    except Exception:
        logger.exception("Orchestrator failed for text: %r", body.text)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI service error",
        )

    return _ok(response.model_dump(mode="json"))
