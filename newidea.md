# GymBuddy System Reference

Validated on `2026-04-20`.

This is the current project reference for GymBuddy. It is written from the live codebase, not from older design notes.

## Presentation Summary

If you need the shortest correct way to describe the project:

- GymBuddy is a voice-first gym app with three product surfaces: `Workouts`, `Coach`, and `Pacer`.
- The frontend is `Next.js 16 + React 19 + TypeScript`.
- The backend is `FastAPI + Python 3.12`.
- Auth is `Supabase Auth`, verified again on the backend with Supabase JWKS.
- Data persistence is `Supabase Postgres` through SQLAlchemy async sessions and raw SQL query functions.
- Short-lived caches use `Upstash Redis` when configured.
- AI behavior is built with the `openai-agents` SDK:
  - one classifier agent,
  - one workout parser agent,
  - one exercise coach agent,
  - one workout pacer agent.
- Voice comes in through the browser SpeechRecognition APIs and goes back out through OpenAI TTS or browser speech fallback.

## What You Built

GymBuddy is not one monolithic AI endpoint. It is three user experiences sharing auth, storage, and some AI infrastructure:

| Surface | Route | What it does | Main backend path |
| --- | --- | --- | --- |
| Workouts | `/` | Log workouts, edit/delete history, manage day/session labels, review recent workouts | Direct workout routes |
| Coach | `/coach` | Ask form questions, identify equipment from images, get exercise instructions and videos | Unified `/api/v1/chat` orchestrator |
| Pacer | `/pacer` | Run a guided workout session, track sets, rest, plan changes, and final logging | Unified `/api/v1/chat` plus direct pacer action routes |

## Architecture Overview

| Layer | Current implementation | Notes |
| --- | --- | --- |
| Frontend | Next.js 16, React 19, TypeScript | App Router, inline styles, runtime env injection, Supabase browser/server clients |
| Backend | FastAPI | Routes in `backend/app/routes`, app setup in `backend/app/main.py` |
| Agent framework | `openai-agents` | 1 classifier + 3 specialist agents |
| Database | Supabase Postgres | SQLAlchemy manages sessions and engine; query logic is raw SQL |
| Cache | Upstash Redis REST client | Optional; the app still works without it |
| Auth | Supabase Auth + backend JWT verification | Frontend sends bearer token to backend |
| External APIs | OpenAI APIs, YouTube Data API v3 | Coach uses YouTube; muscle inference uses OpenAI |

### Repo map

| Path | Role |
| --- | --- |
| `frontend/app` | Pages and route handlers |
| `frontend/components` | UI building blocks |
| `frontend/lib` | Typed API clients, runtime env helpers, TTS, wake word, Supabase client |
| `backend/app/agents` | Classifier, workout parser, coach, pacer |
| `backend/app/routes` | FastAPI entrypoints |
| `backend/app/models` | Pydantic request/response models and pacer state models |
| `backend/app/db` | Engine/session setup and raw SQL query functions |
| `backend/app/services` | In-memory conversation/session stores and YouTube integration |
| `backend/app/data` | Session-to-muscle map and AI muscle inference |
| `backend/app/cache` | Redis cache wrapper |
| `tests` and `backend/tests` | Python tests |

## End-to-End Dataflow

### 1. Auth flow

Primary files: `frontend/app/login/page.tsx`, `frontend/app/auth/callback/route.ts`, `frontend/proxy.ts`, `backend/app/auth/dependencies.py`

1. The user signs in with Google from `/login` using Supabase OAuth.
2. `/auth/callback` exchanges the OAuth code for a Supabase session and redirects to `/`.
3. `frontend/proxy.ts` runs on most routes and checks `supabase.auth.getClaims()` server-side.
4. Frontend API clients fetch the current Supabase access token and send `Authorization: Bearer ...`.
5. The backend verifies the JWT with `PyJWKClient` against the configured Supabase JWKS URL.
6. The backend uses `payload["sub"]` as the per-user UUID for DB and cache scoping.

### 2. Workouts flow on `/`

Primary files: `frontend/app/page.tsx`, `frontend/lib/api.ts`, `backend/app/routes/workouts.py`, `backend/app/agents/workout_parser.py`

This surface bypasses the orchestrator. It talks directly to workout routes.

#### Read flow

