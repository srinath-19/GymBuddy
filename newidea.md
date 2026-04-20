# GymBuddy System Reference and Audit

Validated on `2026-04-19`.

This document describes the repository as it exists today. It replaces the older feature-spec style `newidea.md` and should be treated as the current high-level reference for architecture, flows, agents, tools, and known issues.

## Project Overview

GymBuddy is a voice-first workout application with three user-facing product surfaces:

- `Workouts` on `/`: workout logging, history, manual CRUD, and day/session tracking.
- `Coach` on `/coach`: exercise guidance, image-based equipment help, and tutorial video lookup.
- `Pacer` on `/pacer`: real-time guided workout sessions with set tracking, plan editing, and rest cues.

The codebase is split into a Next.js frontend and a FastAPI backend:

| Layer | Current implementation | Notes |
| --- | --- | --- |
| Frontend | Next.js 16, React 19, TypeScript | App Router, inline styles, Supabase browser/server clients |
| Backend | FastAPI on Python 3.12 | Routes in `backend/app/routes`, app setup in `backend/app/main.py` |
| Agent framework | `openai-agents` | One classifier plus three specialist agents |
| Database | Supabase Postgres via SQLAlchemy asyncio and `asyncpg` | Raw SQL only, no ORM models |
| Auth | Supabase Auth + backend JWT verification via JWKS | Frontend sends bearer token to backend |
| Cache | Upstash Redis REST client | Optional; app still runs when cache is unavailable |
| External APIs | OpenAI APIs, YouTube Data API v3 | Coach uses YouTube; muscle inference uses OpenAI |

### Repo map

| Path | Role |
| --- | --- |
| `frontend/app` | Pages and route handlers |
| `frontend/components` | Shared UI widgets |
| `frontend/lib` | Typed API clients and Supabase client helpers |
| `backend/app/agents` | Classifier, workout parser, coach, and pacer agents |
| `backend/app/routes` | FastAPI HTTP entrypoints |
| `backend/app/models` | Pydantic request/response and pacer state models |
| `backend/app/db` | SQLAlchemy engine/session and raw SQL query functions |
| `backend/app/services` | Conversation store, pacer session store, YouTube lookup |
| `backend/app/data` | Session muscle map and AI muscle inference |
| `backend/app/cache` | Optional Redis cache wrapper |
| `tests` and `backend/tests` | Python tests |

### Current architecture at a glance

- The app is not a single-entrypoint AI system.
- The `Workouts` page talks directly to workout routes such as `POST /api/v1/workouts`.
- The `Coach` and `Pacer` pages currently use the unified `POST /api/v1/chat` route.
- The backend also exposes direct coach and direct pacer routes that bypass the orchestrator in some cases.
- Structured state lives in three places:
  - Postgres for workouts, muscle targets, and declared sessions
  - Redis for optional short-lived caches
  - In-process memory for coach conversations and pacer sessions

## System Flows

### 1. Auth and request ownership

Primary files: `frontend/app/login/page.tsx`, `frontend/app/auth/callback/route.ts`, `frontend/proxy.ts`, `backend/app/auth/dependencies.py`

1. The user signs in with Google from `/login` via Supabase OAuth.
2. `/auth/callback` exchanges the OAuth code for a Supabase session and redirects to `/`.
3. `frontend/proxy.ts` runs on most routes and checks `supabase.auth.getClaims()` server-side.
4. Protected frontend API calls read the current access token from Supabase and send it as `Authorization: Bearer ...`.
5. The backend validates that token in `get_current_user()` using the configured Supabase JWKS URL.

### 2. Workout logging and editing flow on `/`

Primary files: `frontend/app/page.tsx`, `frontend/lib/api.ts`, `backend/app/routes/workouts.py`, `backend/app/agents/workout_parser.py`

