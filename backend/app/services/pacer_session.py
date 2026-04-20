from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from ..models.pacer import PacerSessionState

# content is str for text-only turns, or list[dict] for image+text turns.
HistoryEntry = dict[str, Any]  # {"role": str, "content": str | list[dict]}


class PacerTurnLimitExceededError(Exception):
    """Raised when a pacer session has reached MAX_TURNS."""


# NOTE: pacer_sessions is an in-process dict. This works correctly only under a
# single-worker deployment (uvicorn without --workers N). For multi-instance
# deployment (e.g. Cloud Run with multiple containers), this would need to move
# to Redis/Upstash. The same constraint applies to services/conversation.py.
pacer_sessions: dict[str, dict] = {}

PACER_TTL = timedelta(hours=2)
PACER_MAX_TURNS = 50


def sweep_expired() -> None:
    """Lazy cleanup — call at the start of each pacer request."""
    now = datetime.now(timezone.utc)
    expired = [
        k for k, v in pacer_sessions.items()
        if now - v["last_active"] > PACER_TTL
    ]
    for k in expired:
        del pacer_sessions[k]


def get_or_create(session_id: str | None) -> tuple[str, dict]:
    """Return (id, entry). Creates a fresh entry if id is None or not found."""
    if session_id and session_id in pacer_sessions:
        return session_id, pacer_sessions[session_id]

    new_id = str(uuid.uuid4())
    pacer_sessions[new_id] = {
        "history": [],
        "last_active": datetime.now(timezone.utc),
        "turn_count": 0,
        "state": PacerSessionState(),
    }
    return new_id, pacer_sessions[new_id]


def append_turn(
    session_id: str,
    user_content: str | list[dict],
    assistant_content: str,
) -> None:
    """Append user + assistant messages and update metadata."""
    entry = pacer_sessions[session_id]
    entry["history"].append({"role": "user", "content": user_content})
    entry["history"].append({"role": "assistant", "content": assistant_content})
    entry["last_active"] = datetime.now(timezone.utc)
    entry["turn_count"] += 1


def save_state(session_id: str, state: PacerSessionState) -> None:
    """Persist the updated session state back into the store."""
    entry = pacer_sessions.get(session_id)
    if entry is not None:
        entry["state"] = state
        entry["last_active"] = datetime.now(timezone.utc)


def delete_session(session_id: str) -> None:
    pacer_sessions.pop(session_id, None)


def is_at_limit(session_id: str) -> bool:
    entry = pacer_sessions.get(session_id)
    if entry is None:
        return False
    return entry["turn_count"] >= PACER_MAX_TURNS