1. `HomePage` restores stale-first data from `sessionStorage` if present:
   - `gymbuddy:workouts`
   - `gymbuddy:sessions`
2. It then refreshes from:
   - `GET /api/v1/workouts`
   - `GET /api/v1/sessions`
3. Those backend routes try Redis first and fall back to Postgres if cache is missing.
4. The page groups workouts by day in the UI and matches each day to a declared session type.

#### Voice logging flow

1. `VoiceInput` captures speech or typed text.
2. The page calls `logWorkoutStreamed()` in `frontend/lib/api.ts`.
3. That posts to `POST /api/v1/workouts/stream` with:
   - the transcript
   - `client_tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`
4. `run_agent_streamed()` starts the workout parser agent and emits NDJSON progress events when tools are called.
5. Tool side effects are written into `GymContext`.
6. The final `done` event becomes an `AgentActionResponse`.
7. The backend also attaches `tts_audio_b64` to the final result.
8. The page updates the action card, plays TTS, and then refreshes workouts and sessions.

#### Direct CRUD flow

These actions do not use the LLM:

- `POST /api/v1/workouts/manual`
- `PUT /api/v1/workouts/{id}`
- `DELETE /api/v1/workouts/{id}`
- `PUT /api/v1/sessions/{date}`

The UI applies optimistic updates for several of these paths and then reloads data from the backend.

### 3. Unified chat flow on `/coach` and `/pacer`

Primary files: `frontend/lib/chat-api.ts`, `backend/app/routes/chat.py`, `backend/app/agents/orchestrator.py`

1. `CoachPage` and `PacerPage` call `sendChat()` against `POST /api/v1/chat`.
2. The request includes:
   - `text`
   - optional `image_base64`
   - optional `coach_conversation_id`
   - optional `pacer_conversation_id`
3. `routes/chat.py` enforces a per-user in-memory rate limit of `20 requests / 60 seconds`.
4. `run_orchestrator()` calls the classifier agent.
5. The classifier returns one of:
   - `workout`
   - `coach`
   - `pacer`
6. If `pacer_conversation_id` exists and the classifier picked `workout`, the orchestrator overrides the result to `pacer` because mid-session commands like "done" and "remove bench" otherwise get misrouted.
7. Dispatch goes to:
   - `run_agent()` for workout requests
   - `_run_coach()` for coach requests
   - `run_pacer()` for pacer requests
8. The chat route chooses the assistant message to speak and attaches `tts_audio_b64` to the shared `ChatResponse`.

### 4. Coach flow

Primary files: `frontend/app/coach/page.tsx`, `backend/app/agents/exercise_coach.py`, `backend/app/services/conversation.py`, `backend/app/services/youtube.py`

1. The page accepts text, file upload, or live camera capture.
2. Images are resized client-side to base64 JPEG before sending.
3. The current `/coach` page uses `POST /api/v1/chat`, not the direct `/api/v1/coach/ask` route.
4. Any request with an image is classified as `coach`.
5. `_run_coach()` loads or creates an in-memory conversation entry.
6. The coach agent receives either:
   - plain text, or
   - multimodal content using `input_image` plus `input_text`
7. The coach agent can call:
   - `search_youtube()` for top YouTube videos
   - built-in `WebSearchTool()` for general web search
8. The structured output is `ExerciseCoachResponse`.
9. The conversation store only saves the assistant `message` text for history continuity, not the full structured response.
10. The frontend renders instructions, muscles, mistakes, difficulty, tips, and embedded videos.
11. There is also a "log this" shortcut:
    - if the last coach answer had an `exercise_name`,
    - and the user says something like "log this",
    - the page converts that into a direct workout log request.

### 5. Pacer flow

Primary files: `frontend/app/pacer/page.tsx`, `frontend/components/WorkoutPacer.tsx`, `backend/app/agents/workout_pacer.py`, `backend/app/services/pacer_session.py`, `backend/app/routes/pacer.py`

1. The user says something like "start my push workout".
2. `PacerPage` sends the text to `POST /api/v1/chat`.
3. `run_pacer()` loads or creates an in-memory pacer session.
4. The pacer agent sees prior history plus current text and can:
   - build a plan,
   - record completed sets,
   - change the plan,
   - summarize progress,
   - skip an exercise,
   - end the session.
