from __future__ import annotations

import json
import uuid
from datetime import date as Date, datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.workout import MuscleTargetResponse, WorkoutLog, WorkoutLogResponse, WorkoutSession


def _escape_like(s: str) -> str:
    """Escape LIKE special characters so they match literally. Use with ESCAPE '!'."""
    return s.replace("!", "!!").replace("%", "!%").replace("_", "!_")


# ---------------------------------------------------------------------------
# Shared helper: build WorkoutLogResponse list from JOIN query rows
# ---------------------------------------------------------------------------

def _rows_to_responses(rows: list) -> list[WorkoutLogResponse]:
    result = []
    for row in rows:
        raw = row["muscle_targets_json"] or []
        if isinstance(raw, str):
            raw = json.loads(raw)
        muscle_targets = [MuscleTargetResponse(**mt) for mt in raw]
        result.append(WorkoutLogResponse(
            id=row["id"],
            user_id=row["user_id"],
            exercise=row["exercise"],
            sets=row["sets"],
            reps=row["reps"],
            weight=row["weight"],
            weight_unit=row["weight_unit"],
            notes=row["notes"],
            logged_at=row["logged_at"],
            created_at=row["created_at"],
            is_personal_record=bool(row["is_personal_record"]),
            muscle_targets=muscle_targets,
        ))
    return result


_WORKOUT_SELECT = """
    SELECT
        w.id, w.user_id, w.exercise, w.sets, w.reps, w.weight,
        w.weight_unit, w.notes, w.logged_at, w.created_at,
        (
            w.weight = (
                SELECT MAX(w2.weight)
                FROM workout_logs w2
                WHERE w2.user_id = w.user_id
                  AND LOWER(w2.exercise) = LOWER(w.exercise)
            )
        ) AS is_personal_record,
        COALESCE(
            JSON_AGG(
                JSON_BUILD_OBJECT(
                    'muscle_group', mt.muscle_group,
                    'specific_muscles', mt.specific_muscles,
                    'role', mt.role,
                    'source', mt.source
                )
                ORDER BY mt.role DESC
            ) FILTER (WHERE mt.id IS NOT NULL),
            '[]'
        ) AS muscle_targets_json
    FROM workout_logs w
    LEFT JOIN workout_muscle_targets mt ON mt.workout_id = w.id
"""

# ---------------------------------------------------------------------------
# Insert
# ---------------------------------------------------------------------------

async def insert_workout(
    session: AsyncSession,
    parsed: WorkoutLog,
    user_id: uuid.UUID,
    logged_at: datetime | None = None,
) -> WorkoutLogResponse:
    now = datetime.now(timezone.utc)
    workout_id = uuid.uuid4()
    effective_logged_at = logged_at if logged_at is not None else now

    result = await session.execute(
        text("""
            INSERT INTO workout_logs
                (id, user_id, exercise, sets, reps, weight, weight_unit, notes, logged_at, created_at)
            VALUES
                (:id, :user_id, :exercise, :sets, :reps, :weight, :weight_unit, :notes, :logged_at, :created_at)
            RETURNING
                id, user_id, exercise, sets, reps, weight, weight_unit, notes, logged_at, created_at
        """),
        {
            "id": workout_id,
            "user_id": user_id,
            "exercise": parsed.exercise,
            "sets": parsed.sets,
            "reps": parsed.reps,
            "weight": parsed.weight,
            "weight_unit": parsed.weight_unit,
            "notes": parsed.notes,
            "logged_at": effective_logged_at,
            "created_at": now,
        },
    )
    row = result.mappings().one()
    return WorkoutLogResponse(**row)


# ---------------------------------------------------------------------------
# PR check
# ---------------------------------------------------------------------------

async def check_personal_record(
    session: AsyncSession,
    user_id: uuid.UUID,
    exercise: str,
    weight: float,
    current_id: uuid.UUID,
) -> bool:
    """Return True if weight is an all-time PR for this user+exercise (highest weight ever)."""
    if weight <= 0:
        return False

    result = await session.execute(
        text("""
            SELECT MAX(weight)
            FROM workout_logs
            WHERE user_id = :user_id
              AND LOWER(exercise) = LOWER(:exercise)
              AND id != :current_id
        """),
        {
            "user_id": user_id,
            "exercise": exercise,
            "current_id": current_id,
        },
    )
    prev_max = result.scalar()
    return prev_max is None or weight > prev_max


# ---------------------------------------------------------------------------
# Muscle targets
# ---------------------------------------------------------------------------

async def insert_muscle_targets(
    session: AsyncSession,
    workout_id: uuid.UUID,
    targets: list[dict],
    source: str,
) -> list[MuscleTargetResponse]:
    responses: list[MuscleTargetResponse] = []
    for t in targets:
        await session.execute(
            text("""
                INSERT INTO workout_muscle_targets
                    (id, workout_id, muscle_group, specific_muscles, role, source)
                VALUES
                    (:id, :workout_id, :muscle_group, :specific_muscles, :role, :source)
            """),
            {
                "id": uuid.uuid4(),
                "workout_id": workout_id,
                "muscle_group": t["muscle_group"],
                "specific_muscles": t["specific_muscles"],
                "role": t["role"],
                "source": source,
            },
        )
        responses.append(MuscleTargetResponse(
            muscle_group=t["muscle_group"],
            specific_muscles=t["specific_muscles"],
            role=t["role"],
            source=source,
        ))
    return responses


