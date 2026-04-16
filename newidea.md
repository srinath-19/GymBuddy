# Feature: Exercise Coach Agent

## Summary

A second AI agent — the **Exercise Coach** — that accepts voice, text, and image input to identify gym equipment, provide exercise instructions, fetch YouTube tutorial videos, and answer follow-up questions in a short conversational flow.

This sits alongside the existing **Workout Parser** agent. The two agents serve different purposes:

| Agent | Purpose | Input | Output |
|-------|---------|-------|--------|
| **Workout Parser** (existing) | Log workouts to the database | Voice / text | Structured workout data → DB |
| **Exercise Coach** (new) | Exercise guidance & education | Voice / text / image | Instructions, videos, tips → UI |

---

## Core Capabilities

### 1. Image-Based Equipment Identification

User sends a photo of a gym machine (via camera or file upload) → the agent identifies it and returns:

- **Equipment name** (e.g., "Lat Pulldown Machine")
- **Exercise(s)** you can do on it
- **Step-by-step instructions** on proper form
- **Muscles targeted** (primary + secondary — reuse the muscle_targets schema)
- **Common mistakes** to avoid
- **Difficulty level** (beginner / intermediate / advanced)

**Tech**: Use GPT-4o's vision capability. Send the image as a base64-encoded `image_url` content part in the OpenAI message. No extra vision model needed — GPT-4o handles this natively.

### 2. YouTube Video Fetching (Inline Embedded Player)

When the user asks for a video (explicitly or when the agent thinks one would help), fetch relevant YouTube tutorials and **display them as embedded players directly inside the coach panel** — the user watches the video without ever leaving the app.

**Approach: YouTube Data API v3 (primary) + WebSearchTool (fallback)**

#### YouTube Data API v3

- **Endpoint**: `youtube.search().list(q=keyword, part="snippet", type="video", maxResults=3)`
- **Package**: `google-api-python-client`
- **API key**: Google Cloud Console → enable YouTube Data API v3 → create API key
- **Quota**: Free tier = 10,000 units/day. `search.list` costs 100 units = **~100 searches/day for free** (plenty for personal use)
- **Returns**: Video ID, title, description, thumbnail → used to build an inline embed

#### Inline Embed (How Videos Display)

The API returns a `videoId`. The frontend renders it as an **iframe embed** directly in the coach response card:

```html
<iframe
  src="https://www.youtube.com/embed/{videoId}"
  width="100%"
  height="315"
  frameBorder="0"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
  allowFullScreen
/>
```

This gives the user a full YouTube player (play, pause, fullscreen, volume, scrub) **inside the app**. No redirects, no new tabs. The embed is free and does **not** count against YouTube API quota.

#### What it looks like in the coach panel

```
┌─────────── Exercise Coach Panel ───────────┐
│                                             │
│  📷 [User's image of lat pulldown machine]  │
│                                             │
│  🏋️ Lat Pulldown                            │
│  1. Sit down and adjust the thigh pad...    │
│  2. Grip the bar wider than shoulder...     │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  ▶  How To: Lat Pulldown            │    │  ← Embedded YouTube player
│  │     (plays right here, inline)       │    │     with full controls
│  └─────────────────────────────────────┘    │
│                                             │
│  Muscles: Lats · Biceps · Rear Delts        │
│                                             │
│  💬 [Ask a follow-up...]                    │
└─────────────────────────────────────────────┘
```

If the agent returns multiple videos, they stack vertically or display as a scrollable carousel.

#### WebSearchTool (fallback)

- Built into OpenAI Agents SDK — `from agents import WebSearchTool`
- No extra API key needed
- Agent can search the web if YouTube API is unavailable or quota exhausted
- Less precise but zero-config
- Returns URLs that can still be rendered as iframe embeds if they're YouTube links

**Implementation**: Create a custom function tool `search_youtube(query: str) -> list[VideoResult]` that wraps the YouTube API. Register it with the Exercise Coach agent. If the API call fails, the agent can fall back to `WebSearchTool`.

### 3. Conversational Follow-Ups

After the initial identification/response, the user can ask follow-ups:

- *"What muscles does this target?"*
- *"What's a good superset with this?"*
- *"Show me a beginner variation"*
- *"Any alternatives I can do at home?"*

#### Conversation Lifecycle: Topic-Scoped with Soft Cap