5. Pacer tools mutate `PacerSessionState`.
6. Some pacer tools also write workouts to Postgres by calling `_finalize_exercise()`.
7. `build_pacer_api_response()` returns both:
   - the model's structured pacer output, and
   - the latest persisted state such as current plan, completed exercise count, and last logged workout.

#### Direct pacer action flow

Some pacer actions skip the LLM roundtrip:

- `POST /api/v1/pacer/{conv_id}/set-done`
- `POST /api/v1/pacer/{conv_id}/skip`
- `POST /api/v1/pacer/{conv_id}/plan`

These endpoints:

1. Load the in-memory pacer session.
2. Run direct helper logic like `_mark_set_done_impl()` or `_modify_plan_impl()`.
3. Save the updated state back to the in-memory session store.
4. Add a synthetic assistant history note via `note_manual_action()`.
5. Return `PacerAPIResponse` plus inline `tts_audio_b64`.

### 6. Persistence flow

Primary files: `backend/app/db/database.py`, `backend/app/db/queries.py`, `backend/app/cache/redis_client.py`, `backend/app/data/muscle_ai.py`

#### Workout write path

The common write order for workout creation is:

1. Insert a `workout_logs` row.
2. Check if the weight is a personal record for that exercise.
3. Infer muscle targets through `infer_muscles()`.
4. Insert rows into `workout_muscle_targets`.
5. Invalidate or repopulate relevant caches.

This happens in:

- `POST /api/v1/workouts/manual`
- workout agent tool `log_workout`
- pacer helper `_finalize_exercise()`

#### Pacer finalization details

When pacer finalizes an exercise:

- `sets` = number of completed sets
- `reps` = most common rep count across completed sets
- `weight` = highest weight across completed sets
- `notes` = per-set weight list if weights varied across sets

That means one completed pacer exercise becomes one persisted workout log row.

## Agents

| Agent | File | Model | Output type | State source | Role |
| --- | --- | --- | --- | --- | --- |
| `IntentClassifier` | `backend/app/agents/orchestrator.py` | `gpt-4o-mini` | `IntentResult` | none | Routes `/api/v1/chat` requests |
| `GymBuddy` workout parser | `backend/app/agents/workout_parser.py` | `gpt-4o-mini` | free-text final message; structured side effects via `GymContext` | per-request `GymContext` | Handles workout logging, lookup, delete, update, sessions, PR lookup |
| `Exercise Coach` | `backend/app/agents/exercise_coach.py` | `gpt-4o` | `ExerciseCoachResponse` | in-memory coach conversation history | Handles form, technique, equipment ID, and video lookup |
| `Workout Pacer` | `backend/app/agents/workout_pacer.py` | `gpt-4o` | `PacerAgentOutput` | in-memory pacer session state | Handles live guided workouts |

### Important agent behavior

#### IntentClassifier

- Small routing-only agent.
- No tools.
- Any image forces `coach`.
- Does not know pacer session state by itself.

#### GymBuddy workout parser

- Prepends `[Today is YYYY-MM-DD]` using the client timezone if provided.
- Never returns structured workout data directly.
- Structured results are carried out-of-band through `GymContext`.
- Supports streamed execution through `Runner.run_streamed()`.

#### Exercise Coach

- Uses a structured output type.
- Can search YouTube and the web.
- Optimized for short gym-friendly answers.

#### Workout Pacer

- Uses structured output fields like `phase`, `rest_seconds`, `current_exercise`, `set_number`.
- Reads machine tags from tool results such as:
  - `[PHASE:resting]`
  - `[REST:120]`
  - `[CURRENT_EXERCISE:bench press]`
  - `[CURRENT_SET:2]`
- Returns the live workout plan and progress state on every turn.

## Tool Catalog

### Tool types used in the repo

| Tool type | Meaning in GymBuddy |
| --- | --- |
| `function_tool` | Python function exposed directly to an agent |
| `WebSearchTool()` | OpenAI-provided search tool used by the coach agent |
| direct helper | Internal business logic used by routes without an LLM turn |
| no-tool classifier | Structured routing agent with no tools |

### Workout parser tools

Agent file: `backend/app/agents/workout_parser.py`