1. `HomePage` checks auth and loads stale data from `sessionStorage` immediately if available.
2. The page then refreshes workouts and sessions from `GET /api/v1/workouts` and `GET /api/v1/sessions`.
3. Voice/text input uses `VoiceInput` and calls `logWorkout()` in `frontend/lib/api.ts`.
4. `logWorkout()` posts to `POST /api/v1/workouts`, which runs `run_agent()` in `workout_parser.py`.
5. The workout parser agent decides which function tool to call.
6. Tool side effects are written into `GymContext`; the route reads that context and builds `AgentActionResponse`.
7. Manual add, update, delete, and session changes do not use the agent:
   - `POST /api/v1/workouts/manual`
   - `PUT /api/v1/workouts/{id}`
   - `DELETE /api/v1/workouts/{id}`
   - `PUT /api/v1/sessions/{date}`
8. The page performs optimistic UI updates for several CRUD paths, then reloads workouts/sessions from the backend.

### 3. Unified `/api/v1/chat` orchestrator flow

Primary files: `frontend/lib/chat-api.ts`, `backend/app/routes/chat.py`, `backend/app/agents/orchestrator.py`

1. `CoachPage` and `PacerPage` call `sendChat()` with `text`, optional `image_base64`, and optional conversation IDs.
2. `POST /api/v1/chat` applies a simple per-user rate limit of 20 requests per 60 seconds.
3. `run_orchestrator()` calls the `IntentClassifier` to pick one of `workout`, `coach`, or `pacer`.
4. If `pacer_conversation_id` is present and the classifier picked `workout`, the orchestrator force-overrides to `pacer`.
5. Dispatch then goes to one of:
   - `run_agent()` for workout requests
   - `_run_coach()` for coach requests
   - `run_pacer()` for pacer requests
6. The route wraps the result in the common `{success, data, error}` envelope and returns a `ChatResponse`.

### 4. Coach flow

Primary files: `frontend/app/coach/page.tsx`, `backend/app/agents/exercise_coach.py`, `backend/app/services/conversation.py`, `backend/app/services/youtube.py`

1. The coach page accepts text, uploaded files, or live camera capture.
2. Images are resized to base64 JPEG in the browser and sent as `image_base64`.
3. The page currently uses `POST /api/v1/chat`, not `POST /api/v1/coach/ask`.
4. The classifier routes any message with an image to the coach agent.
5. `_run_coach()` loads or creates an in-memory conversation entry from `services/conversation.py`.
6. The coach agent receives either plain text or multimodal message parts (`input_image` plus `input_text`).
7. The coach agent can call:
   - `search_youtube()` to fetch structured tutorial videos
   - built-in `WebSearchTool()` for broader web search
8. The final `ExerciseCoachResponse` is stored back into conversation history as a short assistant message.
9. The UI renders instructions, muscles, tips, common mistakes, and embedded YouTube videos.
10. The coach page also supports a shortcut where the user says "log this" and the page converts the latest coach exercise into a direct workout log request.

### 5. Pacer flow

Primary files: `frontend/app/pacer/page.tsx`, `frontend/components/WorkoutPacer.tsx`, `backend/app/agents/workout_pacer.py`, `backend/app/services/pacer_session.py`, `backend/app/routes/pacer.py`

1. The pacer page sends chat input such as "start my push workout" to `POST /api/v1/chat`.
2. `run_pacer()` loads or creates an in-memory pacer session from `services/pacer_session.py`.
3. The pacer agent sees prior history plus current text and can plan or update the workout.
4. Pacer function tools mutate `PacerSessionState`; some tools also write workouts to Postgres.
5. `build_pacer_api_response()` returns:
   - `phase`
   - current exercise and set number
   - rest countdown
   - completed plan state
   - last workout logged this turn
6. The page renders `WorkoutPacer`, which also exposes direct action buttons.
7. Manual actions do not go through the LLM. They hit direct REST endpoints:
   - `POST /api/v1/pacer/{conv_id}/set-done`
   - `POST /api/v1/pacer/{conv_id}/skip`
   - `POST /api/v1/pacer/{conv_id}/plan`
8. The pacer page uses the latest `phase` and `rest_seconds` to trigger speech synthesis and auto-start voice recognition after rest.

### 6. Data persistence and cache flow

Primary files: `backend/app/db/database.py`, `backend/app/db/queries.py`, `backend/app/cache/redis_client.py`, `backend/app/data/muscle_ai.py`

