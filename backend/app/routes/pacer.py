from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from ..agents.workout_pacer import (
    _mark_set_done_impl,
    _modify_plan_impl,
    _skip_exercise_impl,
    build_direct_pacer_response,
)
from ..auth.dependencies import get_current_user
from ..models.pacer import (
    PacerContext,
    PacerPlanModifyRequest,
    PacerResponse,
    PacerSetDoneRequest,
)
from ..services.pacer_session import note_manual_action, pacer_sessions, save_state
from .tts import generate_tts_b64

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/pacer", tags=["pacer"])


def _get_context(conv_id: str, user_id: UUID) -> tuple[PacerContext, dict]:
    """Load session entry and build a PacerContext. Raises 404 if not found."""
    entry = pacer_sessions.get(conv_id)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pacer session not found. Start a session via chat first.",
        )
    return PacerContext(user_id=user_id, session_state=entry["state"]), entry


# ---------------------------------------------------------------------------
# POST /pacer/{conv_id}/set-done
# ---------------------------------------------------------------------------

@router.post("/{conv_id}/set-done", response_model=PacerResponse)
async def pacer_set_done(
    conv_id: str,
    body: PacerSetDoneRequest,
    current_user: dict = Depends(get_current_user),
) -> PacerResponse:
    user_id = UUID(current_user["sub"])
    context, entry = _get_context(conv_id, user_id)

    try:
        message, phase, rest_seconds = await _mark_set_done_impl(
            context, body.reps, body.weight, body.weight_unit
        )
    except Exception:
        logger.exception("pacer set-done failed for conv %s", conv_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to record set.",
        )

    save_state(conv_id, context.session_state)
    note_manual_action(conv_id, message)
    response = build_direct_pacer_response(
        context, conv_id, entry["turn_count"], message, phase, rest_seconds
    )
    response.tts_audio_b64 = await generate_tts_b64(message)
    return PacerResponse(success=True, data=response)


# ---------------------------------------------------------------------------
# POST /pacer/{conv_id}/skip
# ---------------------------------------------------------------------------

@router.post("/{conv_id}/skip", response_model=PacerResponse)
async def pacer_skip(
    conv_id: str,
    current_user: dict = Depends(get_current_user),
) -> PacerResponse:
    user_id = UUID(current_user["sub"])
    context, entry = _get_context(conv_id, user_id)

    try:
        message, phase, rest_seconds = await _skip_exercise_impl(context)
    except Exception:
        logger.exception("pacer skip failed for conv %s", conv_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to skip exercise.",
        )

    save_state(conv_id, context.session_state)
    note_manual_action(conv_id, message)
    response = build_direct_pacer_response(
        context, conv_id, entry["turn_count"], message, phase, rest_seconds
    )
    response.tts_audio_b64 = await generate_tts_b64(message)
    return PacerResponse(success=True, data=response)


# ---------------------------------------------------------------------------
# POST /pacer/{conv_id}/plan  — remove / add / swap / change
# ---------------------------------------------------------------------------

@router.post("/{conv_id}/plan", response_model=PacerResponse)
async def pacer_modify_plan(
    conv_id: str,
    body: PacerPlanModifyRequest,
    current_user: dict = Depends(get_current_user),
) -> PacerResponse:
    user_id = UUID(current_user["sub"])
    context, entry = _get_context(conv_id, user_id)

    message = _modify_plan_impl(
        context,
        body.action,
        body.exercise_name,
        body.replacement_name,
        body.target_sets,
        body.target_reps,
    )

    save_state(conv_id, context.session_state)
    note_manual_action(conv_id, message)

    state = context.session_state
    phase = "planning" if state.completed_count == 0 and all(
        ep.sets_done == 0 for ep in state.exercise_progress
    ) else "active"

    response = build_direct_pacer_response(
        context, conv_id, entry["turn_count"], message, phase  # type: ignore[arg-type]
    )
    response.tts_audio_b64 = await generate_tts_b64(message)
    return PacerResponse(success=True, data=response)
