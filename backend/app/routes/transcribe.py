from __future__ import annotations

import logging
import time
from collections import defaultdict

import openai
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from ..auth.dependencies import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["transcribe"])

_client = openai.AsyncOpenAI()

# Server-side speech-to-text exists because the browser Web Speech API is not
# usable on phones: Android Chrome delegates to the on-device SpeechRecognizer
# and iOS Safari to Siri dictation, both of which return duplicated/truncated
# transcripts and ignore `continuous`. Recording audio and transcribing it here
# makes mobile behave identically to desktop, and handles gym background noise
# far better than the on-device models do.
_MODEL = "gpt-4o-transcribe"

# OpenAI rejects audio uploads above 25 MB; a spoken workout is a few hundred KB,
# so anything near the ceiling is a client bug or abuse.
_MAX_BYTES = 25 * 1024 * 1024

# Biases the recognizer toward gym vocabulary it otherwise mangles — set/rep
# shorthand and plate weights are the usual failure cases.
_PROMPT = (
    "Gym workout logging. Common phrases: bench press, incline dumbbell press, "
    "overhead press, squat, front squat, deadlift, romanian deadlift, lat pulldown, "
    "barbell row, bicep curl, tricep pushdown, leg press, leg curl, calf raise, "
    "pull ups, sets, reps, lbs, kg, PR, superset, drop set. "
    "Examples: 'bench press 3x10 at 135 lbs', '4 sets of 8 at 225', "
    "'starting chest day', 'delete my last workout'."
)

# OpenAI infers the audio container from the filename extension, so the upload has
# to be named to match its real content type rather than whatever the client sent.
_EXT_BY_CONTENT_TYPE = {
    "audio/webm": "webm",
    "video/webm": "webm",  # some Chrome builds label Opus-only recordings this way
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "video/mp4": "mp4",  # iOS Safari labels audio-only MediaRecorder output as video/mp4
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/flac": "flac",
    "audio/aac": "aac",
}

# Transcription is a paid per-call endpoint — same limiter shape as /chat.
_RATE_LIMIT = 30
_RATE_WINDOW = 60.0  # seconds

_user_request_times: defaultdict[str, list[float]] = defaultdict(list)


def _check_rate_limit(user_id: str) -> None:
    now = time.monotonic()
    window_start = now - _RATE_WINDOW
    timestamps = _user_request_times[user_id]
    _user_request_times[user_id] = [t for t in timestamps if t > window_start]
    if len(_user_request_times[user_id]) >= _RATE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded: max {_RATE_LIMIT} requests per {int(_RATE_WINDOW)}s.",
        )
    _user_request_times[user_id].append(now)


def _resolve_extension(content_type: str | None, filename: str | None) -> str:
    """Pick the container extension OpenAI should parse the upload as."""
    # Content types arrive as e.g. "audio/webm;codecs=opus" — strip the parameters.
    base = (content_type or "").split(";")[0].strip().lower()
    if base in _EXT_BY_CONTENT_TYPE:
        return _EXT_BY_CONTENT_TYPE[base]

    suffix = (filename or "").rsplit(".", 1)
    if len(suffix) == 2 and suffix[1].lower() in set(_EXT_BY_CONTENT_TYPE.values()):
        return suffix[1].lower()

    # Opus-in-WebM is what every supported browser produces unless it is iOS.
    return "webm"


@router.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
) -> JSONResponse:
    """Transcribe an uploaded audio clip to text via OpenAI."""
    _check_rate_limit(current_user["sub"])

    audio = await file.read()
    if not audio:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Audio file is empty.",
        )
    if len(audio) > _MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Audio file too large (max 25 MB).",
        )

    ext = _resolve_extension(file.content_type, file.filename)

    try:
        result = await _client.audio.transcriptions.create(
            model=_MODEL,
            file=(f"audio.{ext}", audio, file.content_type or f"audio/{ext}"),
            prompt=_PROMPT,
            language="en",
            response_format="text",
        )
    except Exception as exc:
        logger.exception("OpenAI transcription call failed (ext=%s, bytes=%d)", ext, len(audio))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Transcription service error",
        ) from exc

    # response_format="text" yields a bare string rather than a model object.
    text = (result if isinstance(result, str) else getattr(result, "text", "")).strip()

    return JSONResponse({"success": True, "data": {"text": text}, "error": None})