1. FastAPI startup calls `create_tables()` to ensure the required Postgres tables exist.
2. Insert/update/delete work happens through raw SQL query helpers in `backend/app/db/queries.py`.
3. Muscle targeting is inferred by `infer_muscles()` in `backend/app/data/muscle_ai.py`.
4. Optional Redis caches hold:
   - recent workouts per user
   - recent sessions per user
   - PR lookup per user and exercise
5. Workout creation usually follows this order:
   - insert workout row
   - compute PR flag
   - infer muscles
   - insert `workout_muscle_targets`
   - invalidate or repopulate caches

## Agent Inventory

| Agent | File | Model | Output type | Context/state | Tools | Routing role |
| --- | --- | --- | --- | --- | --- | --- |
| `IntentClassifier` | `backend/app/agents/orchestrator.py` | `gpt-4o-mini` | `IntentResult` | none | none | Chooses `workout`, `coach`, or `pacer` for `/api/v1/chat` |
| `GymBuddy` workout parser | `backend/app/agents/workout_parser.py` | `gpt-4o-mini` | none declared; final output is free-text | `GymContext` dataclass per request | 11 `function_tool`s | Handles workout logging, lookup, session assignment, deletion, updates, and PR lookup |
| `Exercise Coach` | `backend/app/agents/exercise_coach.py` | `gpt-4o` | `ExerciseCoachResponse` | in-memory coach conversation history from `services/conversation.py` | `search_youtube` plus built-in `WebSearchTool()` | Handles form/technique questions, equipment identification, and video lookup |
| `Workout Pacer` | `backend/app/agents/workout_pacer.py` | `gpt-4o` | `PacerAgentOutput` | `PacerContext` plus persisted `PacerSessionState` from `services/pacer_session.py` | 6 `function_tool`s | Handles live workout planning, set logging, plan edits, progress checks, and end-session flow |

### Agent notes

#### `IntentClassifier`

- This is a small routing-only agent with no tools.
- If the incoming request contains an image, it always chooses `coach`.
- It does not know about current pacer state; the pacer override is applied in the orchestrator after classification.

#### `GymBuddy` workout parser

- `run_agent()` prepends `[Today is YYYY-MM-DD]` to the transcript before calling the agent.
- The agent does not return structured workout data directly.
- Structured results are carried out-of-band through `GymContext` fields such as `action`, `logged_workout`, `found_workouts`, `deleted_workouts`, and `session`.

#### `Exercise Coach`

- The agent is stateless at import time; conversation continuity is provided by the in-memory conversation store.
- The instructions strongly bias the model toward short, gym-friendly answers with structured steps and optional videos.

#### `Workout Pacer`

- The pacer stores full per-session state in `PacerSessionState`.
- Tools return machine-readable tags such as `[PHASE:resting]` and `[CURRENT_SET:2]`; the agent is instructed to copy those tags into structured output fields.
- Direct pacer REST endpoints reuse the same core helper logic but skip the LLM.

## Tool Catalog

### Tool types used in this repo

| Tool type | Meaning in GymBuddy |
| --- | --- |
| `function_tool` | A Python function exposed directly to an agent through the Agents SDK |
| built-in `WebSearchTool` | OpenAI-provided search tool available to the coach agent |
| no-tool classifier | Agent that only returns structured classification output |
| direct backend helper | Internal business logic used by REST routes without an LLM turn |

### Workout parser agent tools

Agent file: `backend/app/agents/workout_parser.py`