| Tool | What it does | Main read/write behavior |
| --- | --- | --- |
| `log_workout` | Logs one workout entry, optionally for a specific date | Writes `workout_logs`; checks PR; infers muscles; writes `workout_muscle_targets`; invalidates PR cache |
| `get_last_workout` | Reads the user's most recent workout | Reads workouts cache first, then DB |
| `delete_workout` | Deletes one workout by UUID | Deletes from `workout_logs`; returns deleted row in context |
| `update_workout_tool` | Partially updates an existing workout | Updates `workout_logs`; stores updated record in context |
| `search_workouts_tool` | Searches history by exercise | Reads DB search results and stores them in context |
| `start_workout_session` | Creates or updates the session type for a date | Upserts `workout_sessions` |
| `get_session_for_date_tool` | Reads the declared session for a date | Reads sessions cache first, then DB |
| `get_today_workouts` | Reads workouts for a date plus session context and muscle coverage | Uses workouts and sessions cache when possible, else DB; filters by client-local date |
| `delete_exercise_today` | Deletes all matching exercise logs for a date | Bulk-deletes rows from `workout_logs` |
| `get_workouts_for_date` | Lists workouts for a specific date with IDs | Reads cache first when possible, else DB |
| `get_pr_for_exercise` | Reads all-time PR for an exercise | Reads PR cache first, else DB and then caches |

### Coach tools

Agent file: `backend/app/agents/exercise_coach.py`

| Tool | What it does | Notes |
| --- | --- | --- |
| `search_youtube` | Returns up to 3 YouTube tutorial videos for a query | Calls `backend/app/services/youtube.py` |
| `WebSearchTool()` | General web search | Built-in OpenAI tool |

### Pacer tools

Agent file: `backend/app/agents/workout_pacer.py`

| Tool | What it does | Main read/write behavior |
| --- | --- | --- |
| `suggest_exercises` | Builds a plan from a session type | Reads static session muscle map and populates `PacerSessionState` |
| `mark_set_done` | Records one completed set | Mutates pacer state; may finalize an exercise to Postgres |
| `get_session_progress` | Summarizes current workout progress | Read-only over pacer state |
| `skip_exercise` | Skips the current exercise or finalizes a partial one first | Mutates pacer state; may write a workout |
| `end_session` | Ends the session and finalizes any partially completed exercises | May write multiple workouts |
| `modify_plan` | Removes, adds, swaps, or changes exercises in the plan | Mutates in-memory pacer state only |

### Direct helpers that matter

| Helper | Used by | What it does |
| --- | --- | --- |
| `_classify` | orchestrator | Runs the classifier agent |
| `_run_coach` | orchestrator | Reuses coach conversation logic for `/api/v1/chat` |
| `_finalize_exercise` | pacer tools and pacer routes | Converts completed pacer progress into one persisted workout row |
| `_mark_set_done_impl` | pacer tools and routes | Core set completion state machine |
| `_skip_exercise_impl` | pacer tools and routes | Core skip and advance state machine |
| `_modify_plan_impl` | pacer tools and routes | Core plan editing logic |
| `build_pacer_api_response` | orchestrator | Merges model output with current pacer state |
| `build_direct_pacer_response` | direct pacer routes | Builds pacer response without an LLM turn |

## Backend Reference

### HTTP routes

| Method | Path | Purpose | Entrypoint |
| --- | --- | --- | --- |
| `GET` | `/health` | Health check | `backend/app/main.py` |
| `POST` | `/api/v1/workouts/manual` | Manual workout create | `routes/workouts.py:create_workout_manual` |
| `POST` | `/api/v1/workouts` | Agent-driven workout action | `routes/workouts.py:create_workout` |
| `POST` | `/api/v1/workouts/stream` | Streamed workout agent action | `routes/workouts.py:create_workout_stream` |
| `GET` | `/api/v1/workouts` | Recent workout list | `routes/workouts.py:list_workouts` |
| `PUT` | `/api/v1/workouts/{workout_id}` | Direct workout update | `routes/workouts.py:edit_workout` |
| `DELETE` | `/api/v1/workouts/{workout_id}` | Direct workout delete | `routes/workouts.py:remove_workout` |
| `GET` | `/api/v1/sessions` | Recent session list | `routes/workouts.py:list_sessions` |
| `PUT` | `/api/v1/sessions/{date_str}` | Upsert session type for a date | `routes/workouts.py:update_session` |
| `POST` | `/api/v1/chat` | Orchestrated coach/pacer/workout entrypoint | `routes/chat.py:chat` |
| `POST` | `/api/v1/coach/ask` | Direct coach entrypoint | `routes/coach.py:coach_ask` |
| `DELETE` | `/api/v1/coach/conversation/{conversation_id}` | Delete coach conversation from memory | `routes/coach.py:coach_clear_conversation` |
| `POST` | `/api/v1/pacer/{conv_id}/set-done` | Direct pacer set completion | `routes/pacer.py:pacer_set_done` |
| `POST` | `/api/v1/pacer/{conv_id}/skip` | Direct pacer skip | `routes/pacer.py:pacer_skip` |
| `POST` | `/api/v1/pacer/{conv_id}/plan` | Direct pacer plan edit | `routes/pacer.py:pacer_modify_plan` |
| `POST` | `/api/v1/tts` | Stream OpenAI TTS MP3 | `routes/tts.py:text_to_speech` |

