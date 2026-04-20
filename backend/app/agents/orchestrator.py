from __future__ import annotations

import asyncio
import uuid
from typing import Literal

from agents import Agent, Runner

from ..agents.exercise_coach import AGENT_TIMEOUT_SECONDS as COACH_TIMEOUT, exercise_coach
from ..agents.workout_pacer import build_pacer_api_response, run_pacer
from ..agents.workout_parser import run_agent
from ..models.chat import ChatRequest, ChatResponse
from ..models.coach import CoachAPIResponse, ExerciseCoachResponse
from ..models.workout import AgentActionResponse
from ..services.conversation import (
    MAX_TURNS,
    TurnLimitExceededError,
    append_turn,
    get_or_create,
    is_at_limit,
    sweep_expired,
)
from ..services.pacer_session import PacerTurnLimitExceededError
from pydantic import BaseModel

CLASSIFIER_TIMEOUT_SECONDS = 10


# ---------------------------------------------------------------------------
# Intent classifier — small, fast, no tools
# ---------------------------------------------------------------------------

class IntentResult(BaseModel):
    agent: Literal["workout", "coach", "pacer"]


_classifier = Agent(
    name="IntentClassifier",
    instructions="""Classify the user's gym-app message into one agent.

Rules:
- "workout": logging a completed exercise, editing/deleting a log, searching history,
  checking PRs, starting or setting a session type (e.g. "chest day").
- "coach": questions about exercise form, technique, muscles, equipment identification,
  asking for a tutorial or video, general gym knowledge questions. Any message with an image.
- "pacer": starting or guiding through a workout in real-time — "start my push workout",
  "ready", "done", "next", "how long should I rest?", "what's my next exercise?".

If the message contains an image, always choose "coach".
Respond only with the agent field — no explanation.
""",
    output_type=IntentResult,
    model="gpt-4o-mini",
)


async def _classify(text: str, has_image: bool) -> Literal["workout", "coach", "pacer"]:
    prompt = f"[image attached] {text}" if has_image else text
    result = await asyncio.wait_for(
        Runner.run(_classifier, input=prompt),
        timeout=CLASSIFIER_TIMEOUT_SECONDS,
    )
    return result.final_output.agent


# ---------------------------------------------------------------------------
# Coach runner (mirrors the logic in routes/coach.py, extracted for reuse)
# ---------------------------------------------------------------------------

async def _run_coach(
    text: str,
    image_base64: str | None,
    conversation_id: str | None,
) -> CoachAPIResponse:
    sweep_expired()
    conv_id, entry = get_or_create(conversation_id)

    if is_at_limit(conv_id):
        raise TurnLimitExceededError(f"Coach conversation reached the {MAX_TURNS}-turn limit.")

    if image_base64:
        user_content: str | list[dict] = [
            {"type": "input_image", "image_url": image_base64},
            {"type": "input_text", "text": text},
        ]
    else:
        user_content = text

    input_messages = entry["history"] + [{"role": "user", "content": user_content}]

    result = await asyncio.wait_for(
        Runner.run(exercise_coach, input=input_messages),
        timeout=COACH_TIMEOUT,
    )

    coach_response: ExerciseCoachResponse = result.final_output
    append_turn(conv_id, user_content, coach_response.message)
    turn_number = entry["turn_count"]

    return CoachAPIResponse(
        conversation_id=conv_id,
        turn_number=turn_number,
        max_turns=MAX_TURNS,
        response=coach_response,
    )


# ---------------------------------------------------------------------------
# Main orchestrator — classify → dispatch → return ChatResponse
# ---------------------------------------------------------------------------

async def run_orchestrator(req: ChatRequest, user_id: uuid.UUID) -> ChatResponse:
    agent_type = await _classify(req.text, bool(req.image_base64))

    # If the user has an active pacer session and the classifier didn't pick coach
    # (coach is unambiguous — always form/technique), force route to pacer.
    # The classifier lacks session context so "remove bench", "done 10 at 135", etc.
    # get misclassified as "workout" actions. Hard override fixes this.
    if req.pacer_conversation_id and agent_type == "workout":
        agent_type = "pacer"

    if agent_type == "workout":
        gym_context, message = await run_agent(req.text, user_id)
        action = AgentActionResponse(
            action=gym_context.action,  # type: ignore[arg-type]
            message=message,
            workout=gym_context.logged_workout,
            workouts=gym_context.found_workouts or gym_context.deleted_workouts or None,
            session=gym_context.session,
        )
        return ChatResponse(agent_type="workout", workout=action)

    if agent_type == "coach":
        coach_resp = await _run_coach(req.text, req.image_base64, req.coach_conversation_id)
        return ChatResponse(agent_type="coach", coach=coach_resp)

    # pacer
    pacer_output, pacer_ctx, conv_id, turn_number = await run_pacer(
        req.text, req.pacer_conversation_id, user_id
    )
    pacer_resp = build_pacer_api_response(pacer_output, pacer_ctx, conv_id, turn_number)
    return ChatResponse(agent_type="pacer", pacer=pacer_resp)