| Tool | Type | Main job | Typical trigger | Side effects and touched code |
| --- | --- | --- | --- | --- |
| `log_workout` | `function_tool` | Log one workout entry | "bench press 3x10 at 135", "yesterday I did squats" | Writes `workout_logs`; checks PR; calls `infer_muscles()`; writes `workout_muscle_targets`; invalidates PR cache; sets `GymContext.action="logged"` and `logged_workout` |
| `get_last_workout` | `function_tool` | Read the most recent workout | "delete my last workout", "fix my last log" | Reads cached workouts or DB; no DB writes; usually a prerequisite for update/delete tools |
| `delete_workout` | `function_tool` | Delete one workout by UUID | After `get_last_workout` returns an ID | Deletes one `workout_logs` row; sets `action="deleted"` and `deleted_workouts` |
| `update_workout_tool` | `function_tool` | Partial update of an existing workout | "change my last workout to 4 sets", "my squat was actually 185" | Updates `workout_logs`; sets `action="updated"` and `logged_workout`; does not rebuild muscle targets or invalidate PR cache |
| `search_workouts_tool` | `function_tool` | Search workout history by exercise | "show my squat history" | Reads DB search results; sets `action="found"` and `found_workouts` |
| `start_workout_session` | `function_tool` | Create or update session type for a date | "today is push day", "set Monday as legs" | Upserts `workout_sessions`; sets `action="session_started"` and `session` |
| `get_session_for_date_tool` | `function_tool` | Read declared session for one date | "what was my session on Monday?" | Reads session cache or DB; sets `action="found"` and `session` when found |
| `get_today_workouts` | `function_tool` | Return workouts for a date plus session context and muscle coverage hints | "what did I do today?", "did I hit every muscle group?" | Reads workout/session cache or DB; sets `action="found"`, `found_workouts`, and `session` |
| `delete_exercise_today` | `function_tool` | Delete all matching exercise logs for a date | "delete bench from today", "remove my squats" | Bulk-deletes `workout_logs`; sets `action="deleted"` and `deleted_workouts`; does not invalidate PR cache |
| `get_workouts_for_date` | `function_tool` | List workouts for a date with IDs | "show yesterday's workout", "what did I do on Monday?" | Reads cache or DB; sets `action="found"` and `found_workouts` |
| `get_pr_for_exercise` | `function_tool` | Return all-time highest weight entry for one exercise | "what is my PR on bench?" | Reads PR cache or DB; caches result; sets `action="found"` and `found_workouts` |

### Exercise coach agent tools

Agent file: `backend/app/agents/exercise_coach.py`

| Tool | Type | Main job | Typical trigger | Side effects and touched code |
| --- | --- | --- | --- | --- |
| `search_youtube` | `function_tool` | Return top YouTube tutorial videos for a query | Coach needs a demo video or user asks to "show me" | Calls `search_youtube_api()` in `backend/app/services/youtube.py`; uses `YOUTUBE_API_KEY`; no DB writes |
| `WebSearchTool()` | built-in tool | General web search fallback | Coach wants broader web search support | External search only; no DB writes or local state updates |

### Workout pacer agent tools

Agent file: `backend/app/agents/workout_pacer.py`

| Tool | Type | Main job | Typical trigger | Side effects and touched code |
| --- | --- | --- | --- | --- |
| `suggest_exercises` | `function_tool` | Build a plan from a session type | "start my push workout", "what should I do for legs?" | Reads `get_expected_muscles()`; populates `PacerSessionState.plan`, `exercise_progress`, and `session_type`; no DB write |
| `mark_set_done` | `function_tool` | Record a completed set, optionally finalize an exercise | "done", "done 10 at 155" | Appends `CompletedSet`; may call `_finalize_exercise()` which inserts workout rows, checks PR, infers muscles, inserts targets, and invalidates user caches |
| `get_session_progress` | `function_tool` | Summarize completed, current, and pending exercises | "what have I done?", "what's next?" | Read-only view over `PacerSessionState`; no DB write |
| `skip_exercise` | `function_tool` | Skip current exercise or finalize partially done exercise before advancing | "skip", "next exercise" | May call `_finalize_exercise()` if sets were already done; otherwise only mutates in-memory pacer state |
| `end_session` | `function_tool` | End the workout and finalize any partial exercises with completed sets | "end session", "wrap it up" | Iterates pacer state; may write multiple workout rows via `_finalize_exercise()` |
| `modify_plan` | `function_tool` | Remove, add, swap, or change planned exercises | "remove flyes", "swap incline for dumbbell press", "make bench 4x8" | Mutates only in-memory `PacerSessionState` |

### Direct backend helpers and non-LLM tools

These are not directly exposed to a model, but they matter because they implement behavior that users can trigger through HTTP routes.

