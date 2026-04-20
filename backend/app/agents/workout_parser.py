from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import date as Date, timezone, datetime

from agents import Agent, RunContextWrapper, Runner, function_tool

from ..cache.redis_client import (
    get_cached_pr,
    get_cached_sessions,
    get_cached_workouts,
    invalidate_pr,
    set_cached_pr,
)
from ..data.muscle_ai import infer_muscles
from ..data.session_muscles import get_expected_muscles
from ..db.database import get_session
from ..db.queries import (
    check_personal_record,
    delete_workout_by_id,
    delete_workouts_by_exercise_date,
    fetch_workouts,
    fetch_workouts_by_date,
    get_exercise_pr,
    get_session_for_date,
    insert_muscle_targets,
    insert_workout,
    search_workouts,
    update_workout,
    upsert_session,
)
from ..models.workout import WorkoutLog, WorkoutLogResponse, WorkoutSession

AGENT_TIMEOUT_SECONDS = 60


# ---------------------------------------------------------------------------
# Per-request context — passed via RunContextWrapper, never sent to the LLM
# ---------------------------------------------------------------------------

@dataclass
class GymContext:
    user_id: uuid.UUID
    # Tools write back here so the route can build AgentActionResponse
    action: str = "none"
    logged_workout: WorkoutLogResponse | None = None
    found_workouts: list[WorkoutLogResponse] = field(default_factory=list)
    deleted_workouts: list[WorkoutLogResponse] = field(default_factory=list)
    session: WorkoutSession | None = None
    # Set True by any write tool so subsequent READ tools in the same turn skip the cache
    cache_dirty: bool = False


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@function_tool(strict_mode=False)
async def log_workout(
    ctx: RunContextWrapper[GymContext],
    exercise: str,
    sets: int,
    reps: int,
    weight: float,
    weight_unit: str = "lbs",
    notes: str | None = None,
    date_str: str | None = None,
) -> str:
    """
    Log a completed workout set to the database.
    Use this when the user describes a workout they just performed.

    Args:
        exercise: Exercise name, lowercase with spaces (e.g. "bench press", "squat").
        sets: Number of sets performed.
        reps: Reps per set.
        weight: Weight lifted in the given unit. Use 0 for bodyweight exercises.
        weight_unit: "lbs" (default) or "kg".
        notes: Optional extra context (tempo, rest time, form cues). Omit if none.
        date_str: ISO date "YYYY-MM-DD" of when the workout was done. Omit for today.
    """
    user_id = ctx.context.user_id

    logged_at_dt: datetime | None = None
    if date_str:
        try:
            target_date = Date.fromisoformat(date_str)
            logged_at_dt = datetime.combine(target_date, datetime.min.time(), tzinfo=timezone.utc)
        except ValueError:
            return f"Invalid date format: {date_str}. Use YYYY-MM-DD."

    parsed = WorkoutLog(
        exercise=exercise.strip().lower(),
        sets=sets,
        reps=reps,
        weight=weight,
        weight_unit=weight_unit,  # type: ignore[arg-type]
        notes=notes,
    )
    async with get_session() as session:
        record = await insert_workout(session, parsed, user_id, logged_at=logged_at_dt)
        is_pr = await check_personal_record(
            session, user_id, record.exercise, record.weight, record.id
        )
        muscle_data = await infer_muscles(parsed.exercise)
        targets = await insert_muscle_targets(session, record.id, muscle_data, "ai_inferred")
        record = record.model_copy(update={"is_personal_record": is_pr, "muscle_targets": targets})

    await invalidate_pr(str(user_id), parsed.exercise)
    ctx.context.cache_dirty = True
    ctx.context.action = "logged"
    ctx.context.logged_workout = record

    pr_note = " New personal record!" if is_pr else ""
    return f"Logged {exercise} {sets}×{reps} @ {weight} {weight_unit}.{pr_note}"


