from __future__ import annotations

import json
import logging
import os

logger = logging.getLogger(__name__)

CACHE_TTL = 60       # workouts — short enough that stale data self-heals quickly
SESSIONS_TTL = 600   # sessions rarely change mid-day; 10 min is safe
PR_TTL = 600         # PRs are stable; invalidated when a new set is logged for that exercise

_redis = None


def _get_redis():
    global _redis
    if _redis is None:
        url = os.getenv("UPSTASH_REDIS_REST_URL")
        token = os.getenv("UPSTASH_REDIS_REST_TOKEN")
        if not url or not token:
            return None
        try:
            from upstash_redis.asyncio import Redis
            _redis = Redis(url=url, token=token)
        except Exception:
            logger.warning("Upstash Redis unavailable — caching disabled")
            return None
    return _redis


def _workouts_key(user_id: str) -> str:
    return f"gymbuddy:workouts:{user_id}"


def _sessions_key(user_id: str) -> str:
    return f"gymbuddy:sessions:{user_id}"


def _pr_key(user_id: str, exercise: str) -> str:
    return f"gymbuddy:pr:{user_id}:{exercise.strip().lower()}"


async def get_cached(key: str) -> list | None:
    r = _get_redis()
    if r is None:
        return None
    try:
        val = await r.get(key)
        return json.loads(val) if val else None
    except Exception:
        logger.warning("Redis get failed for key %s", key)
        return None


async def set_cached(key: str, data: list, ttl: int = CACHE_TTL) -> None:
    r = _get_redis()
    if r is None:
        return
    try:
        await r.set(key, json.dumps(data), ex=ttl)
    except Exception:
        logger.warning("Redis set failed for key %s", key)


async def invalidate_user(user_id: str) -> None:
    r = _get_redis()
    if r is None:
        return
    try:
        await r.delete(_workouts_key(user_id), _sessions_key(user_id))
    except Exception:
        logger.warning("Redis invalidate failed for user %s", user_id)


async def get_cached_workouts(user_id: str) -> list | None:
    return await get_cached(_workouts_key(user_id))


async def set_cached_workouts(user_id: str, data: list) -> None:
    await set_cached(_workouts_key(user_id), data, ttl=CACHE_TTL)


async def get_cached_sessions(user_id: str) -> list | None:
    return await get_cached(_sessions_key(user_id))


async def set_cached_sessions(user_id: str, data: list) -> None:
    await set_cached(_sessions_key(user_id), data, ttl=SESSIONS_TTL)


async def get_cached_pr(user_id: str, exercise: str) -> dict | None:
    r = _get_redis()
    if r is None:
        return None
    try:
        val = await r.get(_pr_key(user_id, exercise))
        return json.loads(val) if val else None
    except Exception:
        logger.warning("Redis get_pr failed for %s/%s", user_id, exercise)
        return None


async def set_cached_pr(user_id: str, exercise: str, data: dict) -> None:
    r = _get_redis()
    if r is None:
        return
    try:
        await r.set(_pr_key(user_id, exercise), json.dumps(data), ex=PR_TTL)
    except Exception:
        logger.warning("Redis set_pr failed for %s/%s", user_id, exercise)


async def invalidate_pr(user_id: str, exercise: str) -> None:
    r = _get_redis()
    if r is None:
        return
    try:
        await r.delete(_pr_key(user_id, exercise))
    except Exception:
        logger.warning("Redis invalidate_pr failed for %s/%s", user_id, exercise)