| Helper | Used by | Type | Job |
| --- | --- | --- | --- |
| `_classify` | `run_orchestrator()` | no-tool classifier wrapper | Executes the `IntentClassifier` |
| `_run_coach` | orchestrator | direct dispatcher | Reuses coach conversation logic and `exercise_coach` execution for `/api/v1/chat` |
| `_finalize_exercise` | pacer tools and pacer helpers | direct business logic | Converts completed pacer exercise progress into one persisted workout log |
| `_mark_set_done_impl` | pacer tools and `routes/pacer.py` | direct business logic | Core set-completion state machine, with optional DB finalize |
| `_skip_exercise_impl` | pacer tools and `routes/pacer.py` | direct business logic | Core skip/advance state machine |
| `_modify_plan_impl` | pacer tools and `routes/pacer.py` | direct business logic | Core plan-editing logic |
| `build_pacer_api_response` | orchestrator path | response builder | Merges `PacerAgentOutput` and persisted pacer state into `PacerAPIResponse` |
| `build_direct_pacer_response` | direct pacer routes | response builder | Builds `PacerAPIResponse` without an LLM turn |

## Backend Reference

### HTTP routes

| Method | Path | Purpose | Entrypoint |
| --- | --- | --- | --- |
| `GET` | `/health` | Basic health check | `backend/app/main.py` |
| `POST` | `/api/v1/workouts/manual` | Manual workout create | `routes/workouts.py:create_workout_manual` |
| `POST` | `/api/v1/workouts` | Agent-driven workout/session/history action | `routes/workouts.py:create_workout` |
| `GET` | `/api/v1/workouts` | Recent workout list | `routes/workouts.py:list_workouts` |
| `PUT` | `/api/v1/workouts/{workout_id}` | Direct workout update | `routes/workouts.py:edit_workout` |
| `DELETE` | `/api/v1/workouts/{workout_id}` | Direct workout delete | `routes/workouts.py:remove_workout` |
| `GET` | `/api/v1/sessions` | Recent session list | `routes/workouts.py:list_sessions` |
| `PUT` | `/api/v1/sessions/{date_str}` | Upsert session type for one date | `routes/workouts.py:update_session` |
| `POST` | `/api/v1/chat` | Orchestrated chat entrypoint | `routes/chat.py:chat` |
| `POST` | `/api/v1/coach/ask` | Direct coach entrypoint | `routes/coach.py:coach_ask` |
| `DELETE` | `/api/v1/coach/conversation/{conversation_id}` | Delete coach conversation from memory | `routes/coach.py:coach_clear_conversation` |
| `POST` | `/api/v1/pacer/{conv_id}/set-done` | Direct pacer set completion | `routes/pacer.py:pacer_set_done` |
| `POST` | `/api/v1/pacer/{conv_id}/skip` | Direct pacer skip action | `routes/pacer.py:pacer_skip` |
| `POST` | `/api/v1/pacer/{conv_id}/plan` | Direct pacer plan edit | `routes/pacer.py:pacer_modify_plan` |

All routes except `/health` are protected by Supabase bearer-token authentication.

### Core model files

| File | Key types |
| --- | --- |
| `backend/app/models/workout.py` | `WorkoutLog`, `WorkoutLogResponse`, `WorkoutSession`, `AgentActionResponse`, `APIResponse`, direct workout/session request models |
| `backend/app/models/chat.py` | `ChatRequest`, `ChatResponse` |
| `backend/app/models/coach.py` | `CoachRequest`, `VideoResult`, `ExerciseCoachResponse`, `CoachAPIResponse` |
| `backend/app/models/pacer.py` | `PacerSessionState`, `ExerciseProgress`, `PacerAgentOutput`, `PacerAPIResponse`, plan/set request models |

Non-Pydantic per-request state objects:

- `GymContext` in `backend/app/agents/workout_parser.py`
- `PacerContext` in `backend/app/models/pacer.py`

### Database tables

Schema is created in `backend/app/db/database.py:create_tables()`.

| Table | Purpose |
| --- | --- |
| `workout_logs` | Core workout entries: exercise, sets, reps, weight, notes, timestamps, user ID |
| `workout_muscle_targets` | Per-workout muscle breakdown, including primary/secondary role and source |
| `workout_sessions` | One declared session type per user per date |

Important implementation details:

