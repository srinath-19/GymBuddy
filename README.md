# 🏋️ GymBuddy

**Voice-first AI workout companion** — speak or type natural language to log workouts, get real-time exercise coaching, and follow guided workout sessions.

> *"Bench press 3 sets of 10 at 135 lbs"* → AI parses, logs, detects PRs, maps muscle groups — all in one voice command.

---

## Features

### 🎙️ Voice-First Workout Logger (`/`)
- **Natural language input** — speak or type commands like *"squat 4×8 at 225"* or *"delete my last workout"*
- **Automatic PR detection** — flags new personal records after every log
- **AI muscle-group inference** — maps exercises to primary and secondary muscle groups
- **Session management** — declare session types (*"starting chest day"*) with muscle coverage tracking
- **Full CRUD** — log, edit, delete, and search workout history via voice or manual forms
- **Day-grouped history** — workouts organized by date with session badges and inline editing

### 📸 AI Exercise Coach (`/coach`)
- **GPT-4o Vision** — point your camera at gym equipment and get instant identification
- **Step-by-step form guidance** — numbered instructions, common mistakes, difficulty rating
- **YouTube tutorials** — relevant tutorial videos surfaced via YouTube Data API
- **Multi-turn conversations** — ask follow-up questions with conversation memory
- **"Log this" shortcut** — quickly log the exercise you just learned about

### 🏃 Workout Pacer (`/pacer`)
- **Guided sessions** — say *"start my push workout"* and get a full exercise plan
- **Set tracking** — record completed sets with reps and weight (*"done, 10 at 155"*)
- **Rest timers** — automatic rest countdowns between sets and exercises
- **Plan modification** — add, remove, swap, or change exercises mid-workout
- **Auto-logging** — completed exercises are automatically saved to your workout history

### 🗣️ Hands-Free Mode
- **Wake word detection** — say *"GymBuddy"* to activate voice input without touching the screen
- **Text-to-speech** — AI responses are read aloud via OpenAI TTS for fully hands-free use
- **TTS suppression** — wake word pauses during TTS playback to prevent feedback loops

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (Next.js + React 19)             │
│  ┌──────────────┐ ┌─────────────┐ ┌───────────────────────┐ │
│  │  Workouts /  │ │  Coach      │ │  Pacer                │ │
│  │  Voice+Text  │ │  Camera+Text│ │  Voice+Guided Session │ │
│  └──────┬───────┘ └──────┬──────┘ └───────────┬───────────┘ │
│         │           /api/v1/chat           /api/v1/chat     │
│    /api/v1/workouts  (orchestrator)       (orchestrator)    │
└─────────┬────────────────┴──────────────────┬───────────────┘
          │                                   │
          │         HTTPS + JWT               │
          ▼                                   ▼
┌─────────────────────────────────────────────────────────────┐
│                      FastAPI Backend                        │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         Intent Classifier (gpt-4o-mini)             │    │
│  │     Routes /api/v1/chat → workout | coach | pacer   │    │
│  └──────┬──────────────┬──────────────────┬────────────┘    │
│         ▼              ▼                  ▼                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
│  │Workout Parser│ │Exercise Coach│ │ Workout Pacer    │    │
│  │  11 tools    │ │ GPT-4o Vision│ │  6 tools         │    │
│  │ gpt-4o-mini  │ │ +YouTube+Web │ │  gpt-4o          │    │
│  └──────────────┘ └──────────────┘ └──────────────────┘    │
│                                                             │
│  ┌─────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │JWT Auth │ │ Redis Cache  │ │ In-Memory Session Stores │ │
│  └─────────┘ └──────────────┘ └──────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐   │
│  │          SQLAlchemy 2.0 Async + asyncpg              │   │
│  └──────────────────────┬───────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          ▼
              Supabase Postgres + Upstash Redis
