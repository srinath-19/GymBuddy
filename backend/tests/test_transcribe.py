"""
Tests for backend/app/routes/transcribe.py — the server-side speech-to-text path.

This endpoint exists because the browser Web Speech API is unusable on phones,
so the container handling has to be right for every recorder a mobile browser
might hand us — notably iOS Safari, which labels audio-only MediaRecorder output
as video/mp4 and could not write WebM at all before Safari 18.4.
"""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

# ---------------------------------------------------------------------------
# The route pulls in the auth dependency and the OpenAI client at import time,
# both of which read configuration from the environment. Supply placeholders so
# the suite never depends on a local .env — neither is contacted here.
# ---------------------------------------------------------------------------
os.environ.setdefault("SUPABASE_JWKS_URL", "https://example.supabase.co/auth/v1/keys")
os.environ.setdefault("OPENAI_API_KEY", "test-key")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.app.auth.dependencies import get_current_user  # noqa: E402
from backend.app.routes import transcribe as transcribe_route  # noqa: E402

AUDIO = b"\x00" * 4000


@pytest.fixture
def app():
    """Just the transcribe router — importing the whole app would drag in the
    agent graph, which other test modules stub out globally."""
    test_app = FastAPI()
    test_app.include_router(transcribe_route.router)
    test_app.dependency_overrides[get_current_user] = lambda: {"sub": "test-user"}
    return test_app


@pytest.fixture
def client(app):
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def reset_rate_limit():
    transcribe_route._user_request_times.clear()
    yield
    transcribe_route._user_request_times.clear()


def _mock_openai(text: str = "bench press 3x10 at 135 lbs"):
    return patch.object(
        transcribe_route._client.audio.transcriptions,
        "create",
        new=AsyncMock(return_value=text),
    )


class TestExtensionResolution:
    """OpenAI infers the audio container from the upload's filename extension."""

    @pytest.mark.parametrize(
        "content_type,filename,expected",
        [
            # Desktop browsers and Android Chrome
            ("audio/webm;codecs=opus", "speech.webm", "webm"),
            ("audio/webm", "speech.webm", "webm"),
            # iOS Safari labels audio-only recordings as video/*
            ("audio/mp4", "speech.mp4", "mp4"),
            ("video/mp4", "speech.mp4", "mp4"),
            ("video/webm", "speech.webm", "webm"),
            ("audio/ogg;codecs=opus", "speech.ogg", "ogg"),
            ("audio/mpeg", "speech.mp3", "mp3"),
            # Unknown content type falls back to the filename
            ("application/octet-stream", "speech.m4a", "m4a"),
            ("", "speech.wav", "wav"),
            # Nothing usable at all — assume what most browsers produce
            (None, None, "webm"),
            ("application/octet-stream", "speech.exe", "webm"),
        ],
    )
    def test_resolves_container(self, content_type, filename, expected):
        assert transcribe_route._resolve_extension(content_type, filename) == expected


class TestTranscribeEndpoint:
    def test_returns_transcript_in_envelope(self, client):
        with _mock_openai():
            response = client.post(
                "/api/v1/transcribe",
                files={"file": ("speech.webm", AUDIO, "audio/webm;codecs=opus")},
            )

        assert response.status_code == 200
        assert response.json() == {
            "success": True,
            "data": {"text": "bench press 3x10 at 135 lbs"},
            "error": None,
        }

    def test_ios_upload_is_renamed_to_match_its_container(self, client):
        """An .mp4 clip sent as video/mp4 must not reach OpenAI named as WebM."""
        with _mock_openai() as mock_create:
            client.post(
                "/api/v1/transcribe",
                files={"file": ("blob", AUDIO, "video/mp4")},
            )

        filename, payload, _ = mock_create.await_args.kwargs["file"]
        assert filename == "audio.mp4"
        assert payload == AUDIO

    def test_transcript_is_stripped(self, client):
        with _mock_openai("  squat 5x5  \n"):
            response = client.post(
                "/api/v1/transcribe",
                files={"file": ("speech.webm", AUDIO, "audio/webm")},
            )

        assert response.json()["data"]["text"] == "squat 5x5"

    def test_rejects_empty_audio(self, client):
        response = client.post(
            "/api/v1/transcribe",
            files={"file": ("speech.webm", b"", "audio/webm")},
        )
        assert response.status_code == 422

    def test_rejects_oversized_audio(self, client, monkeypatch):
        monkeypatch.setattr(transcribe_route, "_MAX_BYTES", 100)
        response = client.post(
            "/api/v1/transcribe",
            files={"file": ("speech.webm", AUDIO, "audio/webm")},
        )
        assert response.status_code == 413

    def test_upstream_failure_becomes_502(self, client):
        with patch.object(
            transcribe_route._client.audio.transcriptions,
            "create",
            new=AsyncMock(side_effect=RuntimeError("openai is down")),
        ):
            response = client.post(
                "/api/v1/transcribe",
                files={"file": ("speech.webm", AUDIO, "audio/webm")},
            )
        assert response.status_code == 502

    def test_rate_limited_per_user(self, client):
        with _mock_openai():
            for _ in range(transcribe_route._RATE_LIMIT):
                ok = client.post(
                    "/api/v1/transcribe",
                    files={"file": ("speech.webm", AUDIO, "audio/webm")},
                )
                assert ok.status_code == 200

            blocked = client.post(
                "/api/v1/transcribe",
                files={"file": ("speech.webm", AUDIO, "audio/webm")},
            )
        assert blocked.status_code == 429


class TestAuth:
    def test_requires_a_token(self):
        """Without the dependency override, the real bearer check applies."""
        bare = FastAPI()
        bare.include_router(transcribe_route.router)
        with TestClient(bare, raise_server_exceptions=False) as anon:
            response = anon.post(
                "/api/v1/transcribe",
                files={"file": ("speech.webm", AUDIO, "audio/webm")},
            )
        assert response.status_code in (401, 403)