@function_tool(strict_mode=False)
async def get_last_workout(ctx: RunContextWrapper[GymContext]) -> str:
    """
    Retrieve the user's most recently logged workout.
    Call this before delete_workout when the user says 'delete my last workout'.
    """
    if not ctx.context.cache_dirty:
        cached = await get_cached_workouts(str(ctx.context.user_id))
        if cached:
            w = cached[0]  # list is ordered DESC by logged_at
            return (
                f"Last workout: {w['exercise']} {w['sets']}×{w['reps']} "
                f"@ {w['weight']} {w['weight_unit']} "
                f"logged on {w['logged_at'][:10]} | id={w['id']}"
            )

    async with get_session() as session:
        workouts = await fetch_workouts(session, ctx.context.user_id, limit=1)
    if not workouts:
        return "No workouts logged yet."
    w = workouts[0]
    return (
        f"Last workout: {w.exercise} {w.sets}×{w.reps} @ {w.weight} {w.weight_unit} "
        f"logged on {w.logged_at.date()} | id={w.id}"
    )


@function_tool(strict_mode=False)
async def delete_workout(ctx: RunContextWrapper[GymContext], workout_id: str) -> str:
    """
    Permanently delete a specific workout by its UUID.
    Always call get_last_workout first to obtain the ID when the user says 'delete last'.

    Args:
        workout_id: UUID string of the workout to delete.
    """
    try:
        wid = uuid.UUID(workout_id)
    except ValueError:
        return f"Invalid workout ID: {workout_id}"

    async with get_session() as session:
        deleted = await delete_workout_by_id(session, wid, ctx.context.user_id)

    if deleted is None:
        return f"Workout {workout_id} not found or does not belong to you."

    ctx.context.cache_dirty = True
    ctx.context.action = "deleted"
    ctx.context.deleted_workouts = [deleted]
    return (
        f"Deleted: {deleted.exercise} {deleted.sets}×{deleted.reps} "
        f"@ {deleted.weight} {deleted.weight_unit}"
    )


@function_tool(strict_mode=False)
async def update_workout_tool(
    ctx: RunContextWrapper[GymContext],
    workout_id: str,
    exercise: str | None = None,
    sets: int | None = None,
    reps: int | None = None,
    weight: float | None = None,
    weight_unit: str | None = None,
    notes: str | None = None,
) -> str:
    """
    Update specific fields of an existing workout.
    Call get_last_workout first to get the ID when the user refers to their last workout.

    Args:
        workout_id: UUID string of the workout to update.
        exercise: New exercise name (optional).
        sets: New number of sets (optional).
        reps: New reps per set (optional).
        weight: New weight value (optional).
        weight_unit: New weight unit — "lbs" or "kg" (optional).
        notes: New notes (optional).
    """
    try:
        wid = uuid.UUID(workout_id)
    except ValueError:
        return f"Invalid workout ID: {workout_id}"

    updates = {
        k: v for k, v in {
            "exercise": exercise.strip().lower() if exercise else None,
            "sets": sets,
            "reps": reps,
            "weight": weight,
            "weight_unit": weight_unit,
            "notes": notes,
        }.items()
        if v is not None
    }

    if not updates:
        return "Nothing to update — no fields provided."

    async with get_session() as session:
        record = await update_workout(session, wid, ctx.context.user_id, updates)

    if record is None:
        return f"Workout {workout_id} not found or does not belong to you."

    ctx.context.cache_dirty = True
    ctx.context.action = "updated"
    ctx.context.logged_workout = record

    parts = []
    if "exercise" in updates:
        parts.append(f"exercise → {record.exercise}")
    if "sets" in updates or "reps" in updates:
        parts.append(f"{record.sets}×{record.reps}")
    if "weight" in updates:
        parts.append(f"{record.weight} {record.weight_unit}")
    summary = ", ".join(parts) or "fields updated"
    return f"Updated {record.exercise}: {summary}."


@function_tool(strict_mode=False)
async def search_workouts_tool(
    ctx: RunContextWrapper[GymContext],
    exercise: str,
    limit: int = 10,
) -> str:
    """
    Search the user's workout history by exercise name.
    Use this when the user asks to see their history for a specific exercise.

    Args:
        exercise: Exercise name or partial name to search for.
        limit: Maximum number of results to return (default 10).
    """
    async with get_session() as session:
        results = await search_workouts(
            session, ctx.context.user_id, exercise=exercise, limit=limit
        )

    ctx.context.action = "found"
    ctx.context.found_workouts = results

    if not results:
        return f"No workouts found for '{exercise}'."

    lines = [
        f"{w.exercise} {w.sets}×{w.reps} @ {w.weight} {w.weight_unit} on {w.logged_at.date()}"
        for w in results
    ]
    return f"Found {len(results)} workout(s) for '{exercise}':\n" + "\n".join(lines)


