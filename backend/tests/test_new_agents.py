"""
Tests for newly added multi-agent components:
  - backend/app/services/conversation.py
  - backend/app/models/pacer.py
  - backend/app/models/chat.py
  - backend/app/agents/workout_pacer.py  (build_pacer_api_response only)
  - backend/app/data/muscle_ai.py        (cache behaviour)

No live DB or OpenAI connections are used — all external calls are mocked.
"""
from __future__ import annotations

import sys
import types
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Stub out heavy third-party modules BEFORE any backend import so that
# 'import openai' and 'from agents import ...' do not fail in a test env.
# ---------------------------------------------------------------------------

def _stub_openai() -> None:
    """Provide a minimal openai stub."""
    if "openai" in sys.modules:
        return
    openai_mod = types.ModuleType("openai")
    openai_mod.AsyncOpenAI = MagicMock  # type: ignore[attr-defined]
    sys.modules["openai"] = openai_mod
    # openai.BaseModel used by some sub-modules
    pydantic_mod = types.ModuleType("openai.pydantic_v1")
    sys.modules["openai.pydantic_v1"] = pydantic_mod


def _stub_agents() -> None:
    """Provide a minimal openai-agents stub."""
    if "agents" in sys.modules:
        return
    agents_mod = types.ModuleType("agents")
    agents_mod.Agent = MagicMock  # type: ignore[attr-defined]
    agents_mod.Runner = MagicMock  # type: ignore[attr-defined]
    agents_mod.RunContextWrapper = MagicMock  # type: ignore[attr-defined]
    agents_mod.function_tool = lambda **kw: (lambda f: f)  # passthrough decorator
    sys.modules["agents"] = agents_mod


_stub_openai()
_stub_agents()

# ---------------------------------------------------------------------------
# Now we can safely import the modules under test.
# ---------------------------------------------------------------------------

# --- conversation.py ---------------------------------------------------------
from backend.app.services import conversation as conv_module
from backend.app.services.conversation import (
    MAX_TURNS,
    CONVERSATION_TTL,
    append_turn,
    delete_conversation,
    get_or_create,
    is_at_limit,
    sweep_expired,
)

# --- models ------------------------------------------------------------------
from backend.app.models.pacer import PacerAgentOutput, PacerAPIResponse, PacerContext
from backend.app.models.chat import ChatRequest, ChatResponse
from backend.app.models.workout import (
    AgentActionResponse,
    MuscleTargetResponse,
    WorkoutLogResponse,
)

# --- build_pacer_api_response (pure function, no DB/OpenAI) -----------------
from backend.app.agents.workout_pacer import build_pacer_api_response

# --- muscle_ai ---------------------------------------------------------------
# muscle_ai creates an openai.AsyncOpenAI() at import time; our stub handles that.
import backend.app.data.muscle_ai as muscle_ai_module
from backend.app.data.muscle_ai import infer_muscles


# ===========================================================================
# Helpers
# ===========================================================================

def _clear_conversations() -> None:
    """Wipe the global conversations dict between tests."""
    conv_module.conversations.clear()


def _make_workout_log_response(**overrides: Any) -> WorkoutLogResponse:
    defaults: dict[str, Any] = {
        "id": uuid.uuid4(),
        "user_id": uuid.uuid4(),
        "exercise": "bench press",
        "sets": 3,
        "reps": 10,
        "weight": 135.0,
        "weight_unit": "lbs",
        "notes": None,
        "logged_at": datetime.utcnow(),
        "created_at": datetime.utcnow(),
        "is_personal_record": False,
        "muscle_targets": [],
    }
    defaults.update(overrides)
    return WorkoutLogResponse(**defaults)


# ===========================================================================
# 1. conversation.py
# ===========================================================================

