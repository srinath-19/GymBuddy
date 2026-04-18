from __future__ import annotations

import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse

from ..agents.exercise_coach import AGENT_TIMEOUT_SECONDS, exercise_coach
from ..auth.dependencies import get_current_user
from ..models.coach import CoachAPIResponse, CoachRequest, ExerciseCoachResponse
from ..services.conversation import (
    MAX_TURNS,
    append_turn,
    delete_conversation,
    get_or_create,
    is_at_limit,
    sweep_expired,
)

from agents import Runner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["coach"])


def _ok(data: object) -> JSONResponse:
    return JSONResponse({"success": True, "data": data, "error": None})


def _err(msg: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        {"success": False, "data": None, "error": msg},
        status_code=status_code,
    )


@router.post("/coach/ask")
async def coach_ask(
    body: CoachRequest,
    _current_user: dict = Depends(get_current_user),
) -> JSONResponse:
    # Lazy TTL sweep
    sweep_expired()

    # Resolve or create conversation
    conversation_id, entry = get_or_create(body.conversation_id)

    if is_at_limit(conversation_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Conversation limit reached ({MAX_TURNS} turns). Start a new question.",
        )

    # Build user content (multimodal if image provided, plain text otherwise)
    if body.image_base64:
        # Responses API (used by Agents SDK) uses "input_image" / "input_text",
        # not the Chat Completions "image_url" / "text" types.
        user_content: str | list[dict] = [
            {"type": "input_image", "image_url": body.image_base64},
            {"type": "input_text", "text": body.text},
        ]
    else:
        user_content = body.text

    # Compose full input: stored history + new user message
    input_messages = entry["history"] + [{"role": "user", "content": user_content}]

    try:
        result = await asyncio.wait_for(
            Runner.run(exercise_coach, input=input_messages),
            timeout=AGENT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Coach agent timed out.",
        )

    coach_response: ExerciseCoachResponse = result.final_output

    # Persist turn in conversation history
    append_turn(conversation_id, user_content, coach_response.message)

    turn_number = entry["turn_count"]  # already incremented by append_turn

    payload = CoachAPIResponse(
        conversation_id=conversation_id,
        turn_number=turn_number,
        max_turns=MAX_TURNS,
        response=coach_response,
    ).model_dump()

    return _ok(payload)


@router.delete("/coach/conversation/{conversation_id}")
async def coach_clear_conversation(
    conversation_id: str,
    _current_user: dict = Depends(get_current_user),
) -> JSONResponse:
    try:
        uuid.UUID(conversation_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid conversation ID format.",
        )

    delete_conversation(conversation_id)
    return _ok(None)
