from __future__ import annotations

import base64
import logging

import openai
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..auth.dependencies import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["tts"])

_client = openai.AsyncOpenAI()


async def generate_tts_b64(text: str, voice: str = "echo") -> str | None:
    """Generate TTS audio and return as base64-encoded MP3. Returns None on failure."""
    if not text.strip():
        return None
    try:
        response = await _client.audio.speech.create(
            model="tts-1",
            voice=voice,  # type: ignore[arg-type]
            input=text[:1000],
            response_format="mp3",
        )
        return base64.b64encode(response.content).decode()
    except Exception:
        logger.warning("TTS embed failed, skipping inline audio")
        return None


class TTSRequest(BaseModel):
    text: str
    voice: str = "echo"  # energetic male — gym-bro vibe


@router.post("/tts")
async def text_to_speech(
    body: TTSRequest,
    current_user: dict = Depends(get_current_user),
) -> StreamingResponse:
    """Stream OpenAI TTS audio back to the client as MP3."""
    if not body.text.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Text must not be empty.",
        )

    # Cap input length to prevent abuse (roughly ~30 seconds of speech)
    text = body.text[:1000]

    try:
        response = await _client.audio.speech.create(
            model="tts-1",
            voice=body.voice,  # type: ignore[arg-type]
            input=text,
            response_format="mp3",
        )
    except Exception as exc:
        logger.exception("OpenAI TTS call failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="TTS service error",
        ) from exc

    async def audio_stream():
        async for chunk in response.response.aiter_bytes(chunk_size=4096):
            yield chunk

    return StreamingResponse(
        audio_stream(),
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-cache",
            "Content-Disposition": "inline",
        },
    )