- SQLAlchemy is used only for engine/session management.
- All query logic is raw SQL in `backend/app/db/queries.py`.
- There is no migration framework in the repo.
- `create_tables()` handles only the currently known tables/columns.

### Query layer

Key query functions in `backend/app/db/queries.py`:

- `insert_workout()`
- `check_personal_record()`
- `insert_muscle_targets()`
- `fetch_workouts()`
- `search_workouts()`
- `update_workout()`
- `delete_workout_by_id()`
- `upsert_session()`
- `get_session_for_date()`
- `get_exercise_pr()`
- `get_sessions()`
- `fetch_workouts_by_date()`
- `delete_workouts_by_exercise_date()`

### Cache layer

Optional cache wrapper: `backend/app/cache/redis_client.py`

| Cache key | TTL | Purpose |
| --- | --- | --- |
| `gymbuddy:workouts:{user_id}` | 60 seconds | Cached recent workout list |
| `gymbuddy:sessions:{user_id}` | 600 seconds | Cached recent session list |
| `gymbuddy:pr:{user_id}:{exercise}` | 600 seconds | Cached PR lookup for an exercise |

Notes:

- Cache is optional. Missing Upstash env vars disable it quietly.
- Cache usage is best-effort; failures log warnings and fall back to DB.

### In-memory state stores

Coach conversation store: `backend/app/services/conversation.py`

- Keyed by `conversation_id`
- Stores history, `last_active`, and `turn_count`
- TTL: 10 minutes
- Turn limit: 6

Pacer session store: `backend/app/services/pacer_session.py`

- Keyed by `session_id`
- Stores history, `last_active`, `turn_count`, and `PacerSessionState`
- TTL: 2 hours
- Turn limit: 50

### Service modules

| File | Responsibility |
| --- | --- |
| `backend/app/services/conversation.py` | In-memory coach history and TTL sweep |
| `backend/app/services/pacer_session.py` | In-memory pacer session state and TTL sweep |
| `backend/app/services/youtube.py` | Async wrapper around YouTube Data API search |
| `backend/app/data/muscle_ai.py` | AI-based muscle inference with per-exercise in-process cache |
| `backend/app/data/session_muscles.py` | Static session-type to muscle-group map |

### Environment variables and deployment assumptions

Backend:

```text
DATABASE_URL
SUPABASE_JWKS_URL
OPENAI_API_KEY
YOUTUBE_API_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Frontend:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_API_URL
```

Important assumptions in the current code:

