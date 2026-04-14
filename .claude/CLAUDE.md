# GymBuddy — Project Guidelines

## Project Overview

GymBuddy is a voice-first workout tracking application. Users log exercises by speaking naturally (e.g., *"I did lat pull down for 3 sets, 165 lbs, 6 reps"*), and the system uses AI to parse that into structured workout data and persist it to a database.

## MVP Scope (v0.1)

The initial release focuses on a single core flow:

1. **Voice Input** — User records or types a natural-language workout description.
2. **AI Parsing** — The input is sent to an OpenAI agent that extracts structured data (exercise name, sets, reps, weight, units, etc.).
3. **Database Storage** — The structured output is validated and inserted into a PostgreSQL database via Supabase.
4. **Confirmation** — The user sees what was logged and can confirm or correct it.

Future features (auth, analytics, workout history, AI coaching, etc.) will be added incrementally after the MVP is validated.

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Frontend / SSR** | Next.js (App Router) | React-based UI with server-side rendering |
| **Backend / API** | Python (FastAPI) | REST API for AI processing and data operations |
| **AI / Agents** | OpenAI Agents SDK | Agent orchestration for structured voice parsing |
| **LLM** | OpenAI API (GPT-4o+) | Structured output extraction from natural language |
| **Database** | PostgreSQL (Supabase) | Hosted Postgres with Supabase client libraries |
| **ORM** | Prisma | Type-safe database access and migrations |
| **Voice Input** | Web Speech API / Whisper | Browser-native speech-to-text (fallback: OpenAI Whisper) |

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐     ┌───────────┐
│  Next.js UI │────▶│  Python Backend   │────▶│  OpenAI Agent  │────▶│ Structured│
│  (voice in) │◀────│  (FastAPI)        │◀────│  (Agents SDK)  │◀────│  Output   │
└─────────────┘     └──────────────────┘     └────────────────┘     └───────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │  Supabase    │
                    │  (Postgres)  │
                    └──────────────┘
```

### Data Flow

1. User speaks into the Next.js frontend → browser converts speech to text (Web Speech API).
2. Text is sent to the Python FastAPI backend.
3. Backend invokes an OpenAI Agent (via Agents SDK) with a structured output schema.
4. Agent returns validated, structured JSON (exercise, sets, reps, weight, etc.).
5. Backend writes the structured data to Supabase Postgres via Prisma ORM.
6. Response is sent back to the frontend for user confirmation.

## Data Model (Initial)

### `workout_logs`

| Column       | Type        | Description                        |
|-------------|-------------|------------------------------------|
| id          | UUID (PK)   | Auto-generated primary key         |
| exercise    | VARCHAR     | Exercise name (e.g., "Lat Pulldown") |
| sets        | INTEGER     | Number of sets performed           |
| reps        | INTEGER     | Reps per set                       |
| weight      | FLOAT       | Weight used                        |
| weight_unit | VARCHAR     | "lbs" or "kg"                      |
| notes       | TEXT        | Optional raw transcript or notes   |
| logged_at   | TIMESTAMPTZ | When the exercise was performed    |
| created_at  | TIMESTAMPTZ | Record creation timestamp          |

> **Note:** Auth/user columns will be added when user accounts are implemented.

## Project Structure (Planned)

```
GymBuddy/
├── frontend/              # Next.js application
│   ├── app/               # App Router pages & layouts
│   ├── components/        # React components
│   ├── lib/               # Utility functions, API client
│   └── public/            # Static assets
├── backend/               # Python FastAPI application
│   ├── app/
│   │   ├── main.py        # FastAPI entrypoint
│   │   ├── agents/        # OpenAI agent definitions & prompts
│   │   ├── models/        # Pydantic models for structured output
│   │   ├── routes/        # API route handlers
│   │   └── db/            # Database client & queries (Prisma)
│   ├── prisma/
│   │   └── schema.prisma  # Prisma schema definition
│   └── requirements.txt   # Python dependencies
├── .claude/
│   └── CLAUDE.md          # This file — project context for Claude
└── README.md
```

## Code Style & Conventions

- **Python**: Follow PEP 8. Use type hints. Use `async` handlers in FastAPI.
- **TypeScript/React**: Use functional components with hooks. Use TypeScript strict mode.
- **Naming**: snake_case for Python, camelCase for TypeScript, PascalCase for React components.
- **Environment Variables**: Store secrets (OpenAI API key, Supabase URL/key) in `.env` files. Never commit secrets.

## Key Dependencies

### Backend (Python)
- `fastapi` + `uvicorn` — Web framework & ASGI server
- `openai` — OpenAI Python SDK
- `openai-agents` — OpenAI Agents SDK for agent orchestration
- `prisma` — Prisma Client Python
- `pydantic` — Data validation and structured output models

### Frontend (Next.js)
- `next` / `react` / `react-dom` — Core framework
- `@prisma/client` — (if needed for direct DB access in server components)
- Supabase JS client — (if using Supabase client-side features later)

## Environment Variables

```
# OpenAI
OPENAI_API_KEY=

# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
DATABASE_URL=          # Postgres connection string from Supabase