| Rule | Detail |
|------|--------|
| **Scope** | Conversation stays alive while discussing the same exercise/equipment |
| **Soft cap** | 6 turns max per conversation |
| **Reset triggers** | New image uploaded, user clicks "New Question", or 10 min inactivity |
| **Storage** | In-memory dict on the backend, keyed by `conversation_id` |
| **Cleanup** | Lazy TTL sweep on each request (no background scheduler needed) |

**No database needed** for conversation history — it's ephemeral by design. This keeps cost and complexity low.

#### Backend Conversation State

**Important: multimodal `content` format.** Turn 1 may include an image (`list[dict]`), while follow-ups are plain text (`str`). The history must preserve both formats so GPT-4o can reference the original image in follow-up turns.

```python
# Simple in-memory conversation store with multimodal support
from datetime import datetime, timedelta
from typing import Any

# content is str for text-only turns, or list[dict] for image+text turns
# Example image turn content:
#   [{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}},
#    {"type": "text", "text": "How do I use this?"}]
# Example text-only follow-up:
#   "What muscles does this target?"

HistoryEntry = dict[str, Any]  # {"role": str, "content": str | list[dict]}

conversations: dict[str, dict] = {}
# Each entry: {
#   "history": list[HistoryEntry],
#   "last_active": datetime,
#   "turn_count": int,
# }

CONVERSATION_TTL = timedelta(minutes=10)
MAX_TURNS = 6

def sweep_expired() -> None:
    """Lazy cleanup — called at the start of each /coach/ask request."""
    now = datetime.utcnow()
    expired = [k for k, v in conversations.items() if now - v["last_active"] > CONVERSATION_TTL]
    for k in expired:
        del conversations[k]
```

---

## Layout Change: Split-Panel Design

### Current Layout
Single-column centered layout (`max-width: 680px`):
1. Voice input at top
2. Agent response card
3. Workout history list below

### New Layout

```
┌─────────────────────────────────────────────────────────┐
│                     GymBuddy Header                     │
├──────────────────────────┬──────────────────────────────┤
│                          │                              │
│   WORKOUT LOG (Left)     │   EXERCISE COACH (Right)     │
│                          │                              │
│   • Voice input bar      │   • Camera / Upload button   │
│   • Agent response card  │   • Image preview            │
│   • Workout history      │   • Text/voice input         │
│     (day-grouped cards)  │   • Coach response card      │
│   • Manual add form      │     - Instructions           │
│                          │     - Muscles targeted        │
│                          │     - YouTube embed           │
│                          │     - Common mistakes         │
│                          │   • Follow-up messages        │
│                          │   • [Log This Exercise] btn   │
│                          │   • "New Question" button     │
│                          │                              │
└──────────────────────────┴──────────────────────────────┘
```

**Desktop** (≥ 900px): Side-by-side, 50/50 split (or ~55/45 left-heavy)
**Mobile** (< 900px): Tab-based navigation — two tabs: "Log" and "Coach"

---

## Input Methods for Exercise Coach

### Camera Access (Laptop/Desktop)

- Use `navigator.mediaDevices.getUserMedia({ video: true })` to access the webcam
- Show a live preview with a "Capture" button
- On capture: grab a frame from the `<video>` element → convert to base64 JPEG
- Send to backend as part of the request body

### File Upload

- Standard `<input type="file" accept="image/*">` with a styled upload button
- Support drag-and-drop onto the coach panel
- Preview the uploaded image before sending
- Convert to base64 on the frontend before sending to backend

### Voice / Text

- Reuse the existing `VoiceInput` component or a variant of it
- When used with an image, the text provides additional context (e.g., "How do I use this?" or "Show me a video")
- When used without an image, it's a general exercise question

---

## Agent Architecture (OpenAI Agents SDK)

### Option: Triage Agent → Specialist Agents

```
User Input (voice/text/image)
         │
         ▼
   ┌─────────────┐
   │ Triage Agent │──── "I did 3 sets of bench press" ──→ Workout Parser Agent
   │  (router)    │                                        (existing)
   │              │──── [image] + "how do I use this?" ──→ Exercise Coach Agent
   └─────────────┘                                        (new)
```

**However**, for the MVP, keep it simpler:

- The **left panel** always sends to the **Workout Parser** agent (existing behavior, no change)
- The **right panel** always sends to the **Exercise Coach** agent (new)
- **No triage agent needed** — the UI layout itself acts as the router

This avoids adding a triage step that costs an extra API call on every request. The triage agent is a future optimization if/when inputs are unified.