```

---

## Multi-Agent System

GymBuddy uses a **4-agent orchestration system** built with the [OpenAI Agents SDK](https://github.com/openai/openai-agents-python):

| Agent | Model | Tools | Purpose |
|-------|-------|-------|---------|
| **Intent Classifier** | gpt-4o-mini | — | Routes `/api/v1/chat` requests to the correct specialist |
| **Workout Parser** | gpt-4o-mini | 11 function-calling tools | Workout CRUD, sessions, PR lookup, history search |
| **Exercise Coach** | gpt-4o | YouTube search, Web search | Vision-based form analysis, equipment ID, tutorials |
| **Workout Pacer** | gpt-4o | 6 function-calling tools | Guided sessions, set tracking, plan management |

**23 total function-calling tools** across all agents. Each agent uses isolated per-request context (`GymContext` / `PacerContext`) — user IDs and internal state are never exposed to the LLM.

### Workout Parser Tools
| Tool | Trigger |
|------|---------|
| `log_workout` | *"bench press 3×10 at 135"* |
| `get_last_workout` | *"what did I just do?"* |
| `delete_workout` | *"delete my last workout"* |
| `update_workout_tool` | *"change to 4 sets"* |
| `search_workouts_tool` | *"show my squat history"* |
| `start_workout_session` | *"starting chest day"* |
| `get_session_for_date_tool` | *"what's today's session?"* |
| `get_today_workouts` | *"what did I do today?"* |
| `delete_exercise_today` | *"delete bench from today"* |
| `get_workouts_for_date` | *"what did I do Monday?"* |
| `get_pr_for_exercise` | *"what's my bench PR?"* |

### Pacer Tools
| Tool | Trigger |
|------|---------|
| `suggest_exercises` | *"start my push workout"* |
| `mark_set_done` | *"done, 10 at 155"* |
| `get_session_progress` | *"how's the workout going?"* |
| `skip_exercise` | *"skip"* / *"next exercise"* |
| `end_session` | *"done for today"* |
| `modify_plan` | *"remove cable fly"* / *"add dips"* |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 16, React 19, TypeScript, TailwindCSS, shadcn/ui |
| **Backend** | FastAPI, Python 3.12+, fully async |
| **AI** | OpenAI Agents SDK (function calling), GPT-4o, GPT-4o Vision |
| **Database** | Supabase Postgres, SQLAlchemy 2.0 async, asyncpg, raw SQL |
| **Auth** | Supabase Auth (Google OAuth), JWKS JWT validation (PyJWT) |
| **Caching** | Upstash Redis (REST client, optional with graceful fallback) |
| **Voice** | Web Speech API (STT + wake word), OpenAI TTS API |
| **Deployment** | Docker, Google Cloud Run, GitHub Actions CI/CD |

---

## Database Schema

Three tables, all created via idempotent DDL (`CREATE TABLE IF NOT EXISTS`) on every app startup:

```sql
-- Core workout records
workout_logs (
    id UUID PRIMARY KEY,
    user_id UUID,
    exercise VARCHAR(255),
    sets INTEGER, reps INTEGER, weight FLOAT,
    weight_unit VARCHAR(10) DEFAULT 'lbs',
    notes TEXT,
    is_pr BOOLEAN DEFAULT FALSE,
    logged_at TIMESTAMPTZ DEFAULT NOW()
)

-- Muscle targeting per workout (FK with CASCADE delete)
workout_muscle_targets (
    workout_id UUID REFERENCES workout_logs(id) ON DELETE CASCADE,
    muscle_group VARCHAR(100),
    specific_muscles TEXT[],
    role VARCHAR(20),       -- 'primary' | 'secondary'
    source VARCHAR(20)      -- 'lookup' | 'ai_inferred'
)