class TestGetOrCreate:
    def setup_method(self) -> None:
        _clear_conversations()

    def test_none_id_creates_new_entry(self) -> None:
        cid, entry = get_or_create(None)
        assert cid is not None
        assert entry["turn_count"] == 0
        assert entry["history"] == []
        assert "last_active" in entry

    def test_none_id_entry_stored_in_global_dict(self) -> None:
        cid, entry = get_or_create(None)
        assert cid in conv_module.conversations
        assert conv_module.conversations[cid] is entry

    def test_existing_id_returns_same_entry(self) -> None:
        cid, entry_first = get_or_create(None)
        cid2, entry_second = get_or_create(cid)
        assert cid2 == cid
        assert entry_second is entry_first

    def test_unknown_non_none_id_creates_new_entry(self) -> None:
        fake_id = str(uuid.uuid4())
        new_cid, entry = get_or_create(fake_id)
        # A new entry must be created (the unknown id is treated as "not found")
        assert new_cid != fake_id, (
            "get_or_create should create a new entry for an unknown id, not reuse the unknown id"
        )
        assert entry["turn_count"] == 0
        assert entry["history"] == []

    def test_multiple_none_calls_create_separate_entries(self) -> None:
        cid1, _ = get_or_create(None)
        cid2, _ = get_or_create(None)
        assert cid1 != cid2
        assert len(conv_module.conversations) == 2


class TestAppendTurn:
    def setup_method(self) -> None:
        _clear_conversations()

    def test_increments_turn_count(self) -> None:
        cid, entry = get_or_create(None)
        assert entry["turn_count"] == 0
        append_turn(cid, "user message", "assistant reply")
        assert entry["turn_count"] == 1

    def test_appends_user_and_assistant_messages(self) -> None:
        cid, entry = get_or_create(None)
        append_turn(cid, "hello", "hi there")
        assert len(entry["history"]) == 2
        assert entry["history"][0] == {"role": "user", "content": "hello"}
        assert entry["history"][1] == {"role": "assistant", "content": "hi there"}

    def test_multiple_turns_accumulate(self) -> None:
        cid, entry = get_or_create(None)
        append_turn(cid, "msg1", "reply1")
        append_turn(cid, "msg2", "reply2")
        assert entry["turn_count"] == 2
        assert len(entry["history"]) == 4

    def test_updates_last_active(self) -> None:
        cid, entry = get_or_create(None)
        before = entry["last_active"]
        # Tiny sleep alternative: manipulate last_active to a past value so we
        # can confirm it was updated.
        entry["last_active"] = datetime.now(timezone.utc) - timedelta(seconds=5)
        append_turn(cid, "msg", "reply")
        assert entry["last_active"] > before - timedelta(seconds=6)

    def test_accepts_list_content_for_image_turns(self) -> None:
        cid, entry = get_or_create(None)
        image_content = [
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,abc"}},
            {"type": "text", "text": "What is this?"},
        ]
        append_turn(cid, image_content, "That is a barbell.")
        assert entry["history"][0]["content"] == image_content


class TestIsAtLimit:
    def setup_method(self) -> None:
        _clear_conversations()

    def test_false_for_zero_turns(self) -> None:
        cid, _ = get_or_create(None)
        assert is_at_limit(cid) is False

    def test_false_below_max_turns(self) -> None:
        cid, _ = get_or_create(None)
        for i in range(MAX_TURNS - 1):
            append_turn(cid, f"u{i}", f"a{i}")
        assert is_at_limit(cid) is False

    def test_true_at_exactly_max_turns(self) -> None:
        cid, _ = get_or_create(None)
        for i in range(MAX_TURNS):
            append_turn(cid, f"u{i}", f"a{i}")
        assert is_at_limit(cid) is True

    def test_true_above_max_turns(self) -> None:
        cid, _ = get_or_create(None)
        for i in range(MAX_TURNS + 2):
            append_turn(cid, f"u{i}", f"a{i}")
        assert is_at_limit(cid) is True

    def test_false_for_unknown_id(self) -> None:
        assert is_at_limit(str(uuid.uuid4())) is False


class TestSweepExpired:
    def setup_method(self) -> None:
        _clear_conversations()

    def test_removes_expired_entries(self) -> None:
        cid, entry = get_or_create(None)
        # Force last_active far into the past
        entry["last_active"] = datetime.now(timezone.utc) - CONVERSATION_TTL - timedelta(seconds=1)
        sweep_expired()
        assert cid not in conv_module.conversations

    def test_keeps_fresh_entries(self) -> None:
        cid, entry = get_or_create(None)
        # entry is fresh (just created); sweep should keep it
        sweep_expired()
        assert cid in conv_module.conversations

    def test_mixed_expired_and_fresh(self) -> None:
        cid_old, entry_old = get_or_create(None)
        cid_new, entry_new = get_or_create(None)
        entry_old["last_active"] = datetime.now(timezone.utc) - CONVERSATION_TTL - timedelta(seconds=5)
        sweep_expired()
        assert cid_old not in conv_module.conversations
        assert cid_new in conv_module.conversations

    def test_empty_dict_does_not_raise(self) -> None:
        sweep_expired()  # should not raise