# ---------------------------------------------------------------------------
# Fetch / search
# ---------------------------------------------------------------------------

async def fetch_workouts(
    session: AsyncSession, user_id: uuid.UUID, limit: int = 50
) -> list[WorkoutLogResponse]:
    # CTE computes the max weight per exercise for this user in one pass,
    # eliminating the N correlated subqueries from _WORKOUT_SELECT.
    result = await session.execute(
        text("""
            WITH pr AS (
                SELECT LOWER(exercise) AS exercise, MAX(weight) AS max_weight
                FROM workout_logs
                WHERE user_id = :user_id
                GROUP BY LOWER(exercise)
            )
            SELECT
                w.id, w.user_id, w.exercise, w.sets, w.reps, w.weight,
                w.weight_unit, w.notes, w.logged_at, w.created_at,
                COALESCE(w.weight = pr.max_weight, false) AS is_personal_record,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'muscle_group', mt.muscle_group,
                            'specific_muscles', mt.specific_muscles,
                            'role', mt.role,
                            'source', mt.source
                        )
                        ORDER BY mt.role DESC
                    ) FILTER (WHERE mt.id IS NOT NULL),
                    '[]'
                ) AS muscle_targets_json
            FROM workout_logs w
            LEFT JOIN pr ON LOWER(w.exercise) = pr.exercise
            LEFT JOIN workout_muscle_targets mt ON mt.workout_id = w.id
            WHERE w.user_id = :user_id
            GROUP BY w.id, w.user_id, w.exercise, w.sets, w.reps, w.weight,
                     w.weight_unit, w.notes, w.logged_at, w.created_at, pr.max_weight
            ORDER BY w.logged_at DESC
            LIMIT :limit
        """),
        {"user_id": user_id, "limit": limit},
    )
    return _rows_to_responses(result.mappings().all())


async def search_workouts(
    session: AsyncSession, user_id: uuid.UUID, exercise: str, limit: int = 20
) -> list[WorkoutLogResponse]:
    result = await session.execute(
        text(_WORKOUT_SELECT + """
            WHERE w.user_id = :user_id
              AND LOWER(w.exercise) LIKE LOWER(:pattern) ESCAPE '!'
            GROUP BY w.id, w.user_id, w.exercise, w.sets, w.reps, w.weight,
                     w.weight_unit, w.notes, w.logged_at, w.created_at
            ORDER BY w.logged_at DESC
            LIMIT :limit
        """),
        {"user_id": user_id, "pattern": f"%{_escape_like(exercise)}%", "limit": limit},
    )
    return _rows_to_responses(result.mappings().all())


# ---------------------------------------------------------------------------
# Update
# ---------------------------------------------------------------------------

async def update_workout(
    session: AsyncSession,
    workout_id: uuid.UUID,
    user_id: uuid.UUID,
    updates: dict,
) -> WorkoutLogResponse | None:
    """Partial update — only keys present in `updates` are changed.
    Returns the updated row (with muscle targets) or None if not found."""
    allowed = {"exercise", "sets", "reps", "weight", "weight_unit", "notes"}
    fields = {k: v for k, v in updates.items() if k in allowed and v is not None}
    if not fields:
        return None

    # Column names are interpolated into the SQL string (values are parameterized).
    # The allowed-set filter above is the trust boundary — assert it held.
    assert set(fields).issubset(allowed), f"Unexpected column(s): {set(fields) - allowed}"
    set_clause = ", ".join(f"{col} = :{col}" for col in fields)
    params = {**fields, "id": workout_id, "user_id": user_id}

    result = await session.execute(
        text(f"UPDATE workout_logs SET {set_clause} WHERE id = :id AND user_id = :user_id"),
        params,
    )
    if result.rowcount == 0:
        return None

    # Re-fetch with muscle targets JOIN so caller gets a complete response
    result2 = await session.execute(
        text(_WORKOUT_SELECT + """
            WHERE w.id = :id AND w.user_id = :user_id
            GROUP BY w.id, w.user_id, w.exercise, w.sets, w.reps, w.weight,
                     w.weight_unit, w.notes, w.logged_at, w.created_at
        """),
        {"id": workout_id, "user_id": user_id},
    )
    rows = _rows_to_responses(result2.mappings().all())
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------

async def delete_workout_by_id(
    session: AsyncSession, workout_id: uuid.UUID, user_id: uuid.UUID
) -> WorkoutLogResponse | None:
    """Delete a workout (scoped to user). Returns the deleted row or None if not found."""
    result = await session.execute(
        text("""
            DELETE FROM workout_logs
            WHERE id = :id AND user_id = :user_id
            RETURNING id, user_id, exercise, sets, reps, weight, weight_unit,
                      notes, logged_at, created_at
        """),
        {"id": workout_id, "user_id": user_id},
    )
    row = result.mappings().one_or_none()
    if row is None:
        return None
    return WorkoutLogResponse(**row)