@function_tool(strict_mode=False)
async def start_workout_session(
    ctx: RunContextWrapper[GymContext],
    session_type: str,
    notes: str | None = None,
    date_str: str | None = None,
) -> str:
    """
    Record (or update) the workout session type for a given day.
    Use for today ("starting chest day") or a past/future date
    ("yesterday was push day", "set Monday as legs", "change last Tuesday to pull").

    Args:
        session_type: Short label for the session, lowercase (e.g. "chest", "push", "legs", "full body").
        notes: Optional extra context the user mentioned about their plan.
        date_str: ISO date "YYYY-MM-DD". Defaults to today if omitted.
    """
    today = datetime.now(timezone.utc).date()
    if date_str:
        try:
            target_date = Date.fromisoformat(date_str)
        except ValueError:
            return f"Invalid date format: {date_str}. Use YYYY-MM-DD."
    else:
        target_date = today

    async with get_session() as session:
        record = await upsert_session(
            session,
            user_id=ctx.context.user_id,
            date=target_date,
            session_type=session_type.strip().lower(),
            notes=notes,
        )
    ctx.context.cache_dirty = True
    ctx.context.action = "session_started"
    ctx.context.session = record
    label = "today" if target_date == today else str(target_date)
    return f"Recorded {session_type} session for {label}."


@function_tool(strict_mode=False)
async def get_session_for_date_tool(
    ctx: RunContextWrapper[GymContext],
    date_str: str | None = None,
) -> str:
    """
    Look up the declared session type for a specific date.
    Use this when the user asks "what was my session on Monday?",
    "what did I set for yesterday?", or "what session type was last Tuesday?".
    Do NOT use for "what did I do today?" — use get_today_workouts for that.

    Args:
        date_str: ISO date "YYYY-MM-DD". Defaults to today if omitted.
    """
    today = datetime.now(timezone.utc).date()
    if date_str:
        try:
            target_date = Date.fromisoformat(date_str)
        except ValueError:
            return f"Invalid date format: {date_str}. Use YYYY-MM-DD."
    else:
        target_date = today

    date_key = str(target_date)
    if not ctx.context.cache_dirty:
        cached = await get_cached_sessions(str(ctx.context.user_id))
        if cached is not None:
            hit = next((s for s in cached if s.get("date") == date_key), None)
            label = "today" if target_date == today else date_key
            if hit is None:
                return f"No session declared for {label}."
            record = WorkoutSession.model_validate(hit)
            ctx.context.action = "found"
            ctx.context.session = record
            notes_part = f" ({record.notes})" if record.notes else ""
            return f"Session for {label}: {record.session_type}{notes_part}."

    async with get_session() as db:
        record = await get_session_for_date(db, ctx.context.user_id, target_date)

    label = "today" if target_date == today else date_key
    if record is None:
        return f"No session declared for {label}."

    ctx.context.action = "found"
    ctx.context.session = record
    notes_part = f" ({record.notes})" if record.notes else ""
    return f"Session for {label}: {record.session_type}{notes_part}."


