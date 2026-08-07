"""
Tests for POST /workouts/stream/audio — the single-request mobile voice path.

Phones record a clip rather than using the browser Web Speech API. Transcribing
inside the agent route (instead of via a separate /transcribe call) keeps the
whole interaction to one request, so this route owns the transcribe-then-run
sequence and the failure branches that come with it.
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SUPABASE_JWKS_URL", "https://example.supabase.co/auth/v1/keys")
os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/test")

import pytest  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.app.auth.dependencies import get_current_user  # noqa: E402
from backend.app.routes import workouts as workouts_route  # noqa: E402

AUDIO = b"\x00" * 4000
USER_ID = "11111111-2222-3333-4444-555555555555"


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(workouts_route.router)
    app.dependency_overrides[get_current_user] = lambda: {"sub": USER_ID}
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def _events(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def _fake_agent_stream(*_args, **_kwargs):
    async def gen():
        yield {"type": "progress", "message": "Understanding your request..."}
        yield {
            "type": "done",
            "action": "logged",
            "message": "Logged bench press.",
            "logged_workout": None,
            "found_workouts": None,
            "deleted_workouts": None,
            "session": None,
            "cache_dirty": False,
        }
    return gen()


def _post(client, content_type="audio/webm"):
    return client.post(
        "/api/v1/workouts/stream/audio",
        files={"file": ("speech.webm", AUDIO, content_type)},
        data={"client_tz": "America/Denver"},
    )


class TestAudioStream:
    def test_transcribes_then_runs_the_agent_in_one_request(self, client):
        with patch.object(
            workouts_route, "transcribe_audio", new=AsyncMock(return_value="bench press 3x10")
        ), patch.object(
            workouts_route, "run_agent_streamed", new=_fake_agent_stream
        ), patch.object(
            workouts_route, "generate_tts_b64", new=AsyncMock(return_value=None)
        ):
            response = _post(client)

        assert response.status_code == 200
        events = _events(response)
        kinds = [e["type"] for e in events]

        # Progress first, so the phone shows something during the upload.
        assert kinds[0] == "progress"
        assert "ranscrib" in events[0]["message"]
        # The heard text is echoed back — the Web Speech path shows this for free.
        assert "transcript" in kinds
        assert events[kinds.index("transcript")]["message"] == "bench press 3x10"
        assert kinds[-1] == "done"
        assert events[-1]["data"]["message"] == "Logged bench press."

    def test_passes_transcript_and_timezone_to_the_agent(self, client):
        seen = {}

        def capture(transcript, user_id, client_tz):
            seen["transcript"] = transcript
            seen["client_tz"] = client_tz
            return _fake_agent_stream()

        with patch.object(
            workouts_route, "transcribe_audio", new=AsyncMock(return_value="squat 5x5")
        ), patch.object(
            workouts_route, "run_agent_streamed", new=capture
        ), patch.object(
            workouts_route, "generate_tts_b64", new=AsyncMock(return_value=None)
        ):
            _post(client)

        assert seen["transcript"] == "squat 5x5"
        assert seen["client_tz"] == "America/Denver"

    def test_transcription_failure_becomes_an_error_event(self, client):
        """The stream has already started, so a 502 cannot be sent as a status code."""
        failure = HTTPException(status_code=502, detail="Transcription service error")
        with patch.object(
            workouts_route, "transcribe_audio", new=AsyncMock(side_effect=failure)
        ):
            response = _post(client)

        events = _events(response)
        assert events[-1]["type"] == "error"
        assert events[-1]["message"] == "Transcription service error"

    def test_silent_clip_becomes_an_error_event(self, client):
        with patch.object(
            workouts_route, "transcribe_audio", new=AsyncMock(return_value="   ")
        ):
            response = _post(client)

        events = _events(response)
        assert events[-1]["type"] == "error"
        assert "catch that" in events[-1]["message"]

    def test_agent_is_not_run_when_transcription_yields_nothing(self, client):
        agent = AsyncMock()
        with patch.object(
            workouts_route, "transcribe_audio", new=AsyncMock(return_value="")
        ), patch.object(workouts_route, "run_agent_streamed", new=agent):
            _post(client)

        agent.assert_not_called()

    def test_rejects_empty_upload(self, client):
        response = client.post(
            "/api/v1/workouts/stream/audio",
            files={"file": ("speech.webm", b"", "audio/webm")},
        )
        assert response.status_code == 422
