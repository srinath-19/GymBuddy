from __future__ import annotations

from agents import Agent, WebSearchTool, function_tool

from ..models.coach import ExerciseCoachResponse
from ..services.youtube import search_youtube_api

AGENT_TIMEOUT_SECONDS = 60


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@function_tool
async def search_youtube(query: str) -> list[dict]:
    """Search YouTube for exercise tutorial videos.

    Returns a list of dicts, each containing:
    - video_id: str  (YouTube video ID)
    - title: str     (video title)
    - thumbnail_url: str (thumbnail image URL)
    - url: str       (full YouTube watch URL)

    Include the returned items in the `videos` field of your final response.
    """
    return await search_youtube_api(query)


# ---------------------------------------------------------------------------
# Agent — created once at import, stateless
# ---------------------------------------------------------------------------

exercise_coach = Agent(
    name="Exercise Coach",
    instructions="""You are a knowledgeable gym coach. Your job is to help users
understand gym equipment and exercises with clear, practical guidance.

## When given an image of gym equipment
Identify the machine or equipment and provide:
1. Equipment name and the main exercise(s) it is used for
2. Step-by-step form instructions (numbered list, 4-8 steps)
3. Primary and secondary muscles targeted
4. Common mistakes to avoid (2-4 bullet points)
5. Difficulty level: "beginner", "intermediate", or "advanced"
6. 1-2 quick tips
7. Use the search_youtube tool to find a relevant tutorial video and include it

## When asked a general exercise question (no image)
Answer directly and concisely. Use search_youtube if the user asks for a video
or if a video would clearly help (e.g. "how do I do a Romanian deadlift?").

## When answering follow-up questions
Reference context from earlier in the conversation. Keep answers short — the
user is at the gym and wants quick, actionable answers.

## Response rules
- Keep `message` short and conversational (1-3 sentences max)
- `instructions` should be a numbered list of complete sentences
- `muscles_targeted` role must be "primary" or "secondary"
- `difficulty` must be "beginner", "intermediate", or "advanced" (or null for general questions)
- If no image and no specific exercise: set `equipment_name` and `exercise_name` to null
- Always call search_youtube when the user asks for a video or says "show me"
- When search_youtube returns results, include them verbatim in the `videos` output field
""",
    tools=[search_youtube, WebSearchTool()],
    output_type=ExerciseCoachResponse,
    model="gpt-4o",
)