# App
BACKEND_URL=           # Python backend URL for Next.js to call
```

## Commands

```bash
# Backend
cd backend
pip install -r requirements.txt
prisma generate
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev
```

## Important Notes

- This is the MVP phase — keep things simple and functional. No premature optimization.
- The OpenAI Agent should return **structured output** (JSON matching the Pydantic model) — not free-form text.
- Prisma is used as the ORM for both schema management (migrations) and data access.
- Supabase is the hosted Postgres provider; we connect via standard Postgres connection string.
- Voice input in the browser uses the Web Speech API for simplicity; OpenAI Whisper is a future fallback option.

---

## Behavioral Rules (Do / Don't)

### DO
- Always check if a file/module already exists before creating a new one.
- Run `prisma generate` after any schema change.
- Use Pydantic `BaseModel` for ALL request/response shapes in the backend.
- Use OpenAI Agents SDK `Runner.run()` with `output_type` for structured output — never parse free-text LLM responses manually.
- Validate AI-parsed output server-side before writing to the database.
- Return consistent API response envelopes: `{ "success": bool, "data": ..., "error": ... }`.
- Use `try/except` around all OpenAI and database calls — these are external services that can fail.
- Write one module per concern — don't put agent logic, routes, and DB queries in the same file.

### DON'T
- Don't install new dependencies without listing them in the relevant `requirements.txt` or `package.json`.
- Don't use `any` type in TypeScript — always define explicit types/interfaces.
- Don't hardcode API keys, URLs, or secrets — always use environment variables.
- Don't create database tables or columns outside of Prisma migrations.
- Don't add features beyond the current MVP scope unless explicitly asked.
- Don't use `console.log` in production frontend code — use a proper logger or remove before committing.
- Don't make the frontend call OpenAI directly — all AI calls go through the Python backend.

## Error Handling Patterns

### Backend (Python/FastAPI)
```python
from fastapi import HTTPException

# Wrap external calls
try:
    result = await runner.run(agent, input=user_text)
except Exception as e:
    raise HTTPException(status_code=502, detail=f"AI service error: {str(e)}")

# Always return structured errors
@app.exception_handler(Exception)
async def global_handler(request, exc):
    return JSONResponse(
        status_code=500,
        content={"success": False, "data": None, "error": str(exc)}
    )
```

### Frontend (Next.js)
```typescript
// Use try/catch for all API calls, show user-friendly error states
try {
  const res = await fetch(`${BACKEND_URL}/api/log-workout`, { ... });
  if (!res.ok) throw new Error("Failed to log workout");
  const data = await res.json();
} catch (err) {
  setError("Something went wrong. Please try again.");
}
```

## API Design Conventions

- **Base path**: All backend routes under `/api/v1/`
- **Methods**: `POST /api/v1/workouts` to create, `GET /api/v1/workouts` to list
- **Request bodies**: Always JSON, validated by Pydantic models
- **Response envelope**:
  ```json
  {
    "success": true,
    "data": { ... },
    "error": null
  }
  ```
- **Status codes**: 200 success, 201 created, 400 bad request, 422 validation error, 502 upstream AI failure
- **CORS**: Configure FastAPI CORS middleware to allow the Next.js dev origin (`http://localhost:3000`)

## Testing Strategy

### Backend
- Use `pytest` + `pytest-asyncio` for async FastAPI tests.
- Use `httpx.AsyncClient` with FastAPI's `TestClient` for endpoint tests.
- Mock OpenAI API calls in tests — never make real API calls in CI.
- Test the Pydantic models independently to ensure schema validation catches bad data.

```bash
# Run backend tests
cd backend
pytest -v
```

### Frontend
- Use Jest + React Testing Library for component tests.
- Test the voice input → text → API call flow with mocked fetch.

```bash
# Run frontend tests
cd frontend
npm test
```


## Common Pitfalls to Avoid

1. **Prisma Python vs Prisma JS** — This project uses `prisma-client-py` (Python), NOT the Node.js Prisma client for the backend. The schema file is shared, but the client generation is different. Use `prisma py generate` for Python.
2. **Web Speech API browser support** — Only works in Chromium-based browsers. Always show a fallback text input.
3. **OpenAI structured output** — Use `output_type=MyPydanticModel` in the Agent definition. Don't try to JSON-parse raw `chat.completions` responses manually.
4. **Supabase connection pooling** — Use the **connection pooler** URL (port 6543) for Prisma, not the direct Postgres URL (port 5432), to avoid connection limit issues.
5. **CORS errors** — If the frontend can't reach the backend, check that FastAPI CORS middleware includes `http://localhost:3000` in `allow_origins`.
6. **Async everywhere** — FastAPI routes and Prisma queries are all async. Don't mix sync and async calls.

## When Adding New Features

Follow this checklist for every new feature:

1. Define the Pydantic model(s) for request/response
2. Update `schema` if new DB fields are needed → run the commands
3. Create the route in `backend/app/routes/`
4. Create or update the agent in `backend/app/agents/` if AI is involved
5. Add the frontend component/page in `frontend/app/`
6. Add API client function in `frontend/lib/`
7. Write at least one test for the happy path
8. Update this CLAUDE.md if the feature changes architecture or conventions
