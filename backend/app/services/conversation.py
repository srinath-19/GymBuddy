from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

# content is str for text-only turns, or list[dict] for image+text turns.
# Example image turn:
#   [{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}},
#    {"type": "text", "text": "How do I use this?"}]
# Example text-only follow-up:
#   "What muscles does this target?"
HistoryEntry = dict[str, Any]  # {"role": str, "content": str | list[dict]}

conversations: dict[str, dict] = {}

CONVERSATION_TTL = timedelta(minutes=10)
MAX_TURNS = 6


def sweep_expired() -> None:
    """Lazy cleanup — call at the start of each /coach/ask request."""
    now = datetime.utcnow()
    expired = [
        k for k, v in conversations.items()
        if now - v["last_active"] > CONVERSATION_TTL
    ]
    for k in expired:
        del conversations[k]


def get_or_create(conversation_id: str | None) -> tuple[str, dict]:
    """Return (id, entry). Creates a fresh entry if id is None or not found."""
    if conversation_id and conversation_id in conversations:
        return conversation_id, conversations[conversation_id]

    new_id = str(uuid.uuid4())
    conversations[new_id] = {
        "history": [],
        "last_active": datetime.utcnow(),
        "turn_count": 0,
    }
    return new_id, conversations[new_id]


def append_turn(
    conversation_id: str,
    user_content: str | list[dict],
    assistant_content: str,
) -> None:
    """Append user + assistant messages and update metadata."""
    entry = conversations[conversation_id]
    entry["history"].append({"role": "user", "content": user_content})
    entry["history"].append({"role": "assistant", "content": assistant_content})
    entry["last_active"] = datetime.utcnow()
    entry["turn_count"] += 1


def delete_conversation(conversation_id: str) -> None:
    conversations.pop(conversation_id, None)


def is_at_limit(conversation_id: str) -> bool:
    entry = conversations.get(conversation_id)
    if entry is None:
        return False
    return entry["turn_count"] >= MAX_TURNS
