from __future__ import annotations

from pydantic import BaseModel


class CoachRequest(BaseModel):
    text: str
    image_base64: str | None = None   # "data:image/jpeg;base64,..."
    conversation_id: str | None = None


class VideoResult(BaseModel):
    video_id: str
    title: str
    thumbnail_url: str
    url: str


class CoachMuscleTarget(BaseModel):
    muscle_group: str
    role: str  # "primary" | "secondary"


class ExerciseCoachResponse(BaseModel):
    equipment_name: str | None = None
    exercise_name: str | None = None
    instructions: list[str] = []
    muscles_targeted: list[CoachMuscleTarget] = []
    common_mistakes: list[str] = []
    difficulty: str | None = None  # "beginner" | "intermediate" | "advanced"
    tips: list[str] = []
    videos: list[VideoResult] = []
    message: str


class CoachAPIResponse(BaseModel):
    conversation_id: str
    turn_number: int
    max_turns: int
    response: ExerciseCoachResponse