# ---------------------------------------------------------------------------
# Workout sessions
# ---------------------------------------------------------------------------

async def upsert_session(
    session: AsyncSession,
    user_id: uuid.UUID,
    date: Date,
    session_type: str,
    notes: str | None = None,
) -> WorkoutSession:
    """Insert or update the workout session for a given user+date."""
    result = await session.execute(
        text("""
            INSERT INTO workout_sessions (id, user_id, date, session_type, notes, created_at)
            VALUES (:id, :user_id, :date, :session_type, :notes, NOW())
            ON CONFLICT (user_id, date)
            DO UPDATE SET session_type = EXCLUDED.session_type,
                          notes        = EXCLUDED.notes
            RETURNING id, user_id, date, session_type, notes, created_at
        """),
        {
            "id": uuid.uuid4(),
            "user_id": user_id,
            "date": date,
            "session_type": session_type,
            "notes": notes,
        },
    )
    row = result.mappings().one()
    return WorkoutSession(**row)


async def get_session_for_date(
    session: AsyncSession,
    user_id: uuid.UUID,
    date: Date,
) -> WorkoutSession | None:
    """Return the workout session for a specific calendar date, or None if not set."""
    result = await session.execute(
        text("""
            SELECT id, user_id, date, session_type, notes, created_at
            FROM workout_sessions
            WHERE user_id = :user_id
              AND date = :date
        """),
        {"user_id": user_id, "date": date},
    )
    row = result.mappings().one_or_none()
    if row is None:
        return None
    return WorkoutSession(**row)


async def get_exercise_pr(
    session: AsyncSession,
    user_id: uuid.UUID,
    exercise: str,
) -> WorkoutLogResponse | None:
    """Return the workout entry with the highest weight ever for a given exercise (all-time PR)."""
    result = await session.execute(
        text(_WORKOUT_SELECT + """
            WHERE w.user_id = :user_id
              AND LOWER(w.exercise) LIKE LOWER(:pattern) ESCAPE '!'
            GROUP BY w.id, w.user_id, w.exercise, w.sets, w.reps, w.weight,
                     w.weight_unit, w.notes, w.logged_at, w.created_at
            ORDER BY w.weight DESC
            LIMIT 1
        """),
        {"user_id": user_id, "pattern": f"%{_escape_like(exercise)}%"},
    )
    rows = _rows_to_responses(result.mappings().all())
    return rows[0] if rows else None


async def get_sessions(
    session: AsyncSession, user_id: uuid.UUID, days: int = 7, tz: str = "UTC"
) -> list[WorkoutSession]:
    """Return workout sessions for the past N days, newest first.

    The window is measured from *today in `tz`* — using the UTC date instead would
    drop or add a day at the edge for anyone not on UTC.
    """
    result = await session.execute(
        text("""
            SELECT id, user_id, date, session_type, notes, created_at
            FROM workout_sessions
            WHERE user_id = :user_id
              AND date >= (NOW() AT TIME ZONE :tz)::date - CAST(:days AS integer)
            ORDER BY date DESC
        """),
        {"user_id": user_id, "days": days, "tz": tz},
    )
    return [WorkoutSession(**row) for row in result.mappings().all()]


# ---------------------------------------------------------------------------
# Fetch workouts by calendar date
# ---------------------------------------------------------------------------

async def fetch_workouts_by_date(
    session: AsyncSession, user_id: uuid.UUID, date: Date, tz: str = "UTC"
) -> list[WorkoutLogResponse]:
    """Return all workouts logged on a specific calendar date in the given timezone."""
    result = await session.execute(
        text(_WORKOUT_SELECT + """
            WHERE w.user_id = :user_id
              AND (w.logged_at AT TIME ZONE :tz)::date = :date
            GROUP BY w.id, w.user_id, w.exercise, w.sets, w.reps, w.weight,
                     w.weight_unit, w.notes, w.logged_at, w.created_at
            ORDER BY w.logged_at DESC
        """),
        {"user_id": user_id, "date": date, "tz": tz},
    )
    return _rows_to_responses(result.mappings().all())


# ---------------------------------------------------------------------------
# Delete workouts by exercise name + calendar date
# ---------------------------------------------------------------------------

async def delete_workouts_by_exercise_date(
    session: AsyncSession, user_id: uuid.UUID, exercise: str, date: Date, tz: str = "UTC"
) -> list[WorkoutLogResponse]:
    """Delete all workouts matching exercise name on a given date. Returns deleted rows."""
    result = await session.execute(
        text("""
            DELETE FROM workout_logs
            WHERE user_id = :user_id
              AND LOWER(exercise) LIKE LOWER(:pattern) ESCAPE '!'
              AND (logged_at AT TIME ZONE :tz)::date = :date
            RETURNING id, user_id, exercise, sets, reps, weight, weight_unit,
                      notes, logged_at, created_at
        """),
        {"user_id": user_id, "pattern": f"%{_escape_like(exercise)}%", "date": date, "tz": tz},
    )
    rows = result.mappings().all()
    return [WorkoutLogResponse(**row) for row in rows]
