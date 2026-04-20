from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

from .workout import WorkoutLogResponse


# ---------------------------------------------------------------------------
# Workout plan models — structured state that persists across turns
# ---------------------------------------------------------------------------

class PlannedExercise(BaseModel):
    """One exercise in the workout plan."""
    name: str                                    # e.g. "bench press"
    target_sets: int = 3                         # planned number of sets
    target_reps: int = 10                        # planned reps per set
    suggested_weight: float | None = None        # optional hint


class CompletedSet(BaseModel):
    """One individual set completed during the session."""
    reps: int
    weight: float
    weight_unit: str = "lbs"


class ExerciseProgress(BaseModel):
    """Progress on a single exercise during the session."""
    exercise: PlannedExercise
    completed_sets: list[CompletedSet] = []
    finalized: bool = False                      # True once written to DB
    logged_workout_id: uuid.UUID | None = None   # Set after DB write

    @property
    def is_complete(self) -> bool:
        return len(self.completed_sets) >= self.exercise.target_sets

    @property
    def sets_done(self) -> int:
        return len(self.completed_sets)


class PacerSessionState(BaseModel):
    """Full workout session state. Stored in the pacer session store."""
    plan: list[PlannedExercise] = []
    current_exercise_index: int = 0
    exercise_progress: list[ExerciseProgress] = []
    session_type: str | None = None              # "push", "legs", etc.

    @property
    def current_progress(self) -> ExerciseProgress | None:
        if 0 <= self.current_exercise_index < len(self.exercise_progress):
            return self.exercise_progress[self.current_exercise_index]
        return None

    @property
    def completed_count(self) -> int:
        return sum(1 for ep in self.exercise_progress if ep.finalized)

    @property
    def all_done(self) -> bool:
        return (
            len(self.exercise_progress) > 0
            and all(ep.finalized or ep.sets_done == 0 for ep in self.exercise_progress)
        )


# ---------------------------------------------------------------------------
# Per-request context — passed via RunContextWrapper, never sent to the LLM
# ---------------------------------------------------------------------------

@dataclass
class PacerContext:
    user_id: uuid.UUID
    session_state: PacerSessionState = field(default_factory=PacerSessionState)
    # Accumulates workouts logged THIS turn (for the API response)
    logged_workouts: list[WorkoutLogResponse] = field(default_factory=list)


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
# Request models for direct pacer REST endpoints
# ---------------------------------------------------------------------------

class PacerSetDoneRequest(BaseModel):
    reps: int | None = None
    weight: float | None = None
    weight_unit: str = "lbs"


class PacerPlanModifyRequest(BaseModel):
    action: Literal["remove", "add", "swap", "change"]
    exercise_name: str
    replacement_name: str | None = None
    target_sets: int | None = None
    target_reps: int | None = None


# ---------------------------------------------------------------------------
# Plan item — one exercise row as surfaced to the frontend at any phase
# ---------------------------------------------------------------------------

class PlanItem(BaseModel):
    name: str
    target_sets: int
    target_reps: int
    sets_done: int
    finalized: bool


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
    """Populated when an exercise was finalized this turn (from DB, not the LLM)."""

    # Session progress — new fields
    total_exercises: int = 0
    completed_exercises: int = 0
    current_exercise_sets_done: int = 0
    current_exercise_sets_total: int = 0
    session_type: str | None = None
    current_plan: list[PlanItem] = []
    """Live plan with per-exercise progress, populated at every phase."""
    tts_audio_b64: str | None = None                 # inline MP3 audio — avoids a second round trip


class PacerResponse(BaseModel):
    """Envelope used by direct pacer REST endpoints."""
    success: bool
    data: PacerAPIResponse | None = None
    error: str | None = None