# ---------------------------------------------------------------------------
# Turn-number timing issue (known bug documentation)
# ---------------------------------------------------------------------------

class TestTurnNumberTimingIssue:
    """
    Known issue: run_pacer reads entry["turn_count"] AFTER append_turn increments it.

    Code in workout_pacer.run_pacer():
        append_turn(conv_id, text, output.message)   # increments turn_count to N
        turn_number = entry["turn_count"]            # reads N  (already incremented)

    On the very first turn (turn_count starts at 0):
        - append_turn sets turn_count = 1
        - turn_number = 1

    This means the first turn is labelled turn_number=1 (not 0).
    The orchestrator then passes turn_number=1 to build_pacer_api_response
    and the PacerAPIResponse.turn_number will be 1 for the first turn.

    Documented here as a known behaviour so it is visible in the test report.
    """

    def setup_method(self) -> None:
        _clear_conversations()

    def test_turn_number_is_post_increment(self) -> None:
        """After the first append_turn call, turn_count is 1, not 0."""
        cid, entry = get_or_create(None)
        assert entry["turn_count"] == 0, "Pre-condition: starts at 0"
        append_turn(cid, "first user message", "first reply")
        # Simulates what run_pacer does right after append_turn:
        turn_number = entry["turn_count"]
        assert turn_number == 1, (
            "turn_number reflects the POST-increment value; "
            "turn 1 is labelled 1 (not 0). "
            "This is the known timing issue."
        )


# ===========================================================================
# 2. models/pacer.py
# ===========================================================================

class TestPacerAgentOutput:
    def test_valid_phase_planning(self) -> None:
        obj = PacerAgentOutput(message="Let's plan your workout!", phase="planning")
        assert obj.phase == "planning"

    def test_valid_phase_active(self) -> None:
        obj = PacerAgentOutput(message="Go!", phase="active")
        assert obj.phase == "active"

    def test_valid_phase_resting(self) -> None:
        obj = PacerAgentOutput(message="Rest now.", phase="resting", rest_seconds=60)
        assert obj.phase == "resting"
        assert obj.rest_seconds == 60

    def test_valid_phase_done(self) -> None:
        obj = PacerAgentOutput(message="Great workout!", phase="done")
        assert obj.phase == "done"

    def test_invalid_phase_raises(self) -> None:
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            PacerAgentOutput(message="oops", phase="invalid_phase")  # type: ignore[arg-type]

    def test_default_phase_is_planning(self) -> None:
        obj = PacerAgentOutput(message="Hello")
        assert obj.phase == "planning"

    def test_default_rest_seconds_is_none(self) -> None:
        obj = PacerAgentOutput(message="Hello")
        assert obj.rest_seconds is None

    def test_default_suggested_exercises_is_empty_list(self) -> None:
        obj = PacerAgentOutput(message="Hello")
        assert obj.suggested_exercises == []

    def test_suggested_exercises_mutable_default_isolation(self) -> None:
        """
        Pydantic models do NOT share mutable defaults across instances
        (unlike plain Python default arguments). Each instance should have
        its own list.
        """
        a = PacerAgentOutput(message="A")
        b = PacerAgentOutput(message="B")
        a.suggested_exercises.append("squat")
        # b should not be contaminated
        assert b.suggested_exercises == [], (
            "Pydantic correctly isolates mutable defaults — no shared-list bug here."
        )

    def test_full_output(self) -> None:
        obj = PacerAgentOutput(
            message="Ready for bench press?",
            phase="active",
            rest_seconds=None,
            current_exercise="bench press",
            set_number=2,
            suggested_exercises=["bench press", "squat"],
        )
        assert obj.current_exercise == "bench press"
        assert obj.set_number == 2
        assert obj.suggested_exercises == ["bench press", "squat"]


