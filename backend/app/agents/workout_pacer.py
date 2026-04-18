from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

from agents import Agent, RunContextWrapper, Runner, function_tool

from ..data.muscle_ai import infer_muscles
from ..data.session_muscles import get_expected_muscles
from ..db.database import get_session
from ..db.queries import (
    check_personal_record,
    fetch_workouts_by_date,
    insert_muscle_targets,
    insert_workout,
)
from ..models.pacer import PacerAgentOutput, PacerAPIResponse, PacerContext
from ..models.workout import WorkoutLog
from ..services.conversation import (
    MAX_TURNS,
    TurnLimitExceededError,
    append_turn,
    get_or_create,
    is_at_limit,
    sweep_expired,
)

AGENT_TIMEOUT_SECONDS = 60

# ---------------------------------------------------------------------------
# Exercise suggestions per muscle group
# ---------------------------------------------------------------------------

_EXERCISES_BY_MUSCLE: dict[str, list[str]] = {
    "chest":      ["bench press", "incline bench press", "cable fly", "dumbbell fly", "push up"],
    "back":       ["pull up", "lat pull down", "barbell row", "seated cable row", "face pull"],
    "shoulders":  ["overhead press", "dumbbell lateral raise", "front raise", "arnold press"],
    "triceps":    ["tricep pushdown", "skull crusher", "overhead tricep extension", "dips"],
    "biceps":     ["barbell curl", "dumbbell curl", "hammer curl", "preacher curl"],
    "quads":      ["squat", "leg press", "leg extension", "lunges", "hack squat"],
    "hamstrings": ["romanian deadlift", "leg curl", "stiff leg deadlift"],
    "glutes":     ["hip thrust", "glute bridge", "cable kickback"],
    "calves":     ["calf raise", "seated calf raise"],
    "core":       ["plank", "crunch", "leg raise", "cable crunch"],
    "traps":      ["shrug", "upright row", "face pull"],
}


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@function_tool(strict_mode=False)
async def suggest_exercises(
    ctx: RunContextWrapper[PacerContext],
    session_type: str,
) -> str:
    """
    Suggest an ordered list of exercises for a given session type.
    Call this when the user wants to start a workout and needs a plan
    (e.g. "start my push workout", "what should I do for chest day?").

    Args:
        session_type: Session label, lowercase (e.g. "push", "pull", "legs", "chest").
    """
    muscle_groups = get_expected_muscles(session_type)
    if not muscle_groups:
        return f"Unknown session type '{session_type}'. Try 'push', 'pull', 'legs', 'chest', 'back', 'arms', etc."

    suggestions: list[str] = []
    seen: set[str] = set()
    for muscle in muscle_groups:
        for exercise in _EXERCISES_BY_MUSCLE.get(muscle, []):
            if exercise not in seen:
                suggestions.append(exercise)
                seen.add(exercise)

    exercises_str = ", ".join(suggestions[:8])  # cap at 8
    return (
        f"Suggested exercises for {session_type}: {exercises_str}. "
        f"Targets: {', '.join(muscle_groups)}."
    )


@function_tool(strict_mode=False)
async def log_completed_set(
    ctx: RunContextWrapper[PacerContext],
    exercise: str,
    sets: int,
    reps: int,
    weight: float,
    weight_unit: str = "lbs",
) -> str:
    """
    Log a completed set to the database and check for a personal record.
    Call this when the user reports finishing a set (e.g. "done", "3x10 at 135", "finished").

    Args:
        exercise: Exercise name, lowercase with spaces (e.g. "bench press").
        sets: Number of sets completed.
        reps: Reps per set.
        weight: Weight used. Use 0 for bodyweight.
        weight_unit: "lbs" (default) or "kg".
    """
    parsed = WorkoutLog(
        exercise=exercise.strip().lower(),
        sets=sets,
        reps=reps,
        weight=weight,
        weight_unit=weight_unit,  # type: ignore[arg-type]
    )

    async with get_session() as session:
        record = await insert_workout(session, parsed, ctx.context.user_id)
        is_pr = await check_personal_record(
            session, ctx.context.user_id, record.exercise, record.weight, record.id
        )
        muscle_data = await infer_muscles(parsed.exercise)
        targets = await insert_muscle_targets(session, record.id, muscle_data, "ai_inferred")
        record = record.model_copy(update={"is_personal_record": is_pr, "muscle_targets": targets})

    ctx.context.logged_workout = record

    pr_note = " New personal record!" if is_pr else ""
    return f"Logged {exercise} {sets}×{reps} @ {weight} {weight_unit}.{pr_note}"


