from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..agents.workout_parser import parse_workout
from ..auth.dependencies import get_current_user
from ..db.database import get_session
from ..db.queries import fetch_workouts, insert_workout
from ..models.workout import APIResponse, WorkoutRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1")


@router.post(
    "/workouts",
    response_model=APIResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_workout(
    body: WorkoutRequest,
    current_user: dict = Depends(get_current_user),
) -> APIResponse:
    user_id = UUID(current_user["sub"])

    try:
        parsed = await parse_workout(body.transcript)
    except Exception as exc:
        logger.exception("AI parsing failed for transcript: %r", body.transcript)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI service error",
        ) from exc

    try:
        async with get_session() as session:
            record = await insert_workout(session, parsed, user_id)
    except Exception as exc:
        logger.exception("Database insert failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    return APIResponse(success=True, data=record)


@router.get(
    "/workouts",
    response_model=APIResponse,
    status_code=status.HTTP_200_OK,
)
async def list_workouts(
    limit: int = Query(default=50, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
) -> APIResponse:
    user_id = UUID(current_user["sub"])

    try:
        async with get_session() as session:
            records = await fetch_workouts(session, user_id=user_id, limit=limit)
    except Exception as exc:
        logger.exception("Database fetch failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    return APIResponse(success=True, data=records)