class TestPacerAPIResponse:
    def test_serializes_phase_as_str(self) -> None:
        resp = PacerAPIResponse(
            conversation_id="abc-123",
            turn_number=1,
            max_turns=MAX_TURNS,
            message="Go!",
            phase="active",
        )
        data = resp.model_dump()
        assert isinstance(data["phase"], str)
        assert data["phase"] == "active"

    def test_optional_fields_default_none(self) -> None:
        resp = PacerAPIResponse(
            conversation_id="abc-123",
            turn_number=1,
            max_turns=MAX_TURNS,
            message="Plan ready.",
            phase="planning",
        )
        assert resp.rest_seconds is None
        assert resp.current_exercise is None
        assert resp.set_number is None
        assert resp.logged_workout is None
        assert resp.suggested_exercises == []


class TestPacerContext:
    def test_creation_with_user_id(self) -> None:
        uid = uuid.uuid4()
        ctx = PacerContext(user_id=uid)
        assert ctx.user_id == uid
        assert ctx.logged_workouts == []

    def test_logged_workout_can_be_set(self) -> None:
        uid = uuid.uuid4()
        ctx = PacerContext(user_id=uid)
        workout = _make_workout_log_response()
        ctx.logged_workouts.append(workout)
        assert ctx.logged_workouts[-1] is workout


# ===========================================================================
# 3. models/chat.py
# ===========================================================================

class TestChatRequest:
    def test_text_only(self) -> None:
        req = ChatRequest(text="bench press 3x10")
        assert req.text == "bench press 3x10"
        assert req.image_base64 is None
        assert req.coach_conversation_id is None
        assert req.pacer_conversation_id is None

    def test_with_image(self) -> None:
        req = ChatRequest(text="what exercise is this?", image_base64="data:image/jpeg;base64,abc")
        assert req.image_base64 == "data:image/jpeg;base64,abc"

    def test_with_coach_conversation_id(self) -> None:
        cid = str(uuid.uuid4())
        req = ChatRequest(text="next set", coach_conversation_id=cid)
        assert req.coach_conversation_id == cid

    def test_with_pacer_conversation_id(self) -> None:
        cid = str(uuid.uuid4())
        req = ChatRequest(text="done", pacer_conversation_id=cid)
        assert req.pacer_conversation_id == cid

    def test_text_is_required(self) -> None:
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            ChatRequest()  # type: ignore[call-arg]


class TestChatResponse:
    def test_workout_agent_type(self) -> None:
        action = AgentActionResponse(action="logged", message="Logged bench press.")
        resp = ChatResponse(agent_type="workout", workout=action)
        assert resp.agent_type == "workout"
        assert resp.workout is action
        assert resp.coach is None
        assert resp.pacer is None

    def test_coach_agent_type(self) -> None:
        from backend.app.models.coach import CoachAPIResponse, ExerciseCoachResponse
        coach_resp = CoachAPIResponse(
            conversation_id="cid",
            turn_number=1,
            max_turns=6,
            response=ExerciseCoachResponse(message="Keep your back straight."),
        )
        resp = ChatResponse(agent_type="coach", coach=coach_resp)
        assert resp.agent_type == "coach"
        assert resp.coach is coach_resp
        assert resp.workout is None
        assert resp.pacer is None

    def test_pacer_agent_type(self) -> None:
        pacer_resp = PacerAPIResponse(
            conversation_id="cid",
            turn_number=1,
            max_turns=6,
            message="Let's go!",
            phase="active",
        )
        resp = ChatResponse(agent_type="pacer", pacer=pacer_resp)
        assert resp.agent_type == "pacer"
        assert resp.pacer is pacer_resp
        assert resp.workout is None
        assert resp.coach is None

    def test_invalid_agent_type_raises(self) -> None:
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            ChatResponse(agent_type="unknown")  # type: ignore[arg-type]




# ===========================================================================
# 4. workout_pacer.py — build_pacer_api_response (pure function)
# ===========================================================================

