# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

GymBuddy is a voice-first workout tracker. Users speak or type natural language (e.g. *"bench press 3x10 at 135 lbs"* or *"delete bench press from today"*) → the backend routes the intent through an OpenAI agent with DB tools → stores/retrieves data in Supabase Postgres → the frontend shows confirmation and a day-grouped history view.

## Commands

```bash
# Install Python deps (from repo root)
uv sync

# Run backend (from repo root — do NOT cd into backend/)
uv run uvicorn backend.app.main:app --reload --port 8000

# Run frontend
cd frontend && npm install && npm run dev

# Type-check frontend
cd frontend && npm run type-check
```

## Architecture

```
frontend/
  app/page.tsx              Main page — voice/text input, day-grouped history, ActionCard
  components/VoiceInput.tsx Web Speech API + always-visible text fallback (SSR-safe)
  lib/api.ts                Typed fetch wrapper for all backend endpoints

backend/app/
  main.py                   App factory: lifespan (create_tables), CORS, global exception handler
  agents/workout_parser.py  GymBuddy agent — 8 function tools, GymContext, run_agent()
  data/muscle_lookup.py     Static lookup dict: exercise name → primary/secondary muscle dicts
  models/workout.py         All Pydantic models (source of truth for API shapes)
  routes/workouts.py        All HTTP routes: /workouts (CRUD) + /sessions
  db/database.py            SQLAlchemy async engine + session context manager + DDL (create_tables)
  db/queries.py             All raw SQL via text() — no ORM models
```

## Data Flow

**Voice/text input → agent path (POST /api/v1/workouts):**
```
browser → POST /api/v1/workouts {transcript}
  → run_agent(transcript, user_id)
      → GymBuddy Agent (gpt-4o) picks a tool based on intent
      → tool executes DB query, writes result into GymContext
  → route reads GymContext → builds AgentActionResponse
  → APIResponse envelope → UI renders ActionCard by action type
```

**Manual add / edit / delete (direct REST):**
```
browser → POST /workouts/manual | PUT /workouts/{id} | DELETE /workouts/{id}
  → route calls query function directly (no agent)
  → APIResponse envelope
```

## The Agent

`workout_parser.py` creates one `Agent[GymContext]` at import time (stateless). Per-request state lives in a `GymContext` dataclass passed via `RunContextWrapper` — the LLM never sees `user_id` or result fields, only tool return strings.

**8 registered tools:**

| Tool | Triggered by |
|---|---|
| `log_workout` | User describes a completed exercise |
| `get_last_workout` | Prerequisite step for delete/update of "last" workout |
| `delete_workout` | "delete my last workout", "undo that" |
| `update_workout_tool` | "change my last workout to 4 sets" |
| `search_workouts_tool` | "show me my squat history" |
| `start_workout_session` | "starting chest day", "today is push day" |
| `get_today_workouts` | "what did I do today?", "did I hit every muscle group?" |
| `delete_exercise_today` | "delete bench press from today", "remove my squats" |

After `Runner.run()`, the route reads `context.action`, `context.logged_workout`, `context.found_workouts`, `context.deleted_workouts`, and `context.session` to build the typed `AgentActionResponse`.

## Database Tables

All DDL lives in `db/database.py:create_tables()` and runs on every startup via `CREATE TABLE IF NOT EXISTS`. There is no migration tool — add new columns/tables there.

| Table | Purpose |
|---|---|
| `workout_logs` | Core workout records (exercise, sets, reps, weight, user_id, logged_at) |
| `workout_muscle_targets` | Normalized muscle data per workout (FK → workout_logs ON DELETE CASCADE) |
| `workout_sessions` | One declared session per user per day ("chest", "push", etc.) — UNIQUE(user_id, date) |

Muscle targets are populated from `data/muscle_lookup.py` (39 common exercises). The `source` column is `"lookup"` for static matches, `"ai_inferred"` for AI-generated ones.

PR detection runs after every insert: `SELECT MAX(weight) WHERE exercise=:e AND reps>=:r AND id!=:current` — new record is a PR if it exceeds the previous max.

## Key Implementation Details

### ORM: SQLAlchemy 2.0 async (NOT Prisma)
`prisma-client-py` was deprecated April 2025. All queries use `session.execute(text(...))` with named parameters. Results are mapped via `.mappings()` into Pydantic models manually. No ORM model classes exist.

### Supabase / PgBouncer connection
Use the **Transaction pooler URL (port 6543)**, not the direct connection (port 5432). The engine uses `connect_args={"statement_cache_size": 0}` (required for PgBouncer transaction mode) and auto-strips `?pgbouncer=true` from the URL. Pool is `pool_size=5, max_overflow=5` with `pool_pre_ping=True` and `pool_recycle=300`.

### Backend imports
All internal imports must be **relative** (`from ..models.workout import …`). Absolute `from app.X` imports break because uvicorn is launched as `backend.app.main:app` from the repo root.

### Response envelope
Every endpoint returns `{ "success": bool, "data": ..., "error": string | null }`. The global exception handler in `main.py` guarantees this shape for unhandled errors too. `APIResponse.data` is a union — the TypeScript side uses the `action` discriminant on `AgentActionResponse` to decide what to render.

### Frontend UI patterns
`page.tsx` has no CSS modules — all styling is inline `React.CSSProperties`. The history list is day-grouped via `groupByDay()` (pure function above `HomePage`). Each day shows a header with the session badge (from `WorkoutSession`) and workout cards with PR badges (gold pill) and muscle pills (hover title = specific muscles).

### Web Speech API
`VoiceInput.tsx` feature-detects `window.SpeechRecognition ?? window.webkitSpeechRecognition` inside `useEffect` (SSR-safe). The text input is always rendered — it's the primary input for Firefox/keyboard users.

## Environment Variables

**`/.env`** (backend, repo root):
```
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql+asyncpg://postgres.[ref]:[password]@aws-X-us-east-1.pooler.supabase.com:6543/postgres
SUPABASE_JWKS_URL=https://[ref].supabase.co/auth/v1/keys
```

**`/frontend/.env.local`**:
```
NEXT_PUBLIC_SUPABASE_URL=https://[ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Critical Rules

- **Relative imports only** in `backend/app/`. Never `from app.X import`.
- **New DB tables/columns** → add `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` DDL to `database.py:create_tables()` AND update the corresponding Pydantic models in `models/workout.py`.
- **New API shapes** → define explicit TypeScript interfaces in `frontend/lib/api.ts`. No `any`.
- **New dependencies** → `pyproject.toml` (Python) or `frontend/package.json` (JS). No `requirements.txt`.
- **All AI/OpenAI calls go through the backend** — the frontend never calls OpenAI directly.
- **Agent tools write to GymContext** — the route reads GymContext after `Runner.run()` to build the response. Never return structured data from tool return strings; use `ctx.context.*` fields instead.