@function_tool(strict_mode=False)
async def get_today_workouts(
    ctx: RunContextWrapper[GymContext],
    date_str: str | None = None,
) -> str:
    """
    Retrieve all workouts logged for a given day, plus that day's session type
    and a muscle coverage analysis. Works for today AND any past date.
    Use this when the user wants a SUMMARY or RECAP of a day's workout:
    - "what did I do today?", "did I hit chest today?", "did I hit every muscle group?"
    - "how was my workout yesterday?", "how was my push day on Monday?"
    - "recap of April 14th", "how did my session go on [date]?"
    - "what muscles did I hit on [date]?"
    After calling this tool, reason over the results to give gym-bro friendly
    feedback on muscle coverage and suggest what's still missing.

    Args:
        date_str: ISO date "YYYY-MM-DD" to look up. Omit (or pass null) for today.
    """
    today = datetime.now(timezone.utc).date()
    if date_str:
        try:
            target_date = Date.fromisoformat(date_str)
        except ValueError:
            return f"Invalid date format: {date_str}. Use YYYY-MM-DD."
    else:
        target_date = today

    date_key = str(target_date)
    today_session: WorkoutSession | None = None
    workouts: list[WorkoutLogResponse] = []

    if not ctx.context.cache_dirty:
        cached_workouts = await get_cached_workouts(str(ctx.context.user_id))
        cached_sessions = await get_cached_sessions(str(ctx.context.user_id))
        if cached_workouts is not None and cached_sessions is not None:
            workouts = [
                WorkoutLogResponse.model_validate(w)
                for w in cached_workouts
                if w.get("logged_at", "")[:10] == date_key
            ]
            hit = next((s for s in cached_sessions if s.get("date") == date_key), None)
            today_session = WorkoutSession.model_validate(hit) if hit else None
        else:
            async with get_session() as db:
                today_session = await get_session_for_date(db, ctx.context.user_id, target_date)
                workouts = await fetch_workouts_by_date(db, ctx.context.user_id, target_date)
    else:
        async with get_session() as db:
            today_session = await get_session_for_date(db, ctx.context.user_id, target_date)
            workouts = await fetch_workouts_by_date(db, ctx.context.user_id, target_date)

    ctx.context.action = "found"
    ctx.context.found_workouts = workouts
    ctx.context.session = today_session

    day_label = "today" if target_date == today else date_key

    if not workouts:
        if today_session:
            expected = get_expected_muscles(today_session.session_type)
            return (
                f"No workouts logged yet for {day_label}'s {today_session.session_type} session. "
                f"Expected muscles: {', '.join(expected) if expected else 'unknown'}. Get after it!"
            )
        return f"No workouts logged on {day_label}."

    hit_muscles: set[str] = set()
    lines = []
    for w in workouts:
        muscles = ", ".join(t.muscle_group for t in w.muscle_targets) or "unknown muscles"
        hit_muscles.update(t.muscle_group for t in w.muscle_targets if t.role == "primary")
        lines.append(f"{w.exercise} {w.sets}×{w.reps} @ {w.weight} {w.weight_unit} → {muscles}")

    summary = f"Workouts on {day_label} ({len(workouts)}):\n" + "\n".join(lines)

    if today_session:
        expected = get_expected_muscles(today_session.session_type)
        if expected:
            missing = [m for m in expected if m not in hit_muscles]
            covered = [m for m in expected if m in hit_muscles]
            summary += f"\n\nSession: {today_session.session_type}"
            summary += f"\nCovered: {', '.join(covered) if covered else 'none yet'}"
            summary += f"\nMissing: {', '.join(missing) if missing else 'all covered!'}"
        else:
            summary += f"\n\nSession declared: {today_session.session_type} (no muscle map)"

    return summary


@function_tool(strict_mode=False)
async def delete_exercise_today(
    ctx: RunContextWrapper[GymContext],
    exercise: str,
    date_str: str | None = None,
) -> str:
    """
    Delete all logged sets of a specific exercise on a given day.
    Use this when the user names an exercise rather than saying "delete my last workout".
    Examples: "delete bench press from today", "remove my squats", "undo the deadlifts".

    Args:
        exercise: Exercise name or partial name to match (e.g. "bench press", "squat").
        date_str: ISO date "YYYY-MM-DD". Defaults to today if omitted.
    """
    today = datetime.now(timezone.utc).date()
    if date_str:
        try:
            target_date = Date.fromisoformat(date_str)
        except ValueError:
            return f"Invalid date format: {date_str}. Use YYYY-MM-DD."
    else:
        target_date = today

    async with get_session() as session:
        deleted = await delete_workouts_by_exercise_date(
            session, ctx.context.user_id, exercise.strip().lower(), target_date
        )

    if not deleted:
        return f"No '{exercise}' workouts found for {target_date}."

    ctx.context.cache_dirty = True
    ctx.context.action = "deleted"
    ctx.context.deleted_workouts = deleted
    label = "today" if target_date == today else str(target_date)
    return f"Deleted {len(deleted)} set(s) of {exercise} from {label}."