-- Session labels (one per user per day)
workout_sessions (
    user_id UUID, session_type TEXT, date DATE,
    UNIQUE(user_id, date)
)
```

---

## API Endpoints

All endpoints return the envelope: `{ "success": bool, "data": ..., "error": string | null }`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/v1/workouts` | AI agent processes voice/text |
| `POST` | `/api/v1/workouts/stream` | Streaming agent execution (NDJSON) |
| `POST` | `/api/v1/workouts/manual` | Direct manual add (no agent) |
| `GET` | `/api/v1/workouts` | Workout history (cache-first) |
| `PUT` | `/api/v1/workouts/{id}` | Update workout |
| `DELETE` | `/api/v1/workouts/{id}` | Delete workout |
| `GET` | `/api/v1/sessions` | Session list (cache-first) |
| `PUT` | `/api/v1/sessions/{date}` | Update session type |
| `POST` | `/api/v1/chat` | Unified orchestrator (classifier → agent) |
| `POST` | `/api/v1/coach/ask` | Direct coach endpoint |
| `POST` | `/api/v1/pacer/{id}/set-done` | Direct pacer set completion |
| `POST` | `/api/v1/pacer/{id}/skip` | Direct pacer skip |
| `POST` | `/api/v1/pacer/{id}/plan` | Direct pacer plan modification |
| `POST` | `/api/v1/tts` | Text-to-speech generation |
| `GET` | `/health` | Health check |

---

## Getting Started

