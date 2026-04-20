from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Literal

logger = logging.getLogger(__name__)

from agents import Agent, RunContextWrapper, Runner, function_tool

from ..cache.redis_client import invalidate_user, set_cached_workouts
from ..data.muscle_ai import infer_muscles
from ..data.session_muscles import get_expected_muscles
from ..db.database import get_session
from ..db.queries import (
    check_personal_record,
    fetch_workouts,
    insert_muscle_targets,
    insert_workout,
)
from ..models.pacer import (
    CompletedSet,
    ExerciseProgress,
    PacerAgentOutput,
    PacerAPIResponse,
    PacerContext,
    PacerSessionState,
    PlanItem,
    PlannedExercise,
)
from ..models.workout import WorkoutLog
from ..services.pacer_session import (
    PACER_MAX_TURNS,
    PacerTurnLimitExceededError,
    append_turn,
    get_or_create,
    is_at_limit,
    save_state,
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
# Cache helper — mirrors _populate_workouts_cache in routes/workouts.py
# ---------------------------------------------------------------------------

async def _refresh_workouts_cache(user_id: uuid.UUID) -> None:
    try:
        async with get_session() as session:
            fresh = await fetch_workouts(session, user_id=user_id, limit=50)
        await set_cached_workouts(str(user_id), [r.model_dump(mode="json") for r in fresh])
    except Exception:
        logger.warning("Workouts cache refresh failed for user %s", user_id)


# ---------------------------------------------------------------------------
# Internal helper: finalize a completed exercise → one DB write
# ---------------------------------------------------------------------------

async def _finalize_exercise(
    context: PacerContext,
    progress: ExerciseProgress,
) -> str:
    """Write one workout_logs entry for a completed (or partially completed) exercise."""
    if not progress.completed_sets or progress.finalized:
        return ""

    sets = progress.completed_sets
    num_sets = len(sets)

    rep_counts = Counter(s.reps for s in sets)
    reps = rep_counts.most_common(1)[0][0]

    weight = max(s.weight for s in sets)
    weight_unit = sets[-1].weight_unit

    weights = [s.weight for s in sets]
    notes: str | None = None
    if len(set(weights)) > 1:
        weight_strs = [f"{w} {weight_unit}" for w in weights]
        notes = f"Set weights: {', '.join(weight_strs)}"

    parsed = WorkoutLog(
        exercise=progress.exercise.name.strip().lower(),
        sets=num_sets,
        reps=reps,
        weight=weight,
        weight_unit=weight_unit,
        notes=notes,
    )

    async with get_session() as session:
        record = await insert_workout(session, parsed, context.user_id)
        is_pr = await check_personal_record(
            session, context.user_id, record.exercise, record.weight, record.id
        )
        muscle_data = await infer_muscles(parsed.exercise)
        targets = await insert_muscle_targets(session, record.id, muscle_data, "ai_inferred")
        record = record.model_copy(update={"is_personal_record": is_pr, "muscle_targets": targets})

    progress.finalized = True
    progress.logged_workout_id = record.id
    context.logged_workouts.append(record)

    await invalidate_user(str(context.user_id))
    await _refresh_workouts_cache(context.user_id)

    pr_note = " New personal record!" if is_pr else ""
    return (
        f"Logged {progress.exercise.name} {num_sets}×{reps} @ {weight} {weight_unit}.{pr_note}"
    )


# ---------------------------------------------------------------------------
# Standalone business logic — called by both agent tools and REST endpoints
# ---------------------------------------------------------------------------

async def _mark_set_done_impl(
    context: PacerContext,
    reps: int | None,
    weight: float | None,
    weight_unit: str,
) -> tuple[str, Literal["planning", "active", "resting", "done"], int | None]:
    state = context.session_state
    progress = state.current_progress

    if progress is None:
        return "No workout plan active. Say 'start my push workout' to begin.", "planning", None

    if progress.finalized:
        remaining = [
            (i, ep) for i, ep in enumerate(state.exercise_progress)
            if not ep.finalized and i > state.current_exercise_index
        ]
        if not remaining:
            return "All exercises are done! Say 'end session' to wrap up.", "done", None
        state.current_exercise_index = remaining[0][0]
        progress = state.current_progress
        if progress is None:
            return "All exercises are done! Say 'end session' to wrap up.", "done", None

    actual_reps = reps if reps is not None else progress.exercise.target_reps

    if weight is not None:
        actual_weight = weight
    elif progress.completed_sets:
        actual_weight = progress.completed_sets[-1].weight
    else:
        actual_weight = 0.0

    progress.completed_sets.append(
        CompletedSet(reps=actual_reps, weight=actual_weight, weight_unit=weight_unit)
    )

    sets_done = progress.sets_done
    target = progress.exercise.target_sets
    exercise_name = progress.exercise.name

    if progress.is_complete:
        log_msg = await _finalize_exercise(context, progress)

        next_exercises = [
            (i, ep) for i, ep in enumerate(state.exercise_progress)
            if not ep.finalized and ep.sets_done == 0 and i > state.current_exercise_index
        ]

        if next_exercises:
            state.current_exercise_index = next_exercises[0][0]
            next_name = next_exercises[0][1].exercise.name
            msg = (
                f"All {target} sets of {exercise_name} complete! {log_msg} "
                f"Next up: {next_name}."
            )
            return msg, "resting", 120

        msg = (
            f"All {target} sets of {exercise_name} complete! {log_msg} "
            f"That's the last exercise — workout done!"
        )
        return msg, "done", None

    msg = (
        f"Set {sets_done}/{target} of {exercise_name} done "
        f"({actual_reps} reps @ {actual_weight} {weight_unit}). "
        f"{target - sets_done} set(s) remaining."
    )
    return msg, "active", None


async def _skip_exercise_impl(
    context: PacerContext,
) -> tuple[str, Literal["planning", "active", "resting", "done"], int | None]:
    state = context.session_state
    progress = state.current_progress

    if progress is None:
        return "No workout plan active.", "planning", None

    exercise_name = progress.exercise.name
    had_sets = progress.sets_done > 0

    log_msg = ""
    if had_sets and not progress.finalized:
        log_msg = await _finalize_exercise(context, progress)

    next_exercises = [
        (i, ep) for i, ep in enumerate(state.exercise_progress)
        if not ep.finalized and ep.sets_done == 0 and i > state.current_exercise_index
    ]

    if next_exercises:
        state.current_exercise_index = next_exercises[0][0]
        next_name = next_exercises[0][1].exercise.name
        if had_sets:
            msg = f"{exercise_name} done early — {log_msg} Next up: {next_name}."
            return msg, "resting", 120
        return f"Skipped {exercise_name}. Next up: {next_name}.", "active", None

    if had_sets:
        return f"{exercise_name} done early — {log_msg} That was the last exercise!", "done", None
    return f"Skipped {exercise_name}. No more exercises remaining — say 'end session' to finish.", "done", None


def _modify_plan_impl(
    context: PacerContext,
    action: str,
    exercise_name: str,
    replacement_name: str | None,
    target_sets: int | None,
    target_reps: int | None,
) -> str:
    state = context.session_state

    if not state.exercise_progress:
        return "No workout plan active. Start a session first."

    action = action.strip().lower()
    exercise_name = exercise_name.strip().lower()
    sets = target_sets if target_sets is not None else 3
    reps = target_reps if target_reps is not None else 10

    if action == "remove":
        found = False
        for i, ep in enumerate(state.exercise_progress):
            if ep.exercise.name.lower() == exercise_name and not ep.finalized:
                state.exercise_progress.pop(i)
                state.plan = [ep.exercise for ep in state.exercise_progress]
                if state.current_exercise_index >= len(state.exercise_progress):
                    state.current_exercise_index = max(0, len(state.exercise_progress) - 1)
                elif i < state.current_exercise_index:
                    state.current_exercise_index -= 1
                found = True
                break
        if not found:
            return f"'{exercise_name}' not found in the plan or already completed."
        remaining = [ep.exercise.name for ep in state.exercise_progress if not ep.finalized]
        return f"Removed {exercise_name}. Remaining: {', '.join(remaining)}."

    elif action == "add":
        new_ex = PlannedExercise(name=exercise_name, target_sets=sets, target_reps=reps)
        new_progress = ExerciseProgress(exercise=new_ex)
        state.exercise_progress.append(new_progress)
        state.plan.append(new_ex)
        return f"Added {exercise_name} ({sets}×{reps}) to the end of your plan."

    elif action == "swap":
        if not replacement_name:
            return "Need a replacement exercise name for swap."
        replacement_name = replacement_name.strip().lower()
        found = False
        for i, ep in enumerate(state.exercise_progress):
            if ep.exercise.name.lower() == exercise_name and not ep.finalized:
                new_ex = PlannedExercise(
                    name=replacement_name, target_sets=sets, target_reps=reps
                )
                state.exercise_progress[i] = ExerciseProgress(exercise=new_ex)
                state.plan[i] = new_ex
                found = True
                break
        if not found:
            return f"'{exercise_name}' not found in the plan or already completed."
        return f"Swapped {exercise_name} → {replacement_name} ({sets}×{reps})."

    elif action == "change":
        found = False
        idx = -1
        for i, ep in enumerate(state.exercise_progress):
            if ep.exercise.name.lower() == exercise_name and not ep.finalized:
                if target_sets is not None:
                    ep.exercise.target_sets = target_sets
                if target_reps is not None:
                    ep.exercise.target_reps = target_reps
                state.plan[i] = ep.exercise
                idx = i
                found = True
                break
        if not found:
            return f"'{exercise_name}' not found in the plan or already completed."
        ep_ref = state.exercise_progress[idx]
        return f"Updated {exercise_name} to {ep_ref.exercise.target_sets}×{ep_ref.exercise.target_reps}."

    return f"Unknown action '{action}'. Use 'remove', 'add', 'swap', or 'change'."


# ---------------------------------------------------------------------------
# Direct-response builder — used by REST endpoints (no LLM output needed)
# ---------------------------------------------------------------------------

def build_direct_pacer_response(
    context: PacerContext,
    conv_id: str,
    turn_number: int,
    message: str,
    phase: Literal["planning", "active", "resting", "done"],
    rest_seconds: int | None = None,
) -> PacerAPIResponse:
    state = context.session_state
    current = state.current_progress
    last_logged = context.logged_workouts[-1] if context.logged_workouts else None

    current_plan = [
        PlanItem(
            name=ep.exercise.name,
            target_sets=ep.exercise.target_sets,
            target_reps=ep.exercise.target_reps,
            sets_done=ep.sets_done,
            finalized=ep.finalized,
        )
        for ep in state.exercise_progress
    ]

    current_exercise: str | None = None
    set_number: int | None = None
    if current and not current.finalized:
        current_exercise = current.exercise.name
        if phase == "active":
            set_number = current.sets_done + 1

    return PacerAPIResponse(
        conversation_id=conv_id,
        turn_number=turn_number,
        max_turns=PACER_MAX_TURNS,
        message=message,
        phase=phase,
        rest_seconds=rest_seconds,
        current_exercise=current_exercise,
        set_number=set_number,
        suggested_exercises=[],
        logged_workout=last_logged,
        total_exercises=len(state.exercise_progress),
        completed_exercises=state.completed_count,
        current_exercise_sets_done=current.sets_done if current else 0,
        current_exercise_sets_total=current.exercise.target_sets if current else 0,
        session_type=state.session_type,
        current_plan=current_plan,
    )


# ---------------------------------------------------------------------------
# Tools — thin wrappers that call the _impl functions above
# ---------------------------------------------------------------------------

@function_tool(strict_mode=False)
async def suggest_exercises(
    ctx: RunContextWrapper[PacerContext],
    session_type: str,
) -> str:
    """
    Build a workout plan for a session type and store it.
    Call this ONLY when starting a brand-new session with no exercises yet.
    Do NOT call this if exercises already exist — that would wipe the current plan.

    Args:
        session_type: Session label, lowercase (e.g. "push", "pull", "legs", "chest").
    """
    state = ctx.context.session_state

    # Guard: if a plan already exists, do not reset it. Just transition to active.
    if state.exercise_progress:
        remaining = [ep for ep in state.exercise_progress if not ep.finalized]
        current = state.current_progress
        if not current and remaining:
            state.current_exercise_index = state.exercise_progress.index(remaining[0])
            current = state.current_progress
        names = ", ".join(ep.exercise.name for ep in remaining)
        tags = " [PHASE:active]"
        if current:
            tags += f"[CURRENT_EXERCISE:{current.exercise.name}][CURRENT_SET:{current.sets_done + 1}]"
        return f"Plan already set ({len(remaining)} exercises remaining): {names}. Starting now.{tags}"

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

    exercises = suggestions[:6]

    state = ctx.context.session_state
    state.session_type = session_type.strip().lower()
    state.plan = [
        PlannedExercise(name=ex, target_sets=3, target_reps=10)
        for ex in exercises
    ]
    state.exercise_progress = [
        ExerciseProgress(exercise=pe) for pe in state.plan
    ]
    state.current_exercise_index = 0

    exercises_str = ", ".join(exercises)
    targets_str = ", ".join(muscle_groups)
    return (
        f"Workout plan for {session_type} ({len(exercises)} exercises): {exercises_str}. "
        f"Targets: {targets_str}. "
        f"First up: {exercises[0]} — 3 sets of 10."
    )


@function_tool(strict_mode=False)
async def mark_set_done(
    ctx: RunContextWrapper[PacerContext],
    reps: int | None = None,
    weight: float | None = None,
    weight_unit: str = "lbs",
) -> str:
    """
    Record completing the current set. If all planned sets are now done,
    automatically logs the exercise to the database.

    Call this when the user says "done", "finished", "set done", or reports
    completing a set with specific numbers.

    Args:
        reps: Actual reps completed. Uses planned reps if omitted (user just says "done").
        weight: Actual weight used. Uses last set's weight or 0 if first set and omitted.
        weight_unit: "lbs" (default) or "kg".
    """
    msg, phase, rest_seconds = await _mark_set_done_impl(ctx.context, reps, weight, weight_unit)
    current = ctx.context.session_state.current_progress
    tags = f" [PHASE:{phase}]"
    if rest_seconds is not None:
        tags += f"[REST:{rest_seconds}]"
    if current and not current.finalized:
        tags += f"[CURRENT_EXERCISE:{current.exercise.name}][CURRENT_SET:{current.sets_done + 1}]"
    return msg + tags


@function_tool(strict_mode=False)
async def get_session_progress(
    ctx: RunContextWrapper[PacerContext],
) -> str:
    """
    Check overall session progress: what exercises are done, in progress, or remaining.
    Call this when the user asks "what have I done so far?", "how's the workout going?",
    or "what's next?".
    """
    state = ctx.context.session_state

    if not state.exercise_progress:
        return "No workout plan active. Say 'start my push workout' to begin."

    lines: list[str] = []
    for i, ep in enumerate(state.exercise_progress):
        status = ""
        if ep.finalized:
            status = "✓ done"
        elif ep.sets_done > 0:
            status = f"→ {ep.sets_done}/{ep.exercise.target_sets} sets"
        elif i == state.current_exercise_index:
            status = "← up next"
        else:
            status = "pending"

        lines.append(f"{i+1}. {ep.exercise.name} — {status}")

    completed = state.completed_count
    total = len(state.exercise_progress)
    header = f"Session progress ({completed}/{total} exercises done):"

    return header + "\n" + "\n".join(lines)


@function_tool(strict_mode=False)
async def skip_exercise(
    ctx: RunContextWrapper[PacerContext],
) -> str:
    """
    Move to the next exercise. If the user has completed at least one set
    of the current exercise, those sets are logged to the database before
    advancing. If no sets were done, the exercise is skipped entirely.

    Call this when the user says "skip", "next exercise", "move on",
    "let's go to the next one", or wants to stop the current exercise early.
    """
    msg, phase, rest_seconds = await _skip_exercise_impl(ctx.context)
    current = ctx.context.session_state.current_progress
    tags = f" [PHASE:{phase}]"
    if rest_seconds is not None:
        tags += f"[REST:{rest_seconds}]"
    if current and not current.finalized:
        tags += f"[CURRENT_EXERCISE:{current.exercise.name}][CURRENT_SET:{current.sets_done + 1}]"
    return msg + tags


@function_tool(strict_mode=False)
async def end_session(
    ctx: RunContextWrapper[PacerContext],
) -> str:
    """
    End the workout session. Logs any exercise with at least one completed set
    (even if not all planned sets were done). Discards exercises with zero sets.

    Call this when the user says "done", "end workout", "I'm done", "end session",
    or "that's it".
    """
    state = ctx.context.session_state

    if not state.exercise_progress:
        return "No workout plan active. Nothing to end."

    logged_names: list[str] = []
    skipped_names: list[str] = []

    for ep in state.exercise_progress:
        if ep.finalized:
            logged_names.append(ep.exercise.name)
            continue
        if ep.sets_done > 0:
            await _finalize_exercise(ctx.context, ep)
            logged_names.append(f"{ep.exercise.name} ({ep.sets_done} sets)")
        else:
            skipped_names.append(ep.exercise.name)

    parts: list[str] = []
    if logged_names:
        parts.append(f"Logged: {', '.join(logged_names)}")
    if skipped_names:
        parts.append(f"Skipped: {', '.join(skipped_names)}")

    return f"Session complete! {'. '.join(parts)}. [PHASE:done]"


@function_tool(strict_mode=False)
async def modify_plan(
    ctx: RunContextWrapper[PacerContext],
    action: str,
    exercise_name: str,
    replacement_name: str | None = None,
    target_sets: int | None = None,
    target_reps: int | None = None,
) -> str:
    """
    Modify the workout plan. Use when the user wants to customize exercises
    after seeing the plan.

    Args:
        action: One of "remove", "add", "swap", or "change".
          - "remove": remove the named exercise from the plan.
          - "add": add a new exercise (uses target_sets/target_reps, defaults 3×10).
          - "swap": replace exercise_name with replacement_name.
          - "change": update set/rep targets of an existing exercise
            (e.g. "change bench to 4 sets of 8").
        exercise_name: The exercise to remove/swap/change, or the exercise to add.
        replacement_name: For "swap" only — the new exercise to replace with.
        target_sets: Sets for added/swapped/changed exercise (default 3).
        target_reps: Reps for added/swapped/changed exercise (default 10).
    """
    return _modify_plan_impl(
        ctx.context, action, exercise_name, replacement_name, target_sets, target_reps
    )


# ---------------------------------------------------------------------------
# Agent — created once at import, stateless (context is per-request)
# ---------------------------------------------------------------------------

_pacer: Agent[PacerContext] = Agent(
    name="Workout Pacer",
    instructions="""You are GymBuddy's Workout Pacer — a voice-first coach who guides users
through their gym sessions in real time. You are energetic, concise, and practical.

## Your job
1. **Plan the session** — when the user says "start my push workout" or similar, call
   suggest_exercises to build a plan. Set phase="planning".
2. **Cue each set** — after the plan is set, tell the user what exercise and set to do next.
   Set current_exercise and set_number. Set phase="active".
3. **Record completed sets** — when the user says "done", "finished", or gives numbers
   (e.g. "done, 10 at 155"), call mark_set_done. The tool handles auto-logging when all
   sets are complete.
4. **Manage rest** — after mark_set_done, the tool tells you the rest time in [REST:N].
   Echo it in rest_seconds and set phase="resting".
5. **Cue next set or exercise** — when user says "ready", "go", or timer done, set
   phase="active" with the next exercise/set from the [CURRENT_EXERCISE] / [CURRENT_SET] tags.
6. **End the session** — when user says "done for today", "end session", or "wrap it up",
   call end_session. Set phase="done".

## CRITICAL: Reading tool result tags
Every tool that changes state returns machine-readable tags. You MUST copy them exactly:
- `[PHASE:resting]` → set phase="resting" in your output
- `[PHASE:active]` → set phase="active"
- `[PHASE:done]` → set phase="done"
- `[REST:90]` → set rest_seconds=90
- `[CURRENT_EXERCISE:bench press]` → set current_exercise="bench press"
- `[CURRENT_SET:2]` → set set_number=2
- If no [REST:N] tag appears → do NOT set rest_seconds (leave null)
Never infer phase or rest time from the message text — always use the tags.

## Tool usage rules — when to call what
- "start my push workout" / "let's do chest day" → call suggest_exercises() ONLY if no plan exists yet.
  If a plan already exists (you can see exercises in conversation history or via get_session_progress),
  DO NOT call suggest_exercises — it will wipe the plan. Instead set phase="active" and cue the first exercise.
- "let's start" / "begin" / "let's go" / "start workout now" in planning phase → NO tool call.
  Just set phase="active" with the first non-done exercise.
- "done" / "finished" / "set done" / "got it" / "done, 10 at 135" → call mark_set_done()
- "skip" / "next exercise" / "move on" / "let's do the next one" → call skip_exercise()
  (auto-logs partial sets if any; skips cleanly if none)
- "remove cable fly" / "add dips" → call modify_plan(action="remove"/"add", ...)
- "swap incline for dumbbell press" → call modify_plan(action="swap", ...)
- "change bench to 4 sets" / "make bench 4x8" → call modify_plan(action="change",
  exercise_name="bench press", target_sets=4, target_reps=8)
- "what have I done?" / "progress?" / "what's next?" → call get_session_progress()
- "end session" / "done for today" / "all done" / "wrap it up" → call end_session()
- "ready" / "go" / "let's go" (after rest) → NO tool call, just set phase="active" with
  the [CURRENT_EXERCISE] and [CURRENT_SET] from the last tool result

## Disambiguating "done"
- "done" alone mid-session (after a set cue) → ALWAYS mark_set_done, not end_session
- "done for today" / "done with the workout" / "that's it for today" → end_session
- "done, skip the rest" → skip_exercise
- When in doubt: if there are remaining sets/exercises, prefer mark_set_done

## Voice-first rules
- Keep message SHORT: 1-3 sentences. You will be read aloud.
- Use active, motivating language: "Let's go!", "Rack it!", "Big set."
- Never output JSON, lists, or formatted text in the message field.
- Put structured data (exercises, rest duration) in the output fields, not in message.

## Rest time defaults (only used if tool doesn't return [REST:N])
- 3×8–12 hypertrophy: rest_seconds=60
- 4–6 rep strength: rest_seconds=150
- Supersets: rest_seconds=30
- Between exercises (all sets done, moving to next): rest_seconds=120
- If unsure: rest_seconds=90

## Tone
- Short and direct. No filler.
- Gym-bro energy: "Let's go!", "Solid set.", "One more."
- Celebrate PRs: "New PR! That's a new top weight!"
- For set cues: tell them the exercise, set number, target reps.
  "Bench press, set 2. Same weight, 10 reps. Go."

Always call a tool when one applies — never just respond with text.
""",
    tools=[suggest_exercises, mark_set_done, get_session_progress, skip_exercise, end_session, modify_plan],
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
        raise PacerTurnLimitExceededError(
            f"Pacer session reached the {PACER_MAX_TURNS}-turn limit."
        )

    state: PacerSessionState = entry["state"]
    context = PacerContext(user_id=user_id, session_state=state)

    input_messages = entry["history"] + [{"role": "user", "content": text}]

    result = await asyncio.wait_for(
        Runner.run(_pacer, input=input_messages, context=context),
        timeout=AGENT_TIMEOUT_SECONDS,
    )

    output: PacerAgentOutput = result.final_output

    append_turn(conv_id, text, output.message)
    save_state(conv_id, context.session_state)

    turn_number = entry["turn_count"]

    return output, context, conv_id, turn_number


def build_pacer_api_response(
    output: PacerAgentOutput,
    context: PacerContext,
    conversation_id: str,
    turn_number: int,
) -> PacerAPIResponse:
    state = context.session_state
    current = state.current_progress

    last_logged = context.logged_workouts[-1] if context.logged_workouts else None

    current_plan = [
        PlanItem(
            name=ep.exercise.name,
            target_sets=ep.exercise.target_sets,
            target_reps=ep.exercise.target_reps,
            sets_done=ep.sets_done,
            finalized=ep.finalized,
        )
        for ep in state.exercise_progress
    ]

    return PacerAPIResponse(
        conversation_id=conversation_id,
        turn_number=turn_number,
        max_turns=PACER_MAX_TURNS,
        message=output.message,
        phase=output.phase,
        rest_seconds=output.rest_seconds,
        current_exercise=output.current_exercise,
        set_number=output.set_number,
        suggested_exercises=output.suggested_exercises,
        logged_workout=last_logged,
        total_exercises=len(state.exercise_progress),
        completed_exercises=state.completed_count,
        current_exercise_sets_done=current.sets_done if current else 0,
        current_exercise_sets_total=current.exercise.target_sets if current else 0,
        session_type=state.session_type,
        current_plan=current_plan,
    )