@function_tool(strict_mode=False)
async def get_workouts_for_date(
    ctx: RunContextWrapper[GymContext],
    date_str: str | None = None,
) -> str:
    """
    Retrieve all workouts logged on a specific date, including their IDs.
    Use this BEFORE update_workout_tool when the user wants to change a past workout.
    Also use when the user asks "what did I do on Monday?" or "show me yesterday's workouts".
    Do NOT use for "what did I do today?" — use get_today_workouts for that (it includes session context).

    Args:
        date_str: ISO date "YYYY-MM-DD". Defaults to today if omitted.
    """
    today = datetime.now(timezone.utc).date()
    if date_str:
        try:
            target_date = Date.fromisoformat(date_str)
        except ValueError:
            return f"Invalid date format: {date_str}. Use YYYY-MM-DD."
    else:
        target_date = today

    date_key = str(target_date)
    workouts: list[WorkoutLogResponse] = []
    used_cache = False

    if not ctx.context.cache_dirty:
        cached = await get_cached_workouts(str(ctx.context.user_id))
        if cached is not None:
            workouts = [
                WorkoutLogResponse.model_validate(w)
                for w in cached
                if w.get("logged_at", "")[:10] == date_key
            ]
            used_cache = True

    if not used_cache or not workouts:
        async with get_session() as db:
            workouts = await fetch_workouts_by_date(db, ctx.context.user_id, target_date)

    label = "today" if target_date == today else date_key
    if not workouts:
        return f"No workouts found for {label}."

    ctx.context.action = "found"
    ctx.context.found_workouts = workouts

    lines = [
        f"{w.exercise} {w.sets}×{w.reps} @ {w.weight} {w.weight_unit} | id={w.id}"
        for w in workouts
    ]
    return f"Workouts on {label} ({len(workouts)}):\n" + "\n".join(lines)


@function_tool(strict_mode=False)
async def get_pr_for_exercise(
    ctx: RunContextWrapper[GymContext],
    exercise: str,
) -> str:
    """
    Find the all-time personal record (highest weight ever lifted) for a specific exercise.
    Use this when the user asks "what's my PR on bench press?", "what's my best squat weight?",
    or "have I ever hit 225 on deadlift?".

    Args:
        exercise: Exercise name or partial name to search for.
    """
    uid = str(ctx.context.user_id)
    cached_pr = await get_cached_pr(uid, exercise)
    if cached_pr:
        record = WorkoutLogResponse.model_validate(cached_pr)
        ctx.context.action = "found"
        ctx.context.found_workouts = [record]
        return (
            f"All-time PR on {record.exercise}: {record.weight} {record.weight_unit} "
            f"({record.sets}\u00d7{record.reps}) — logged on {record.logged_at.date()}."
        )

    async with get_session() as db:
        record = await get_exercise_pr(db, ctx.context.user_id, exercise)

    if record is None:
        return f"No '{exercise}' workouts found in your history."

    await set_cached_pr(uid, exercise, record.model_dump(mode="json"))
    ctx.context.action = "found"
    ctx.context.found_workouts = [record]
    return (
        f"All-time PR on {record.exercise}: {record.weight} {record.weight_unit} "
        f"({record.sets}\u00d7{record.reps}) — logged on {record.logged_at.date()}."
    )


# ---------------------------------------------------------------------------
# Agent — created once at import, stateless (context is per-request)
# ---------------------------------------------------------------------------

