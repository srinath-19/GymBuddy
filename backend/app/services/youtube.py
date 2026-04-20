from __future__ import annotations

import asyncio
import os


def _sync_search(query: str) -> list[dict]:
    """Blocking YouTube Data API v3 search — run via run_in_executor."""
    from googleapiclient.discovery import build  # noqa: PLC0415

    yt = build("youtube", "v3", developerKey=os.environ["YOUTUBE_API_KEY"])
    resp = (
        yt.search()
        .list(q=query, part="snippet", type="video", maxResults=3)
        .execute()
    )
    results = []
    for item in resp.get("items", []):
        vid = item["id"]["videoId"]
        results.append(
            {
                "video_id": vid,
                "title": item["snippet"]["title"],
                "thumbnail_url": item["snippet"]["thumbnails"]["medium"]["url"],
                "url": f"https://www.youtube.com/watch?v={vid}",
            }
        )
    return results


async def search_youtube_api(query: str) -> list[dict]:
    """Async wrapper — offloads blocking googleapiclient call to a thread."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _sync_search, query)
