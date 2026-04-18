from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from .workout import WorkoutLogResponse


# ---------------------------------------------------------------------------
# Per-request context — passed via RunContextWrapper, never sent to the LLM
# ---------------------------------------------------------------------------

@dataclass
class PacerContext:
    user_id: uuid.UUID
    logged_workout: WorkoutLogResponse | None = None


# ---------------------------------------------------------------------------
# Structured output the pacer LLM must produce each turn
# ---------------------------------------------------------------------------

class PacerAgentOutput(BaseModel):
    message: str
    """Short, voice-friendly cue (1-3 sentences max)."""

    phase: Literal["planning", "active", "resting", "done"] = "planning"
    """Current phase of the workout session."""

    rest_seconds: int | None = None
    """If set, the client should start a countdown timer for this many seconds."""

    current_exercise: str | None = None
    """The exercise the user is currently working on or about to start."""

    set_number: int | None = None
    """Which set number they are on (1-based)."""

    suggested_exercises: list[str] = []
    """Ordered list of exercises for the session (only populated in planning phase)."""


# ---------------------------------------------------------------------------
# API response model — merges LLM output with DB side-effects from tools
# ---------------------------------------------------------------------------

class PacerAPIResponse(BaseModel):
    conversation_id: str
    turn_number: int
    max_turns: int
    message: str
    phase: Literal["planning", "active", "resting", "done"]
    rest_seconds: int | None = None
    current_exercise: str | None = None
    set_number: int | None = None
    suggested_exercises: list[str] = []
    logged_workout: WorkoutLogResponse | None = None
    """Populated when a set was logged this turn (from DB, not the LLM)."""