All routes except `/health` are protected by Supabase bearer-token authentication.

### Startup and app setup

Primary file: `backend/app/main.py`

- FastAPI startup calls `create_tables()`.
- CORS is configured from:
  - `CORS_ALLOWED_ORIGINS` if present,
  - else `FRONTEND_URL` if present,
  - else `http://localhost:3000`.
- Routers registered:
  - workouts
  - coach
  - chat
  - pacer
  - tts

### Database tables

Created in `backend/app/db/database.py:create_tables()`.

| Table | Purpose |
| --- | --- |
| `workout_logs` | Core workout entries: exercise, sets, reps, weight, notes, timestamps, user ID |
| `workout_muscle_targets` | Per-workout muscle breakdown with muscle group, specific muscles, role, and source |
| `workout_sessions` | One declared session type per user per date |

### Query layer

Primary file: `backend/app/db/queries.py`

Important query functions:

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

### How read works

This is the key backend read path summary.

#### Shared read model pattern

`backend/app/db/queries.py` uses:

1. raw SQL,
2. left join from `workout_logs` to `workout_muscle_targets`,
3. `JSON_AGG(JSON_BUILD_OBJECT(...))` to collect muscle targets per workout,
4. `_rows_to_responses()` to convert the SQL rows into `WorkoutLogResponse`.

That means a single read can return:

- the workout row,
- whether it is a PR,
- and the nested muscle target list.

#### Recent workouts read

Route: `GET /api/v1/workouts`

Read order:

1. Try Redis key `gymbuddy:workouts:{user_id}`.
2. If cache miss, call `fetch_workouts(session, user_id, limit)`.
3. Return `list[WorkoutLogResponse]`.
4. Cache the serialized result for future reads.

#### Recent sessions read

Route: `GET /api/v1/sessions`

Read order:

1. Try Redis key `gymbuddy:sessions:{user_id}`.
2. If cache miss, call `get_sessions(session, user_id, days)`.
3. Return `list[WorkoutSession]`.
4. Cache the serialized result.

#### Date-specific workout reads

Functions:

- `fetch_workouts_by_date()`
- workout agent tool `get_today_workouts()`
- workout agent tool `get_workouts_for_date()`

Important detail:

- `fetch_workouts_by_date()` uses `(w.logged_at AT TIME ZONE :tz)::date = :date`
- so date reads are timezone-aware on the backend.

`get_today_workouts()` also uses the client timezone to filter cached records correctly by local calendar date.

#### PR read

Function: `get_pr_for_exercise()`

Read order:

1. Try Redis key `gymbuddy:pr:{user_id}:{exercise}`.
2. If cache miss, call `get_exercise_pr()` in Postgres.
3. Cache the result if found.

#### Coach conversation read

Service: `backend/app/services/conversation.py`

Read order:

1. `sweep_expired()`
2. `get_or_create(conversation_id)`
3. build `input_messages = history + current user turn`
4. run the coach agent

This is in-memory only, not persisted to Postgres.

#### Pacer session read

Service: `backend/app/services/pacer_session.py`

Read order:

1. `sweep_expired()`
2. `get_or_create(session_id)`
3. load `history`
4. load `PacerSessionState`
5. run pacer agent or direct helper logic

This is also in-memory only.

## Frontend Reference

### Page responsibilities