- `backend/app/main.py` allows CORS only from `http://localhost:3000`.
- The in-memory coach and pacer stores assume a single-process deployment if conversation continuity matters.
- The DB connection setup assumes a Supabase/PgBouncer-friendly async connection string.
- The frontend supports both `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## Frontend Reference

### Page-level responsibilities

| File | Route | Responsibility |
| --- | --- | --- |
| `frontend/app/page.tsx` | `/` | Workout history, voice logging, manual CRUD, session editing, week grouping |
| `frontend/app/coach/page.tsx` | `/coach` | Coach chat thread, image upload/camera capture, "log this" shortcut |
| `frontend/app/pacer/page.tsx` | `/pacer` | Pacer chat thread, rest timer, auto-listen, direct pacer actions |
| `frontend/app/login/page.tsx` | `/login` | Google OAuth entry |
| `frontend/app/auth/callback/route.ts` | `/auth/callback` | OAuth code exchange and redirect |
| `frontend/app/layout.tsx` | all pages | Root layout plus top nav |
| `frontend/proxy.ts` | route middleware | Auth gate and session cookie propagation |

### Shared components

| File | Responsibility |
| --- | --- |
| `frontend/components/VoiceInput.tsx` | Web Speech API wrapper plus text fallback |
| `frontend/components/CoachResponse.tsx` | Coach response rendering with muscles, steps, videos, and log button |
| `frontend/components/WorkoutPacer.tsx` | Pacer plan/progress UI and manual action emitters |
| `frontend/components/CameraCapture.tsx` | Live camera modal and still capture |
| `frontend/components/YouTubeEmbed.tsx` | Inline YouTube iframe |
| `frontend/components/NavBar.tsx` | Top navigation |
| `frontend/components/ExerciseCoach.tsx` | Alternate standalone coach UI component; appears separate from current page flow |

### API client modules

| File | Responsibility |
| --- | --- |
| `frontend/lib/api.ts` | Direct workout/session REST calls and shared workout/session types |
| `frontend/lib/chat-api.ts` | Unified `/api/v1/chat` request/response types |
| `frontend/lib/coach-api.ts` | Direct coach REST client and image resize helper |
| `frontend/lib/pacer-api.ts` | Direct pacer REST client and typed manual action definitions |
| `frontend/lib/supabase/client.ts` | Browser Supabase client creation |

### Frontend state ownership

- `HomePage` owns workout/session lists, optimistic CRUD, last action card, and session editing state.
- `HomePage` also uses `sessionStorage` as a stale-first cache before network refresh.
- `CoachPage` owns:
  - the displayed thread
  - pending image
  - local `coachConvId`
  - log modal state
- `CoachPage` currently uses `sendChat()`, not `askCoach()`.
- `PacerPage` owns:
  - the displayed thread
  - `pacerConvId`
  - latest `phase`
  - latest `rest_seconds`
- `WorkoutPacer` does not call the backend directly; it emits typed manual actions back to `PacerPage`.
- `VoiceInput` owns the browser speech-recognition instance and exposes `startListening()` through a ref for pacer auto-listen.

### Important current frontend/backend coupling

- The `Workouts` page bypasses the orchestrator and talks directly to workout routes.
- The `Coach` and `Pacer` pages depend on the orchestrator returning the expected agent type.
- Direct pacer buttons call pacer routes without an LLM turn.
- The direct coach route exists, but the active `/coach` page does not use it.

## Validation Snapshot

The following checks were run against the current repo state on `2026-04-19`:

| Check | Result | Notes |
| --- | --- | --- |
| `uv run pytest -q` | Failed | Import error: `tests/test_new_models_and_lookup.py` imports missing `backend.app.data.muscle_lookup` |
| `uv run pytest backend/tests/test_new_agents.py -q` | Passed | `56 passed`, plus 4 deprecation warnings from test code using `datetime.utcnow()` |
| `cmd /c npm run type-check` in `frontend/` | Passed | `tsc --noEmit` completed successfully |
| `cmd /c npm run build` in `frontend/` | Failed | Next/Turbopack inferred root as `C:\Users\srina` and failed with access denied while reading that directory |

## Code Review / Improvement Audit

Legend:

- `Verified`: backed by an executed check in this repo during the validation snapshot above.
- `Observed by inspection`: derived from current source code, not from a dedicated runtime repro.

### Critical

1. `[Critical][Verified]` The full Python test suite currently does not collect because `tests/test_new_models_and_lookup.py` imports `backend.app.data.muscle_lookup`, but that module is not present in the repo. Recommendation: either restore the missing lookup module or rewrite/remove the stale test file so the default test command is meaningful again.

2. `[Critical][Observed by inspection]` Coach and pacer in-memory state is keyed only by opaque IDs, and direct routes accept those IDs without proving ownership. In practice, possession of a valid `conversation_id` or `conv_id` appears sufficient to continue or delete another user's in-memory state. Recommendation: bind in-memory entries to `user_id` and verify ownership on every read/write/delete path.

3. `[Critical][Observed by inspection]` The coach and pacer stores are explicitly single-process assumptions. Under multiple workers or multiple containers, follow-up turns can land on a different process and lose state. Recommendation: move conversation/session state into a shared store such as Redis or Postgres if multi-instance deployment is required.

### High

4. `[High][Verified]` Frontend production build is currently broken in this environment because Turbopack infers the wrong workspace root and walks into `C:\Users\srina`, which raises access denied. `frontend/next.config.ts` is effectively empty and does not pin `turbopack.root`. Recommendation: set an explicit Turbopack root and confirm `next build` from `frontend/` succeeds in CI.

5. `[High][Observed by inspection]` Cache invalidation and cache read scopes are inconsistent. Examples:
   - `update_workout_tool()` updates the workout row but does not rebuild muscle targets or invalidate PR cache.
   - `delete_exercise_today()` bulk-deletes workouts but does not invalidate PR cache.
   - `GET /api/v1/workouts` and `GET /api/v1/sessions` can return cached data that ignores request-specific `limit` and `days` values because the cache is populated with fixed sizes. Recommendation: make cache keys parameter-aware or stop using shared caches for parameterized list endpoints.

6. `[High][Observed by inspection]` Direct pacer REST actions bypass `append_turn()`. That means manual set/skip/plan actions do not extend pacer conversation history and do not increment turn counts consistently; the returned `turn_number` can repeat across multiple direct actions. Recommendation: decide whether direct actions should be first-class conversation turns and keep history/turn accounting consistent either way.

7. `[High][Observed by inspection]` The current pacer route helper `_get_context()` checks only whether a session ID exists, not whether the current authenticated user owns that session. Recommendation: include user ownership in pacer session entries and reject cross-user access.

### Medium

8. `[Medium][Verified]` The previous `newidea.md` and current `CLAUDE.md` are no longer accurate descriptions of the system. Examples include references to `data/muscle_lookup.py`, outdated tool counts, and older architecture assumptions. Recommendation: treat this rewritten `newidea.md` as the new high-level reference and either update `CLAUDE.md` or clearly mark it as stale.

9. `[Medium][Observed by inspection]` Widespread mojibake/encoding corruption appears in prompts, docs, and UI strings, for example `Ã—`, `â†’`, `âœ•`, and `â€¦`. This affects readability and user-facing polish. Recommendation: do a repo-wide encoding cleanup with explicit UTF-8 handling and regression checks on prompts and UI copy.

10. `[Medium][Observed by inspection]` Page-level assumptions about returned agent type are brittle:
    - `frontend/app/coach/page.tsx` remaps `pacer` replies to `coach` and drops pacer structured data.
    - `frontend/app/pacer/page.tsx` falls back to plain text for non-pacer replies but has no structured workout/coach rendering. Recommendation: either hard-route each page to its intended backend path or render all possible `ChatResponse` variants explicitly.

11. `[Medium][Observed by inspection]` Clearing local UI does not always clear server-side state:
    - `CoachPage` local clear resets the thread and conversation ID but does not call `/api/v1/coach/conversation/{id}`.
    - `PacerPage` clear drops the local session ID but there is no pacer delete route. Recommendation: either accept TTL-based cleanup explicitly or provide and use server-side clear endpoints.

12. `[Medium][Observed by inspection]` `frontend/components/ExerciseCoach.tsx` appears to be a second coach UI path that is separate from the active `/coach` page flow. Recommendation: remove dead UI surface or wire it intentionally so the repo has one clear coach entrypoint.

13. `[Medium][Observed by inspection]` `PacerSessionState.all_done` is not referenced elsewhere, and its logic would report `true` even when all exercises are merely untouched (`sets_done == 0`). It is harmless today because it appears unused, but it is risky if later adopted. Recommendation: either remove the property or redefine it before any production use.

### Low

14. `[Low][Observed by inspection]` `backend/app/main.py` hardcodes CORS to `http://localhost:3000`. That is convenient for local development but not enough for multi-environment deployment. Recommendation: move allowed origins to configuration.

15. `[Low][Verified]` The focused backend agent test file passes, but it emits deprecation warnings because the tests use `datetime.utcnow()`. Recommendation: replace test-side `utcnow()` calls with timezone-aware UTC datetimes to keep the suite clean on newer Python versions.

## Bottom Line

The current GymBuddy repo already has a real product shape:

- a workout logging/history surface,
- a coach surface,
- a pacer surface,
- a classifier-backed chat orchestrator,
- Postgres persistence,
- optional Redis caching,
- Supabase auth,
- and structured agent tool usage.

The biggest issues are not missing architecture. They are correctness and operational maturity:

- stale tests/docs,
- insecure or fragile in-memory state handling,
- inconsistent cache and pacer history behavior,
- and a currently broken frontend production build configuration.

If someone asks what this project is today, the most accurate short answer is:

> GymBuddy is a multi-surface gym assistant with one direct workout agent path, one orchestrated chat path, a vision-enabled coach, and a stateful workout pacer, all built on FastAPI, Next.js, Supabase auth, Postgres, and the OpenAI Agents SDK.
