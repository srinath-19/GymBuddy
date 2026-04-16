from __future__ import annotations

import logging
import uuid
from datetime import datetime, time, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text

from ..agents.workout_parser import run_agent
from ..auth.dependencies import get_current_user
from ..data.muscle_lookup import lookup_muscles
from ..db.database import get_session
from ..db.queries import (
    check_personal_record,
    delete_workout_by_id,
    fetch_workouts,
    get_sessions,
    insert_muscle_targets,
    insert_workout,
    update_workout,
)
from ..models.workout import (
    AgentActionResponse,
    APIResponse,
    ManualWorkoutRequest,
    WorkoutLog,
    WorkoutUpdateRequest,
    WorkoutRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1")


# ---------------------------------------------------------------------------
# POST /workouts/manual  — must be before /{workout_id} to avoid routing clash
# ---------------------------------------------------------------------------

@router.post(
    "/workouts/manual",
    response_model=APIResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_workout_manual(
    body: ManualWorkoutRequest,
    current_user: dict = Depends(get_current_user),
) -> APIResponse:
    user_id = UUID(current_user["sub"])

    parsed = WorkoutLog(
        exercise=body.exercise.strip().lower(),
        sets=body.sets,
        reps=body.reps,
        weight=body.weight,
        weight_unit=body.weight_unit,
        notes=body.notes,
    )

    logged_at_dt: datetime | None = None
    if body.logged_at:
        logged_at_dt = datetime.combine(body.logged_at, time.min, tzinfo=timezone.utc)

    try:
        async with get_session() as session:
            record = await insert_workout(session, parsed, user_id, logged_at=logged_at_dt)
            is_pr = await check_personal_record(
                session, user_id, parsed.exercise, parsed.weight, record.id
            )
            record.is_personal_record = is_pr

            muscle_dicts = lookup_muscles(parsed.exercise)
            if muscle_dicts:
                targets = await insert_muscle_targets(session, record.id, muscle_dicts, "lookup")
                record.muscle_targets = targets
    except Exception as exc:
        logger.exception("Manual insert failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    return APIResponse(success=True, data=record)


# ---------------------------------------------------------------------------
# POST /workouts  — AI-agent path
# ---------------------------------------------------------------------------

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
        context, message = await run_agent(body.transcript, user_id)
    except Exception as exc:
        logger.exception("Agent failed for transcript: %r", body.transcript)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI service error",
        ) from exc

    action_data = AgentActionResponse(
        action=context.action,  # type: ignore[arg-type]
        message=message,
        workout=context.logged_workout,
        workouts=context.found_workouts or context.deleted_workouts or None,
        session=context.session,
    )
    return APIResponse(success=True, data=action_data)


# ---------------------------------------------------------------------------
# GET /sessions
# ---------------------------------------------------------------------------

@router.get(
    "/sessions",
    response_model=APIResponse,
    status_code=status.HTTP_200_OK,
)
async def list_sessions(
    days: int = Query(default=7, ge=1, le=30),
    current_user: dict = Depends(get_current_user),
) -> APIResponse:
    user_id = UUID(current_user["sub"])

    try:
        async with get_session() as session:
            records = await get_sessions(session, user_id, days=days)
    except Exception as exc:
        logger.exception("Sessions fetch failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    return APIResponse(success=True, data=records)


# ---------------------------------------------------------------------------
# GET /workouts
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# PUT /workouts/{workout_id}
# ---------------------------------------------------------------------------

@router.put(
    "/workouts/{workout_id}",
    response_model=APIResponse,
    status_code=status.HTTP_200_OK,
)
async def edit_workout(
    workout_id: uuid.UUID,
    body: WorkoutUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> APIResponse:
    user_id = UUID(current_user["sub"])
    updates = body.model_dump(exclude_none=True)

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )

    try:
        async with get_session() as session:
            record = await update_workout(session, workout_id, user_id, updates)
            if record is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workout not found")

            # If exercise changed, rebuild muscle targets — but only replace the old
            # targets if the new name has a lookup hit. If the new name is unknown,
            # keep the existing muscle targets rather than silently blanking them.
            if "exercise" in updates:
                muscle_dicts = lookup_muscles(updates["exercise"].strip().lower())
                if muscle_dicts:
                    await session.execute(
                        text("DELETE FROM workout_muscle_targets WHERE workout_id = :id"),
                        {"id": workout_id},
                    )
                    targets = await insert_muscle_targets(session, workout_id, muscle_dicts, "lookup")
                    record.muscle_targets = targets
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Update failed for workout %s", workout_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    return APIResponse(success=True, data=record)


# ---------------------------------------------------------------------------
# DELETE /workouts/{workout_id}
# ---------------------------------------------------------------------------

@router.delete(
    "/workouts/{workout_id}",
    response_model=APIResponse,
    status_code=status.HTTP_200_OK,
)
async def remove_workout(
    workout_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
) -> APIResponse:
    user_id = UUID(current_user["sub"])

    try:
        async with get_session() as session:
            record = await delete_workout_by_id(session, workout_id, user_id)
    except Exception as exc:
        logger.exception("Delete failed for workout %s", workout_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workout not found")

    return APIResponse(success=True, data=record)
