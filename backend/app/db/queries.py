from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.workout import WorkoutLog, WorkoutLogResponse


async def insert_workout(session: AsyncSession, parsed: WorkoutLog) -> WorkoutLogResponse:
    now = datetime.now(timezone.utc)
    workout_id = uuid.uuid4()

    result = await session.execute(
        text("""
            INSERT INTO workout_logs
                (id, exercise, sets, reps, weight, weight_unit, notes, logged_at, created_at)
            VALUES
                (:id, :exercise, :sets, :reps, :weight, :weight_unit, :notes, :logged_at, :created_at)
            RETURNING
                id, exercise, sets, reps, weight, weight_unit, notes, logged_at, created_at
        """),
        {
            "id": workout_id,
            "exercise": parsed.exercise,
            "sets": parsed.sets,
            "reps": parsed.reps,
            "weight": parsed.weight,
            "weight_unit": parsed.weight_unit,
            "notes": parsed.notes,
            "logged_at": now,
            "created_at": now,
        },
    )
    row = result.mappings().one()
    return WorkoutLogResponse(**row)


async def fetch_workouts(
    session: AsyncSession, limit: int = 50
) -> list[WorkoutLogResponse]:
    result = await session.execute(
        text("""
            SELECT id, exercise, sets, reps, weight, weight_unit, notes, logged_at, created_at
            FROM workout_logs
            ORDER BY logged_at DESC
            LIMIT :limit
        """),
        {"limit": limit},
    )
    rows = result.mappings().all()
    return [WorkoutLogResponse(**row) for row in rows]
