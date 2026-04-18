from __future__ import annotations

from datetime import date as Date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# AI output model — used as output_type= in the OpenAI Agent
# ---------------------------------------------------------------------------
class WorkoutLog(BaseModel):
    """Structured output the AI must produce from free-form voice/text input."""

    exercise: str = Field(description="Name of the exercise, e.g. 'bench press'")
    sets: int = Field(ge=1, description="Number of sets performed")
    reps: int = Field(ge=1, description="Reps per set")
    weight: float = Field(ge=0.0, description="Weight lifted (0 if bodyweight)")
    weight_unit: Literal["lbs", "kg"] = Field(
        default="lbs", description="Unit of the weight value"
    )
    notes: str | None = Field(
        default=None, description="Optional extra context from the user"
    )


# ---------------------------------------------------------------------------
# API request model
# ---------------------------------------------------------------------------
class WorkoutRequest(BaseModel):
    transcript: str = Field(
        min_length=3,
        description="Raw voice transcript or typed workout description",
    )


# ---------------------------------------------------------------------------
# Muscle targeting models
# ---------------------------------------------------------------------------
class MuscleTargetResponse(BaseModel):
    muscle_group: str
    specific_muscles: list[str]
    role: Literal["primary", "secondary"]
    source: Literal["lookup", "ai_inferred"]


# ---------------------------------------------------------------------------
# API response models
# ---------------------------------------------------------------------------
class WorkoutLogResponse(BaseModel):
    id: UUID
    user_id: UUID | None
    exercise: str
    sets: int
    reps: int
    weight: float
    weight_unit: str
    notes: str | None
    logged_at: datetime
    created_at: datetime
    is_personal_record: bool = False
    muscle_targets: list[MuscleTargetResponse] = []


class ManualWorkoutRequest(BaseModel):
    """Direct workout creation — bypasses AI agent."""

    exercise: str = Field(min_length=1)
    sets: int = Field(ge=1)
    reps: int = Field(ge=1)
    weight: float = Field(ge=0.0)
    weight_unit: Literal["lbs", "kg"] = "lbs"
    notes: str | None = None
    logged_at: Date | None = None  # "YYYY-MM-DD"; defaults to today on backend if omitted


class WorkoutUpdateRequest(BaseModel):
    """Partial update — only supplied fields are changed."""

    exercise: str | None = None
    sets: int | None = Field(default=None, ge=1)
    reps: int | None = Field(default=None, ge=1)
    weight: float | None = Field(default=None, ge=0.0)
    weight_unit: Literal["lbs", "kg"] | None = None
    notes: str | None = None


class SessionUpdateRequest(BaseModel):
    """Update (or create) the session type for a specific date."""

    session_type: str = Field(min_length=1)
    notes: str | None = None


class WorkoutSession(BaseModel):
    """A declared workout session for a calendar day (e.g. 'chest day', 'push day')."""

    id: UUID
    user_id: UUID
    date: Date
    session_type: str
    notes: str | None
    created_at: datetime


class AgentActionResponse(BaseModel):
    """Returned by POST /api/v1/workouts for any agent action (log, delete, search, etc.)."""

    action: Literal["logged", "deleted", "found", "updated", "none", "session_started"]
    message: str
    workout: WorkoutLogResponse | None = None        # populated when action="logged"/"updated"
    workouts: list[WorkoutLogResponse] | None = None  # populated when action="found" or bulk delete
    session: WorkoutSession | None = None            # populated when action="session_started"


class APIResponse(BaseModel):
    success: bool
    data: AgentActionResponse | list[WorkoutLogResponse] | list[WorkoutSession] | WorkoutLogResponse | WorkoutSession | None = None
    error: str | None = None