| File | Route | Responsibility |
| --- | --- | --- |
| `frontend/app/page.tsx` | `/` | Workout history, streamed voice logging, manual CRUD, session editing, stale-first cache, wake word, TTS |
| `frontend/app/coach/page.tsx` | `/coach` | Coach thread, image upload/camera capture, "log this" shortcut, wake word, TTS |
| `frontend/app/pacer/page.tsx` | `/pacer` | Pacer thread, auto-listen after rest, direct pacer actions, wake word, TTS |
| `frontend/app/login/page.tsx` | `/login` | Google OAuth entry |
| `frontend/app/auth/callback/route.ts` | `/auth/callback` | OAuth code exchange and redirect |
| `frontend/app/layout.tsx` | all pages | Root layout, nav bar, runtime public env injection |
| `frontend/proxy.ts` | route gate | Auth gate and session cookie propagation |

### Important frontend modules

| File | Responsibility |
| --- | --- |
| `frontend/components/VoiceInput.tsx` | Manual voice capture and typed fallback |
| `frontend/components/WakeWordIndicator.tsx` | Floating mic/wake-word status UI |
| `frontend/components/WorkoutPacer.tsx` | Pacer plan, progress, rest timer, and manual action UI |
| `frontend/components/CoachResponse.tsx` | Coach structured response renderer |
| `frontend/components/CameraCapture.tsx` | Camera modal and still capture |
| `frontend/lib/api.ts` | Direct workout/session REST clients and workout/session type helpers |
| `frontend/lib/chat-api.ts` | Unified `/api/v1/chat` client and pacer response types |
| `frontend/lib/coach-api.ts` | Direct coach client plus image resize helper |
| `frontend/lib/pacer-api.ts` | Direct pacer action clients |
| `frontend/lib/useTTS.ts` | OpenAI TTS playback with browser fallback |
| `frontend/lib/useWakeWord.ts` | Always-listening "Gym Buddy" wake-word recognition |
| `frontend/lib/public-env.ts` | Runtime env lookup on client and server |

### Runtime env handling

Primary files: `frontend/app/layout.tsx`, `frontend/lib/public-env.ts`

- The frontend uses `dynamic = "force-dynamic"` in the root layout.
- The layout injects `window.__GYMBUDDY_PUBLIC_ENV__` at request time.
- This lets the deployed frontend read runtime env vars instead of hardcoding all `NEXT_PUBLIC_*` values at build time.

## Timing Reference

This section is the fastest way to answer timing questions in a presentation.

| Area | Value | Where it comes from |
| --- | --- | --- |
| Chat route rate limit | `20 requests / 60 seconds` | `backend/app/routes/chat.py` |
| Intent classifier timeout | `10 seconds` | `CLASSIFIER_TIMEOUT_SECONDS` |
| Workout agent timeout | `60 seconds` | `backend/app/agents/workout_parser.py` |
| Coach agent timeout | `60 seconds` | `backend/app/agents/exercise_coach.py` |
| Pacer agent timeout | `60 seconds` | `backend/app/agents/workout_pacer.py` |
| Workouts cache TTL | `60 seconds` | `backend/app/cache/redis_client.py` |
| Sessions cache TTL | `600 seconds` | `backend/app/cache/redis_client.py` |
| PR cache TTL | `600 seconds` | `backend/app/cache/redis_client.py` |
| Coach conversation TTL | `10 minutes` | `backend/app/services/conversation.py` |
| Coach conversation turn limit | `6 turns` | `backend/app/services/conversation.py` |
| Pacer session TTL | `2 hours` | `backend/app/services/pacer_session.py` |
| Pacer session turn limit | `50 turns` | `backend/app/services/pacer_session.py` |
| JWKS cache lifespan | `900 seconds` | `backend/app/auth/dependencies.py` |
| DB pool recycle | `300 seconds` | `backend/app/db/database.py` |
| Manual speech capture silence timeout | `2000 ms` | `frontend/components/VoiceInput.tsx` |
| Wake-word command silence timeout | `2000 ms` default | `frontend/lib/useWakeWord.ts` |
| Wake-word wait after wake-word-only activation | `4000 ms` | `commandSilenceMs * 2` |
| Wake-word restart after stop | `300 ms` | `frontend/lib/useWakeWord.ts` |
| Wake-word retry after failed start | `500 ms` | `frontend/lib/useWakeWord.ts` |
| Pacer auto-listen after rest | `rest_seconds + 1 second` | `frontend/app/pacer/page.tsx` |
| Pacer visible rest countdown tick | `1000 ms` | `frontend/components/WorkoutPacer.tsx` |
| Direct pacer between-exercise rest | `120 seconds` | `_mark_set_done_impl()` and `_skip_exercise_impl()` |
| TTS input cap | `1000 chars` | `backend/app/routes/tts.py` and `generate_tts_b64()` |

