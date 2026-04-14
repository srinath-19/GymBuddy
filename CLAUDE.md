# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

GymBuddy is a voice-first workout tracker. Users speak or type a workout (e.g. *"lat pull down 3 sets 165 lbs 6 reps"*) → the backend parses it with an OpenAI agent → stores it in Supabase Postgres → the frontend shows confirmation and history.

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
frontend/               Next.js 15 + React 19 (App Router, "use client" pages)
  app/page.tsx          Main page — voice/text input + workout history list
  components/VoiceInput.tsx  Web Speech API + always-visible text fallback
  lib/api.ts            Typed fetch wrapper → POST /api/v1/workouts, GET /api/v1/workouts

backend/app/            Python FastAPI (all async)
  main.py               App factory: lifespan (create_tables), CORS, global exception handler
  agents/workout_parser.py  OpenAI Agent (output_type=WorkoutLog) — created once at import
  models/workout.py     All Pydantic models: WorkoutLog (AI output), WorkoutRequest, APIResponse
  routes/workouts.py    POST + GET /api/v1/workouts
  db/database.py        SQLAlchemy async engine + session + DDL
  db/queries.py         insert_workout(), fetch_workouts() — raw text() SQL
```

**Data flow:** browser → `POST /api/v1/workouts` → `parse_workout()` (OpenAI agent) → `insert_workout()` (SQLAlchemy) → Supabase Postgres → response envelope back to UI.

## Key Implementation Details

### ORM: SQLAlchemy 2.0 async (NOT Prisma)
`prisma-client-py` was deprecated April 2025. The project uses **SQLAlchemy 2.0 + asyncpg**. Table DDL lives in `database.py:create_tables()` and runs on startup via the FastAPI lifespan. There is no migration tool — use `CREATE TABLE IF NOT EXISTS` DDL for schema changes.

### PgBouncer / Supabase connection
`database.py` uses `NullPool` and `connect_args={"statement_cache_size": 0}`. It also automatically strips `?pgbouncer=true` from the URL if present (that's a Prisma-only flag). Use the **Transaction pooler URL (port 6543)** from Supabase, not the direct connection (port 5432).

### Backend imports
All internal imports use **relative imports** (`from .db.database import …`, `from ..models.workout import …`). This is required because uvicorn is launched as `backend.app.main:app` from the repo root.

### OpenAI Agent
`workout_parser.py` creates one `Agent(output_type=WorkoutLog, model="gpt-4o")` at module import time — it's stateless. `Runner.run()` is the per-request async call. The `output_type` forces the SDK to validate the structured output before returning; never parse raw completions manually.

### Web Speech API
`VoiceInput.tsx` feature-detects `window.SpeechRecognition ?? window.webkitSpeechRecognition` inside `useEffect` (SSR-safe). The text input is **always rendered** — it's the primary input for Firefox and keyboard users, not a hidden fallback.

### Response envelope
All API responses follow `{ "success": bool, "data": ..., "error": string | null }`. The global exception handler in `main.py` guarantees this shape even for unhandled errors.

## Environment Variables

**`/.env`** (backend, repo root):
```
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql+asyncpg://postgres.[ref]:[password]@aws-X-us-east-1.pooler.supabase.com:6543/postgres
```

**`/frontend/.env.local`**:
```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Critical Rules

- **Never use `from app.X import`** — always relative imports in `backend/app/`. Absolute `app.*` imports break when launched as `backend.app.main`.
- **New DB columns** → add to the `CREATE TABLE` DDL in `database.py` and the `WorkoutLog`/`WorkoutLogResponse` Pydantic models.
- **New dependencies** → `pyproject.toml` (Python) or `frontend/package.json` (JS). There is no `requirements.txt`.
- **All AI calls go through the backend** — the frontend never calls OpenAI directly.
- **No `any` in TypeScript** — define explicit interfaces in `frontend/lib/api.ts` for all API shapes.
