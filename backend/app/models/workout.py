from __future__ import annotations

from datetime import datetime
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


class APIResponse(BaseModel):
    success: bool
    data: WorkoutLogResponse | list[WorkoutLogResponse] | None = None
    error: str | None = None