### Exercise Coach Agent Definition

```python
from agents import Agent, WebSearchTool, function_tool
from pydantic import BaseModel

class MuscleTarget(BaseModel):
    muscle_group: str      # e.g., "Lats"
    role: str              # "primary" | "secondary"

class VideoResult(BaseModel):
    video_id: str
    title: str
    thumbnail_url: str
    url: str               # Full YouTube watch URL

class ExerciseCoachResponse(BaseModel):
    equipment_name: str | None         # None for general questions
    exercise_name: str | None          # None for broad questions like "how to get bigger biceps?"
    instructions: list[str]           # Step-by-step form instructions
    muscles_targeted: list[MuscleTarget]
    common_mistakes: list[str]
    difficulty: str | None             # "beginner" | "intermediate" | "advanced" (None for general)
    tips: list[str]
    videos: list[VideoResult]         # Populated from search_youtube tool results
    message: str                       # Conversational summary for display

@function_tool
def search_youtube(query: str) -> list[dict]:
    """Search YouTube for exercise tutorial videos.
    
    Returns a list of dicts, each containing:
    - video_id: str (YouTube video ID)
    - title: str (video title)
    - thumbnail_url: str (thumbnail image URL)
    - url: str (full YouTube watch URL)
    
    The agent should include these in the `videos` field of its final response.
    """
    from googleapiclient.discovery import build
    import os
    
    youtube = build("youtube", "v3", developerKey=os.environ["YOUTUBE_API_KEY"])
    response = youtube.search().list(
        q=query, part="snippet", type="video", maxResults=3
    ).execute()
    
    results = []
    for item in response.get("items", []):
        vid = item["id"]["videoId"]
        results.append({
            "video_id": vid,
            "title": item["snippet"]["title"],
            "thumbnail_url": item["snippet"]["thumbnails"]["medium"]["url"],
            "url": f"https://www.youtube.com/watch?v={vid}",
        })
    return results

exercise_coach = Agent(
    name="Exercise Coach",
    instructions="""You are a knowledgeable gym coach. When given an image of gym 
    equipment, identify it and provide detailed exercise guidance. When asked for 
    videos, use the search_youtube tool. Be concise and practical — users are 
    at the gym and want quick, actionable advice.
    
    When search_youtube returns results, include them in your `videos` output field
    exactly as returned (video_id, title, thumbnail_url, url).""",
    tools=[search_youtube, WebSearchTool()],
    output_type=ExerciseCoachResponse,
    model="gpt-4o",
)
```

---

## API Endpoints (New)

> **Auth**: All coach endpoints use `Depends(get_current_user)` — same pattern as existing workout routes. Without auth, any request can burn OpenAI + YouTube API quota.

### `POST /api/v1/coach/ask`

```python
@router.post("/coach/ask")
async def coach_ask(
    body: CoachRequest,
    current_user: dict = Depends(get_current_user),  # ← REQUIRED
) -> APIResponse:
```

**Request body**:
```json
{
  "text": "How do I use this machine?",
  "image_base64": "data:image/jpeg;base64,...",    // optional
  "conversation_id": "uuid-or-null"                 // null = new conversation
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "conversation_id": "abc-123",
    "turn_number": 1,
    "max_turns": 6,
    "response": {
      "equipment_name": "Lat Pulldown Machine",
      "exercise_name": "Lat Pulldown",
      "instructions": [
        "Sit down and adjust the thigh pad...",
        "Grip the bar wider than shoulder width...",
        "..."
      ],
      "muscles_targeted": [
        { "muscle_group": "Lats", "role": "primary" },
        { "muscle_group": "Biceps", "role": "secondary" }
      ],
      "common_mistakes": [
        "Pulling the bar behind the neck",
        "Using momentum instead of controlled movement"
      ],
      "difficulty": "beginner",
      "tips": ["Focus on squeezing your shoulder blades together"],
      "videos": [
        {
          "video_id": "abc123",
          "title": "How To: Lat Pulldown (Proper Form)",
          "thumbnail_url": "https://img.youtube.com/vi/abc123/mqdefault.jpg",
          "url": "https://www.youtube.com/watch?v=abc123"
        }
      ],
      "message": "This is a Lat Pulldown machine! Here's how to use it..."
    }
  },
  "error": null
}
```

### `DELETE /api/v1/coach/conversation/{conversation_id}`

