from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import date as Date, datetime, time, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from ..agents.workout_parser import run_agent, run_agent_streamed
from ..auth.dependencies import get_current_user
from .tts import generate_tts_b64
from ..cache.redis_client import (
    get_cached_sessions,
    get_cached_workouts,
    invalidate_pr,
    set_cached_sessions,
    set_cached_workouts,
)
from ..data.muscle_ai import infer_muscles
from ..db.database import get_session
from ..db.queries import (
    check_personal_record,
    delete_workout_by_id,
    fetch_workouts,
    get_sessions,
    insert_muscle_targets,
    insert_workout,
    update_workout,
    upsert_session,
)
from ..models.workout import (
    AgentActionResponse,
    APIResponse,
    ManualWorkoutRequest,
    SessionUpdateRequest,
    WorkoutLog,
    WorkoutLogResponse,
    WorkoutSession,
    WorkoutUpdateRequest,
    WorkoutRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1")


async def _populate_workouts_cache(user_id: UUID) -> None:
    try:
        async with get_session() as session:
            fresh = await fetch_workouts(session, user_id=user_id, limit=50)
        await set_cached_workouts(str(user_id), [r.model_dump(mode="json") for r in fresh])
    except Exception:
        logger.warning("Workouts cache populate failed for user %s", user_id)


async def _populate_sessions_cache(user_id: UUID) -> None:
    try:
        async with get_session() as session:
            fresh = await get_sessions(session, user_id, days=90)
        await set_cached_sessions(str(user_id), [r.model_dump(mode="json") for r in fresh])
    except Exception:
        logger.warning("Sessions cache populate failed for user %s", user_id)


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

            muscle_dicts = await infer_muscles(parsed.exercise)
            if muscle_dicts:
                targets = await insert_muscle_targets(session, record.id, muscle_dicts, "ai_inferred")
                record.muscle_targets = targets
    except Exception as exc:
        logger.exception("Manual insert failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    await invalidate_pr(str(user_id), parsed.exercise)
    await _populate_workouts_cache(user_id)
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
    if context.cache_dirty:
        action_data.tts_audio_b64, _ = await asyncio.gather(
            generate_tts_b64(message),
            asyncio.gather(_populate_workouts_cache(user_id), _populate_sessions_cache(user_id)),
        )
    else:
        action_data.tts_audio_b64 = await generate_tts_b64(message)
    return APIResponse(success=True, data=action_data)


# ---------------------------------------------------------------------------
# POST /workouts/stream  — AI-agent path with SSE-style progress events
# ---------------------------------------------------------------------------

@router.post("/workouts/stream")
async def create_workout_stream(
    body: WorkoutRequest,
    current_user: dict = Depends(get_current_user),
) -> StreamingResponse:
    user_id = UUID(current_user["sub"])

    async def event_generator():
        async for event in run_agent_streamed(body.transcript, user_id):
            if event["type"] == "done":
                cache_dirty = event.pop("cache_dirty", False)
                msg = event["message"]
                action_data = AgentActionResponse(
                    action=event["action"],  # type: ignore[arg-type]
                    message=msg,
                    workout=WorkoutLogResponse.model_validate(event["logged_workout"]) if event["logged_workout"] else None,
                    workouts=(
                        [WorkoutLogResponse.model_validate(w) for w in event["found_workouts"]]
                        if event["found_workouts"]
                        else ([WorkoutLogResponse.model_validate(w) for w in event["deleted_workouts"]] if event["deleted_workouts"] else None)
                    ),
                    session=WorkoutSession.model_validate(event["session"]) if event["session"] else None,
                )
                if cache_dirty:
                    action_data.tts_audio_b64, _ = await asyncio.gather(
                        generate_tts_b64(msg),
                        asyncio.gather(_populate_workouts_cache(user_id), _populate_sessions_cache(user_id)),
                    )
                else:
                    action_data.tts_audio_b64 = await generate_tts_b64(msg)
                yield json.dumps({"type": "done", "data": action_data.model_dump(mode="json")}) + "\n"
            else:
                yield json.dumps(event) + "\n"

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")


# ---------------------------------------------------------------------------
# GET /sessions
# ---------------------------------------------------------------------------

@router.get(
    "/sessions",
    response_model=APIResponse,
    status_code=status.HTTP_200_OK,
)
async def list_sessions(
    days: int = Query(default=7, ge=1, le=90),
    current_user: dict = Depends(get_current_user),
) -> APIResponse:
    user_id = UUID(current_user["sub"])

    cached = await get_cached_sessions(str(user_id))
    if cached is not None:
        return APIResponse(success=True, data=[WorkoutSession.model_validate(r) for r in cached])

    try:
        async with get_session() as session:
            records = await get_sessions(session, user_id, days=days)
    except Exception as exc:
        logger.exception("Sessions fetch failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    await set_cached_sessions(str(user_id), [r.model_dump(mode="json") for r in records])
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

    cached = await get_cached_workouts(str(user_id))
    if cached is not None:
        return APIResponse(success=True, data=[WorkoutLogResponse.model_validate(r) for r in cached])

    try:
        async with get_session() as session:
            records = await fetch_workouts(session, user_id=user_id, limit=limit)
    except Exception as exc:
        logger.exception("Database fetch failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    await set_cached_workouts(str(user_id), [r.model_dump(mode="json") for r in records])
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
                muscle_dicts = await infer_muscles(updates["exercise"].strip().lower())
                if muscle_dicts:
                    await session.execute(
                        text("DELETE FROM workout_muscle_targets WHERE workout_id = :id"),
                        {"id": workout_id},
                    )
                    targets = await insert_muscle_targets(session, workout_id, muscle_dicts, "ai_inferred")
                    record.muscle_targets = targets
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Update failed for workout %s", workout_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    if "exercise" in updates:
        await invalidate_pr(str(user_id), updates["exercise"])
    await _populate_workouts_cache(user_id)
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

    await _populate_workouts_cache(user_id)
    return APIResponse(success=True, data=record)


# ---------------------------------------------------------------------------
# PUT /sessions/{date_str}  — upsert session type for a specific date
# ---------------------------------------------------------------------------

@router.put(
    "/sessions/{date_str}",
    response_model=APIResponse,
    status_code=status.HTTP_200_OK,
)
async def update_session(
    date_str: str,
    body: SessionUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> APIResponse:
    user_id = UUID(current_user["sub"])

    try:
        target_date = Date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid date format: {date_str!r}. Use YYYY-MM-DD.",
        )

    try:
        async with get_session() as session:
            record: WorkoutSession = await upsert_session(
                session,
                user_id=user_id,
                date=target_date,
                session_type=body.session_type.strip().lower(),
                notes=body.notes,
            )
    except Exception as exc:
        logger.exception("Session upsert failed for date %s", date_str)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error",
        ) from exc

    await _populate_sessions_cache(user_id)
    return APIResponse(success=True, data=record)
