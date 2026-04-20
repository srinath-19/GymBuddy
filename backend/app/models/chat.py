from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from .coach import CoachAPIResponse
from .pacer import PacerAPIResponse
from .workout import AgentActionResponse


class ChatRequest(BaseModel):
    text: str
    image_base64: str | None = None
    # Each sub-agent keeps its own conversation history.
    # Pass the ID returned by a previous turn to continue that conversation.
    coach_conversation_id: str | None = None
    pacer_conversation_id: str | None = None


class ChatResponse(BaseModel):
    agent_type: Literal["workout", "coach", "pacer"]
    workout: AgentActionResponse | None = None
    coach: CoachAPIResponse | None = None
    pacer: PacerAPIResponse | None = None
    tts_audio_b64: str | None = None                 # inline MP3 audio — avoids a second round trip