Manually clear a conversation (for the "New Question" button). Also authenticated.

---

## Coach → Workout Log Shortcut

After the coach identifies an exercise, the response card shows a **"Log This Exercise"** button. Clicking it:

1. Pre-fills the exercise name from `ExerciseCoachResponse.exercise_name`
2. Opens the left panel's manual workout form (or scrolls to it) with the exercise name already populated
3. User just fills in sets, reps, weight and saves

This connects the two panels without building a triage agent. The flow:
```
See machine → Coach identifies "Lat Pulldown" → Do the exercise → Click "Log This Exercise"
→ Left panel form opens with exercise="lat pulldown" pre-filled → User adds 3×10 @ 165 lbs → Save
```

**Implementation**: Frontend-only. The coach response component calls a callback like `onLogExercise(exerciseName)` that the parent page passes down. The parent sets the left panel's manual form state with the pre-filled name. No new API needed.

---

## New Dependencies

### Backend (Python)
- `google-api-python-client` — YouTube Data API v3 client

### Frontend (Next.js)
- No new packages needed — camera API and file upload are native browser APIs

### New Environment Variables
```
YOUTUBE_API_KEY=           # Google Cloud API key for YouTube Data API v3
```

---

## File Changes Summary

### Backend — New Files

| File | Purpose |
|------|---------|
| `backend/app/agents/exercise_coach.py` | Exercise Coach agent definition + tools |
| `backend/app/routes/coach.py` | `/api/v1/coach/*` route handlers |
| `backend/app/models/coach.py` | Pydantic models for coach request/response |
| `backend/app/services/youtube.py` | YouTube Data API v3 wrapper |
| `backend/app/services/conversation.py` | In-memory conversation state manager |

### Backend — Modified Files

| File | Change |
|------|--------|
| `backend/app/main.py` | Register new coach router |

### Frontend — New Files

| File | Purpose |
|------|---------|
| `frontend/components/ExerciseCoach.tsx` | Right-panel coach UI (camera, upload, chat) |
| `frontend/components/CameraCapture.tsx` | Webcam access + capture component |
| `frontend/components/CoachResponse.tsx` | Render coach response cards (instructions, videos, muscles) |
| `frontend/components/YouTubeEmbed.tsx` | Embedded YouTube player component |
| `frontend/lib/coach-api.ts` | API client functions for coach endpoints |

### Frontend — Modified Files

| File | Change |
|------|--------|
| `frontend/app/page.tsx` | Split into two-panel layout, move existing content to left panel |

---

## Implementation Order

1. **Backend models** — Define Pydantic schemas for coach input/output
2. **YouTube service** — Build the YouTube API wrapper + test it
3. **Conversation manager** — In-memory store with TTL cleanup
4. **Exercise Coach agent** — Agent definition with tools (YouTube + WebSearch)
5. **Coach API routes** — Wire up `/api/v1/coach/ask` and conversation management
6. **Frontend: Coach panel** — Camera, upload, text input, response rendering
7. **Frontend: Layout split** — Restructure page.tsx into left/right panels
8. **Frontend: YouTube embed** — Inline video player in response cards
9. **Testing** — Mock OpenAI + YouTube APIs, test conversation lifecycle
10. **Polish** — Mobile tabs, loading states, error handling

---

## Resolved Design Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Auth on coach routes? | ✅ Yes — `Depends(get_current_user)` | Prevents unauthorized API cost burn |
| 2 | Conversation history with images? | `content: str \| list[dict]` | GPT-4o multimodal messages use list format for image turns |
| 3 | TTL cleanup mechanism? | Lazy sweep on each request | No background scheduler needed for single-user MVP |
| 4 | `output_type` vs tool-writes? | `output_type=ExerciseCoachResponse` | Coach returns info, doesn't write to DB — different from parser pattern |
| 5 | `exercise_name` optional? | ✅ `str \| None` | General questions don't map to a single exercise |
| 6 | Coach → Log shortcut? | ✅ "Log This Exercise" button | Pre-fills exercise name in left panel's manual form |

## Open Decisions

- [ ] **YouTube API key**: User needs to create a Google Cloud project and enable YouTube Data API v3. Free tier should be sufficient for personal use (~100 searches/day).
- [x] **Image size limits**: Resize to max 1024px on frontend before sending. Saves bandwidth and API cost.
- [x] **Conversation history persistence**: In-memory only for MVP. Add `coach_conversations` table later if needed.