@function_tool(strict_mode=False)
async def get_today_progress(
    ctx: RunContextWrapper[PacerContext],
) -> str:
    """
    Check what exercises have already been logged today.
    Call this when the user asks what they've done so far, or to avoid repeating an exercise.
    """
    today = datetime.now(timezone.utc).date()
    async with get_session() as db:
        workouts = await fetch_workouts_by_date(db, ctx.context.user_id, today)

    if not workouts:
        return "No exercises logged yet today. Fresh start!"

    lines = [
        f"{w.exercise} {w.sets}×{w.reps} @ {w.weight} {w.weight_unit}"
        for w in workouts
    ]
    return f"Done today ({len(workouts)} sets):\n" + "\n".join(lines)


# ---------------------------------------------------------------------------
# Agent — created once at import, stateless (context is per-request)
# ---------------------------------------------------------------------------

_pacer: Agent[PacerContext] = Agent(
    name="Workout Pacer",
    instructions="""You are GymBuddy's Workout Pacer — a voice-first coach who guides users
through their gym sessions in real time. You are energetic, concise, and practical.

## Your job
1. **Plan the session** — when the user says "start my push workout" or similar, call
   suggest_exercises to build a plan. Return it in suggested_exercises, set phase="planning".
2. **Guide each set** — tell the user what exercise to do next, which set they're on.
   Set current_exercise and set_number in your output.
3. **Log completed sets** — when the user reports finishing a set (e.g. "done", "3x10 at 135"),
   call log_completed_set. Always log before telling them to rest.
4. **Manage rest** — after logging, set rest_seconds to a sensible rest time (45-90s for
   hypertrophy, 120-180s for strength). Set phase="resting".
5. **Cue the next set** — when they say "done resting", "go", or "ready", advance to the
   next set or exercise. Set phase="active".
6. **End the session** — when all exercises are done or user says "done", set phase="done".

## Voice-first rules
- Keep message SHORT: 1-3 sentences. You will be read aloud.
- Use active, motivating language: "Let's go!", "Rack it!", "Big set."
- Never output JSON, lists, or formatted text in the message field.
- Put structured data (exercises, rest duration) in the output fields, not in message.

## Rest time defaults
- 3×8-12 hypertrophy: rest_seconds=60
- 4-6 rep strength: rest_seconds=150
- Supersets: rest_seconds=30
- If unsure: rest_seconds=90

## Set logging
- When user says "done" after being told to start a set, assume they completed the planned reps/weight.
- If user gives specific numbers ("3 sets of 10 at 135"), use those exact values.
- For bodyweight exercises, use weight=0.
""",
    tools=[suggest_exercises, log_completed_set, get_today_progress],
    output_type=PacerAgentOutput,
    model="gpt-4o",
)


# ---------------------------------------------------------------------------
# Run function called by the orchestrator
# ---------------------------------------------------------------------------

async def run_pacer(
    text: str,
    conversation_id: str | None,
    user_id: uuid.UUID,
) -> tuple[PacerAgentOutput, PacerContext, str, int]:
    """
    Run one turn of the pacer agent.
    Returns (agent_output, pacer_context, conversation_id, turn_number).
    """
    sweep_expired()
    conv_id, entry = get_or_create(conversation_id)

    if is_at_limit(conv_id):
        raise TurnLimitExceededError(f"Pacer session reached the {MAX_TURNS}-turn limit.")

    input_messages = entry["history"] + [{"role": "user", "content": text}]
    context = PacerContext(user_id=user_id)

    result = await asyncio.wait_for(
        Runner.run(_pacer, input=input_messages, context=context),
        timeout=AGENT_TIMEOUT_SECONDS,
    )

    output: PacerAgentOutput = result.final_output
    append_turn(conv_id, text, output.message)
    turn_number = entry["turn_count"]

    return output, context, conv_id, turn_number


def build_pacer_api_response(
    output: PacerAgentOutput,
    context: PacerContext,
    conversation_id: str,
    turn_number: int,
) -> PacerAPIResponse:
    return PacerAPIResponse(
        conversation_id=conversation_id,
        turn_number=turn_number,
        max_turns=MAX_TURNS,
        message=output.message,
        phase=output.phase,
        rest_seconds=output.rest_seconds,
        current_exercise=output.current_exercise,
        set_number=output.set_number,
        suggested_exercises=output.suggested_exercises,
        logged_workout=context.logged_workout,
    )