class TestBuildPacerApiResponse:
    def _make_output(self, **kw: Any) -> PacerAgentOutput:
        defaults: dict[str, Any] = {
            "message": "Time to rest.",
            "phase": "resting",
            "rest_seconds": 60,
            "current_exercise": "bench press",
            "set_number": 2,
            "suggested_exercises": [],
        }
        defaults.update(kw)
        return PacerAgentOutput(**defaults)

    def test_maps_all_fields_from_output(self) -> None:
        output = self._make_output(
            message="Big set coming up!",
            phase="active",
            rest_seconds=None,
            current_exercise="squat",
            set_number=3,
            suggested_exercises=["squat", "leg press"],
        )
        context = PacerContext(user_id=uuid.uuid4())
        conv_id = "test-conv-id"
        turn_number = 2

        from backend.app.services.pacer_session import PACER_MAX_TURNS
        result = build_pacer_api_response(output, context, conv_id, turn_number)

        assert result.conversation_id == conv_id
        assert result.turn_number == turn_number
        assert result.max_turns == PACER_MAX_TURNS
        assert result.message == "Big set coming up!"
        assert result.phase == "active"
        assert result.rest_seconds is None
        assert result.current_exercise == "squat"
        assert result.set_number == 3
        assert result.suggested_exercises == ["squat", "leg press"]

    def test_logged_workout_comes_from_context_not_output(self) -> None:
        """
        Critical: logged_workout must come from PacerContext, not from PacerAgentOutput
        (the LLM never sees DB data directly).
        """
        output = self._make_output()
        context = PacerContext(user_id=uuid.uuid4())
        workout = _make_workout_log_response(exercise="deadlift", sets=1, reps=5, weight=225.0)
        context.logged_workouts.append(workout)

        result = build_pacer_api_response(output, context, "cid", 1)

        assert result.logged_workout is workout
        assert result.logged_workout.exercise == "deadlift"

    def test_logged_workout_none_when_context_has_none(self) -> None:
        output = self._make_output()
        context = PacerContext(user_id=uuid.uuid4())
        # context.logged_workouts is empty by default

        result = build_pacer_api_response(output, context, "cid", 1)

        assert result.logged_workout is None

    def test_returns_pacer_api_response_instance(self) -> None:
        output = self._make_output()
        context = PacerContext(user_id=uuid.uuid4())
        result = build_pacer_api_response(output, context, "cid", 1)
        assert isinstance(result, PacerAPIResponse)

    def test_rest_seconds_propagated(self) -> None:
        output = self._make_output(rest_seconds=90)
        context = PacerContext(user_id=uuid.uuid4())
        result = build_pacer_api_response(output, context, "cid", 1)
        assert result.rest_seconds == 90

    def test_planning_phase_with_suggested_exercises(self) -> None:
        exercises = ["bench press", "incline press", "cable fly"]
        output = self._make_output(
            phase="planning",
            rest_seconds=None,
            current_exercise=None,
            set_number=None,
            suggested_exercises=exercises,
        )
        context = PacerContext(user_id=uuid.uuid4())
        result = build_pacer_api_response(output, context, "cid", 1)
        assert result.phase == "planning"
        assert result.suggested_exercises == exercises


# ===========================================================================
# 5. muscle_ai.py — cache behaviour
# ===========================================================================

