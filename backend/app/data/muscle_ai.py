from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Literal

import openai
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class _MuscleTarget(BaseModel):
    muscle_group: str
    specific_muscles: list[str]
    role: Literal["primary", "secondary"]


class _MuscleTargetList(BaseModel):
    targets: list[_MuscleTarget]


_client = openai.AsyncOpenAI()
_cache: dict[str, list[dict]] = {}
# Per-exercise locks prevent concurrent requests for the same exercise from
# each making a redundant OpenAI call before the first one populates the cache.
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

_SYSTEM = (
    "You are a certified strength and conditioning specialist. "
    "Given an exercise name, return the primary and secondary muscle groups it targets. "
    "Use these standard group names only: chest, back, shoulders, triceps, biceps, traps, "
    "quads, hamstrings, glutes, calves, core, forearms. "
    "Populate specific_muscles with anatomical names (e.g. 'pectoralis major', 'latissimus dorsi'). "
    "Return at least one entry."
)


async def infer_muscles(exercise: str) -> list[dict]:
    """Return AI-inferred muscle targets for an exercise.
    Results are cached per exercise name for the process lifetime. Returns [] on error."""
    key = exercise.strip().lower()
    if key in _cache:
        return _cache[key]
    async with _locks[key]:
        # Re-check after acquiring the lock — another coroutine may have populated it.
        if key in _cache:
            return _cache[key]
        try:
            result = await _client.beta.chat.completions.parse(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": _SYSTEM},
                    {"role": "user", "content": f"What muscles does '{exercise}' target?"},
                ],
                response_format=_MuscleTargetList,
            )
            parsed = result.choices[0].message.parsed
            data = [t.model_dump() for t in parsed.targets] if parsed else []
        except Exception:
            logger.warning("AI muscle inference failed for %r", exercise, exc_info=True)
            data = []
        _cache[key] = data
    return data