_agent: Agent[GymContext] = Agent(
    name="GymBuddy",
    instructions="""You are GymBuddy, a voice-first workout tracking assistant with the energy of a knowledgeable gym bro.
Keep responses concise, motivating, and actionable. Never give a wall of text.

## What you can do

- **Log a workout** — user describes a completed exercise (e.g. "bench press 3x10 at 135 lbs")
  → use `date_str` if the user says "I forgot to log yesterday's..." or names a past date
- **Start / set a session** — user declares a session type for today OR a past/future date
  → call start_workout_session; add date_str if the user names a date other than today
  ("yesterday was push day", "set Monday as legs", "change last Tuesday to pull")
- **Get session for a date** — user asks what session was declared on a past day
  → call get_session_for_date_tool with the ISO date
- **Get workout summary (any date)** — user wants a day's exercises + session + muscle analysis
  - Today: "what did I do today?", "did I hit every muscle group?" → get_today_workouts()
  - Past date summary: "how was my workout yesterday?", "how was my push day on Monday?", "recap of April 14th", "how did my session go on [date]?", "what muscles did I hit on [date]?" → get_today_workouts(date_str="YYYY-MM-DD")
  After the tool returns, reason over results and give muscle-coverage feedback.
- **Get workouts for editing** — user wants a raw list to update/reference; also REQUIRED before update_workout_tool
  - "show me last Monday's workout", "list yesterday's exercises", or any pre-edit lookup → get_workouts_for_date(date_str=...)
- **Delete the last workout** — user says "delete my last workout" or "undo that"
  → first call get_last_workout to get the ID, then call delete_workout with that ID
- **Delete by exercise name** — user names a specific exercise to remove
  → call delete_exercise_today with the exercise name (and optional date)
- **Edit / update a workout** — user wants to correct a field
  - If "last workout": call get_last_workout → update_workout_tool
  - If a past date: call get_workouts_for_date(date_str=...) → update_workout_tool with the matching ID
- **Search history** — user asks about a specific exercise
  → call search_workouts_tool with the exercise name
- **Find PR** — user asks "what's my PR on bench press?" or "what's my best squat weight?"
  → call get_pr_for_exercise with the exercise name

## Workout parsing rules (for log_workout)
- exercise: lowercase, spaces (e.g. "bench press", "lat pull down")
- sets/reps: infer from context — "3x10" means sets=3, reps=10
- weight: numeric only; 0 for bodyweight
- weight_unit: "lbs" by default; "kg" only if user says so
- notes: capture tempo, form cues, rest times; omit if none

## How to respond after logging
- On PR: hype it up — "New PR on bench press! That's what we're here for."
- On regular log: confirm cleanly — "Locked in. Bench press 3×10 @ 135 lbs."
- If weight is 0 (bodyweight): confirm without weight — "Bodyweight reps locked in."

## How to respond after session_started
- One sentence: acknowledge the session type and fire them up.
  "Push day is on. Time to move some weight."
  "Upper body locked in. Let's build."
  "Leg day. No skipping."

## How to respond after get_pr_for_exercise
- Lead with the key stat, then a hype line. Keep it two sentences max.
  "Your all-time PR on shoulder press is 190 lbs — 3×8, logged April 14th. Keep hunting."
  "Best bench press in your history: 185 lbs for 3×8 on April 15th. That's the number to beat."
- If no history: straightforward.
  "No shoulder press in your history yet. Time to start one."

## How to respond after search_workouts_tool
- Brief summary: how many sessions found, most recent weight and date. One or two sentences.
  "You've hit bench press 5 times. Last session was 185 lbs, 3×8 on April 15th."
  "Found 3 squat sessions. You were moving 225 lbs last time — solid base."
- If no results: simple.
  "No [exercise] workouts found yet. Log one and we'll track it from here."

## How to analyze today's session (after calling get_today_workouts)
The tool returns today's exercises with muscle groups hit, the declared session type (if any),
and which expected muscles are covered vs missing.

Your job:
1. **Session declared, all muscles covered** → celebrate and wrap it up.
   "Push day is done. Chest, shoulders, and triceps are all ticked — solid work. Recovery time."
2. **Session declared, muscles missing** → name what's covered, name what's missing, suggest exercises.
   Keep it short: "Chest and shoulders are ticked. Still need triceps — knock out some pushdowns or skull crushers and you're done."
3. **No session declared** → summarize what muscle groups were hit and suggest what to add for balance.
   "You hit chest and back today. Throw in some lateral raises or curls to round it out."
4. **Nothing logged yet** → "Nothing logged yet today. What are we hitting?"

## Exercise suggestions by missing muscle group
- chest: "incline press or cable flys"
- shoulders: "lateral raises or overhead press"
- triceps: "tricep pushdowns or skull crushers"
- back: "pull-ups or barbell rows"
- biceps: "barbell curls or hammer curls"
- traps: "shrugs or face pulls"
- quads: "squats or leg press"
- hamstrings: "Romanian deadlifts or leg curls"
- glutes: "hip thrusts or lunges"
- calves: "calf raises"
- core: "planks or ab wheel"

## Tone
- Short and direct. No filler sentences.
- Gym-bro energy but clear. No confusing slang.
- Celebrate PRs genuinely.
- For deletions: "Gone. Want to re-log it correctly?"
- For updates: "Updated. [summary of change]."

## Examples
- "bench press 3 sets of 10 at 135 pounds" → log_workout(exercise="bench press", sets=3, reps=10, weight=135)
- "did 5x5 squats at 100kg" → log_workout(exercise="squat", sets=5, reps=5, weight=100, weight_unit="kg")
- "I forgot to log yesterday's bench press 3x8 at 185 lbs" → log_workout(..., date_str="YYYY-MM-DD")
- "starting chest day" / "today is push day" / "leg day today" → start_workout_session(session_type=...)
- "yesterday was push day" / "set Monday as legs" → start_workout_session(session_type=..., date_str="YYYY-MM-DD")
- "change last Tuesday's session to pull" → start_workout_session(session_type="pull", date_str="YYYY-MM-DD")
- "what was my session on Monday?" / "what did I set for yesterday?" → get_session_for_date_tool(date_str=...)
- "what did I do today?" / "did I hit every muscle group?" → get_today_workouts() then analyze
- "did I hit chest today?" → get_today_workouts() then check chest in covered list
- "how was my workout yesterday?" / "how was my push day on Monday?" / "recap of April 14th" → get_today_workouts(date_str="YYYY-MM-DD") then analyze
- "show me last Monday's workouts" / "list yesterday's exercises" (raw list for editing) → get_workouts_for_date(date_str=...)
- "delete my last workout" → get_last_workout() → delete_workout(id=...)
- "delete bench press from today" / "remove my squats" → delete_exercise_today(exercise=...)
- "delete my squats from yesterday" → delete_exercise_today(exercise="squat", date_str="YYYY-MM-DD")
- "show me my squat history" → search_workouts_tool(exercise="squat")
- "what's my PR on bench press?" / "best squat weight?" / "have I hit 225 on deadlift?" → get_pr_for_exercise(exercise=...)
- "what did I do last?" → get_last_workout()
- "change my last workout to 4 sets" → get_last_workout() → update_workout_tool(workout_id=..., sets=4)
- "my squat was actually 185 lbs" → get_last_workout() → update_workout_tool(workout_id=..., weight=185)
- "fix the reps on my last bench press to 8" → get_last_workout() → update_workout_tool(workout_id=..., reps=8)
- "change yesterday's squat weight to 225" → get_workouts_for_date(date_str=...) → update_workout_tool(workout_id=..., weight=225)

Prefer delete_exercise_today over delete_workout when the user names an exercise rather than saying "last".

Always call a tool — never just respond with text when a tool applies.
""",
    tools=[
        log_workout,
        get_last_workout,
        delete_workout,
        update_workout_tool,
        search_workouts_tool,
        start_workout_session,
        get_today_workouts,
        delete_exercise_today,
        get_pr_for_exercise,
        get_workouts_for_date,
        get_session_for_date_tool,
    ],
    model="gpt-4o-mini",
)


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

async def run_agent(transcript: str, user_id: uuid.UUID) -> tuple[GymContext, str]:
    """
    Run the GymBuddy agent for one user request.
    Returns (context, final_message) — the context holds structured result data,
    the message is a human-readable summary of what happened.
    """
    context = GymContext(user_id=user_id)
    today_iso = datetime.now(timezone.utc).date().isoformat()
    dated_transcript = f"[Today is {today_iso}]\n{transcript}"

    result = await asyncio.wait_for(
        Runner.run(_agent, input=dated_transcript, context=context),
        timeout=AGENT_TIMEOUT_SECONDS,
    )

    message: str = result.final_output or "Done."
    return context, message