### Prerequisites
- Python 3.12+
- Node.js 22.x
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- A [Supabase](https://supabase.com/) project (Postgres + Auth)
- An [OpenAI](https://platform.openai.com/) API key

### 1. Clone the repo
```bash
git clone https://github.com/srinath-19/GymBuddy.git
cd GymBuddy
```

### 2. Backend setup
```bash
# Install Python dependencies
uv sync

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your keys:
#   OPENAI_API_KEY, DATABASE_URL, SUPABASE_JWKS_URL,
#   YOUTUBE_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

# Start the backend (from repo root — do NOT cd into backend/)
uv run uvicorn backend.app.main:app --reload --port 8000
```

### 3. Frontend setup
```bash
cd frontend

# Install JS dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env.local
# Edit .env.local with your Supabase URL and keys

# Start the frontend
npm run dev
```

The backend runs on `http://localhost:8000`, frontend on `http://localhost:3000`.

### Environment Variables

**Backend** (`.env`):
| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for agents and TTS |
| `DATABASE_URL` | Supabase Postgres connection string (use port 6543 for PgBouncer) |
| `SUPABASE_JWKS_URL` | JWKS endpoint for JWT verification |
| `YOUTUBE_API_KEY` | YouTube Data API key (for coach tutorials) |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis URL (optional) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis token (optional) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins |

**Frontend** (`frontend/.env.local`):
| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable/anon key |
| `NEXT_PUBLIC_API_URL` | Backend API URL (`http://localhost:8000`) |

---

## Project Structure

```
GymBuddy/
├── backend/app/
│   ├── main.py                  # App factory, CORS, lifespan, global error handler
│   ├── agents/
│   │   ├── orchestrator.py      # Intent classifier + dispatch to specialist agents
│   │   ├── workout_parser.py    # 11-tool workout agent + GymContext + streaming
│   │   ├── exercise_coach.py    # GPT-4o Vision coach + YouTube/web search
│   │   └── workout_pacer.py     # 6-tool pacer agent + state machine + auto-logging
│   ├── auth/
│   │   └── dependencies.py      # JWKS-based JWT validation
│   ├── cache/
│   │   └── redis_client.py      # Upstash Redis REST client (optional)
│   ├── data/
│   │   ├── muscle_ai.py         # AI muscle inference via OpenAI
│   │   └── session_muscles.py   # Session type → expected muscle groups
│   ├── db/
│   │   ├── database.py          # SQLAlchemy engine, session manager, DDL
│   │   └── queries.py           # All raw SQL queries (15+ functions)
│   ├── models/
│   │   ├── workout.py           # Workout Pydantic models
│   │   ├── coach.py             # Coach response models
│   │   ├── pacer.py             # Pacer state + response models
│   │   └── chat.py              # Unified chat request/response
│   ├── routes/
│   │   ├── workouts.py          # Workout CRUD + streaming agent
│   │   ├── chat.py              # Unified orchestrator endpoint
│   │   ├── coach.py             # Direct coach endpoint
│   │   ├── pacer.py             # Direct pacer action endpoints
│   │   └── tts.py               # TTS generation
│   └── services/
│       ├── conversation.py      # In-memory coach conversation store
│       ├── pacer_session.py     # In-memory pacer session store
│       └── youtube.py           # YouTube Data API + Redis caching
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx             # Main workouts page (~900 lines)
│   │   ├── layout.tsx           # Root layout, runtime env injection
│   │   ├── globals.css          # Dark glassmorphism design system
│   │   ├── coach/page.tsx       # Exercise Coach page
│   │   ├── pacer/page.tsx       # Workout Pacer page
│   │   ├── login/page.tsx       # Google OAuth login
│   │   └── auth/callback/       # OAuth callback handler
│   ├── components/
│   │   ├── VoiceInput.tsx       # Web Speech API + text fallback
│   │   ├── WorkoutPacer.tsx     # Guided workout state machine
│   │   ├── ExerciseCoach.tsx    # Camera + AI form analysis
│   │   ├── CameraCapture.tsx    # getUserMedia() camera capture
│   │   ├── CoachResponse.tsx    # Coach feedback renderer
│   │   ├── NavBar.tsx           # Navigation bar
│   │   ├── WakeWordIndicator.tsx# Wake word status indicator
│   │   ├── YouTubeEmbed.tsx     # YouTube video embed
│   │   └── ui/                  # shadcn/ui components
│   ├── lib/
│   │   ├── api.ts               # Typed fetch wrapper (workouts, sessions)
│   │   ├── chat-api.ts          # Unified chat endpoint client
│   │   ├── coach-api.ts         # Coach API types + image resize
│   │   ├── pacer-api.ts         # Pacer API types
│   │   ├── useTTS.ts            # TTS hook (OpenAI audio + browser fallback)
│   │   ├── useWakeWord.ts       # Wake word detection hook
│   │   ├── public-env.ts        # Runtime env injection
│   │   ├── speech-types.ts      # Web Speech API TypeScript types
│   │   ├── utils.ts             # Utilities
│   │   └── supabase/client.ts   # Supabase browser client
│   └── proxy.ts                 # Next.js middleware (auth guard)
│
├── tests/                       # Pydantic model + muscle lookup tests
├── docs/cloud-run-deploy.md     # Cloud Run deployment runbook
├── pyproject.toml               # Python dependencies
└── .env.example                 # Environment variable template
```

---

## Deployment

The app is deployed as two separate services on **Google Cloud Run** (Docker containers). See the full deployment runbook at [docs/cloud-run-deploy.md](docs/cloud-run-deploy.md).

CI/CD is handled via **GitHub Actions** — pushes to `main` trigger automated builds and deploys.

**Estimated cost**: $0 on Cloud Run free tier for portfolio/hobby use.

---

## Key Design Decisions

- **Multi-agent over monolithic prompt** — Intent classifier routes to specialist agents, each with focused instructions and tools. Keeps prompts small and reliable.
- **Per-request context isolation** — `GymContext` and `PacerContext` carry user state through agent tool calls. The LLM never sees user IDs or internal objects.
- **Raw SQL over ORM** — All queries use `session.execute(text(...))` with named parameters. `prisma-client-py` was deprecated in April 2025.
- **Cache-first with graceful fallback** — Redis caches workouts, sessions, and PRs. App works without Redis; it just hits Postgres directly.
- **Streaming agent responses** — NDJSON streaming from `Runner.run_streamed()` gives real-time UI feedback during AI processing.
- **Machine-readable tags** — Pacer tools return tags like `[PHASE:resting][REST:120]` that the agent copies into structured output, preventing state hallucination.
- **Runtime env injection** — `window.__GYMBUDDY_PUBLIC_ENV__` injects env vars at request time, so Cloud Run can configure without rebuilding.

---

## License

This project is for portfolio and educational purposes.