### Voice timing behavior by surface

#### Manual voice input

- `VoiceInput` runs continuous recognition.
- It stops after `2 seconds` of silence.
- On end, it sends the final transcript to the page callback.

#### Wake-word behavior

- The app listens for variants like `gym buddy`, `hey gym buddy`, and common mis-hearings.
- Once activated, it waits for the command and uses the silence timer to decide when the command is complete.
- Wake-word listening is suppressed while:
  - TTS is speaking
  - a manual voice request is already running

#### Pacer rest behavior

- The pacer component shows a live countdown.
- When the timer reaches zero, the browser says `Rest done. Let's go!`.
- `PacerPage` then auto-starts `VoiceInput` after `rest_seconds + 1 second`.

## Environment Variables

### Backend

```text
DATABASE_URL
SUPABASE_JWKS_URL
OPENAI_API_KEY
YOUTUBE_API_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
FRONTEND_URL
CORS_ALLOWED_ORIGINS
```

### Frontend

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_API_URL
```

Notes:

- The frontend supports both `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- The frontend defaults the API base URL to `http://localhost:8000` if `NEXT_PUBLIC_API_URL` is missing.

## Validation Snapshot

Checks run against the current repo on `2026-04-20`:

| Check | Result | Notes |
| --- | --- | --- |
| `uv run pytest -q` | Failed | Test collection still fails because `tests/test_new_models_and_lookup.py` imports missing `backend.app.data.muscle_lookup` |
| `uv run pytest backend/tests/test_new_agents.py -q` | Passed | `56 passed`, plus 4 deprecation warnings from test code using `datetime.utcnow()` |
| `cmd /c npm run type-check` in `frontend/` | Passed | `tsc --noEmit` completed successfully |
| `cmd /c npm run build` in `frontend/` | Passed | Next.js production build completed successfully |

## Current Risks and Caveats

These are the main things to say if someone asks what is still rough around the edges.

1. The full Python test suite is still broken by a stale import to `backend.app.data.muscle_lookup`.
2. Coach and pacer state are in-memory only, so conversation continuity assumes a single-process deployment.
3. In-memory coach and pacer session IDs are not currently bound to `user_id` ownership in the stores themselves.
4. Direct pacer manual actions append synthetic history notes but do not increment pacer turn count the same way normal chat turns do.
5. Cache keys for workout/session lists are per user, not per query shape, so parameterized reads like `limit` and `days` can share the same cached payload.
6. Clearing coach or pacer UI locally does not fully clear all backend-side in-memory state in every path.
7. There is visible encoding corruption in several UI strings, prompts, and docs, which hurts polish.

## Good Presentation Answers

If someone asks "How does the data flow?", the concise answer is:

> Supabase handles login, the frontend sends a bearer token to FastAPI, FastAPI verifies it, routes the request either directly or through the orchestrator, reads or writes Postgres through raw SQL helpers, optionally uses Redis for short-lived caches, and then sends structured results plus inline TTS audio back to the frontend.

If someone asks "How do reads work?", the concise answer is:

> Reads are cache-first when possible. Recent workouts, sessions, and PR lookups try Redis first, then Postgres. Postgres reads use raw SQL joins that already include muscle targets and PR status, so the frontend gets complete typed models back in one response.

If someone asks "Why do you have both direct routes and an orchestrator?", the concise answer is:

> Workouts needed deterministic CRUD and a streamed logging path, so that surface talks directly to workout routes. Coach and Pacer are more conversational, so they share the chat orchestrator. Pacer also has direct action routes for buttons like set-done, skip, and plan edits so those actions do not need an extra LLM turn.

If someone asks "What is the hardest real-time part?", the concise answer is:

> The pacer. It keeps live session state in memory, tracks per-exercise set progress, turns that into persisted workout logs when exercises finish, coordinates rest timers, triggers TTS, and auto-restarts voice listening after rest.

If someone asks "What makes this more than a CRUD app?", the concise answer is:

> The AI layer is not just chat text. It classifies intent, calls structured tools, writes real workout data, infers muscle targets, answers multimodal coach questions, and drives a stateful workout pacer that can persist results back into the same data model.