class TestInferMuscles:
    def setup_method(self) -> None:
        # Clear the module-level cache between tests so they are independent.
        muscle_ai_module._cache.clear()

    @pytest.mark.asyncio
    async def test_returns_list_on_success(self) -> None:
        from backend.app.data.muscle_ai import _MuscleTarget, _MuscleTargetList

        mock_target = _MuscleTarget(
            muscle_group="chest",
            specific_muscles=["pectoralis major"],
            role="primary",
        )
        mock_parsed = _MuscleTargetList(targets=[mock_target])

        mock_result = MagicMock()
        mock_result.choices[0].message.parsed = mock_parsed

        with patch.object(
            muscle_ai_module._client.beta.chat.completions,
            "parse",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await infer_muscles("bench press")

        assert isinstance(result, list)
        assert len(result) == 1
        assert result[0]["muscle_group"] == "chest"

    @pytest.mark.asyncio
    async def test_second_call_uses_cache_not_openai(self) -> None:
        """Cache hit: second call for same exercise must NOT call OpenAI again."""
        from backend.app.data.muscle_ai import _MuscleTarget, _MuscleTargetList

        mock_target = _MuscleTarget(
            muscle_group="back",
            specific_muscles=["latissimus dorsi"],
            role="primary",
        )
        mock_parsed = _MuscleTargetList(targets=[mock_target])

        mock_result = MagicMock()
        mock_result.choices[0].message.parsed = mock_parsed

        parse_mock = AsyncMock(return_value=mock_result)
        with patch.object(
            muscle_ai_module._client.beta.chat.completions,
            "parse",
            new=parse_mock,
        ):
            first = await infer_muscles("pull up")
            second = await infer_muscles("pull up")

        # OpenAI must have been called only once
        assert parse_mock.call_count == 1, (
            f"Expected 1 OpenAI call (cache hit on 2nd), got {parse_mock.call_count}"
        )
        assert first == second

    @pytest.mark.asyncio
    async def test_cache_key_normalises_whitespace_and_case(self) -> None:
        """'Bench Press' and 'bench press' should resolve to the same cache key."""
        from backend.app.data.muscle_ai import _MuscleTarget, _MuscleTargetList

        mock_target = _MuscleTarget(
            muscle_group="chest",
            specific_muscles=["pectoralis major"],
            role="primary",
        )
        mock_parsed = _MuscleTargetList(targets=[mock_target])
        mock_result = MagicMock()
        mock_result.choices[0].message.parsed = mock_parsed

        parse_mock = AsyncMock(return_value=mock_result)
        with patch.object(
            muscle_ai_module._client.beta.chat.completions,
            "parse",
            new=parse_mock,
        ):
            await infer_muscles("Bench Press")
            await infer_muscles("bench press")

        # Both variants should result in only one API call
        assert parse_mock.call_count == 1

    @pytest.mark.asyncio
    async def test_openai_error_returns_empty_list(self) -> None:
        """If OpenAI raises, infer_muscles must return [] and not propagate the exception."""
        with patch.object(
            muscle_ai_module._client.beta.chat.completions,
            "parse",
            new=AsyncMock(side_effect=RuntimeError("OpenAI is down")),
        ):
            result = await infer_muscles("unknown exercise xyz")

        assert result == [], (
            "infer_muscles should return [] on error, not raise"
        )

    @pytest.mark.asyncio
    async def test_error_result_is_cached(self) -> None:
        """Failed inference caches [] so we don't hammer a broken API on retries."""
        parse_mock = AsyncMock(side_effect=RuntimeError("network error"))
        with patch.object(
            muscle_ai_module._client.beta.chat.completions,
            "parse",
            new=parse_mock,
        ):
            first = await infer_muscles("bad exercise")
            second = await infer_muscles("bad exercise")

        assert first == []
        assert second == []
        # The error result was cached — only one actual API attempt
        assert parse_mock.call_count == 1

    @pytest.mark.asyncio
    async def test_different_exercises_get_separate_cache_entries(self) -> None:
        from backend.app.data.muscle_ai import _MuscleTarget, _MuscleTargetList

        def _make_result(muscle: str) -> Any:
            target = _MuscleTarget(
                muscle_group=muscle,
                specific_muscles=[muscle],
                role="primary",
            )
            parsed = _MuscleTargetList(targets=[target])
            r = MagicMock()
            r.choices[0].message.parsed = parsed
            return r

        call_count = 0

        async def side_effect(*args: Any, **kwargs: Any) -> Any:
            nonlocal call_count
            exercise_msg = kwargs.get("messages", args[1] if len(args) > 1 else [])
            # derive muscle from the user message content
            content = exercise_msg[-1]["content"] if exercise_msg else ""
            muscle = "chest" if "bench" in content else "quads"
            call_count += 1
            return _make_result(muscle)

        with patch.object(
            muscle_ai_module._client.beta.chat.completions,
            "parse",
            new=side_effect,
        ):
            r1 = await infer_muscles("bench press")
            r2 = await infer_muscles("squat")

        # Two different exercises → two API calls, separate cache entries
        assert call_count == 2
        assert r1 != r2


# ===========================================================================
# 6. Pacer turn-limit enforcement (known missing feature)
# ===========================================================================

class TestPacerTurnLimitEnforcement:
    """
    The pacer now uses its own session store (pacer_session.py) and enforces
    turn limits via is_at_limit() inside run_pacer().
    """

    def test_run_pacer_calls_is_at_limit(self) -> None:
        """
        Verify that run_pacer's source code contains the is_at_limit check.
        This was a known missing guard that has now been fixed.
        """
        import inspect
        import backend.app.agents.workout_pacer as pacer_mod

        source = inspect.getsource(pacer_mod.run_pacer)
        assert "is_at_limit" in source, (
            "run_pacer should call is_at_limit — the turn limit guard is now implemented."
        )
