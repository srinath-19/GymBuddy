from __future__ import annotations

import asyncio

from agents import Agent, Runner

from ..models.workout import WorkoutLog

PARSE_TIMEOUT_SECONDS = 30

# Agent is stateless — created once at import time (no network call at construction).
# Runner.run() is what makes the actual OpenAI API call per request.
_agent = Agent(
    name="WorkoutParser",
    instructions="""
You are a workout logging assistant. Parse free-form workout descriptions from
voice transcripts or typed input and extract structured data.

Rules:
- exercise: normalize to lowercase with spaces (e.g. "bench press", "squat")
- sets/reps: infer from context (e.g. "3x10" means sets=3, reps=10)
- weight: numeric value only; use 0 for bodyweight exercises
- weight_unit: default to "lbs" unless the user explicitly says "kg" or "kilograms"
- notes: capture extra context (tempo, rest time, form cues); null if none

Examples:
  "bench press 3 sets of 10 at 135 pounds" -> exercise="bench press", sets=3, reps=10, weight=135, weight_unit="lbs"
  "did 5x5 squats at 100kg" -> exercise="squat", sets=5, reps=5, weight=100, weight_unit="kg"
  "20 push ups" -> exercise="push up", sets=1, reps=20, weight=0, weight_unit="lbs"
  "lat pull down 3 sets 165 lbs 6 reps" -> exercise="lat pull down", sets=3, reps=6, weight=165, weight_unit="lbs"
""",
    output_type=WorkoutLog,
    model="gpt-4o",
)


async def parse_workout(transcript: str) -> WorkoutLog:
    """
    Run the workout-parsing agent against a voice/text transcript.
    Returns a validated WorkoutLog Pydantic model.
    Raises RuntimeError if the agent fails to produce structured output.
    """
    result = await asyncio.wait_for(
        Runner.run(_agent, input=transcript),
        timeout=PARSE_TIMEOUT_SECONDS,
    )

    if result.final_output is None:
        raise RuntimeError("Agent returned no structured output")

    # Runner.run() with output_type guarantees final_output is WorkoutLog
    return result.final_output
